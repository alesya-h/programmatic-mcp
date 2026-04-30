import process from "node:process";
import { randomUUID } from "node:crypto";

import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DEFAULT_PROXY_PATH, SERVER_NAME } from "../constants.js";
import { getErrorMessage } from "../utils.js";
import {
  classifyRequest,
  cloneMessage,
  createCapabilityChangeErrorResponse,
  createDisconnectErrorResponse,
  createInternalRequest,
  createRequestFailureResponse,
  diffListServers,
  diffListTools,
  isInitializeRequest,
  isInitializedNotification,
  isRequest,
  isResponse,
  isResponseForId,
} from "./messages.js";

export async function runProxyClient({ port, requestedProfile, sessionId }) {
  const wsUrl = new URL(`ws://127.0.0.1:${port}${DEFAULT_PROXY_PATH}`);
  if (requestedProfile) {
    wsUrl.searchParams.set("profile", requestedProfile);
  }
  wsUrl.searchParams.set("sessionId", sessionId ?? randomUUID());

  const proxyClient = new ReconnectingProxyClient(wsUrl);
  await proxyClient.start();
}

class ReconnectingProxyClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.localTransport = new StdioServerTransport();
    this.remoteTransport = null;
    this.localClosed = false;
    this.closing = false;
    this.pendingRequests = new Map();
    this.internalRequests = new Map();
    this.restoreInitializeRequest = null;
    this.restoreInitializedNotification = null;
    this.cachedListServers = null;
    this.cachedListTools = new Map();
    this.pendingCapabilityChange = null;
    this.connectPromise = null;
    this.restorePromise = null;
    this.restoreResolver = null;
    this.restoreRejecter = null;
    this.queue = Promise.resolve();
    this.hasConnected = false;
  }

  async start() {
    this.localTransport.onmessage = (message) => {
      this.queue = this.queue
        .then(() => this.handleLocalMessage(message))
        .catch((error) => this.handleLocalMessageFailure(message, error));
    };
    this.localTransport.onerror = (error) => this.fail(error);
    this.localTransport.onclose = () => {
      this.localClosed = true;
      void this.close();
    };

    process.stdin.on("end", () => {
      this.localClosed = true;
      void this.close();
    });
    process.stdin.on("close", () => {
      this.localClosed = true;
      void this.close();
    });

    await this.localTransport.start();
    await this.ensureRemoteReady();
    await new Promise(() => {});
  }

  async handleLocalMessageFailure(message, error) {
    if (isRequest(message)) {
      await this.localTransport.send(createRequestFailureResponse(message.id, classifyRequest(message), error));
      return;
    }

    this.fail(error);
  }

  async handleLocalMessage(message) {
    if (isInitializeRequest(message)) {
      this.restoreInitializeRequest = message;
    } else if (isInitializedNotification(message)) {
      this.restoreInitializedNotification = message;
    }

    const requestInfo = isRequest(message) ? classifyRequest(message) : null;

    await this.ensureRemoteReady();

    if (requestInfo?.kind === "execute_code" && this.pendingCapabilityChange) {
      const change = this.pendingCapabilityChange;
      this.pendingCapabilityChange = null;
      await this.localTransport.send(createCapabilityChangeErrorResponse(message.id, change));
      return;
    }

    if (requestInfo) {
      this.pendingRequests.set(message.id, requestInfo);
    }

    try {
      await this.remoteTransport.send(message);
    } catch (error) {
      if (isRequest(message)) {
        this.pendingRequests.delete(message.id);
      }
      throw error;
    }
  }

  async ensureRemoteReady() {
    if (this.remoteTransport) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connectRemote();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectRemote() {
    const transport = new WebSocketClientTransport(this.wsUrl);
    transport.onmessage = (message) => {
      void this.handleRemoteMessage(message).catch((error) => this.fail(error));
    };
    transport.onerror = (error) => {
      if (!this.closing) {
        console.error(`[${SERVER_NAME}] proxy client transport error: ${getErrorMessage(error)}`);
      }
    };
    transport.onclose = () => {
      this.handleRemoteClose();
    };

    await transport.start();
    this.remoteTransport = transport;

    if (!this.hasConnected) {
      this.hasConnected = true;
      console.error(`[${SERVER_NAME}] client connected to ${this.wsUrl}`);
    } else {
      console.error(`[${SERVER_NAME}] client reconnected to ${this.wsUrl}`);
    }

    if (this.restoreInitializeRequest) {
      await this.restoreRemoteSession();
      await this.refreshDiscoveryCache();
    }
  }

  async restoreRemoteSession() {
    if (!this.restoreInitializeRequest || !this.remoteTransport) {
      return;
    }

    if (this.restorePromise) {
      await this.restorePromise;
      return;
    }

    this.restorePromise = new Promise((resolve, reject) => {
      this.restoreResolver = resolve;
      this.restoreRejecter = reject;
    });

    try {
      await this.remoteTransport.send(this.restoreInitializeRequest);
      await this.restorePromise;

      if (this.restoreInitializedNotification) {
        await this.remoteTransport.send(this.restoreInitializedNotification);
      }
    } finally {
      this.restorePromise = null;
      this.restoreResolver = null;
      this.restoreRejecter = null;
    }
  }

  async handleRemoteMessage(message) {
    if (
      this.restoreInitializeRequest &&
      isResponseForId(message, this.restoreInitializeRequest.id) &&
      this.restorePromise
    ) {
      if (message.error) {
        this.restoreRejecter?.(new Error(message.error.message || "Remote initialize failed during reconnect."));
      } else {
        this.restoreResolver?.();
      }
      return;
    }

    const internalRequest = this.internalRequests.get(message.id);
    if (internalRequest) {
      this.internalRequests.delete(message.id);
      internalRequest.resolve(message);
      return;
    }

    if (isResponse(message)) {
      const request = this.pendingRequests.get(message.id);
      this.pendingRequests.delete(message.id);

      if (request?.kind === "list_servers") {
        this.maybeCacheListServers(request, message);
      } else if (request?.kind === "list_tools") {
        this.maybeCacheListTools(request, message);
      }
    }

    await this.localTransport.send(message);
  }

  handleRemoteClose() {
    const hadRemote = this.remoteTransport !== null;
    this.remoteTransport = null;

    if (!hadRemote || this.closing) {
      return;
    }

    if (this.restoreRejecter) {
      this.restoreRejecter(new Error("Disconnected while restoring MCP session."));
    }

    for (const [id, request] of this.internalRequests) {
      request.reject(new Error("Disconnected while refreshing cached discovery state."));
      this.internalRequests.delete(id);
    }

    if (this.pendingRequests.size > 0) {
      void this.failPendingRequests();
    }
  }

  async failPendingRequests() {
    const pending = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();

    for (const [id, request] of pending) {
      await this.localTransport.send(createDisconnectErrorResponse(id, request));
    }
  }

  fail(error) {
    if (this.closing) {
      return;
    }

    console.error(`[${SERVER_NAME}] proxy client fatal error: ${getErrorMessage(error)}`);
    void this.close();
  }

  async close() {
    if (this.closing) {
      return;
    }

    this.closing = true;
    await Promise.allSettled([this.localTransport.close(), this.remoteTransport?.close()]);
    process.stdin.pause();
    process.exit(0);
  }

  maybeCacheListServers(request, response) {
    if (response.error || !response.result) {
      return;
    }

    this.cachedListServers = {
      request: cloneMessage(request.originalMessage),
      response: cloneMessage(response),
    };
  }

  maybeCacheListTools(request, response) {
    if (response.error || !response.result) {
      return;
    }

    this.cachedListTools.set(request.serverName, {
      request: cloneMessage(request.originalMessage),
      response: cloneMessage(response),
    });
  }

  async refreshDiscoveryCache() {
    const changes = [];

    if (this.cachedListServers) {
      const next = await this.sendInternalRequest(this.cachedListServers.request);
      const diff = diffListServers(this.cachedListServers.response, next);

      if (diff) {
        changes.push(diff);
      }

      this.cachedListServers = {
        request: cloneMessage(this.cachedListServers.request),
        response: cloneMessage(next),
      };
    }

    for (const [serverName, cached] of this.cachedListTools) {
      const next = await this.sendInternalRequest(cached.request);
      const diff = diffListTools(serverName, cached.response, next);

      if (diff) {
        changes.push(diff);
      }

      this.cachedListTools.set(serverName, {
        request: cloneMessage(cached.request),
        response: cloneMessage(next),
      });
    }

    this.pendingCapabilityChange = changes.length > 0 ? { changes } : null;
  }

  async sendInternalRequest(message) {
    const request = createInternalRequest(message);

    const responsePromise = new Promise((resolve, reject) => {
      this.internalRequests.set(request.id, { resolve, reject });
    });

    try {
      await this.remoteTransport.send(request);
      return await responsePromise;
    } catch (error) {
      this.internalRequests.delete(request.id);
      throw error;
    }
  }
}
