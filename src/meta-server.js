import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DEFAULT_CODE_TIMEOUT_MS, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import {
  formatExecutionValue,
  renderClearLogsText,
  renderLogsText,
  renderServerListText,
  renderToolListText,
} from "./rendering.js";
import { getErrorMessage } from "./utils.js";

export async function createMetaServer(runtime) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "list_servers",
    {
      description:
        "Required first step. You MUST call this to discover which tool server namespaces are available before using any tools. It lists the available servers, what they are for, and whether they started successfully. User assumes you called it and know what groups of tools are available to you. Once you have the list of servers you may use list_tools to learn more about tools in each group whenever your work might need any of the tools from it.",
      inputSchema: z.object({}),
    },
    async () => {
      const servers = await runtime.listServers();
      const structuredContent = { servers };
      return {
        content: [{ type: "text", text: renderServerListText(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "list_tools",
    {
      description:
        "List the allowed tools for a server, including preferred aliases and schemas. You MUST call this before using that server in execute_code so you know the exact tool names, aliases, and arguments.",
      inputSchema: z.object({
        server: z.string().min(1),
      }),
    },
    async ({ server: serverName }) => {
      const tools = await runtime.listTools(serverName);
      const structuredContent = {
        server: serverName,
        tools,
      };
      return {
        content: [{ type: "text", text: renderToolListText(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "execute_code",
    {
      description:
        "Execute JavaScript against started MCP server namespaces. You MUST call list_tools for a server before using its tools here. After calling list_servers, each started server is available as a global object and each allowed tool is a function on it. Prefer underscore aliases when available, for example return await math.add({ a: 2, b: 5 }) or return await browser.open_tab({ url: \"https://example.com\" }). Original tool names still work with bracket access such as obj[\"tool-name\"], but prefer obj.tool_name for readability. Prefer writing JavaScript here whenever the work would require more than a single tool call, because code makes multi-step tool use easier and less error-prone. console.log/info/warn/error write to fetch_logs, not the return value.",
      inputSchema: z.object({
        code: z.string().min(1),
        timeoutMs: z.number().int().positive().max(300000).optional(),
      }),
    },
    async ({ code, timeoutMs }, extra) => {
      try {
        const value = await runtime.executeCode(code, timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS, extra.sessionId);
        const structuredContent =
          value && typeof value === "object" && !Array.isArray(value)
            ? value
            : { value };

        return {
          content: [{ type: "text", text: formatExecutionValue(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: getErrorMessage(error) }],
          structuredContent: { error: getErrorMessage(error) },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "fetch_logs",
    {
      description: "Fetch and clear logs emitted by execute_code via console methods",
      inputSchema: z.object({}),
    },
    async (_args, extra) => {
      const logs = runtime.fetchLogs(extra.sessionId);
      const structuredContent = { logs };
      return {
        content: [{ type: "text", text: renderLogsText(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    "clear_logs",
    {
      description: "Clear stored execute_code logs",
      inputSchema: z.object({}),
    },
    async (_args, extra) => {
      const cleared = runtime.clearLogs(extra.sessionId);
      const structuredContent = { cleared };
      return {
        content: [{ type: "text", text: renderClearLogsText(structuredContent) }],
        structuredContent,
      };
    },
  );

  return server;
}
