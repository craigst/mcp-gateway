# MCP Gateway — Build & Test Plan

> Source of truth: `docs/All-in-One MCP Gateway Architectural Specification & Build Guide.pdf`
> (8 pages, extracted text in [`docs/spec-extracted.txt`](./spec-extracted.txt)).
>
> Target repository: <https://github.com/craigst/mcp-gateway> (public)
> Stack: TypeScript + Node.js 22.5+ (built-in `node:sqlite`, `node:http`, `node:crypto`), React + Tailwind for the console, Vitest for tests, Docker for the all-in-one image.

---

## 1. Objective

Build a production-shaped, fully tested implementation of the specification: a single Docker container that hosts
one JSON-RPC 2.0 MCP endpoint (`/mcp/v1`) in front of many heterogeneous MCP sub-servers, enforcing

1. **Zero-trust discovery** — the catalog is censored per API key; unauthorized tools are invisible.
2. **Scoped API keys / RBAC** — server grants, tool whitelists, argument guardrails, delegation claims.
3. **Default-hidden high-privilege tools** — never listed or discoverable without an explicit signed grant.
4. **Sub-agent delegation** — remote observer harnesses exposed as MCP tools with depth limiting and audit lineage.
5. **Encrypted vault + Git import engine** — AES-256-GCM secret storage, one-command sub-server installs from GitHub.
6. **Web UI console** — dashboard, catalog manager, RBAC grid, vault, delegation observer, audit explorer, playground.
7. **Real automated tests** — unit + integration + end-to-end, exercised against live stdio sub-processes.

### Non-goals for v1

- Multi-node clustering / horizontal replication (single-writer SQLite is intentional).
- Replacing the Docker daemon or orchestrating containers per sub-server (sub-servers are child processes).
- Full OAuth 2.1 / OIDC flows beyond static scoped keys (roadmap item, interface stubbed).

---

## 2. Architecture

```
                       ┌────────────────────────────────────────────────────────────┐
  AI agent / harness   │  Master container (Docker)                                 │
  Authorization:       │                                                            │
  Bearer mcp_ag_...    │  ┌──────────────── /mcp/v1 (JSON-RPC 2.0 HTTP) ───────────┐ │
        │              │  │ gateway/  ingress · body limit · batch · errors      │ │
        └─────────────►│  │ rbac/     key verify → policy decision point         │ │
                       │  │ catalog/  scope-filtered search + listing (censored) │ │
                       │  │ delegation/ remote observer proxy, depth ≤ 3         │ │
                       │  └───────────────┬──────────────────────────────────────┘ │
                       │                  │ stdio / http transports                │
                       │        ┌─────────┴──────────┬───────────────┐               │
                       │        ▼                    ▼               ▼               │
                       │   Node MCP server     Python MCP server   Remote observer    │
                       │   (child process)     (uv venv process)   harness (HTTP)     │
                       │                                                            │
                       │  vault/ AES-256-GCM ──┐   git_engine/ clone+build+register  │
                       │  data/gateway.db (SQLite: keys, servers, tools, audit, …)   │
                       │  ui/ React+Tailwind console served as a static bundle       │
                       └────────────────────────────────────────────────────────────┘
```

### Module map

| Path | Responsibility | Spec § |
|---|---|---|
| `src/core/` | config, typed contracts, errors, logger, SQLite schema, ids | 1, 11, 12 |
| `src/rbac/` | key issuance/verification (SHA-256), policy decision point, guardrails | 5, 6 |
| `src/catalog/` | tool registry, scope filtering, censored search, permitted servers | 3, 4 |
| `src/gateway/` | HTTP ingress, JSON-RPC router, MCP handshake, stdio/http transports, supervisor | 1, 11, 14 |
| `src/delegation/` | remote observer proxy, depth limiter, approval tokens, traces | 7, 8 |
| `src/vault/` | AES-256-GCM secret store, scrypt key derivation, hot rotation | 9 |
| `src/git_engine/` | GitHub clone, manifest parsing, build, supervisor registration | 13 |
| `src/ui/` | React/Tailwind console (dashboard, catalog, RBAC grid, vault, audit, playground) | 9, 10 |
| `tests/` | unit, integration, E2E suites | 16 |

### Data model (SQLite)

`api_keys` · `servers` · `tools` · `audit_log` · `vault_secrets` · `escalations` · `delegation_traces` · `settings`.
Schema is versioned with `PRAGMA user_version`; all timestamps ISO-8601 UTC.

---

## 3. Protocol surface

### 3.1 JSON-RPC methods (`POST /mcp/v1`)

