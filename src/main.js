import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { handleAuthCommand } from "./auth.js";
import { DEFAULT_PRESET, DEFAULT_PROXY_PORT, SERVER_NAME } from "./constants.js";
import { createMetaServer } from "./meta-server.js";
import { runProxyClient, runProxyServer } from "./proxy.js";
import { MetaMcpRuntime } from "./runtime.js";

const RUN_COMMANDS = new Set(["run", "server", "client"]);

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    throw new Error(getMainUsage());
  }

  if (command === "auth") {
    await handleAuthCommand(args.slice(1));
    return;
  }

  if (!RUN_COMMANDS.has(command)) {
    throw new Error(`Unknown command \"${command}\".\n${getMainUsage()}`);
  }

  const options = parseRunCommandArgs(command, args.slice(1));

  if (command === "run") {
    await runMetaServer(options.presetName);
    return;
  }

  if (command === "server") {
    await runProxyServer({ presetName: options.presetName, port: options.port });
    return;
  }

  await runProxyClient({
    port: options.port,
    requestedProfile: options.profileProvided ? options.presetName : undefined,
  });
}

async function runMetaServer(presetName) {
  const runtime = await MetaMcpRuntime.load(presetName);
  await runtime.startAllServers();
  const server = await createMetaServer(runtime);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await Promise.allSettled([server.close(), runtime.close()]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ready with preset "${presetName}"`);
}

function parseRunCommandArgs(command, args) {
  let presetName = DEFAULT_PRESET;
  let profileProvided = false;
  let port = DEFAULT_PROXY_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --profile.\n${getRunUsage(command)}`);
      }
      if (profileProvided) {
        throw new Error(`Profile specified more than once.\n${getRunUsage(command)}`);
      }
      presetName = value;
      profileProvided = true;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --port.\n${getRunUsage(command)}`);
      }

      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port \"${value}\".\n${getRunUsage(command)}`);
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option \"${argument}\".\n${getRunUsage(command)}`);
    }

    if (profileProvided) {
      throw new Error(`Profile specified more than once.\n${getRunUsage(command)}`);
    }

    presetName = argument;
    profileProvided = true;
  }

  return { port, presetName, profileProvided };
}

function getMainUsage() {
  return [
    `Usage: ${SERVER_NAME} <command> [options]`,
    `Commands: auth, run, server, client`,
    `Run commands accept [profile] [--profile <name>] [--port <number>]`,
  ].join("\n");
}

function getRunUsage(command) {
  return `Usage: ${SERVER_NAME} ${command} [profile] [--profile <name>] [--port <number>]`;
}
