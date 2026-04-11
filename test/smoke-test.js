#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const fixtureServerPath = path.join(projectRoot, "test", "fixtures", "arithmetic-server.js");
const brokenServerPath = path.join(projectRoot, "test", "fixtures", "broken-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-"));

try {
  await mkdir(path.join(tempConfigHome, "jsmcp"), { recursive: true });

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  );
  env.XDG_CONFIG_HOME = tempConfigHome;
  env.SMOKE_TEST_VALUE = "env-ok";

  await writeConfig({
    servers: {
      math: {
        type: "stdio",
        description: "Arithmetic test server",
        command: "node",
        args: [fixtureServerPath],
        env: {
          TEST_MCP_VALUE: "${SMOKE_TEST_VALUE:-env-ok}",
        },
        timeout: 5000,
      },
      broken: {
        type: "stdio",
        description: "Broken test server",
        command: "node",
        args: [brokenServerPath],
        timeout: 5000,
      },
      hidden: {
        type: "stdio",
        description: "Hidden test server",
        command: "node",
        args: [fixtureServerPath],
        enabled: false,
        timeout: 5000,
      },
    },
  });

  await withClient(env, {}, async (client) => {
    const listResult = await client.callTool({ name: "list_servers", arguments: {} });
    assert.equal(listResult.isError, undefined);
    assert.equal(listResult.structuredContent.servers.length, 2);
    assert.deepEqual(listResult.structuredContent.servers[0], {
      name: "math",
      description: "Arithmetic test server",
      ok: true,
    });
    assert.equal(listResult.structuredContent.servers[1].name, "broken");
    assert.equal(listResult.structuredContent.servers[1].description, "Broken test server");
    assert.match(listResult.structuredContent.servers[1].error.message, /Failed to start "broken"/);
    assert.match(listResult.structuredContent.servers[1].error.stderr, /broken server stderr output/);
    assert.match(listResult.content[0].text, /Arithmetic test server/);
    assert.match(listResult.content[0].text, /ok: true/);
    assert.match(listResult.content[0].text, /Broken test server/);
    assert.match(listResult.content[0].text, /Failed to start/);
    assert.match(listResult.content[0].text, /broken server stderr output/);
    assert.doesNotMatch(listResult.content[0].text, /Hidden test server/);
    assert.doesNotMatch(listResult.content[0].text, /repeat_text/);
    assert.doesNotMatch(listResult.content[0].text, /inputSchema/);

    const toolListResult = await client.callTool({
      name: "list_tools",
      arguments: { server: "math" },
    });
    assert.equal(toolListResult.isError, undefined);
    assert.equal(toolListResult.structuredContent.server, "math");
    assert.deepEqual(
      [...toolListResult.structuredContent.tools.map((tool) => tool.name)].sort(),
      [
        "ConfluenceFetch",
        "IssueLookup",
        "add",
        "foobar_baz_one",
        "foobar_baz_two",
        "kagi_search_fetch",
        "read-env",
        "repeat",
        "repeat-text",
      ].sort(),
    );

    const envResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: 'return await math.read_env({ name: "TEST_MCP_VALUE" });',
      },
    });
    assert.equal(envResult.isError, undefined);
    assert.deepEqual(envResult.structuredContent, { value: "env-ok" });
  });

  await writeConfig({
    servers: {
      math: {
        type: "stdio",
        description: "Arithmetic test server",
        command: "node",
        args: [fixtureServerPath],
        env: {
          TEST_MCP_VALUE: "${SMOKE_TEST_VALUE:-env-ok}",
        },
        timeout: 5000,
      },
      broken: {
        type: "stdio",
        description: "Broken test server",
        command: "node",
        args: [brokenServerPath],
        timeout: 5000,
      },
      hidden: {
        type: "stdio",
        description: "Hidden test server",
        command: "node",
        args: [fixtureServerPath],
        enabled: false,
        timeout: 5000,
      },
    },
    presets: {
      default: {
        math: [
          "add",
          "read-env",
          "kagi_search_fetch",
          { regex: "(Confluence|Issue)" },
          { glob: "foobar_baz_*" },
        ],
        broken: true,
      },
      work: {
        math: [
          "add",
          "read-env",
          "kagi_search_fetch",
          { regex: "(Confluence|Issue)" },
          { glob: "foobar_baz_*" },
        ],
        broken: true,
        hidden: true,
      },
    },
  });

  await withClient(env, { command: "run" }, async (client) => {
    const listResult = await client.callTool({ name: "list_servers", arguments: {} });
    assert.equal(listResult.structuredContent.servers.length, 2);
    assert.deepEqual(
      [...listResult.structuredContent.servers.map((server) => server.name)].sort(),
      ["broken", "math"],
    );

    const toolListResult = await client.callTool({
      name: "list_tools",
      arguments: { server: "math" },
    });
    assert.equal(toolListResult.isError, undefined);
    assert.deepEqual(
      [...toolListResult.structuredContent.tools.map((tool) => tool.name)].sort(),
      [
        "ConfluenceFetch",
        "IssueLookup",
        "add",
        "foobar_baz_one",
        "foobar_baz_two",
        "kagi_search_fetch",
        "read-env",
      ].sort(),
    );
    assert.match(toolListResult.content[0].text, /inputSchema/);
    assert.match(toolListResult.content[0].text, /kagi_search_fetch/);
    assert.match(toolListResult.content[0].text, /"server": "math"/);

    const executeResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: "return await math.add({ a: 2, b: 5 });",
      },
    });
    assert.equal(executeResult.isError, undefined);
    assert.deepEqual(executeResult.structuredContent, { sum: 7 });

    const aliasResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: 'return await math.foobar_baz_one({});',
      },
    });
    assert.equal(aliasResult.isError, undefined);
    assert.deepEqual(aliasResult.structuredContent, { value: "foobar_baz_one" });

    const logResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: 'console.log("hello", { value: 3 }); return await math.add({ a: 1, b: 2 });',
      },
    });
    assert.deepEqual(logResult.structuredContent, { sum: 3 });

    const fetchLogsResult = await client.callTool({ name: "fetch_logs", arguments: {} });
    assert.equal(fetchLogsResult.structuredContent.logs.length, 1);
    assert.equal(fetchLogsResult.structuredContent.logs[0].level, "log");
    assert.match(fetchLogsResult.structuredContent.logs[0].message, /hello/);
    assert.match(fetchLogsResult.content[0].text, new RegExp(fetchLogsResult.structuredContent.logs[0].timestamp));

    const drainedLogsResult = await client.callTool({ name: "fetch_logs", arguments: {} });
    assert.deepEqual(drainedLogsResult.structuredContent.logs, []);

    const blockedToolResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: 'return await math.repeat({ text: "x", times: 2 });',
      },
    });
    assert.equal(blockedToolResult.isError, true);
    assert.match(blockedToolResult.structuredContent.error, /repeat is not a function/);

    const clearLogsResult = await client.callTool({ name: "clear_logs", arguments: {} });
    assert.equal(clearLogsResult.structuredContent.cleared, 0);

    const emptyLogsResult = await client.callTool({ name: "fetch_logs", arguments: {} });
    assert.deepEqual(emptyLogsResult.structuredContent.logs, []);
  });

  const proxyPort = await getAvailablePort();
  await withDaemon(env, { presetName: "work", port: proxyPort }, async () => {
    await withClient(
      env,
      { command: "client", presetName: "work", port: proxyPort, useProfileFlag: true },
      async (client) => {
        const listResult = await client.callTool({ name: "list_servers", arguments: {} });
        assert.deepEqual(
          [...listResult.structuredContent.servers.map((server) => server.name)].sort(),
          ["broken", "hidden", "math"],
        );

        const executeResult = await client.callTool({
          name: "execute_code",
          arguments: {
            code: "return await math.add({ a: 10, b: 4 });",
          },
        });
        assert.deepEqual(executeResult.structuredContent, { sum: 14 });
      },
    );
  });
} finally {
  await rm(tempConfigHome, { recursive: true, force: true });
}

