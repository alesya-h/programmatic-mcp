export function renderServerListText(structuredContent) {
  const { servers } = structuredContent;
  const lines = [];

  for (const server of servers) {
    if (server.description) {
      lines.push(`- ${server.name}: ${server.description}`);
    } else {
      lines.push(`- ${server.name}`);
    }

    if (server.ok === true) {
      lines.push("  ok: true");
    } else if (server.error) {
      lines.push(`  error: ${server.error.message}`);
      if (server.error.stderr) {
        lines.push("  stderr:");
        for (const line of String(server.error.stderr).split("\n")) {
          lines.push(`    ${line}`);
        }
      }
    }
  }

  return lines.join("\n");
}

export function renderToolListText(structuredContent) {
  const { server: serverName, tools } = structuredContent;
  const lines = [`Server: ${serverName}`];

  for (const tool of tools) {
    lines.push(`- ${tool.name}${tool.alias ? ` (preferred: ${tool.alias})` : ""}`);
    if (tool.description) {
      lines.push(`  description: ${tool.description}`);
    }
    lines.push(`  inputSchema: ${formatSchemaText(tool.inputSchema)}`);
    if (tool.outputSchema) {
      lines.push(`  outputSchema: ${formatSchemaText(tool.outputSchema)}`);
    }
  }

  return withStructuredData(lines.join("\n"), structuredContent);
}

function formatSchemaText(schema) {
  return JSON.stringify(schema, null, 2)
    .split("\n")
    .join(" ");
}

export function renderLogsText(structuredContent) {
  const { logs } = structuredContent;
  const summary =
    logs.length === 0
      ? "No logs."
      : logs.map((entry) => `${entry.id}. [${entry.level}] ${entry.message}`).join("\n");

  return withStructuredData(summary, structuredContent);
}

export function formatExecutionValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function withStructuredData(summary, structuredData) {
  return `${summary}\n\nStructured data:\n${JSON.stringify(structuredData, null, 2)}`;
}

export function renderClearLogsText(structuredContent) {
  return withStructuredData(`Cleared ${structuredContent.cleared} log entries.`, structuredContent);
}
