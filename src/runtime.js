import vm from "node:vm";
import { inspect } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { snakeCase } from "change-case";

import { AuthStateStore, createRemoteAuthProvider } from "./auth.js";
import { DEFAULT_PRESET, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import {
  getDiscoveryTimeout,
  loadResolvedConfig,
  normalizePreset,
  normalizeServerEntries,
  resolveAuthStorePath,
} from "./config.js";
import { closeClient, getErrorMessage, toJsonSafe, withTimeout } from "./utils.js";

const DEFAULT_LOG_SESSION = "__default__";

export class MetaMcpRuntime {
  constructor({ configPath, defaultProfileName, serverEntries, presetsConfig, jsmcpConfig, serversConfig, authStore }) {
    this.configPath = configPath;
    this.defaultProfileName = defaultProfileName;
    this.serverEntries = serverEntries;
    this.presetsConfig = presetsConfig;
    this.jsmcpConfig = jsmcpConfig;
    this.serversConfig = serversConfig;
    this.profileEntries = new Map();
    this.authStore = authStore;
    this.startedServers = new Map();
    this.pendingStarts = new Map();
    this.startErrors = new Map();
    this.logsBySession = new Map();
    this.nextLogId = 1;
  }

  static async load(presetName) {
    const { configPath, jsmcpConfig, serversConfig, presetsConfig } = await loadResolvedConfig();

    return new MetaMcpRuntime({
      configPath,
      defaultProfileName: presetName ?? DEFAULT_PRESET,
      serverEntries: normalizeServerEntries(serversConfig, jsmcpConfig),
      presetsConfig,
      jsmcpConfig,
      serversConfig,
      authStore: new AuthStateStore(resolveAuthStorePath()),
    });
  }

  validateProfile(profileName = this.defaultProfileName) {
    this.getProfileEntries(profileName);
    return profileName;
  }

  async listServers(profileName = this.defaultProfileName) {
    const profileEntries = this.getProfileEntries(profileName);
    return [...profileEntries.keys()].map((name) => {
      const entry = this.requireProfileServerEntry(profileName, name);
      const error = this.startErrors.get(name);

      return {
        name,
        description: entry.serverConfig.description,
        ...(error ? { error } : { ok: true }),
      };
    });
  }

  async startAllServers() {
    await Promise.all(
      [...this.serverEntries.keys()].map((name) => this.ensureServerStarted(name).catch(() => null)),
    );
  }

  async listTools(serverName, profileName = this.defaultProfileName) {
    const profileEntry = this.requireProfileServerEntry(profileName, serverName);
    const started = await this.ensureServerStarted(serverName);
    return filterTools(started.tools, profileEntry.toolPolicy).map(sanitizeTool);
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

    const client = new Client({
      name: `${SERVER_NAME}-client`,
      version: SERVER_VERSION,
    });
    const transport = createClientTransport(name, entry.serverConfig, this.authStore);
    const stderrCapture = createTransportStderrCapture(name, entry.serverConfig, transport);
    const startedServer = {
      name,
      client,
      transport,
      tools: [],
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

      startedServer.tools = sortTools(normalizeToolNames(name, listToolsResult.tools, entry.serverConfig));

      this.startErrors.delete(name);
      this.startedServers.set(name, startedServer);
      return startedServer;
    } catch (error) {
      const startError = buildStartError(name, error, stderrCapture?.getText());
      this.startErrors.set(name, startError);
      await closeClient(client);
      throw new Error(startError.message);
    }
  }

  async executeCode(code, timeoutMs, sessionId, data, profileName = this.defaultProfileName) {
    if (this.startedServers.size === 0) {
      throw new Error("No servers are started. Call list_servers first.");
    }

    const contextValues = this.buildSandboxContext(profileName, sessionId, data);
    const context = vm.createContext(contextValues);
    context.globalThis = context;

    const script = new vm.Script(`(async () => {\n"use strict";\n${code}\n})()`, {
      filename: "execute_code.js",
    });

    const execution = Promise.resolve(script.runInContext(context, { timeout: timeoutMs }));
    const result = await withTimeout(execution, timeoutMs, `Code execution exceeded ${timeoutMs}ms.`);
    return toJsonSafe(result);
  }

  buildSandboxContext(profileName, sessionId, data) {
    const profileEntries = this.getProfileEntries(profileName);
    const context = {
      console: createCapturedConsole(this, sessionId),
      data: toJsonSafe(data),
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };

    for (const [serverName, profileEntry] of profileEntries) {
      const started = this.startedServers.get(serverName);
      if (started) {
        context[serverName] = this.createServerLibrary(
          profileName,
          serverName,
          filterTools(started.tools, profileEntry.toolPolicy),
        );
      }
    }

    return context;
  }

  createServerLibrary(profileName, serverName, tools) {
    const library = Object.create(null);

    for (const tool of tools) {
      const callable = async (args = {}, options = {}) => this.callTool(profileName, serverName, tool.name, args, options);
      library[tool.name] = callable;

      const alias = createToolAlias(tool.name);
      if (alias && library[alias] === undefined) {
        library[alias] = callable;
      }
    }

    return Object.freeze(library);
  }

  async callTool(profileName = this.defaultProfileName, serverName, toolName, args = {}, options = {}) {
    const entry = this.requireProfileServerEntry(profileName, serverName);
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
      { name: tool.originalName ?? toolName, arguments: args },
      undefined,
      requestOptions,
    );

    return unwrapToolResult(serverName, toolName, result);
  }

  appendLog(level, values, sessionId) {
    const logs = this.getSessionLogs(sessionId);

    logs.push({
      id: this.nextLogId,
      level,
      message: values.map((value) => inspect(value, { depth: 6, breakLength: 120 })).join(" "),
      timestamp: new Date().toISOString(),
    });
    this.nextLogId += 1;
  }

  fetchLogs(sessionId) {
    const key = getLogSessionKey(sessionId);
    const logs = (this.logsBySession.get(key) ?? []).map((entry) => ({ ...entry }));
    this.logsBySession.delete(key);
    return logs;
  }

  clearLogs(sessionId) {
    const key = getLogSessionKey(sessionId);
    const cleared = this.logsBySession.get(key)?.length ?? 0;
    this.logsBySession.delete(key);
    return cleared;
  }

  requireServerEntry(name) {
    const entry = this.serverEntries.get(name);
    if (!entry) {
      throw new Error(
        `Server "${name}" is disabled or not defined. Started servers: ${[
          ...this.serverEntries.keys(),
        ].join(", ") || "none"}`,
      );
    }
    return entry;
  }

  requireProfileServerEntry(profileName, serverName) {
    const profileEntries = this.getProfileEntries(profileName);
    const entry = profileEntries.get(serverName);
    if (!entry) {
      throw new Error(
        `Server "${serverName}" is not part of profile "${profileName}". Allowed servers: ${[
          ...profileEntries.keys(),
        ].join(", ") || "none"}`,
      );
    }
    return entry;
  }

  getProfileEntries(profileName = this.defaultProfileName) {
    let entries = this.profileEntries.get(profileName);
    if (!entries) {
      entries = normalizePreset(profileName, this.serversConfig, this.presetsConfig, this.jsmcpConfig);
      this.profileEntries.set(profileName, entries);
    }
    return entries;
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
    this.logsBySession.clear();
    await Promise.allSettled(servers.map((server) => closeClient(server.client)));
  }

  getSessionLogs(sessionId) {
    const key = getLogSessionKey(sessionId);
    let logs = this.logsBySession.get(key);

    if (!logs) {
      logs = [];
      this.logsBySession.set(key, logs);
    }

    return logs;
  }
}

