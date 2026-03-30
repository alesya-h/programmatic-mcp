# jsmcp

A meta MCP server that:

- lists MCP servers available in a preset
- connects to preset servers on startup
- exposes approved server tools to `execute_code()` as JavaScript libraries
- stores `console` output separately through log tools

Config is read from `$XDG_CONFIG_HOME/jsmcp/config.json`. If `XDG_CONFIG_HOME` is not set, it falls back to `~/.config/jsmcp/config.json`.

## Run

```bash
node src/index.js
node src/index.js my-preset
```

The only optional argument is the preset name. If omitted, `default` is used.

## Config

`servers` uses the same local or remote format as OpenCode MCP config.

`presets` decides which servers are visible and which tools from each server are allowed.

Each server may also define an optional `description`. This is surfaced by `list_servers()` so agents can understand when to use that server.

Server names must be valid JavaScript identifiers because `execute_code()` exposes them directly as globals.

Example:

```json
{
  "servers": {
    "math": {
      "type": "local",
      "description": "Basic arithmetic tools",
      "command": ["node", "/absolute/path/to/math-server.js"]
    },
    "docs": {
      "type": "remote",
      "description": "Documentation search and retrieval",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer {env:DOCS_TOKEN}"
      }
    }
  },
  "presets": {
    "default": {
      "servers": {
        "math": {
          "tools": ["add", "multiply"]
        },
        "docs": {
          "tools": ["search", "fetch_page"]
        }
      }
    },
    "math-only": ["math"]
  }
}
```

Accepted preset forms:

- `"preset": ["server-a", "server-b"]`
- `"preset": { "servers": { "server-a": true } }`
- `"preset": { "servers": { "server-a": { "tools": ["tool1"] } } }`

Tool rules:

- `true`, omitted `tools`, or `"*"` means all tools from that server
- `tools: ["name"]` restricts access to the listed tools
- `false` or `enabled: false` removes that server from the preset

OpenCode-style `{env:NAME}` and `{file:path}` substitutions are supported.

## Exposed Tools

- `list_servers`
- `list_tools`
- `execute_code`
- `fetch_logs`
- `clear_logs`

## Behavior

- preset servers are started when `jsmcp` starts
- `list_servers()` is the required first step so the agent can learn what capabilities are available
- you must call `list_tools(server)` before using a server in `execute_code()` so you know the exact tool names, aliases, and schemas
- `list_tools(server)` returns only the tools allowed for that server in the preset
- `execute_code(code)` does not manage server lifecycle; it can only use servers that are already started
- prefer `execute_code(code)` whenever the work would require more than a single tool call
- `console.log`, `console.info`, `console.warn`, and `console.error` inside `execute_code()` are stored for `fetch_logs()`
- `fetch_logs()` drains the log buffer on read

## `execute_code`

`execute_code` runs JavaScript as the body of an async function.

Started servers are injected as globals. Each allowed MCP tool becomes a function on that server object. Prefer underscore aliases when available.

You should call `list_tools(server)` before using a server in `execute_code()`. For multi-step work, prefer writing JavaScript instead of trying to mentally chain several tool calls.

Example:

```js
return await math.add({ a: 2, b: 5 });
```

If the MCP tool returns `structuredContent`, that is what the JavaScript call resolves to. So the example above can return:

```json
{
  "sum": 7
}
```

If a tool name is not a valid JavaScript identifier, prefer its underscore alias:

```js
return await math.tool_name({ value: 1 });
```

The original tool name still works with bracket access:

```js
return await math["tool-name"]({ value: 1 });
```
