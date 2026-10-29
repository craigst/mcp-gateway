# Importing MCP servers

The gateway can bring existing MCP servers under one zero-trust endpoint in three ways.
All three are available from **Catalog** in the Web UI and over the admin API
([`API-V2.md`](./API-V2.md)).

---

## 1. Connect a GitHub MCP catalog (public or private)

A **catalog source** is a repository that lists installable MCP servers. Add it once, then
browse and one-click install from **Catalog → Discover**.

| Kind | Shape | Use when |
|---|---|---|
| `dsh-umbrella` | `.gitmodules` mapping names → repos, plus a `pinned.json` with an `mcp[]` (and optional `bundles[]`) array | You keep one umbrella repo that pins many MCP servers (one git submodule per server). `mcp[]` rows need `name`, `entry`, optional `tag`/`serverName`; `bundles[]` entries are listed but marked unsupported (they are harness runtime bundles, not standalone stdio servers). |
| `github-repo` | A single MCP server repository | Import one repo at a time. |
| `catalog-json` | Any HTTP(S)/`file://` JSON URL returning `{ "entries": [ … ] }` or a bare array | Host your own catalog index anywhere. |

### Add a private catalog

```jsonc
POST /mcp/v1/admin/catalog/sources
{
  "label": "Internal MCP catalog",
  "kind": "dsh-umbrella",
  "repoUrl": "https://github.com/example/private-mcp-catalog",
  "ref": "main",
  "token": "ghp_…"          // stored in the AES-256 vault as CATALOG_<id>_TOKEN
}
```

- The token is **never** returned by an API, written to logs, or placed in a clone URL.
  Clones authenticate through `git`'s environment-configured `http.extraheader`
  (`x-access-token` basic auth).
- If no per-source token is supplied, `GITHUB_TOKEN` / `GH_TOKEN` from the environment is
  used as a fallback (`MCP_GIT_IMPORT_ALLOWED_PREFIXES` must allow the host).
- Repo/ref/subpath changes are cached briefly; use `?refresh=1` in Discover to re-read.

### Install and test

```jsonc
POST /mcp/v1/admin/catalog/install
{
  "sourceId": "cat_…", "entryId": "example-mcp",
  "name": "example",
  "env": { "API_TOKEN": "…" },        // optional; values are stored per server
  "envFile": "~/.config/example/mcp.env",  // optional; values stay on disk
  "start": true, "test": true
}
```

The pipeline is: clone (token/ref/subpath) → resolve `mcp-manifest.json` **or auto-detect**
an entry point → run the build (bounded, shell-free) → register the server → optionally start
and run an MCP `tools/list` probe. The response includes the generated server record, the
discovered tool count/names, latency, and the scrubbed build-log tail.

### Auto-manifest detection

Repositories do not need a hand-written manifest:

- **Node** — `package.json`: entry from `bin` → `main` → conventional files
  (`<name>.js`, `server.js`, `index.js`); build runs `npm install --omit=dev` when
  `dependencies` is non-empty; start is `node <entry>`.
- **Python** — `pyproject.toml`/`setup.py` + `server.py`/`main.py`; build `uv sync`,
  start `uv run python server.py`.
- **Otherwise** the entry is listed as unsupported with the reason, before any clone work.

`mcp-manifest.json` always wins when present — see [`MANIFEST.md`](./MANIFEST.md).

### Catalog JSON format

```jsonc
{
  "entries": [
    { "name": "echo-server", "repoUrl": "https://github.com/example/echo-mcp",
      "ref": "v1.2.0", "entry": "server.js", "kind": "mcp", "serverName": "echo",
      "description": "Echo tools", "supported": true },
    { "name": "runtime-bundle", "repoUrl": "https://github.com/example/runtime-bundle",
      "kind": "bundle", "supported": false,
      "unsupportedReason": "Harness runtime bundle — not a standalone MCP server" }
  ]
}
```

---

## 2. Import from a Git URL

**Catalog → Discover → Import from URL** (or `POST /admin/catalog/import-url`) accepts any
repository URL plus optional `ref`, `subpath`, `env` and `envFile`. The same clone →
auto-manifest → build → register → test pipeline runs. This is the fastest path for a
single repository you do not want to add a catalog for.

---

## 3. Import from your existing local harnesses

**Catalog → Import** performs a read-only scan of MCP servers already configured for your
local agents, so you do not have to retype commands:

| Harness | Default config | Override |
|---|---|---|
| Claude Code | `~/.claude.json` → `mcpServers` | `MCP_DISCOVERY_CLAUDE_CONFIG` |
| opencode | `~/.config/opencode/opencode.json` → `mcp` (+ sibling `mcp.env`) | `MCP_DISCOVERY_OPENCODE_CONFIG` / `_ENV_FILE` |
| OpenMausBot | `~/.openmausbot/config.json` → `mcpServers` (HTTP/SSE + stdio) | `MCP_DISCOVERY_OPENMAUSBOT_CONFIG` |
| Generic | `MCP_DISCOVERY_CONFIG` pointing at a JSON file with `mcpServers` | — |

Discovery is **read-only and local-only**:

- It returns only environment/header **names**, never their values.
- Existing harness configs are never modified.
- Import creates a stopped server record. Remote transports keep their URL and accept auth
  headers supplied at import time; stdio servers can reference an env file on disk
  (`envFile`) instead of copying secrets into the gateway database.

After import, use **Installed → Details** to inspect tools, set high-privilege/approval
protection, test the server and stream its logs.

---

## Vault Warden: approval-gated credential delivery

Import a Vaultwarden MCP server (for example from your catalog), then open **Vault Warden**:

1. **Protect defaults** marks credential-delivering and mutating tools as high-privilege and
   **approval-required**.
2. When an agent calls a protected tool, it receives
   `-32004 ESCALATION_REQUIRED` with a ticket id — nothing executes.
3. A human approves the request in **Vault Warden → Pending credential requests**. The
   gateway executes the stored call **once** and stores the result.
4. The agent retries the same `tools/call` with `_meta.escalation_ticket` (or the
   `X-MCP-Escalation-Ticket` header) and receives the stored result exactly once.

Results from Vaultwarden tools are short-lived `0600` file paths, not secret values — so a
credential can reach a process without ever entering the model context. Every vault tool
call is recorded in the access log (agent, tool, status, latency) and in the global audit
trail.

---

## Security notes

- Catalog and import tokens live in the AES-256-GCM vault; they are never logged, returned,
  or placed in command-line arguments.
- Builds and clones are bounded by timeouts and run without a shell.
- Private catalog URLs and tokens belong in your local `.env`/UI, never in this repository.
- Remote harness entries can carry auth headers; those values are stored locally and are
  never emitted by discovery.
