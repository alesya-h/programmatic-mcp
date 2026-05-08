import { loadApiKey } from "./api-key.js";
import { API_KEY_HEADER, DEFAULT_CLIENT_HOST, DEFAULT_PRESET, DEFAULT_PROXY_PORT, SERVER_NAME } from "./constants.js";
import { getErrorMessage } from "./utils.js";

export async function handleStatusCommand(args) {
  const options = parseStatusArgs(args);
  const apiKey = await loadApiKey();
  const url = new URL(`http://${formatHostForUrl(options.host)}:${options.port}/api/call`);
  url.searchParams.set("tool", "list_servers");

  if (options.profileProvided) {
    url.searchParams.set("profile", options.profile);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [API_KEY_HEADER]: apiKey,
    },
    body: "{}",
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Status request failed with HTTP ${response.status}: ${body.error ?? body.text ?? response.statusText}`);
  }

  if (Array.isArray(body.structuredContent?.servers)) {
    console.log(formatServerStatus(body.structuredContent.servers));
    return;
  }

  console.log(JSON.stringify(body.structuredContent ?? body, null, 2));
}

function formatServerStatus(servers) {
  return servers
    .map((server) => {
      if (server.ok === true) {
        return `${server.name}: ok`;
      }

      return `${server.name}: error${server.error?.message ? `: ${server.error.message}` : ""}`;
    })
    .join("\n");
}

function parseStatusArgs(args) {
  let host = DEFAULT_CLIENT_HOST;
  let port = DEFAULT_PROXY_PORT;
  let profile = DEFAULT_PRESET;
  let profileProvided = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--host") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --host.\n${getStatusUsage()}`);
      }
      host = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --port.\n${getStatusUsage()}`);
      }

      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port "${value}".\n${getStatusUsage()}`);
      }

      index += 1;
      continue;
    }

    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --profile.\n${getStatusUsage()}`);
      }
      if (profileProvided) {
        throw new Error(`Profile specified more than once.\n${getStatusUsage()}`);
      }
      profile = value;
      profileProvided = true;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option "${argument}".\n${getStatusUsage()}`);
    }

    if (profileProvided) {
      throw new Error(`Profile specified more than once.\n${getStatusUsage()}`);
    }

    profile = argument;
    profileProvided = true;
  }

  return { host, port, profile, profileProvided };
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function getStatusUsage() {
  return `Usage: ${SERVER_NAME} status [profile] [--profile <name>] [--host <host>] [--port <number>]`;
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
