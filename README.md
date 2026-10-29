# MCP Gateway

**All-in-One MCP Gateway & Orchestration Engine** — a zero-trust JSON-RPC 2.0 proxy that fronts every MCP sub-server and remote agent harness behind one endpoint, with per-key catalog censorship, encrypted secrets, sub-agent delegation and a management console.

[![CI](https://github.com/craigst/mcp-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/craigst/mcp-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
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
| 📦 | **Git import engine** | Clone an allowlisted repo, validate `mcp-manifest.json`, build, register, start — shell-free with timeouts. |
| 🖥️ | **Web UI console** | Dashboard, catalog manager, RBAC grid, vault, audit explorer, delegation observer, live log stream, JSON-RPC playground. |
| 📊 | **Audit everything** | Every discovery/execution/denial recorded with latency, key, tool, delegation depth and payload (truncated). |
| 🧪 | **Real tests** | Vitest unit + integration + E2E against live stdio sub-processes; CI builds the Docker image and smoke-tests `/health`. |

## Console

![Gateway dashboard — live telemetry, request mix and sub-server status](docs/screenshots/dashboard.png)

<details>
<summary>More screenshots (RBAC grid · catalog manager · audit explorer · playground)</summary>

| RBAC scope grid | Catalog manager |
|---|---|
| ![RBAC](docs/screenshots/rbac.png) | ![Catalog](docs/screenshots/catalog.png) |

| Audit explorer | JSON-RPC playground |
|---|---|
| ![Audit](docs/screenshots/audit.png) | ![Playground](docs/screenshots/playground.png) |

</details>

Screenshots come from a seeded local instance (`echo` + `analytics-mcp` sub-servers, scoped keys, one denied high-privilege call).

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

See [`docs/API.md`](./docs/API.md) for the complete JSON-RPC + admin API, and
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

The suite is **317 tests across 21 files**: unit suites per module, an integration suite that
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

| Phase | Scope | State |
|---|---|---|
| 1 | Core engine, JSON-RPC ingress, multi-runtime container | ✅ implemented |
| 2 | Catalog & RBAC shield, zero-trust discovery | ✅ implemented |
| 3 | Web UI management console | ✅ implemented |
| 4 | Sub-agent delegation & observer runtimes | ✅ implemented |
| 5 | Git import engine & encrypted vault | ✅ implemented |

## License

[MIT](./LICENSE) © 2026 Craig CXS
