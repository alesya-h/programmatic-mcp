import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import { WebSocketServer } from "ws";

import { apiKeysEqual, loadOrCreateApiKey } from "../api-key.js";
import {
  API_KEY_HEADER,
  DEFAULT_BIND_HOST,
  DEFAULT_CODE_TIMEOUT_MS,
  DEFAULT_PROXY_PATH,
  SERVER_NAME,
  SESSION_ID_PATTERN,
} from "../constants.js";
import { createMetaServer } from "../meta-server.js";
import {
  formatExecutionValue,
  renderClearLogsText,
  renderLogsText,
  renderServerListText,
  renderToolListText,
} from "../rendering.js";
import { MetaMcpRuntime } from "../runtime.js";
import { getErrorMessage } from "../utils.js";
import { WebSocketServerTransport } from "./websocket-server-transport.js";

const MCP_SUBPROTOCOL = "mcp";

export async function runProxyServer({ presetName, port, bindHost = DEFAULT_BIND_HOST }) {
  const apiKey = await loadOrCreateApiKey();
  const runtime = await MetaMcpRuntime.load(presetName);
  runtime.validateProfile(presetName);
  await runtime.startAllServers();

  const sessions = new Set();
  const httpServer = createHttpServer((request, response) => {
    void handleHttpRequest(request, response, runtime, apiKey, presetName).catch((error) => {
      writeJson(response, 500, {
        error: `Internal server error: ${getErrorMessage(error)}`,
      });
    });
  });
  const wsServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(MCP_SUBPROTOCOL) ? MCP_SUBPROTOCOL : false;
    },
  });
  let shuttingDown = false;

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

    if (!isAuthorized(request, apiKey)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    if (requestUrl.pathname !== DEFAULT_PROXY_PATH) {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }

    const requestedProfile = requestUrl.searchParams.get("profile") ?? presetName;
    try {
      runtime.validateProfile(requestedProfile);
    } catch (error) {
      rejectUpgrade(socket, 400, getErrorMessage(error));
      return;
    }

    const requestedSessionId = requestUrl.searchParams.get("sessionId") ?? undefined;
    if (requestedSessionId !== undefined && !SESSION_ID_PATTERN.test(requestedSessionId)) {
      rejectUpgrade(socket, 400, "Invalid sessionId query parameter.");
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request, requestedSessionId, requestedProfile);
    });
  });

  wsServer.on("connection", async (socket, _request, sessionId, profileName) => {
    const transport = new WebSocketServerTransport(socket, sessionId);
    const server = await createMetaServer(runtime, profileName);
    const session = { server, transport };
    sessions.add(session);

    server.server.onerror = (error) => {
      console.error(`[${SERVER_NAME}] proxy session error: ${getErrorMessage(error)}`);
    };

    server.server.onclose = () => {
      sessions.delete(session);
    };

    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(session);
      console.error(`[${SERVER_NAME}] failed to start proxy session: ${getErrorMessage(error)}`);
      await transport.close().catch(() => null);
    }
  });

  wsServer.on("error", (error) => {
    console.error(`[${SERVER_NAME}] websocket server error: ${getErrorMessage(error)}`);
  });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await Promise.allSettled([
      ...[...sessions].map((session) => session.server.close()),
      closeWebSocketServer(wsServer),
      closeHttpServer(httpServer),
      runtime.close(),
    ]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await listen(httpServer, port, bindHost);
  console.error(
    `[${SERVER_NAME}] server listening on ws://${formatHostForUrl(bindHost)}:${port}${DEFAULT_PROXY_PATH} with default profile "${presetName}"`,
  );
}