async function writeConfig(config) {
  await writeFile(path.join(tempConfigHome, "jsmcp", "config.json"), JSON.stringify(config, null, 2));
}

async function withClient(env, options, callback) {
  const { command = "run", presetName, port, useProfileFlag = false } = options;
  const profileArgs =
    presetName === undefined
      ? []
      : useProfileFlag
        ? ["--profile", presetName]
        : [presetName];
  const client = new Client({
    name: "smoke-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [metaServerPath, command, ...profileArgs, ...(port ? ["--port", String(port)] : [])],
    env,
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
    await callback(client);
  } finally {
    await client.close();
  }
}

async function withDaemon(env, options, callback) {
  const { presetName, port, useProfileFlag = false } = options;
  const profileArgs =
    presetName === undefined
      ? []
      : useProfileFlag
        ? ["--profile", presetName]
        : [presetName];
  const child = spawn("node", [metaServerPath, "server", ...profileArgs, "--port", String(port)], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readyText = `server listening on ws://127.0.0.1:${port}/mcp`;
  const exitPromise = once(child, "exit");

  try {
    await waitForDaemonReady(child, readyText);
    await callback();
  } finally {
    child.kill("SIGTERM");
    await exitPromise.catch(() => null);
  }
}

async function waitForDaemonReady(child, readyText) {
  let stderr = "";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for daemon startup.\n${stderr}`));
    }, 10000);
    const onData = (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes(readyText)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Daemon exited before it was ready (code=${code}, signal=${signal}).\n${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function getAvailablePort() {
  const server = createNetServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();
    assert(address && typeof address === "object");
    return address.port;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
