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
const brokenServerPath = path.join(projectRoot, "test", "fixtures", "broken-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-"));

try {
  await mkdir(path.join(tempConfigHome, "jsmcp"), { recursive: true });
  await writeFile(
    path.join(tempConfigHome, "jsmcp", "config.json"),
    JSON.stringify(
      {
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
            servers: {
              math: {
                tools: ["add", "repeat-text", "read-env"],
              },
              broken: true,
              hidden: true,
            },
          },
          "with-hidden-override": {
            servers: {
              hidden: {
                enabled: true,
                tools: ["add"],
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
  env.SMOKE_TEST_VALUE = "env-ok";

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
    assert.doesNotMatch(listResult.content[0].text, /Preset:/);

    const toolListResult = await client.callTool({
      name: "list_tools",
      arguments: { server: "math" },
    });
    assert.equal(toolListResult.isError, undefined);
    assert.equal(toolListResult.structuredContent.server, "math");
    assert.deepEqual(toolListResult.structuredContent.tools.map((tool) => tool.name), ["add", "read-env", "repeat-text"]);
    assert.equal(toolListResult.structuredContent.tools[2].alias, "repeat_text");
    assert.match(toolListResult.content[0].text, /inputSchema/);
    assert.match(toolListResult.content[0].text, /repeat_text/);
    assert.match(toolListResult.content[0].text, /"server": "math"/);

    const envResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: 'return await math.read_env({ name: "TEST_MCP_VALUE" });',
      },
    });
    assert.equal(envResult.isError, undefined);
    assert.deepEqual(envResult.structuredContent, { value: "env-ok" });

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
  } finally {
    await client.close();
  }

  const overrideClient = new Client({
    name: "smoke-test-override",
    version: "1.0.0",
  });
  const overrideTransport = new StdioClientTransport({
    command: "node",
    args: [metaServerPath, "with-hidden-override"],
    env,
    stderr: "inherit",
  });

  try {
    await overrideClient.connect(overrideTransport);

    const overrideListResult = await overrideClient.callTool({ name: "list_servers", arguments: {} });
    assert.deepEqual(overrideListResult.structuredContent.servers, [
      {
        name: "hidden",
        description: "Hidden test server",
        ok: true,
      },
    ]);
  } finally {
    await overrideClient.close();
  }
} finally {
  await rm(tempConfigHome, { recursive: true, force: true });
}