| Method | Auth | Behaviour |
|---|---|---|
| `initialize` | any valid key | Returns server info, capabilities, and the gateway's protocol version. |
| `ping` | any valid key | Liveness. |
| `tools/list` | any valid key | **Masked** schemas for permitted, non-hidden tools only. |
| `tools/search` | any valid key | Ranked search over the censored catalog (`{query, limit}`). |
| `tools/call` | any valid key | Policy check (server → tool → high-privilege → guardrails) then dispatch. |
| `servers/list_permitted` | any valid key | Zero-trust server menu; unpermitted servers absent. |
| `agents/delegate` | `delegationAllowed` | Routes to observer harness; enforces depth ≤ `MCP_DELEGATION_MAX_DEPTH`. |
| `escalations/request` | `escalationAllowed` | Creates an audit ticket for supervisory approval. |
| `notifications/initialized` | — | No-op notification. |

Unknown tools get a generic `Tool Not Found (-32002)`. Known-but-ungranted tools get structured
`Access Denied (-32001)` with `{status, reason, ticket_id, escalation_supported}`.

### 3.2 REST admin API (master/supervisor keys)

```
POST   /mcp/v1/admin/keys/create           → issue key (plaintext returned once)
GET    /mcp/v1/admin/keys                  → list keys (hashes never returned)
POST   /mcp/v1/admin/keys/:id/revoke       → instant lockout
POST   /mcp/v1/admin/servers               → register sub-server
POST   /mcp/v1/admin/servers/:id/start|stop|restart
GET    /mcp/v1/admin/servers/:id/logs      → ring buffer / WS stream
POST   /mcp/v1/admin/servers/import        → git import (clone/manifest/build/register)
GET    /mcp/v1/admin/audit                 → filtered audit query
GET    /mcp/v1/admin/delegations           → delegation traces
POST   /mcp/v1/admin/vault/secrets         → create/rotate secret
GET    /mcp/v1/admin/vault/secrets         → names + metadata only
DELETE /mcp/v1/admin/vault/secrets/:name
POST   /mcp/v1/admin/escalations/:ticket/approve|deny
GET    /mcp/v1/health · /mcp/v1/metrics
```

### 3.3 Web UI routes

`/` dashboard (req/min, CPU/RAM, error rate) · `/catalog` · `/rbac` · `/vault` · `/audit` · `/delegation` · `/playground`.
Static SPA bundle served from `ui/dist`; live logs over `WebSocket /mcp/v1/admin/ws/logs`.

---

## 4. Security model

| Control | Implementation |
|---|---|
| Key randomness | `randomBytes(32).toString('base64url')`, prefixed per type (`mcp_ag_`, `mcp_dev_`, `mcp_sub_`, `mcp_sup_`, `mcp_master_`). |
| Key storage | SHA-256 (optionally peppered via `MCP_KEY_PEPPER`); plaintext shown exactly once. Lookup by hash, constant-time compare. |
| Revocation | `revoked_at` checked on every request; `POST …/revoke` = instant lockout. |
| Zero-trust catalog | Filtering applied *before* serialization; denials do not leak tool existence. |
| High privilege | `HIGH_PRIVILEGE` flag; omitted from search/list unless the key's grant explicitly names the tool. |
| Argument guardrails | Regex deny/require rules on serialized arguments + JSON Schema subset validation. |
| Vault | AES-256-GCM, unique IV per write, scrypt-derived key from `MCP_VAULT_SECRET`; material injected only into the granted child process env. |
| Delegation | `X-MCP-Delegation-Depth` header, hard cap 3, parent-child audit rows, isolated context (params only). |
| Import engine | Clone URL allowlist (`MCP_GIT_IMPORT_ALLOWED_PREFIXES`), no shell interpolation, manifest validated, build runs with timeout. |
| Transport | Binds `0.0.0.0:8080` in Docker; bearer auth required for every `/mcp/v1` call except `/health`. Body size limit, JSON-RPC batch cap. |

---

## 5. Phases, workstreams & acceptance criteria

Legend: ✅ = done when its automated tests pass and CI is green.

### Phase 1 — Core engine & container
- **1a Gateway ingress** (`src/gateway/server.ts`, `router.ts`): HTTP server, `/mcp/v1` + `/health`, JSON-RPC 2.0 single & batch, parse/validation errors, body limits, request ids, structured error mapping, audit hooks.
- **1b Transports** (`src/gateway/transport/`): newline-delimited JSON-RPC over stdio; HTTP transport for remote MCP servers; per-request timeouts; `initialize` handshake.
- **1c Supervisor** (`src/gateway/supervisor.ts`): spawn/stop/restart child processes, ring-buffer logs, status transitions, PID tracking, crash backoff.
- **1d Multi-runtime Dockerfile + compose**, `.dockerignore`, non-root user, healthcheck.
- **Acceptance**: integration test boots a mock stdio MCP server, calls `initialize` → `tools/list` → `tools/call`, asserts payloads; Docker build passes in CI.

