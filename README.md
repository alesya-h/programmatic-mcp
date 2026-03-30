# jsmcp

`jsmcp` exists for cases where an agent needs to do more than a single MCP tool call.

Most MCP clients are great at one tool call at a time, but awkward when work requires:

- several related tool calls
- branching logic based on earlier results
- loops, retries, or result aggregation
- transforming tool output before the next call

`jsmcp` solves that by exposing approved MCP tools as JavaScript namespaces. Instead of forcing the model to juggle many separate tool invocations, it can discover what is available and then write a small amount of JavaScript to use those tools programmatically.

In practice, this means:

- the agent first learns what servers and tools are available, while `jsmcp` constrains access to whatever servers and tools you allow in a preset
- the agent can then write JavaScript for multi-step work
- logs stay separate from return values so the code stays easier to reason about

Config is read from `$XDG_CONFIG_HOME/jsmcp/config.json`. If `XDG_CONFIG_HOME` is not set, it falls back to `~/.config/jsmcp/config.json`.

## Why

Use `jsmcp` when you want agents to treat MCP tools more like a small programmable API surface than a sequence of isolated button presses.

This is especially useful when an agent needs to:

- combine results from several MCP tools
- script workflows across one or more MCP servers
- make decisions in code instead of repeatedly re-planning between tool calls
- keep tool access constrained to a reviewed preset

## Install

```bash
npm install -g @alesya_h/jsmcp
```

Or run it without installing globally:

```bash
npx @alesya_h/jsmcp
```

## Run

```bash
jsmcp
jsmcp my-preset
jsmcp auth
jsmcp auth firefox_devtools
```

If you are running from a source checkout instead of an installed package, replace `jsmcp` with `node src/index.js`.

When running the MCP server, the only optional argument is the preset name. If omitted, `default` is used.

Use `jsmcp auth` to manage OAuth for remote servers. With no arguments it lists remote servers that have OAuth enabled. With a server name it starts the OAuth flow for that server.

If no graphical environment is detected, or if you pass `--no-browser`, `jsmcp auth <server>` prints the authorization URL and waits for either the localhost callback or a pasted callback URL/code.

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
      "oauth": {
        "scope": "docs.read"
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

For remote servers, `oauth` is supported in the same spirit as OpenCode config:

- omit `oauth` or set it to an object to enable OAuth support
- set `oauth: false` to disable OAuth for that server
- supported fields today: `clientId`, `clientSecret`, `scope`

OAuth tokens and registration state are stored in `$XDG_DATA_HOME/jsmcp/oauth.json` or `~/.local/share/jsmcp/oauth.json`.

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
