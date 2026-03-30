#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { inspect } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "jsmcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PRESET = "default";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_CODE_TIMEOUT_MS = 30000;

class MetaMcpRuntime {
  constructor({ configPath, presetName, serverEntries }) {
    this.configPath = configPath;
    this.presetName = presetName;
    this.serverEntries = serverEntries;
    this.startedServers = new Map();
    this.pendingStarts = new Map();
    this.startErrors = new Map();
    this.logs = [];
    this.nextLogId = 1;
  }

  static async load(presetName) {
    const configPath = resolveConfigPath();
    const configDirectory = path.dirname(configPath);
    const rawConfig = await readConfigFile(configPath);
    const parsedConfig = parseJsonConfig(rawConfig, configPath);
    const resolvedConfig = await substituteVariables(parsedConfig, configDirectory);
    const serversConfig = getPlainObject(resolvedConfig.servers, 'Config field "servers"');
    const presetsConfig = getPlainObject(resolvedConfig.presets, 'Config field "presets"');
    const presetConfig = presetsConfig[presetName];

    if (presetConfig === undefined) {
      throw new Error(
        `Preset "${presetName}" was not found in ${configPath}. Available presets: ${Object.keys(
          presetsConfig,
        ).join(", ") || "none"}`,
      );
    }

    return new MetaMcpRuntime({
      configPath,
      presetName,
      serverEntries: normalizePreset(presetName, presetConfig, serversConfig),
    });
  }

  async listServers() {
    return this.listServerSummaries();
  }

  async startAllServers() {
    await Promise.all(
      [...this.serverEntries.keys()].map((name) => this.ensureServerStarted(name).catch(() => null)),
    );
  }

  listServerSummaries() {
    return [...this.serverEntries.keys()].map((name) => this.buildServerSummary(name));
  }

  buildServerSummary(name) {
    const entry = this.requireServerEntry(name);
    const started = this.startedServers.get(name);

    return {
      name,
      description: entry.serverConfig.description,
      type: entry.serverConfig.type,
      enabled: entry.serverConfig.enabled !== false,
      started: Boolean(started),
      allowedTools: describeAllowedTools(entry.toolPolicy),
      availableTools: started ? started.tools.map(sanitizeTool) : [],
      missingAllowedTools: started ? [...started.missingAllowedTools] : [],
      error: this.startErrors.get(name),
      command:
        entry.serverConfig.type === "local" ? [...entry.serverConfig.command] : undefined,
      url: entry.serverConfig.type === "remote" ? entry.serverConfig.url : undefined,
      timeoutMs:
        typeof entry.serverConfig.timeout === "number"
          ? entry.serverConfig.timeout
          : DEFAULT_DISCOVERY_TIMEOUT_MS,
    };
  }

  async listTools(serverName) {
    const started = await this.ensureServerStarted(serverName);
    return started.tools.map(sanitizeTool);
  }

  async ensureServerStarted(name) {
    const existing = this.startedServers.get(name);
    if (existing) {
      return existing;
    }

    const pending = this.pendingStarts.get(name);
    if (pending) {
      return pending;
    }

    const startPromise = this.startServer(name).finally(() => {
      this.pendingStarts.delete(name);
    });

    this.pendingStarts.set(name, startPromise);
    return startPromise;
  }

  async startServer(name) {
    const entry = this.requireServerEntry(name);

    if (entry.serverConfig.enabled === false) {
      const error = `Server "${name}" is disabled in config.`;
      this.startErrors.set(name, error);
      throw new Error(error);
    }

    const client = new Client({
      name: `${SERVER_NAME}-client`,
      version: SERVER_VERSION,
    });
    const transport = createClientTransport(entry.serverConfig);
    const startedServer = {
      name,
      client,
      transport,
      tools: [],
      missingAllowedTools: [],
    };

    transport.onclose = () => {
      const current = this.startedServers.get(name);
      if (current === startedServer) {
        this.startedServers.delete(name);
      }
    };

    transport.onerror = (error) => {
      console.error(`[${SERVER_NAME}] transport error from ${name}: ${getErrorMessage(error)}`);
    };

    client.onerror = (error) => {
      console.error(`[${SERVER_NAME}] client error from ${name}: ${getErrorMessage(error)}`);
    };

    try {
      await client.connect(transport);

      const listToolsResult = await client.listTools(undefined, {
        timeout: getDiscoveryTimeout(entry.serverConfig),
      });

      startedServer.tools = filterTools(listToolsResult.tools, entry.toolPolicy);
      startedServer.missingAllowedTools =
        entry.toolPolicy.mode === "all"
          ? []
          : [...entry.toolPolicy.tools]
              .filter((toolName) => !startedServer.tools.some((tool) => tool.name === toolName))
              .sort();

      this.startErrors.delete(name);
      this.startedServers.set(name, startedServer);
      return startedServer;
    } catch (error) {
      const message = `Failed to start "${name}": ${getErrorMessage(error)}`;
      this.startErrors.set(name, message);
      await closeClient(client);
      throw new Error(message);
    }
  }