### Phase 2 — Catalog & RBAC shield
- **2a Key service** (`src/rbac/keys.ts`): issuance, hashing, verification, revocation, expiry, rotation, listing.
- **2b Policy engine** (`src/rbac/policy.ts`): server grant → tool whitelist → high-privilege → guardrails; structured denials + escalation tickets.
- **2c Guardrails** (`src/rbac/guardrails.ts`): regex deny/require + JSON Schema subset validator.
- **2d Catalog** (`src/catalog/`): registry CRUD from sub-server tool discovery; zero-trust `tools/search` ranking; `servers/list_permitted`.
- **Acceptance**: tests prove unauthorized tools are *absent* from search/list; high-privilege tools hidden by default; guardrail violations denied with `-32001`; master key sees everything.

### Phase 3 — Web UI console
- **3a UI foundation**: Vite + React 19 + Tailwind 4, layout, design tokens, API client with key handling, router.
- **3b Dashboard**: overview metrics from `/metrics` + live WS log stream.
- **3c Catalog manager**: register/start/stop/import servers, log viewer.
- **3d RBAC scope grid**: key list, create-key dialog (server/tool checkboxes, delegation), revoke.
- **3e Vault + Audit + Delegation + Playground** views: secret CRUD, filtered audit search, trace table, JSON-RPC sandbox with latency breakdown.
- **Acceptance**: `vite build` produces a servable bundle; gateway serves it; component tests cover key flows; Playwright-free E2E asserts the SPA shell loads and API-backed views render.

### Phase 4 — Sub-agent delegation
- **4a Proxy** (`src/delegation/proxy.ts`): HTTP/MCP delegation to remote harnesses, timeouts, auth via vault.
- **4b Observer pattern** (`src/delegation/observer.ts`): `observe_and_verify`, approval token issuance/verification.
- **4c Depth limiter + traces**: `X-MCP-Delegation-Depth`, cap 3, parent-child audit linkage.
- **Acceptance**: fake observer harness in tests returns approval/denial; recursive delegation blocked at depth 3 with `-32003`; trace rows link parent → child.

### Phase 5 — Git engine & vault
- **5a Vault crypto** (`src/vault/crypto.ts`): AES-256-GCM encrypt/decrypt, scrypt KDF, rotation.
- **5b Secret store + env injection** (`src/vault/store.ts`): CRUD, metadata-only listing, hot rotation for running servers.
- **5c Git engine** (`src/git_engine/`): clone (allowlisted), manifest parse/validate, build with timeout, register + start via supervisor.
- **Acceptance**: vault round-trip and tamper detection tests; import a local fixture repo, assert build ran and server registered; disallowed clone URL rejected.

### Cross-cutting (Lead)
- `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md`, `docs/MANIFEST.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.env.example`.
- CI workflow: typecheck → lint → unit/integration tests → UI build → Docker build.
- Release hygiene: MIT license, `v0.2.0` tag.

---

## 6. Test strategy

| Layer | Tooling | Coverage |
|---|---|---|
| Unit | Vitest | key hashing/prefixes/expiry, policy matrix, guardrails, schema validator, search ranking, crypto round-trip, depth limiter, manifest validation. |
| Integration | Vitest + real HTTP server on ephemeral port | full JSON-RPC flow against in-process gateway with a mock stdio sub-server; auth failures; batch; audit rows; admin API. |
| E2E | Vitest booting compiled/in-process gateway + fixture MCP servers | multi-key scenario: master issues scoped keys, agent sees only its tools, calls succeed/deny, escalation ticket created and approved, delegation chain observed. |
| UI | Vitest + Testing Library (jsdom) | API client, scope-grid logic, key-creation form validation, audit filtering, playground request builder. |
| Static | `tsc --noEmit`, ESLint | zero errors. |
| Container | GitHub Actions `docker build` | image builds and starts; `/health` returns ok. |

**Definition of done for any feature**: its tests exist, are deterministic, and run in `npm test`; CI is green; docs updated.

### Test fixtures
- `tests/fixtures/mcp-echo-server.mjs` — stdio MCP server exposing `echo`, `add`, plus a high-privilege `danger_delete`.
- `tests/fixtures/observer-harness.mjs` — HTTP observer returning approval tokens.
- `tests/fixtures/manifest-repo/` — local git repo with `mcp-manifest.json` + build script.

