import { randomUUID } from "node:crypto";

import { DEFAULT_OAUTH_CALLBACK_URL } from "./constants.js";

class AuthRequiredError extends Error {
  constructor(serverName) {
    super(`OAuth authorization required for server "${serverName}". Run "jsmcp auth ${serverName}" and try again.`);
    this.name = "AuthRequiredError";
  }
}

class PersistentOAuthProvider {
  constructor({ serverName, serverConfig, authStore, redirectUrl, mode, onRedirect }) {
    this.serverName = serverName;
    this.serverConfig = serverConfig;
    this.authStore = authStore;
    this._redirectUrl = redirectUrl;
    this.mode = mode;
    this.onRedirect = onRedirect;
    this._oauthConfig = serverConfig.oauth || { enabled: true };
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: `jsmcp ${this.serverName}`,
      redirect_uris: [String(this._redirectUrl)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this._oauthConfig.clientSecret ? "client_secret_post" : "none",
      scope: this._oauthConfig.scope,
    };
  }

  async state() {
    return randomUUID();
  }

  async clientInformation() {
    if (this._oauthConfig.clientId) {
      return {
        client_id: this._oauthConfig.clientId,
        client_secret: this._oauthConfig.clientSecret,
      };
    }

    const state = await this.authStore.getServerState(this.serverName);
    return state.clientInformation;
  }

  async saveClientInformation(clientInformation) {
    await this.authStore.updateServerState(this.serverName, (state) => ({
      ...state,
      clientInformation,
      redirectUrl: String(this._redirectUrl),
    }));
  }

  async tokens() {
    const state = await this.authStore.getServerState(this.serverName);
    return state.tokens;
  }

  async saveTokens(tokens) {
    await this.authStore.updateServerState(this.serverName, (state) => ({
      ...state,
      tokens,
      redirectUrl: String(this._redirectUrl),
    }));
  }

  async redirectToAuthorization(authorizationUrl) {
    if (this.mode === "startup") {
      throw new AuthRequiredError(this.serverName);
    }

    if (this.onRedirect) {
      await this.onRedirect(authorizationUrl);
    }
  }

  async saveCodeVerifier(codeVerifier) {
    await this.authStore.updateServerState(this.serverName, (state) => ({
      ...state,
      codeVerifier,
      redirectUrl: String(this._redirectUrl),
    }));
  }

  async codeVerifier() {
    const state = await this.authStore.getServerState(this.serverName);
    if (!state.codeVerifier) {
      throw new Error(`No code verifier saved for server "${this.serverName}".`);
    }
    return state.codeVerifier;
  }

  async saveDiscoveryState(discoveryState) {
    await this.authStore.updateServerState(this.serverName, (state) => ({
      ...state,
      discoveryState,
      redirectUrl: String(this._redirectUrl),
    }));
  }

  async discoveryState() {
    const state = await this.authStore.getServerState(this.serverName);
    return state.discoveryState;
  }

  async invalidateCredentials(scope) {
    await this.authStore.updateServerState(this.serverName, (state) => {
      const nextState = { ...state };

      if (scope === "all") {
        if (!this._oauthConfig.clientId) {
          delete nextState.clientInformation;
        }
        delete nextState.tokens;
        delete nextState.codeVerifier;
        delete nextState.discoveryState;
        return nextState;
      }

      if (scope === "client" && !this._oauthConfig.clientId) {
        delete nextState.clientInformation;
      }
      if (scope === "tokens") {
        delete nextState.tokens;
      }
      if (scope === "verifier") {
        delete nextState.codeVerifier;
      }
      if (scope === "discovery") {
        delete nextState.discoveryState;
      }

      return nextState;
    });
  }
}

export function createRemoteAuthProvider(serverName, serverConfig, authStore, { mode, onRedirect }) {
  if (serverConfig.type !== "remote" || serverConfig.oauth === false) {
    return undefined;
  }

  return new PersistentOAuthProvider({
    serverName,
    serverConfig,
    authStore,
    redirectUrl: DEFAULT_OAUTH_CALLBACK_URL,
    mode,
    onRedirect,
  });
}