  async executeCode(code, timeoutMs) {
    if (this.startedServers.size === 0) {
      throw new Error("No servers are started. Call list_servers first.");
    }

    const contextValues = this.buildSandboxContext();
    const context = vm.createContext(contextValues);
    context.globalThis = context;

    const script = new vm.Script(`(async () => {\n${code}\n})()`, {
      filename: "execute_code.js",
    });

    const execution = Promise.resolve(script.runInContext(context, { timeout: timeoutMs }));
    const result = await withTimeout(execution, timeoutMs, `Code execution exceeded ${timeoutMs}ms.`);
    return toJsonSafe(result);
  }

  buildSandboxContext() {
    const context = {
      console: createCapturedConsole(this),
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };

    for (const [serverName, started] of this.startedServers) {
      context[serverName] = this.createServerLibrary(serverName, started.tools);
    }

    return context;
  }

  createServerLibrary(serverName, tools) {
    const library = Object.create(null);

    for (const tool of tools) {
      const callable = async (args = {}, options = {}) => this.callTool(serverName, tool.name, args, options);
      library[tool.name] = callable;

      const alias = createToolAlias(tool.name);
      if (alias && library[alias] === undefined) {
        library[alias] = callable;
      }
    }

    return Object.freeze(library);
  }

  async callTool(serverName, toolName, args = {}, options = {}) {
    const entry = this.requireServerEntry(serverName);
    const started = this.requireStartedServer(serverName);

    if (!isToolAllowed(entry.toolPolicy, toolName)) {
      throw new Error(`Tool "${toolName}" is not allowed for server "${serverName}".`);
    }

    const tool = started.tools.find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`Tool "${toolName}" is not available on server "${serverName}".`);
    }

    const requestOptions = {};
    if (typeof options.timeoutMs === "number") {
      requestOptions.timeout = options.timeoutMs;
    }

    const result = await started.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      requestOptions,
    );

    return unwrapToolResult(serverName, toolName, result);
  }

  appendLog(level, values) {
    this.logs.push({
      id: this.nextLogId,
      level,
      message: values.map((value) => inspect(value, { depth: 6, breakLength: 120 })).join(" "),
      timestamp: new Date().toISOString(),
    });
    this.nextLogId += 1;
  }

  fetchLogs() {
    const logs = this.logs.map((entry) => ({ ...entry }));
    this.logs = [];
    return logs;
  }

  clearLogs() {
    const cleared = this.logs.length;
    this.logs = [];
    return cleared;
  }

  requireServerEntry(name) {
    const entry = this.serverEntries.get(name);
    if (!entry) {
      throw new Error(
        `Server "${name}" is not part of preset "${this.presetName}". Allowed servers: ${[
          ...this.serverEntries.keys(),
        ].join(", ") || "none"}`,
      );
    }
    return entry;
  }

  requireStartedServer(name) {
    const started = this.startedServers.get(name);
    if (!started) {
      throw new Error(`Server "${name}" is not started. Call list_servers first.`);
    }
    return started;
  }

  async close() {
    const servers = [...this.startedServers.values()];
    this.startedServers.clear();
    this.pendingStarts.clear();
    await Promise.allSettled(servers.map((server) => closeClient(server.client)));
  }
}

function resolveConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, SERVER_NAME, "config.json");
}

async function readConfigFile(configPath) {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Config file not found at ${configPath}.`);
    }
    throw error;
  }
}

function parseJsonConfig(rawConfig, configPath) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${configPath}: ${getErrorMessage(error)}`);
  }
}

async function substituteVariables(value, configDirectory) {
  if (typeof value === "string") {
    return substituteString(value, configDirectory);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => substituteVariables(item, configDirectory)));
  }

  if (value && typeof value === "object") {
    const object = {};
    for (const [key, childValue] of Object.entries(value)) {
      object[key] = await substituteVariables(childValue, configDirectory);
    }
    return object;
  }

  return value;
}

