import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import { WebSocketServer } from "ws";

import { DEFAULT_PROXY_PATH, SERVER_NAME, SESSION_ID_PATTERN } from "../constants.js";
import { createMetaServer } from "../meta-server.js";
import { MetaMcpRuntime } from "../runtime.js";
import { getErrorMessage } from "../utils.js";
import { WebSocketServerTransport } from "./websocket-server-transport.js";

const MCP_SUBPROTOCOL = "mcp";

export async function runProxyServer({ presetName, port }) {
  const runtime = await MetaMcpRuntime.load(presetName);
  await runtime.startAllServers();

  const sessions = new Set();
  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Use WebSocket on /mcp.\n");
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

    if (requestUrl.pathname !== DEFAULT_PROXY_PATH) {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }

    const requestedProfile = requestUrl.searchParams.get("profile");
    if (requestedProfile && requestedProfile !== presetName) {
      rejectUpgrade(socket, 409, `Profile mismatch. Server is running preset \"${presetName}\".`);
      return;
    }

    const requestedSessionId = requestUrl.searchParams.get("sessionId") ?? undefined;
    if (requestedSessionId !== undefined && !SESSION_ID_PATTERN.test(requestedSessionId)) {
      rejectUpgrade(socket, 400, "Invalid sessionId query parameter.");
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request, requestedSessionId);
    });
  });

  wsServer.on("connection", async (socket, _request, sessionId) => {
    const transport = new WebSocketServerTransport(socket, sessionId);
    const server = await createMetaServer(runtime);
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

  await listen(httpServer, port);
  console.error(
    `[${SERVER_NAME}] server listening on ws://127.0.0.1:${port}${DEFAULT_PROXY_PATH} with preset "${presetName}"`,
  );
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

  if (statusCode === 400) {
    return "Bad Request";
  }

  if (statusCode === 426) {
    return "Upgrade Required";
  }

  return "Error";
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
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
