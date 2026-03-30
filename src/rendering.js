export function renderServerListText(servers) {
  const lines = [];

  for (const server of servers) {
    if (server.description) {
      lines.push(`- ${server.name}: ${server.description}`);
    } else {
      lines.push(`- ${server.name}`);
    }
    const allowedTools =
      server.allowedTools === "all" ? "all tools" : server.allowedTools.join(", ") || "no tools";
    const status = server.started ? "started" : "failed";
    const details = server.availableTools.length
      ? ` tools: ${server.availableTools.map((tool) => tool.name).join(", ")}`
      : "";
    const error = server.error ? ` error: ${server.error}` : "";
    lines.push(`  type: ${server.type}; status: ${status}; allowed: ${allowedTools}${details}${error}`);
  }

  return lines.join("\n");
}

export function renderToolListText(serverName, tools) {
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

  return lines.join("\n");
}

function formatSchemaText(schema) {
  return JSON.stringify(schema, null, 2)
    .split("\n")
    .join(" ");
}

export function renderLogsText(logs) {
  if (logs.length === 0) {
    return "No logs.";
  }

  return logs.map((entry) => `${entry.id}. [${entry.level}] ${entry.message}`).join("\n");
}

export function formatExecutionValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}