async function substituteString(value, configDirectory) {
  let nextValue = value.replaceAll(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  const fileMatches = [...nextValue.matchAll(/\{file:([^}]+)\}/g)];

  for (const match of fileMatches) {
    const token = match[0];
    const filePath = resolveReferencedFile(match[1], configDirectory);
    const fileContents = await readFile(filePath, "utf8");
    nextValue = nextValue.replace(token, fileContents);
  }

  return nextValue;
}

function resolveReferencedFile(filePath, configDirectory) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(configDirectory, filePath);
}

function normalizePreset(presetName, presetConfig, serversConfig) {
  const presetSource =
    Array.isArray(presetConfig) || typeof presetConfig === "string"
      ? presetConfig
      : getPlainObject(presetConfig, `Preset "${presetName}"`).servers ?? presetConfig;

  const normalizedEntries = new Map();

  if (typeof presetSource === "string") {
    addPresetEntry(normalizedEntries, presetSource, true);
  } else if (Array.isArray(presetSource)) {
    for (const serverName of presetSource) {
      addPresetEntry(normalizedEntries, serverName, true);
    }
  } else {
    const presetObject = getPlainObject(presetSource, `Preset "${presetName}" servers`);
    for (const [serverName, rule] of Object.entries(presetObject)) {
      addPresetEntry(normalizedEntries, serverName, rule);
    }
  }

  for (const [serverName, entry] of normalizedEntries) {
    entry.serverConfig = parseServerConfig(serverName, serversConfig[serverName]);
  }

  return normalizedEntries;
}

function addPresetEntry(target, serverName, rule) {
  if (typeof serverName !== "string" || !serverName) {
    throw new Error(`Preset contains an invalid server name: ${inspect(serverName)}`);
  }

  assertValidServerName(serverName);

  const toolPolicy = parseToolPolicy(serverName, rule);
  if (!toolPolicy) {
    return;
  }

  target.set(serverName, {
    name: serverName,
    toolPolicy,
    serverConfig: undefined,
  });
}

function parseServerConfig(serverName, config) {
  assertValidServerName(serverName);
  const serverConfig = getPlainObject(config, `Server "${serverName}" config`);

  if (serverConfig.type === "local") {
    if (!Array.isArray(serverConfig.command) || serverConfig.command.length === 0) {
      throw new Error(`Local server "${serverName}" must define a non-empty command array.`);
    }

    return {
      type: "local",
      description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
      command: serverConfig.command.map((item) => String(item)),
      environment: normalizeStringMap(serverConfig.environment, `Server "${serverName}" environment`),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
    };
  }

  if (serverConfig.type === "remote") {
    if (typeof serverConfig.url !== "string" || !serverConfig.url) {
      throw new Error(`Remote server "${serverName}" must define a url.`);
    }

    return {
      type: "remote",
      description: typeof serverConfig.description === "string" ? serverConfig.description : undefined,
      url: serverConfig.url,
      headers: normalizeStringMap(serverConfig.headers, `Server "${serverName}" headers`),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      oauth: serverConfig.oauth,
    };
  }

  throw new Error(
    `Server "${serverName}" must have type "local" or "remote", got ${inspect(
      serverConfig.type,
    )}.`,
  );
}

function normalizeStringMap(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const object = getPlainObject(value, label);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, String(item)]));
}

function assertValidServerName(serverName) {
  if (!isValidJavaScriptIdentifier(serverName)) {
    throw new Error(
      `Server name "${serverName}" is invalid. Server names must be valid JavaScript identifiers so they can be used directly in execute_code.`,
    );
  }
}

function isValidJavaScriptIdentifier(value) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    return false;
  }

  try {
    new vm.Script(`const ${value} = null;`);
    return true;
  } catch {
    return false;
  }
}

function parseToolPolicy(serverName, rule) {
  if (rule === false) {
    return null;
  }

  if (rule === true || rule === undefined || rule === null) {
    return { mode: "all" };
  }

  if (typeof rule === "string") {
    return rule === "*" ? { mode: "all" } : { mode: "subset", tools: new Set([rule]) };
  }

  if (Array.isArray(rule)) {
    if (rule.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(rule.map(String)) };
  }

  const ruleObject = getPlainObject(rule, `Preset rule for server "${serverName}"`);

  if (ruleObject.enabled === false) {
    return null;
  }

  if (ruleObject.tools === undefined || ruleObject.tools === true) {
    return { mode: "all" };
  }

  if (ruleObject.tools === "*" || ruleObject.tools === null) {
    return { mode: "all" };
  }

  if (typeof ruleObject.tools === "string") {
    return { mode: "subset", tools: new Set([ruleObject.tools]) };
  }

  if (Array.isArray(ruleObject.tools)) {
    if (ruleObject.tools.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(ruleObject.tools.map(String)) };
  }

  throw new Error(
    `Preset rule for server "${serverName}" must use tools as "*" or an array of tool names.`,
  );
}

function getPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function createClientTransport(serverConfig) {
  if (serverConfig.type === "local") {
    return new StdioClientTransport({
      command: serverConfig.command[0],
      args: serverConfig.command.slice(1),
      env: {
        ...getDefaultEnvironment(),
        ...(serverConfig.environment ?? {}),
      },
      cwd: serverConfig.cwd,
      stderr: "inherit",
    });
  }

  const requestInit = serverConfig.headers ? { headers: serverConfig.headers } : undefined;
  return new StreamableHTTPClientTransport(new URL(serverConfig.url), { requestInit });
}

function getDiscoveryTimeout(serverConfig) {
  return typeof serverConfig.timeout === "number"
    ? serverConfig.timeout
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function filterTools(tools, toolPolicy) {
  const filtered =
    toolPolicy.mode === "all"
      ? tools
      : tools.filter((tool) => toolPolicy.tools.has(tool.name));

  return [...filtered].sort((left, right) => left.name.localeCompare(right.name));
}

function sanitizeTool(tool) {
  return {
    name: tool.name,
    alias: createToolAlias(tool.name),
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

function createToolAlias(toolName) {
  const alias = toolName.replaceAll(/[^A-Za-z0-9_$]/g, "_");
  if (!alias || alias === toolName) {
    return undefined;
  }
  if (/^[0-9]/.test(alias)) {
    return `_${alias}`;
  }
  return alias;
}

function describeAllowedTools(toolPolicy) {
  if (toolPolicy.mode === "all") {
    return "all";
  }

  return [...toolPolicy.tools].sort();
}

function isToolAllowed(toolPolicy, toolName) {
  return toolPolicy.mode === "all" || toolPolicy.tools.has(toolName);
}

function unwrapToolResult(serverName, toolName, result) {
  if (result.isError) {
    throw new Error(renderToolError(serverName, toolName, result));
  }

  if (result.structuredContent !== undefined) {
    return toJsonSafe(result.structuredContent);
  }

  const text = renderToolContent(result.content ?? []);
  const nonTextContent = (result.content ?? []).some((item) => item.type !== "text");

  if (!nonTextContent) {
    return text;
  }

  return toJsonSafe({
    text,
    content: result.content ?? [],
    meta: result._meta,
  });
}

function renderToolError(serverName, toolName, result) {
  const text = renderToolContent(result.content ?? []);
  return text || `Tool "${toolName}" on server "${serverName}" failed.`;
}

function renderToolContent(content) {
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return `[image:${item.mimeType}]`;
      }
      if (item.type === "audio") {
        return `[audio:${item.mimeType}]`;
      }
      if (item.type === "resource") {
        return `[resource:${item.resource.uri}]`;
      }
      if (item.type === "resource_link") {
        return `[resource_link:${item.uri}]`;
      }
      return inspect(item, { depth: 4, breakLength: 120 });
    })
    .join("\n");
}

function createCapturedConsole(runtime) {
  const write = (level, values) => runtime.appendLog(level, values);

  return {
    log: (...values) => write("log", values),
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values),
  };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toJsonSafe(value, seen = new WeakSet()) {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = toJsonSafe(item, seen);
    }
    seen.delete(value);
    return output;
  }

  return inspect(value, { depth: 4, breakLength: 120 });
}

function renderServerListText(servers) {
  const lines = [];

  for (const server of servers) {
    if (server.description) {
      lines.push(`- ${server.name}: ${server.description}`);
    } else {
      lines.push(`- ${server.name}`);
    }
    const allowedTools =
      server.allowedTools === "all" ? "all tools" : server.allowedTools.join(", ") || "no tools";
    const status = server.started ? "started" : "failed";
    const details = server.availableTools.length
      ? ` tools: ${server.availableTools.map((tool) => tool.name).join(", ")}`
      : "";
    const error = server.error ? ` error: ${server.error}` : "";
    lines.push(`  type: ${server.type}; status: ${status}; allowed: ${allowedTools}${details}${error}`);
  }

  return lines.join("\n");
}