function createClientTransport(serverName, serverConfig, authStore) {
  if (serverConfig.type === "local") {
    return new StdioClientTransport({
      command: serverConfig.command[0],
      args: serverConfig.command.slice(1),
      env: {
        ...getDefaultEnvironment(),
        ...(serverConfig.environment ?? {}),
      },
      cwd: serverConfig.cwd,
      stderr: "pipe",
    });
  }

  const requestInit = serverConfig.headers ? { headers: serverConfig.headers } : undefined;
  const authProvider = createRemoteAuthProvider(serverName, serverConfig, authStore, {
    mode: "startup",
  });

  if (serverConfig.transport === "sse") {
    return new SSEClientTransport(new URL(serverConfig.url), { requestInit, authProvider });
  }

  return new StreamableHTTPClientTransport(new URL(serverConfig.url), { requestInit, authProvider });
}

function createTransportStderrCapture(serverName, serverConfig, transport) {
  if (serverConfig.type !== "local" || !transport.stderr) {
    return null;
  }

  const chunks = [];
  let totalLength = 0;
  const maxLength = 32000;

  transport.stderr.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    process.stderr.write(text);
    chunks.push(text);
    totalLength += text.length;

    while (totalLength > maxLength && chunks.length > 0) {
      const removed = chunks.shift();
      totalLength -= removed.length;
    }
  });

  transport.stderr.on("error", (error) => {
    console.error(`[${SERVER_NAME}] stderr capture error from ${serverName}: ${getErrorMessage(error)}`);
  });

  return {
    getText() {
      const text = chunks.join("").trim();
      return text || undefined;
    },
  };
}

