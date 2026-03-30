#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const fixtureServerPath = path.join(projectRoot, "test", "fixtures", "arithmetic-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "programmatic-mcp-"));

try {
  await mkdir(path.join(tempConfigHome, "programmatic-mcp"), { recursive: true });
  await writeFile(
    path.join(tempConfigHome, "programmatic-mcp", "config.json"),
    JSON.stringify(
      {
        servers: {
          math: {
            type: "local",
            command: ["node", fixtureServerPath],
            timeout: 5000,
          },
        },
        presets: {
          default: {
            servers: {
              math: {
                tools: ["add", "repeat-text"],
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  );
  env.XDG_CONFIG_HOME = tempConfigHome;

  const client = new Client({
    name: "smoke-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [metaServerPath],
    env,
    stderr: "inherit",
  });

  try {
    await client.connect(transport);

    const listResult = await client.callTool({ name: "list_servers", arguments: {} });
    assert.equal(listResult.isError, undefined);
    assert.equal(listResult.structuredContent.preset, "default");
    assert.equal(listResult.structuredContent.servers.length, 1);
    assert.equal(listResult.structuredContent.servers[0].name, "math");
    assert.equal(listResult.structuredContent.servers[0].started, true);
    assert.deepEqual(listResult.structuredContent.servers[0].allowedTools, ["add", "repeat-text"]);
    assert.deepEqual(
      listResult.structuredContent.servers[0].availableTools.map((tool) => tool.name),
      ["add", "repeat-text"],
    );
    assert.equal(listResult.structuredContent.servers[0].availableTools[1].alias, "repeat_text");

    const toolListResult = await client.callTool({
      name: "list_tools",
      arguments: { server: "math" },
    });
    assert.equal(toolListResult.isError, undefined);
    assert.equal(toolListResult.structuredContent.server, "math");
    assert.deepEqual(toolListResult.structuredContent.tools.map((tool) => tool.name), ["add", "repeat-text"]);
    assert.equal(toolListResult.structuredContent.tools[1].alias, "repeat_text");
    assert.match(toolListResult.content[0].text, /inputSchema/);
    assert.match(toolListResult.content[0].text, /repeat_text/);

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
        code: 'return await math.repeat_text({ text: "x", times: 3 });',
      },
    });
    assert.equal(aliasResult.isError, undefined);
    assert.deepEqual(aliasResult.structuredContent, { value: "xxx" });

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
  } finally {
    await client.close();
  }
} finally {
  await rm(tempConfigHome, { recursive: true, force: true });
}
