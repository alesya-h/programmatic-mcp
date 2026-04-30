import { randomUUID } from "node:crypto";

import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";

export class WebSocketServerTransport {
  constructor(socket, sessionId) {
    this.socket = socket;
    this.sessionId = sessionId ?? randomUUID();
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
