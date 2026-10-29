# `mcp-manifest.json` Specification

Every sub-server installed through the gateway's Git import engine must include a
`mcp-manifest.json` at the repository root. The gateway clones the repo, validates
this file, runs the build command, then registers the server with the supervisor.

## Schema

```jsonc
{
  "name": "github-mcp-connector",          // required, slug: [a-z0-9][a-z0-9-_]{0,63}
  "version": "2.1.0",                      // required, semver-like string
  "runtime": "node20",                     // required: node20|node22|node24|python3.11|python3.12|binary|go|rust
  "build_command": "npm install && npm run build",  // optional, default per runtime
  "start_command": "node dist/index.js",   // required (or "command"): no shell, tokenized
  "environment": {                         // optional static env vars
    "DEFAULT_BRANCH": "main"
  },
  "required_secrets": ["GITHUB_PAT_TOKEN"],// optional vault secret names
  "capabilities": {
    "high_privilege_tools": ["repo_delete", "force_push"], // hidden by default
    "delegation_supported": false                          // participates in agents/delegate
  }
}
```

## Runtime defaults

| `runtime` | Default build | Notes |
|---|---|---|
| `node20` / `node22` / `node24` | `npm install --no-audit --no-fund` | stdio or HTTP transport |
| `python3.11` / `python3.12` | `uv sync` | isolated venv, never system Python |
| `binary` / `go` / `rust` | none (pre-compiled) | executed directly with namespace limits in-container |
| `remote-agent` | none | `url` transport, proxied |

## Rules

1. `start_command` is split by a shell-free tokenizer; pipes, `&&`, redirects and
   variable expansion are **not** supported in the start command.
2. `required_secrets` are resolved from the AES-256-GCM vault at process start and
   injected as environment variables. Missing secrets abort the start with a clear
   error (secret values are never logged).
3. Tools listed under `capabilities.high_privilege_tools` are marked
   `HIGH_PRIVILEGE` and omitted from all catalog search/list results unless an API
   key holds an explicit signed grant for that tool.
4. Clone URLs must match `MCP_GIT_IMPORT_ALLOWED_PREFIXES`; empty allowlist disables
   the import engine entirely.
5. Build commands run with a 180s timeout inside the container, never through a shell.
