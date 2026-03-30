import { createServer } from "node:http";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";

import { auth } from "@modelcontextprotocol/sdk/client/auth.js";

import { AuthStateStore } from "./auth-store.js";
import {
  DEFAULT_OAUTH_CALLBACK_PORT,
  DEFAULT_OAUTH_CALLBACK_URL,
  SERVER_NAME,
} from "./constants.js";
import { loadResolvedConfig, parseAllServers, resolveAuthStorePath } from "./config.js";
import { createRemoteAuthProvider } from "./oauth-provider.js";
import { getErrorMessage } from "./utils.js";

function detectGraphicalEnvironment() {
  if (process.platform === "win32") {
    return true;
  }

  if (process.platform === "darwin") {
    return true;
  }

  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_CURRENT_DESKTOP);
}

async function tryOpenBrowser(url) {
  const target = String(url);
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [target];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", target];
  } else {
    command = "xdg-open";
    args = [target];
  }

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function createOAuthCallbackServer(port) {
  let resolveCode;
  let rejectCode;
  let settled = false;

  const codePromise = new Promise((resolve, reject) => {
    resolveCode = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    rejectCode = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
  });

  const server = createServer((req, res) => {
    const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname !== "/callback") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    const code = requestUrl.searchParams.get("code");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Authorization failed</h1><p>You can close this tab.</p></body></html>");
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Missing authorization code</h1><p>You can close this tab.</p></body></html>");
      rejectCode(new Error("OAuth callback did not contain an authorization code."));
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body><h1>Authorization complete</h1><p>You can close this tab and return to the terminal.</p></body></html>");
    resolveCode(code);
  });

  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      reject(new Error(`Could not start OAuth callback server on ${DEFAULT_OAUTH_CALLBACK_URL}: ${getErrorMessage(error)}`));
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    url: DEFAULT_OAUTH_CALLBACK_URL,
    waitForCode: () => codePromise,
    close: async () => {
      resolveCode(undefined);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function extractAuthorizationCode(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("No authorization input provided.");
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    const url = new URL(trimmed);
    const error = url.searchParams.get("error");
    if (error) {
      throw new Error(`OAuth authorization failed: ${error}`);
    }
    const code = url.searchParams.get("code");
    if (!code) {
      throw new Error("The callback URL did not contain an authorization code.");
    }
    return code;
  }

  return trimmed;
}

async function waitForAuthorizationCode(callbackServer, allowManualPaste) {
  if (!allowManualPaste) {
    const code = await callbackServer.waitForCode();
    if (!code) {
      throw new Error("OAuth callback server closed before authorization completed.");
    }
    return code;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const manualInput = (async () => {
      while (true) {
        const value = await readline.question("Paste callback URL or authorization code: ");
        if (!value.trim()) {
          continue;
        }
        return extractAuthorizationCode(value);
      }
    })();

    const result = await Promise.race([callbackServer.waitForCode(), manualInput]);
    if (!result) {
      throw new Error("OAuth callback server closed before authorization completed.");
    }
    return result;
  } finally {
    readline.close();
  }
}

function isOAuthServer(serverConfig) {
  return serverConfig.type === "remote" && serverConfig.oauth !== false;
}

async function formatAuthServerList(servers, authStore) {
  const lines = [];

  for (const [name, serverConfig] of servers) {
    const state = await authStore.getServerState(name);
    const status = state.tokens ? "authorized" : "needs_auth";
    lines.push(`- ${name}${serverConfig.description ? `: ${serverConfig.description}` : ""}`);
    lines.push(`  status: ${status}; url: ${serverConfig.url}`);
  }

  if (lines.length === 0) {
    return "No remote servers with OAuth enabled in config.";
  }

  return lines.join("\n");
}

export async function handleAuthCommand(args) {
  const nonOptionArgs = args.filter((arg) => !arg.startsWith("--"));
  const noBrowser = args.includes("--no-browser");

  if (nonOptionArgs.length > 1) {
    throw new Error(`Usage: ${SERVER_NAME} auth [server-name] [--no-browser]`);
  }

  const { serversConfig } = await loadResolvedConfig();
  const allServers = parseAllServers(serversConfig);
  const authServers = new Map([...allServers].filter(([, serverConfig]) => isOAuthServer(serverConfig)));
  const authStore = new AuthStateStore(resolveAuthStorePath());

  const serverName = nonOptionArgs[0];
  if (!serverName) {
    console.log(await formatAuthServerList(authServers, authStore));
    return;
  }

  const serverConfig = authServers.get(serverName);
  if (!serverConfig) {
    throw new Error(`Server "${serverName}" is not a remote server with OAuth enabled.`);
  }

  const callbackServer = await createOAuthCallbackServer(DEFAULT_OAUTH_CALLBACK_PORT);
  let authorizationUrl;
  const shouldOpenBrowser = detectGraphicalEnvironment() && !noBrowser;
  const authProvider = createRemoteAuthProvider(serverName, serverConfig, authStore, {
    mode: "interactive",
    onRedirect: async (url) => {
      authorizationUrl = url;
      if (shouldOpenBrowser) {
        const opened = await tryOpenBrowser(url);
        if (!opened) {
          console.log(`Open this URL in your browser:\n${url}`);
        }
      } else {
        console.log(`Open this URL in your browser:\n${url}`);
      }
    },
  });

  try {
    const result = await auth(authProvider, { serverUrl: serverConfig.url });
    if (result === "AUTHORIZED") {
      console.log(`Already authorized for ${serverName}.`);
      return;
    }

    if (shouldOpenBrowser) {
      console.log(`Waiting for OAuth callback on ${callbackServer.url}...`);
    } else {
      console.log(`Waiting for OAuth callback on ${callbackServer.url}.`);
      console.log("If automatic callback capture is unavailable, paste the callback URL or authorization code here.");
    }

    const authorizationCode = await waitForAuthorizationCode(callbackServer, !shouldOpenBrowser);
    const finalResult = await auth(authProvider, {
      serverUrl: serverConfig.url,
      authorizationCode,
    });

    if (finalResult !== "AUTHORIZED") {
      throw new Error(`Authorization for server "${serverName}" did not complete successfully.`);
    }

    console.log(`Authorized ${serverName}.`);
  } catch (error) {
    if (authorizationUrl && !shouldOpenBrowser) {
      console.error(`Authorization URL: ${authorizationUrl}`);
    }
    throw error;
  } finally {
    await callbackServer.close().catch(() => null);
  }
}
