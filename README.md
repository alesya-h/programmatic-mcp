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

Config is read from `$XDG_CONFIG_HOME/jsmcp/` or, if `XDG_CONFIG_HOME` is not set, `~/.config/jsmcp/`. Exactly one of `config.json`, `config.yaml`, or `config.yml` must exist there.

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
npx @alesya_h/jsmcp run
```

## Run

```bash
jsmcp run
jsmcp run work
jsmcp server work --port 3000
jsmcp client --profile work --port 3000
jsmcp auth
jsmcp auth firefox_devtools
```

If you are running from a source checkout instead of an installed package, replace `jsmcp` with `node src/index.js`, for example `node src/index.js run`.

`run` starts the meta-MCP server directly over stdio.

`server` starts a long-lived daemon on `ws://127.0.0.1:<port>/mcp`, loading the chosen preset once and keeping the underlying MCP server connections warm.

`client` exposes a stdio MCP server that proxies raw MCP/JSON-RPC messages to `server` over WebSocket. It accepts `--port <number>` to choose which daemon to connect to, and can optionally pass `--profile <name>` to require that the daemon is running the expected preset.

`run`, `server`, and `client` all accept an optional preset as either a positional argument or `--profile <name>`. The default daemon port is `41528`.

Use `jsmcp auth` to manage OAuth for remote servers. With no arguments it lists remote servers that have OAuth enabled. With a server name it starts the OAuth flow for that server.

If no graphical environment is detected, or if you pass `--no-browser`, `jsmcp auth <server>` prints the authorization URL and waits for either the localhost callback or a pasted callback URL/code.

## systemd User Service

This repo includes `systemd/jsmcp.service`, a user unit that starts `jsmcp server` from the globally installed CLI.

Install it with:

```bash
npm install -g .
mkdir -p ~/.config/systemd/user
ln -sfn "$PWD/systemd/jsmcp.service" ~/.config/systemd/user/jsmcp.service
systemctl --user daemon-reload
systemctl --user enable --now jsmcp.service
```

Useful commands:

```bash
systemctl --user status jsmcp.service
journalctl --user -u jsmcp.service -f
systemctl --user restart jsmcp.service
```

The checked-in unit starts the default preset on the default daemon port and resolves `jsmcp` through the user's actual login shell from `getent passwd`.

## Config

The config file may be JSON or YAML and uses these top-level keys:

- `servers`: server definitions
- `presets`: optional overrides for which servers and tools are exposed to the agent

Server names must be valid JavaScript identifiers because `execute_code()` exposes them directly as globals.

`jsmcp` accepts both OpenCode MCP config style and the overlapping Claude Code MCP style for the common fields:

- local servers: `type: "local"` or `type: "stdio"`
- remote servers: `type: "remote"`, `type: "http"`, or `type: "sse"`
- commands: either `command: ["cmd", "arg1"]` or `command: "cmd"` with `args: ["arg1"]`
- environment variables: either `environment` or `env`

Supported `servers.<name>` fields:

- `type`: required; one of `local`, `stdio`, `remote`, `http`, `sse`
- `description`: optional string shown in `list_servers()`
- `enabled`: optional boolean; defaults to `true`
- `timeout`: optional number in milliseconds used for initial tool discovery

For local / stdio servers:

- `command`: required; non-empty string or non-empty array
- `args`: optional array; appended to `command` when `command` is a string, and also accepted when `command` is an array
- `env`: optional object of environment variables
- `environment`: optional object of environment variables; merged with `env`, and wins on duplicate keys
- `cwd`: optional working directory

For remote / HTTP / SSE servers:

- `url`: required string
- `headers`: optional object of request headers
- `oauth`: optional OAuth config

Supported `oauth` forms:

- omitted, `null`, or `true`: enable OAuth with default behavior
- `false`: disable OAuth for that server
- object with any of:
  - `clientId`
  - `clientSecret`
  - `scope`

Supported value substitutions in string fields:

- `{env:NAME}`: expand from the current environment
- `${NAME}`: Claude Code-style environment expansion
- `${NAME:-default}`: Claude Code-style expansion with fallback
- `{file:path}`: replace with file contents

For `{file:path}`:

- relative paths are resolved relative to the config file directory
- `~/...` resolves from the user home directory
- absolute paths are used as-is

If `presets` is omitted, the default preset includes every server with `enabled !== false` and allows all of that server's tools.

If `presets` is present, it is an object of preset names. Each preset is an object of per-server overrides layered on top of the server definitions:

- `presets.default`: optional overrides for the default preset
- any other preset name, such as `presets.work`: additional named preset overrides

Within a preset, server rules work like this:

- omitted server rule: use the server definition as-is
- `true`: include that server and allow all its tools
- `false`: exclude that server from that preset
- `"tool_name"`: include only that exact tool
- array entries may be:
  - exact tool name strings
  - `{ "regex": "..." }` selectors
  - `{ "glob": "..." }` selectors

If a server has `enabled: false` in `servers`, adding it to a preset enables it for that preset.

Example:

```json
{
  "servers": {
    "math": {
      "type": "stdio",
      "description": "Basic arithmetic tools",
      "command": "node",
      "args": ["/absolute/path/to/math-server.js"],
      "env": {
        "LOG_LEVEL": "debug"
      },
      "cwd": "${PWD}"
    },
    "docs": {
      "type": "http",
      "description": "Documentation search and retrieval",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      },
      "oauth": {
        "scope": "docs.read"
      }
    }
  },
  "presets": {
    "default": {
      "math": ["add", { "glob": "mul_*" }],
      "docs": [{ "regex": "(search|fetch)" }]
    },
    "work": {
      "docs": true
    }
  }
}
```

Compatibility notes:

- Claude Code-style `env`, `type: "stdio"`, `type: "http"`, `type: "sse"`, and `command` plus `args` are supported
- OpenCode-style `type: "local"`, `type: "remote"`, command arrays, and `environment` are also supported
- Claude Code-specific features such as `headersHelper` and advanced OAuth fields like `callbackPort` or `authServerMetadataUrl` are not supported yet

OAuth tokens and registration state are stored in `$XDG_DATA_HOME/jsmcp/oauth.json` or `~/.local/share/jsmcp/oauth.json`.

## Exposed Tools

- `list_servers`
- `list_tools`
- `execute_code`
- `fetch_logs`
- `clear_logs`

## Behavior

- servers in the default preset are started when `jsmcp` starts
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