function renderToolListText(serverName, tools) {
  const lines = [`Server: ${serverName}`];

  for (const tool of tools) {
    lines.push(`- ${tool.name}${tool.alias ? ` (preferred: ${tool.alias})` : ""}`);
    if (tool.description) {
      lines.push(`  description: ${tool.description}`);
    }
    lines.push(`  inputSchema: ${formatSchemaText(tool.inputSchema)}`);
    if (tool.outputSchema) {
      lines.push(`  outputSchema: ${formatSchemaText(tool.outputSchema)}`);
    }
  }

  return lines.join("\n");
}

function formatSchemaText(schema) {
  return JSON.stringify(schema, null, 2)
    .split("\n")
    .join(" ");
}

function renderLogsText(logs) {
  if (logs.length === 0) {
    return "No logs.";
  }

  return logs.map((entry) => `${entry.id}. [${entry.level}] ${entry.message}`).join("\n");
}

function formatExecutionValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function closeClient(client) {
  try {
    await client.close();
  } catch {
  }
}

async function createMetaServer(runtime) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "list_servers",
    {
      description:
        "Required first step. You MUST call this to discover which tool server namespaces are available before using any tools. It lists the available servers, what they are for, and whether they started successfully. User assumes you called it and know what groups of tools are available to you. Once you have the list of servers you may use list_tools to learn more about tools in each group whenever your work might need any of the tools from it.",
      inputSchema: z.object({}),
    },
    async () => {
      const servers = await runtime.listServers();
      return {
        content: [{ type: "text", text: renderServerListText(servers) }],
        structuredContent: {
          servers,
        },
      };
    },
  );

  server.registerTool(
    "list_tools",
    {
      description:
        "List the allowed tools for a server, including preferred aliases and schemas. You MUST call this before using that server in execute_code so you know the exact tool names, aliases, and arguments.",
      inputSchema: z.object({
        server: z.string().min(1),
      }),
    },
    async ({ server: serverName }) => {
      const tools = await runtime.listTools(serverName);
      return {
        content: [{ type: "text", text: renderToolListText(serverName, tools) }],
        structuredContent: {
          server: serverName,
          tools,
        },
      };
    },
  );

  server.registerTool(
    "execute_code",
    {
      description:
        "Execute JavaScript against started MCP server namespaces. You MUST call list_tools for a server before using its tools here. After calling list_servers, each started server is available as a global object and each allowed tool is a function on it. Prefer underscore aliases when available, for example return await math.add({ a: 2, b: 5 }) or return await browser.open_tab({ url: \"https://example.com\" }). Original tool names still work with bracket access such as obj[\"tool-name\"], but prefer obj.tool_name for readability. Prefer writing JavaScript here whenever the work would require more than a single tool call, because code makes multi-step tool use easier and less error-prone. console.log/info/warn/error write to fetch_logs, not the return value.",
      inputSchema: z.object({
        code: z.string().min(1),
        timeoutMs: z.number().int().positive().max(300000).optional(),
      }),
    },
    async ({ code, timeoutMs }) => {
      try {
        const value = await runtime.executeCode(code, timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS);
        const structuredContent =
          value && typeof value === "object" && !Array.isArray(value)
            ? value
            : { value };

        return {
          content: [{ type: "text", text: formatExecutionValue(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: getErrorMessage(error) }],
          structuredContent: { error: getErrorMessage(error) },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "fetch_logs",
    {
      description: "Fetch and clear logs emitted by execute_code via console methods",
      inputSchema: z.object({}),
    },
    async () => {
      const logs = runtime.fetchLogs();
      return {
        content: [{ type: "text", text: renderLogsText(logs) }],
        structuredContent: { logs },
      };
    },
  );

  server.registerTool(
    "clear_logs",
    {
      description: "Clear stored execute_code logs",
      inputSchema: z.object({}),
    },
    async () => {
      const cleared = runtime.clearLogs();
      return {
        content: [{ type: "text", text: `Cleared ${cleared} log entries.` }],
        structuredContent: { cleared },
      };
    },
  );

  return server;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 1) {
    throw new Error(`Usage: ${SERVER_NAME} [preset]`);
  }

  const presetName = args[0] || DEFAULT_PRESET;
  const runtime = await MetaMcpRuntime.load(presetName);
  await runtime.startAllServers();
  const server = await createMetaServer(runtime);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await Promise.allSettled([server.close(), runtime.close()]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ready with preset "${presetName}"`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal error: ${getErrorMessage(error)}`);
  process.exit(1);
});
