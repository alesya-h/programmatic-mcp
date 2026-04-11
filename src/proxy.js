import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";

import { DEFAULT_PROXY_PATH, SERVER_NAME } from "./constants.js";
import { createMetaServer } from "./meta-server.js";
import { MetaMcpRuntime } from "./runtime.js";
import { getErrorMessage } from "./utils.js";

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

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  });

  wsServer.on("connection", async (socket) => {
    const transport = new WebSocketServerTransport(socket);
    const server = await createMetaServer(runtime);
    const session = { server, transport };
    sessions.add(session);

    server.server.onerror = (error) => {
      console.error(`[${SERVER_NAME}] proxy session error: ${getErrorMessage(error)}`);
    };

    server.server.onclose = () => {
      sessions.delete(session);
      runtime.dropSession(transport.sessionId);
    };

    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(session);
      runtime.dropSession(transport.sessionId);
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

export async function runProxyClient({ port, requestedProfile }) {
  const wsUrl = new URL(`ws://127.0.0.1:${port}${DEFAULT_PROXY_PATH}`);
  if (requestedProfile) {
    wsUrl.searchParams.set("profile", requestedProfile);
  }

  const localTransport = new StdioServerTransport();
  const remoteTransport = new WebSocketClientTransport(wsUrl);

  await bridgeTransports(localTransport, remoteTransport, {
    onReady() {
      console.error(`[${SERVER_NAME}] client connected to ${wsUrl}`);
    },
    onClose() {
      process.stdin.pause();
    },
  });
}

class WebSocketServerTransport {
  constructor(socket) {
    this.socket = socket;
    this.sessionId = randomUUID();
    this.started = false;
    this.closed = false;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.handleMessage = (data, isBinary) => {
      if (isBinary) {
        this.onerror?.(new Error("Binary WebSocket messages are not supported."));
        return;
      }

      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const message = JSONRPCMessageSchema.parse(JSON.parse(raw));
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.handleClose = () => {
      if (this.closed) {
        return;
      }

      this.closed = true;
      this.socket.off("message", this.handleMessage);
      this.socket.off("close", this.handleClose);
      this.socket.off("error", this.handleError);
      this.resolveClosed();
      this.onclose?.();
    };
    this.handleError = (error) => {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    };
  }

  async start() {
    if (this.started) {
      throw new Error(
        "WebSocketServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this.started = true;
    this.socket.on("message", this.handleMessage);
    this.socket.on("close", this.handleClose);
    this.socket.on("error", this.handleError);
  }

  async send(message) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open.");
    }

    await new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async close() {
    if (this.closed) {
      return;
    }

    if (this.socket.readyState === WebSocket.CLOSED) {
      this.handleClose();
      return;
    }

    this.socket.close();
    await this.closedPromise;
  }
}

async function bridgeTransports(left, right, { onReady, onClose }) {
  let closing = false;
  let resolveFinished;
  let rejectFinished;
  const finished = new Promise((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const closeBoth = async () => {
    if (closing) {
      return;
    }

    closing = true;
    await Promise.allSettled([left.close(), right.close()]);
    onClose?.();
    resolveFinished();
  };

  const fail = (error) => {
    if (closing) {
      return;
    }

    rejectFinished(error instanceof Error ? error : new Error(String(error)));
    void closeBoth();
  };

  left.onmessage = (message) => {
    void right.send(message).catch(fail);
  };
  right.onmessage = (message) => {
    void left.send(message).catch(fail);
  };
  left.onerror = fail;
  right.onerror = fail;
  left.onclose = () => {
    void closeBoth();
  };
  right.onclose = () => {
    void closeBoth();
  };

  process.stdin.on("end", () => {
    void closeBoth();
  });
  process.stdin.on("close", () => {
    void closeBoth();
  });

  try {
    await right.start();
    await left.start();
    onReady?.();
  } catch (error) {
    fail(error);
  }

  await finished;
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
