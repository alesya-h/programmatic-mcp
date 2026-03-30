#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "arithmetic-server",
  version: "1.0.0",
});

server.registerTool(
  "add",
  {
    description: "Add two numbers",
    inputSchema: z.object({
      a: z.number(),
      b: z.number(),
    }),
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);

server.registerTool(
  "repeat",
  {
    description: "Repeat text a number of times",
    inputSchema: z.object({
      text: z.string(),
      times: z.number().int().min(1).max(5),
    }),
  },
  async ({ text, times }) => ({
    content: [{ type: "text", text: text.repeat(times) }],
    structuredContent: { value: text.repeat(times) },
  }),
);

server.registerTool(
  "repeat-text",
  {
    description: "Repeat text with a dashed tool name",
    inputSchema: z.object({
      text: z.string(),
      times: z.number().int().min(1).max(5),
    }),
  },
  async ({ text, times }) => ({
    content: [{ type: "text", text: text.repeat(times) }],
    structuredContent: { value: text.repeat(times) },
  }),
);

server.registerTool(
  "read-env",
  {
    description: "Read an environment variable",
    inputSchema: z.object({
      name: z.string(),
    }),
  },
  async ({ name }) => ({
    content: [{ type: "text", text: process.env[name] ?? "" }],
    structuredContent: { value: process.env[name] ?? null },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
