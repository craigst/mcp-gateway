# MCP Gateway

**All-in-One MCP Gateway & Orchestration Engine** — a zero-trust JSON-RPC 2.0 proxy that fronts every MCP sub-server and remote agent harness behind one endpoint, with per-key catalog censorship, encrypted secrets, sub-agent delegation and a management console.

[![CI](https://github.com/craigst/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/craigst/mcp-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/craigst/mcp-gateway?label=release)](https://github.com/craigst/mcp-gateway/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](https://nodejs.org)

---

## Why

Agents calling tools directly have three systemic problems: **credential sprawl**, **tool sprawl**, and **no audit lineage**. This gateway puts one policy decision point in front of every MCP runtime (Node, Python, native binaries, remote harnesses) and answers one question per request:

> *May **this** key see and execute **this** tool, with **these** arguments, right now?*

If not, the tool is invisible — not merely denied.

## Features

| | Feature | Detail |
|---|---|---|
| 🔐 | **Scoped API keys** | `mcp_ag_`, `mcp_dev_`, `mcp_sub_`, `mcp_sup_`, `mcp_master_`; SHA-256 hashes (optional pepper), expiry, instant revocation. |
| 🕵️ | **Zero-trust discovery** | `tools/search` and `tools/list` are censored *before* serialization; unpermitted servers/tools never appear. |
| 🧱 | **Default-hidden high privilege** | `HIGH_PRIVILEGE` tools are omitted unless the key holds an explicit grant; denials return `-32001` with escalation tickets. |
| 🛡️ | **Argument guardrails** | Regex deny/require rules and JSON-Schema validation on tool arguments (e.g. allow `SELECT`, block `DROP/UPDATE`). |
| 🤖 | **Sub-agent delegation** | Expose remote observer bots as tools via `agents/delegate`; depth-capped at 3, parent-child audit tracing, approval tokens. |
| 🔒 | **Encrypted vault** | AES-256-GCM (scrypt-derived key) for API tokens / DB strings; injected into sub-process env at start; hot rotation. |
| 📦 | **Git import engine** | Clone an allowlisted repo, validate `mcp-manifest.json` **or auto-detect** the entry point, build, register, start — shell-free with timeouts. |
| 🛒 | **MCP catalog marketplace** | Connect public or **private** GitHub catalogs (`.gitmodules` + `pinned.json` umbrellas, single repos, or any catalog JSON), browse entries and one-click install/test. |
| 🔎 | **Harness import** | Read-only discovery of MCP servers already configured in Claude Code, opencode and OpenMausBot; one-click import with env-file references. |
| 🗝️ | **Vault Warden approvals** | Approval-gated credential delivery: agents request a secret, a human approves, the gateway executes once and returns a file path — values never enter the model context. |
| 🖥️ | **Web UI console** | Dashboard, catalog manager, RBAC grid, vault, audit explorer, delegation observer, live log stream, JSON-RPC playground. |
| 📊 | **Audit everything** | Every discovery/execution/denial recorded with latency, key, tool, delegation depth and payload (truncated). |
| 🧪 | **Real tests** | Vitest unit + integration + E2E against live stdio sub-processes; CI builds the Docker image and smoke-tests `/health`. |

## Console

![Vault Warden — pending credential approvals, tool protection and vault access log](docs/screenshots/v02/vaultwarden.png)

<details>
<summary>More screenshots (dashboard · catalog discover · catalog import · sources)</summary>

| Dashboard | Catalog Discover |
|---|---|
| ![Dashboard](docs/screenshots/v02/dashboard.png) | ![Catalog Discover](docs/screenshots/v02/catalog-discover.png) |

| Catalog Import | Connect a catalog |
|---|---|
| ![Catalog Import](docs/screenshots/v02/catalog-import.png) | ![Catalog Sources](docs/screenshots/v02/catalog-sources.png) |

</details>

Screenshots use generic demo data (no personal configuration): a demo catalog, two fixture
sub-servers and a Vaultwarden fixture with one pending credential request.

## Architecture

```
 AI agents / harnesses                         ┌────────────── Master container ──────────────┐
 (Bearer mcp_ag_…)  ── POST /mcp/v1 ─────────► │ ingress ─► RBAC policy ─► catalog (censored) │
                                               │              │                               │
                                               │              ├─► stdio supervisor ─► Node MCP │
                                               │              │                     ─► Python  │
                                               │              ├─► remote agent proxy (HTTP)   │
                                               │              ├─► AES-256-GCM vault           │
                                               │              └─► SQLite audit / traces       │
                                               │ Web UI console (React+Tailwind, /)           │
                                               └──────────────────────────────────────────────┘
```

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/craigst/mcp-gateway.git
cd mcp-gateway

# Generate the two required secrets
export MCP_MASTER_KEY="mcp_master_$(openssl rand -hex 24)"
export MCP_VAULT_SECRET="$(openssl rand -base64 48)"

docker compose up -d --build
curl -s localhost:8080/mcp/v1/health
```

Open <http://localhost:8080> for the console. On first boot (empty key table) the
bootstrap master key from `MCP_MASTER_KEY` is registered; if it is unset a random
master key is generated and printed once to the container logs:

```bash
docker compose logs gateway | grep "master key"
```

### From source

```bash
npm ci
npm run build          # tsc + vite (UI bundle)
MCP_MASTER_KEY="mcp_master_$(openssl rand -hex 24)" \
MCP_VAULT_SECRET="$(openssl rand -base64 48)" \
npm start              # http://localhost:8080
```

## Import your own MCP servers

Three paths, all in **Catalog**:

1. **GitHub catalog** — connect a public or private catalog repo. Umbrella catalogs that
   pin many servers via `.gitmodules` + `pinned.json` are supported, as are single repos
   and any catalog JSON. Install runs clone → auto-manifest → build → register → test.
2. **Git URL** — paste any MCP server repository and install it directly.
3. **Local harnesses** — scan Claude Code, opencode and OpenMausBot configs read-only and
   import existing servers with one click. Environment **values** are never returned; use
   env files or supply values at import time.

Full guide: [`docs/IMPORTING.md`](./docs/IMPORTING.md).

```jsonc
// Connect a private catalog (token goes to the encrypted vault, never returned)
POST /mcp/v1/admin/catalog/sources
{ "label": "Internal MCP catalog", "kind": "dsh-umbrella",
  "repoUrl": "https://github.com/example/private-mcp-catalog", "ref": "main", "token": "ghp_…" }

// Then browse and install
POST /mcp/v1/admin/catalog/install
{ "sourceId": "cat_…", "entryId": "example-mcp", "start": true, "test": true }
```

### Vault Warden

Dangerous Vaultwarden tools are approval-gated: an agent call returns
`-32004 ESCALATION_REQUIRED`, a human approves it in **Vault Warden**, the gateway executes
the stored call once and stores the result, and the agent retrieves it with the ticket.
Deliveries are short-lived `0600` file paths — secret values never enter the model context.

## Use it from an agent

```bash
KEY="mcp_master_…"
curl -s localhost:8080/mcp/v1 \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/search","params":{"query":"echo","limit":5}}'
```

```jsonc
{"jsonrpc":"2.0","id":1,"result":{
  "tools":[{"name":"echo","description":"Echo the supplied text back to the caller",
            "server_id":"srv_…","tool_id":"srv_…:echo","score":5}],
  "total":1,"censored":true}}
```

Issue a least-privilege agent key (master key required):

```bash
curl -s localhost:8080/mcp/v1/admin/keys/create \
  -H "Authorization: Bearer $MASTER" -H 'content-type: application/json' \
  -d '{"name":"reporting-agent","keyType":"agent",
       "serverGrants":[{"serverId":"srv_…","tools":["echo"]}],
       "delegationAllowed":false,"escalationAllowed":true}'
```

The response contains `plaintext` **exactly once**. Then execute directly:

```bash
curl -s localhost:8080/mcp/v1 -H "Authorization: Bearer $AGENT_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}'
```

See [`docs/API.md`](./docs/API.md) and [`docs/API-V2.md`](./docs/API-V2.md) for the complete
JSON-RPC + admin API, [`docs/IMPORTING.md`](./docs/IMPORTING.md) for catalogs/harnesses and
[`docs/MANIFEST.md`](./docs/MANIFEST.md) for the sub-server manifest format.

## Repository layout

```
src/
  core/        config · types · ports · errors · logger · SQLite schema
  gateway/     HTTP ingress · JSON-RPC router · supervisor · stdio/http transports · audit
  rbac/        key service · policy decision point · guardrails · escalations
  catalog/     tool registry · censored search · permitted server menu
  delegation/  observer proxy · depth limiter · traces
  vault/       AES-256-GCM secret store
  git_engine/  clone · manifest · timed build · registration
  admin/       REST management API
  ui/          React + Tailwind console (built to ui/dist)
tests/         unit · integration · e2e · fixtures
docs/          PLAN.md · API.md · MANIFEST.md · extracted spec
```

## Testing

```bash
npm test               # unit + integration + live stdio sub-process E2E
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run build          # server + UI bundle
```

The suite is **480 tests across 40 files**: unit suites per module, an integration suite that
boots a real gateway on an ephemeral port and spawns fixture MCP servers, and an end-to-end
scenario covering vault → git import → catalog → execution → delegation → depth guard → escalation,
plus jsdom UI tests. CI also builds the Docker image and smoke-tests `/health` inside the container.

## Security

- Every request is authenticated; keys are stored only as SHA-256 hashes.
- The catalog is filtered server-side before serialization (no client-side trust).
- Denials for invisible tools are indistinguishable from unknown tools.
- Sub-processes run unprivileged inside the container; build/clone URLs are allowlisted.
- Secrets are encrypted at rest with AES-256-GCM and never returned by the API.

Read [`SECURITY.md`](./SECURITY.md) for the full threat model and disclosure process.

## Status

| Release | Scope | State |
|---|---|---|
| v0.1.0 | Core engine, JSON-RPC ingress, RBAC/zero-trust catalog, UI, delegation, vault + git import | ✅ shipped |
| **v0.2.0** | **Private GitHub catalogs, harness discovery/import, auto-manifest detection, approval-gated Vault Warden, UI marketplace** | ✅ **current** |

## License

[MIT](./LICENSE) © 2026 Craig CXS
