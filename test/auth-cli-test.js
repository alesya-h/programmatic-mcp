#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const entryPath = path.join(projectRoot, "src", "index.js");

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "jsmcp-auth-"));
const configHome = path.join(tempRoot, "config-home");
const dataHome = path.join(tempRoot, "data-home");

try {
  await mkdir(path.join(configHome, "jsmcp"), { recursive: true });
  await mkdir(path.join(dataHome, "jsmcp"), { recursive: true });

  await writeFile(
    path.join(configHome, "jsmcp", "config.json"),
    JSON.stringify(
      {
        servers: {
          docs: {
            type: "remote",
            description: "Documentation server",
            url: "https://example.com/mcp",
          },
          private_docs: {
            type: "remote",
            description: "Private documentation server",
            url: "https://private.example.com/mcp",
            oauth: {
              scope: "docs.read",
            },
          },
          public_docs: {
            type: "remote",
            url: "https://public.example.com/mcp",
            oauth: false,
          },
        },
        presets: {
          default: {
            servers: {
              docs: true,
              private_docs: true,
              public_docs: true,
            },
          },
        },
      },
      null,
      2,
    ),
  );

  await writeFile(
    path.join(dataHome, "jsmcp", "oauth.json"),
    JSON.stringify(
      {
        version: 1,
        servers: {
          private_docs: {
            tokens: {
              access_token: "token",
              token_type: "Bearer",
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
  };

  const { stdout } = await execFileAsync("node", [entryPath, "auth"], { env });

  assert.match(stdout, /docs: Documentation server/);
  assert.match(stdout, /status: needs_auth/);
  assert.match(stdout, /private_docs: Private documentation server/);
  assert.match(stdout, /status: authorized/);
  assert.doesNotMatch(stdout, /public_docs/);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