function buildStartError(serverName, error, stderr) {
  const startError = {
    message: `Failed to start "${serverName}": ${getErrorMessage(error)}`,
  };

  if (stderr) {
    startError.stderr = stderr;
  }

  return startError;
}

function normalizeToolNames(serverName, tools, serverConfig) {
  const stripToolPrefix = serverConfig.stripToolPrefix ?? inferToolPrefix(tools, serverConfig.inferToolPrefix);
  const normalizedTools = tools.map((tool) => {
    const strippedName = stripToolName(tool.name, stripToolPrefix);
    const name = serverConfig.normalizeToolNames ? snakeCase(strippedName) : strippedName;
    return name === tool.name ? tool : { ...tool, name, originalName: tool.name };
  });
  const names = new Set();

  for (const tool of normalizedTools) {
    if (!tool.name) {
      throw new Error(`Server "${serverName}" produced an empty tool name after strip_tool_prefix.`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Server "${serverName}" has duplicate tool name "${tool.name}" after strip_tool_prefix.`);
    }
    names.add(tool.name);
  }

  return normalizedTools;
}

function inferToolPrefix(tools, enabled) {
  if (!enabled || tools.length < 2) {
    return undefined;
  }

  const commonPrefix = getCommonPrefix(tools.map((tool) => tool.name));
  const separatorIndex = Math.max(
    commonPrefix.lastIndexOf("-"),
    commonPrefix.lastIndexOf("_"),
    commonPrefix.lastIndexOf("."),
    commonPrefix.lastIndexOf(":"),
  );

  if (separatorIndex < 1) {
    return undefined;
  }

  const prefix = commonPrefix.slice(0, separatorIndex + 1);
  const strippedNames = tools.map((tool) => tool.name.slice(prefix.length));
  if (strippedNames.some((name) => !name)) {
    return undefined;
  }
  if (new Set(strippedNames).size !== strippedNames.length) {
    return undefined;
  }

  return prefix;
}

function getCommonPrefix(values) {
  let prefix = values[0] ?? "";

  for (const value of values.slice(1)) {
    while (prefix && !value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }

  return prefix;
}

function stripToolName(toolName, stripToolPrefix) {
  if (!stripToolPrefix || !toolName.startsWith(stripToolPrefix)) {
    return toolName;
  }

  return toolName.slice(stripToolPrefix.length);
}

function filterTools(tools, toolPolicy) {
  const filtered =
    toolPolicy.mode === "all"
      ? tools
      : tools.filter((tool) => matchesToolPolicy(toolPolicy, tool.name));

  return sortTools(filtered);
}

function sortTools(tools) {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
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

function isToolAllowed(toolPolicy, toolName) {
  return toolPolicy.mode === "all" || matchesToolPolicy(toolPolicy, toolName);
}

function matchesToolPolicy(toolPolicy, toolName) {
  return toolPolicy.selectors.some((selector) => matchesToolSelector(selector, toolName));
}

function matchesToolSelector(selector, toolName) {
  if (selector.type === "exact") {
    return selector.value === toolName;
  }

  return selector.matcher.test(toolName);
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

function getLogSessionKey(sessionId) {
  return sessionId ?? DEFAULT_LOG_SESSION;
}

function createCapturedConsole(runtime, sessionId) {
  const write = (level, values) => runtime.appendLog(level, values, sessionId);

  return {
    log: (...values) => write("log", values),
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values),
  };
}
