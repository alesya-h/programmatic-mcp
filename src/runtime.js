import vm from "node:vm";
import { inspect } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { AuthStateStore, createRemoteAuthProvider } from "./auth.js";
import { SERVER_NAME, SERVER_VERSION } from "./constants.js";
import {
  getDiscoveryTimeout,
  loadResolvedConfig,
  normalizePreset,
  resolveAuthStorePath,
} from "./config.js";
import { closeClient, getErrorMessage, toJsonSafe, withTimeout } from "./utils.js";

export class MetaMcpRuntime {
  constructor({ configPath, presetName, serverEntries, authStore }) {
    this.configPath = configPath;
    this.presetName = presetName;
    this.serverEntries = serverEntries;
    this.authStore = authStore;
    this.startedServers = new Map();
    this.pendingStarts = new Map();
    this.startErrors = new Map();
    this.logs = [];
    this.nextLogId = 1;
  }

  static async load(presetName) {
    const { configPath, serversConfig, presetsConfig } = await loadResolvedConfig();
    const presetConfig = presetsConfig[presetName];

    if (presetConfig === undefined) {
      throw new Error(
        `Preset "${presetName}" was not found in ${configPath}. Available presets: ${Object.keys(presetsConfig).join(
          ", ",
        ) || "none"}`,
      );
    }

    return new MetaMcpRuntime({
      configPath,
      presetName,
      serverEntries: normalizePreset(presetName, presetConfig, serversConfig),
      authStore: new AuthStateStore(resolveAuthStorePath()),
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
          : getDiscoveryTimeout(entry.serverConfig),
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
    const transport = createClientTransport(name, entry.serverConfig, this.authStore);
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
      stderr: "inherit",
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
