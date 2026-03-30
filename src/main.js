import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { handleAuthCommand } from "./auth.js";
import { DEFAULT_PRESET, SERVER_NAME } from "./constants.js";
import { createMetaServer } from "./meta-server.js";
import { MetaMcpRuntime } from "./runtime.js";

export async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "auth") {
    await handleAuthCommand(args.slice(1));
    return;
  }

  if (args.length > 1) {
    throw new Error(`Usage: ${SERVER_NAME} [preset]`);
  }

  const presetName = args[0] || DEFAULT_PRESET;
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