async function handleHttpRequest(request, response, runtime, apiKey, presetName) {
  if (!isAuthorized(request, apiKey)) {
    writeJson(response, 401, { error: "Unauthorized" });
    return;
  }

  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname === DEFAULT_PROXY_PATH) {
    response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Use WebSocket on /mcp.\n");
    return;
  }

  if (requestUrl.pathname !== "/api/call") {
    writeJson(response, 404, { error: "Not found" });
    return;
  }

  const profileName = requestUrl.searchParams.get("profile") ?? presetName;
  try {
    runtime.validateProfile(profileName);
  } catch (error) {
    writeJson(response, 400, { error: getErrorMessage(error) });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "Use POST." });
    return;
  }

  const toolName = requestUrl.searchParams.get("tool");
  let sessionId;
  try {
    sessionId = validateOptionalSessionId(requestUrl.searchParams.get("sessionId") ?? undefined);
  } catch (error) {
    writeJson(response, 400, { error: getErrorMessage(error) });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    writeJson(response, 400, { error: getErrorMessage(error) });
    return;
  }

  if (toolName === "list_servers") {
    const structuredContent = { servers: await runtime.listServers(profileName) };
    writeJson(response, 200, {
      content: [{ type: "text", text: renderServerListText(structuredContent) }],
      structuredContent,
    });
    return;
  }

  if (toolName === "list_tools") {
    if (typeof body.server !== "string" || !body.server) {
      writeJson(response, 400, { error: 'Field "server" is required.' });
      return;
    }

    const structuredContent = { server: body.server, tools: await runtime.listTools(body.server, profileName) };
    writeJson(response, 200, {
      content: [{ type: "text", text: renderToolListText(structuredContent) }],
      structuredContent,
    });
    return;
  }

  if (toolName === "execute_code") {
    if (typeof body.code !== "string" || !body.code) {
      writeJson(response, 400, { error: 'Field "code" is required.' });
      return;
    }

    try {
      const timeoutMs = validateOptionalTimeoutMs(body.timeoutMs);
      const value = await runtime.executeCode(body.code, timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS, sessionId, body.data, profileName);
      const structuredContent = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
      writeJson(response, 200, {
        content: [{ type: "text", text: formatExecutionValue(structuredContent) }],
        structuredContent,
      });
    } catch (error) {
      writeJson(response, 200, {
        content: [{ type: "text", text: getErrorMessage(error) }],
        structuredContent: { error: getErrorMessage(error) },
        isError: true,
      });
    }
    return;
  }

  if (toolName === "fetch_logs") {
    const structuredContent = { logs: runtime.fetchLogs(sessionId) };
    writeJson(response, 200, {
      content: [{ type: "text", text: renderLogsText(structuredContent) }],
      structuredContent,
    });
    return;
  }

  if (toolName === "clear_logs") {
    const structuredContent = { cleared: runtime.clearLogs(sessionId) };
    writeJson(response, 200, {
      content: [{ type: "text", text: renderClearLogsText(structuredContent) }],
      structuredContent,
    });
    return;
  }

  writeJson(response, 400, { error: 'Query parameter "tool" must be one of: list_servers, list_tools, execute_code, fetch_logs, clear_logs.' });
}

function isAuthorized(request, apiKey) {
  const value = request.headers[API_KEY_HEADER];
  const provided = Array.isArray(value) ? value[0] : value;
  return apiKeysEqual(provided, apiKey);
}

async function readJsonBody(request) {
  const chunks = [];
  let totalLength = 0;
  const maxLength = 1024 * 1024;

  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > maxLength) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }

  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Request body must be a JSON object.");
    }
    return value;
  } catch (error) {
    throw new Error(`Invalid JSON request body: ${getErrorMessage(error)}`);
  }
}

function validateOptionalSessionId(sessionId) {
  if (sessionId === undefined || sessionId === null) {
    return undefined;
  }

  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Query parameter "sessionId" must be 1-128 URL-safe characters.');
  }

  return sessionId;
}

function validateOptionalTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) {
    return undefined;
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new Error('Field "timeoutMs" must be an integer from 1 to 300000.');
  }

  return timeoutMs;
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${getStatusText(statusCode)}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`,
  );
  socket.destroy();
}

function getStatusText(statusCode) {
  if (statusCode === 404) {
    return "Not Found";
  }

  if (statusCode === 409) {
    return "Conflict";
  }

  if (statusCode === 401) {
    return "Unauthorized";
  }

  if (statusCode === 400) {
    return "Bad Request";
  }

  if (statusCode === 426) {
    return "Upgrade Required";
  }

  return "Error";
}

async function listen(server, port, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function closeHttpServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function closeWebSocketServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}