---

## 7. Milestones & sequencing

| # | Milestone | Owner | Depends on |
|---|---|---|---|
| M0 | Scaffold, contracts, repo, CI skeleton | Lead | — |
| M1 | Gateway ingress + transports + supervisor (+ tests) | Lead | M0 |
| M2 | RBAC + catalog (+ tests) | Teammate A | M0 |
| M3 | Vault + Git engine (+ tests) | Teammate B | M0 (vault) |
| M4 | Delegation + observer (+ tests) | Teammate C | M0 (interfaces) |
| M5 | Web UI console | Teammate D | M0, admin API surface |
| M6 | Admin API + integration/E2E tests | Lead | M1, M2, M3, M4 |
| M7 | Docker image, CI, docs, release v0.2.0 | Lead | M1–M6 |

Parallelism rule: each workstream owns disjoint directories; `src/core/` contracts are changed only by the Lead.
Cross-module imports go through the agreed interfaces; integration wiring is the Lead's job.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `node:sqlite` API differences across Node 22/24/26 | Pin Node 24 in Docker/CI; integration tests run on the pinned version; isolate all SQL in `src/**/store.ts`. |
| Spawning arbitrary sub-processes is a large attack surface | Allowlist clone URLs, non-root container user, per-process env injection, timeouts, no shell interpolation. |
| UI bundle adds build complexity | Vite build in CI; gateway serves static bundle with cache headers; UI logic kept in testable modules. |
| Docker daemon unavailable on the dev host | CI performs the Docker build; locally validate Dockerfile with `docker build --check` when available and document it. |
| Scope creep across 5 phases | Milestone gates + explicit acceptance criteria above; non-goals recorded. |

---

## 9. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MCP_PORT` / `MCP_HOST` | `8080` / `0.0.0.0` | Ingress bind. |
| `MCP_DATA_DIR` | `data` | DB, repos, runtime state. |
| `MCP_DB_PATH` | `data/gateway.db` | SQLite file. |
| `MCP_MASTER_KEY` | — | Bootstrap master key, created on first boot only if no keys exist. |
| `MCP_VAULT_SECRET` | — (required for vault) | scrypt input for the AES-256-GCM key. |
| `MCP_KEY_PEPPER` | — | Optional HMAC pepper for key hashes. |
| `MCP_DELEGATION_MAX_DEPTH` | `3` | Hard recursion cap. |
| `MCP_GIT_IMPORT_ALLOWED_PREFIXES` | off | Comma-separated clone URL allowlist. |
| `MCP_UI_DIST` | `ui/dist` | Compiled console bundle. |
| `MCP_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent`. |

---

## v0.2 upgrade (shipped)

Major upgrade delivering private-catalog import and approval-gated credential access.

| Area | Delivered |
|---|---|
| Plugin catalog | DB-backed `catalog_sources`; providers for DSH-style umbrella repos (`.gitmodules` + `pinned.json` `mcp[]`/`bundles[]`), single GitHub repos, and arbitrary catalog JSON; install pipeline clone → auto-manifest → bounded build → register → optional start/test; per-source tokens stored in the AES-256 vault. |
| Auto-manifest | Node (`bin`/`main`/conventional entry, dependency-aware build) and Python (`pyproject` + `uv`) detection when `mcp-manifest.json` is absent; unsupported entries flagged before cloning. Private clone auth via git env headers (`x-access-token`), never argv/URL/logs. |
| Harness discovery | Read-only adapters for Claude Code, opencode, OpenMausBot and generic JSON configs; returns env/header **names only**; one-click import preserving command/args/transport, optional `envFile`, runtime mapping. |
| Approval gating | `approvalRequiredTools` per server; gated calls return `-32004` with a ticket; supervisor approval executes the stored call once and the agent retrieves the result with `_meta.escalation_ticket` (one-shot). |
| Vault Warden | Vaultwarden-specific defaults, `GET /admin/vaultwarden` (tools, protection, pending requests, access log), `POST /admin/vaultwarden/protect`, dedicated UI page. Adds `headers` support for remote MCP transports. |
| Schema | Version 2 migration: `servers.headers/env_file/approval_required_tools`, escalation ticket type/args/result/consumed, `catalog_sources`; automatic upgrade from v1. |
| UI | Tabbed catalog workspace (Installed / Discover / Sources / Import), server policy drawer with per-tool protection, install dialog with env + probe result, Vault Warden approvals, toasts/skeletons, deep-linkable routes. |
| Tests | 480 tests / 40 files (unit, integration, live stdio E2E, approval + discovery flows, jsdom UI); real-world validation against a private umbrella catalog and local harness configs. |
