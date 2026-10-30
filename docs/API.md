# Gateway API Contract (v0.10.0)

All JSON bodies are `application/json`. Auth is `Authorization: Bearer <key>` unless noted.
Admin routes require a **master** key, except audit, delegations, escalations and tools which
accept `master` **or** `sup`. Vault routes are master-only. Errors use
`{ "error": { "code": <jsonrpc-code|http>, "message": "...", "data": {...} } }`.

## 0. Web console session auth

The browser console does **not** use API keys. It signs in with the configured
`MCP_UI_USERNAME` / `MCP_UI_PASSWORD` and receives an HttpOnly `mcp_session` cookie
(`SameSite=Strict`, sliding expiry). API keys remain for AI/external management clients.

```jsonc
POST /mcp/v1/auth/login        { "username": "admin", "password": "…" }
  → 200 { "user": { "username": "admin" }, "expiresAt": "…" } + Set-Cookie: mcp_session=…
  → 401 { "error": { "code": -32005, "message": "Invalid username or password." } }

POST /mcp/v1/auth/logout       → { "ok": true } (revokes the session, clears the cookie)
GET  /mcp/v1/auth/me           → { "authenticated": true, "user": { "username": "admin" } }
POST /mcp/v1/auth/password     { "currentPassword": "…", "newPassword": "…" }
  → { "ok": true } (+ cookie cleared; all sessions revoked)
```

Session-authenticated requests are accepted everywhere an admin/master key is
(admin REST, JSON-RPC, metrics, live-log WebSocket). Cookie-authenticated
POST/PUT/PATCH/DELETE requests are rejected when an `Origin` header does not match
the request host (CSRF defence).

## 1. JSON-RPC ingress — `POST /mcp/v1`

Accepts a single request or a batch (max 20). `id` is echoed verbatim. Notifications
(no `id`) return `204`.

### `initialize`
```jsonc
// result
{
  "protocolVersion": "2025-06-18",
  "serverInfo": { "name": "mcp-gateway", "version": "0.10.0" },
  "capabilities": { "tools": { "listChanged": true }, "logging": {} },
  "_meta": { "gateway": { "key_id": "key_...", "key_type": "agent", "delegation_max_depth": 3 } }
}
```

### `tools/list`
```jsonc
// params: { "serverId"?: string }   (optional filter)
// result — MASKED: only tools this key may see; high-privilege hidden unless granted
{
  "tools": [{
    "name": "postgres_read_query",
    "description": "Execute read-only SQL SELECT statements",
    "inputSchema": { "type": "object", "properties": { "sql": { "type": "string" } }, "required": ["sql"] },
    "server_id": "postgres-mcp-v1",
    "tool_id": "postgres-mcp-v1:postgres_read_query"
  }],
  "total": 1
}
```

### `tools/search`
```jsonc
// params: { "query": "database postgres query", "limit": 5, "serverId"?: string }
// result — CENSORED: filtered by key scope before ranking
{
  "tools": [{ "name": "postgres_read_query", "description": "...", "server_id": "postgres-mcp-v1", "tool_id": "...", "score": 0.82 }],
  "total": 1,
  "censored": true
}
```

### `tools/call`
```jsonc
// params: { "name": "postgres_read_query", "arguments": { "sql": "SELECT 1" }, "serverId"?: "..." }
// result — the upstream MCP CallToolResult, augmented with gateway timing:
{
  "content": [{ "type": "text", "text": "..." }],
  "isError": false,
  "structuredContent": null,
  "_meta": { "server_id": "...", "tool_id": "...", "gateway_overhead_ms": 1.4, "sub_server_ms": 12.0 }
}
```
Denial: `code -32001`, `data: { status: "FORBIDDEN", reason: "HIGH_PRIVILEGE_RESTRICTION", ticket_id: "esc-...", escalation_supported: true }`.
Invisible tool: `code -32002`, `message: "Tool Not Found"`.

### `servers/list_permitted`
```jsonc
// result — ZERO-TRUST: unpermitted servers are absent
{ "servers": [{ "id": "postgres-mcp-v1", "name": "postgres", "runtime": "node", "status": "running", "delegation_supported": false, "tool_count": 4 }] }
```

### `agents/delegate`
```jsonc
// params: { "targetId": "observer-bot", "payload": { ... }, "mode"?: "observe_and_verify" }
// result
{ "target_id": "observer-bot", "status": "approved", "verdict": "payload safe", "approval_token": "apr_...", "output": {...}, "latency_ms": 42.1, "depth": 1, "trace_id": "tr_..." }
```
Depth > `MCP_DELEGATION_MAX_DEPTH` → `-32003`.

### `escalations/request`
```jsonc
// params: { "toolId": "db:drop_table", "reason": "HIGH_PRIVILEGE_RESTRICTION", "requestPayload": {...} }
// result
{ "ticket_id": "esc-20261029-8812", "status": "pending", "created_at": "2026-10-29T18:00:00.000Z" }
```

## 2. Health & metrics

| Route | Auth | Response |
|---|---|---|
| `GET /mcp/v1/health` | none | `{ "status": "ok", "version": "0.10.0", "uptimeMs": 1234 }` |
| `GET /mcp/v1/metrics` | any key | `MetricsSnapshot` (see `src/core/ports.ts`) |

## 3. Admin API

### Keys
```jsonc
POST /mcp/v1/admin/keys/create
{ "name": "sales-agent", "keyType": "agent",
  "serverGrants": [{ "serverId": "postgres-mcp-v1", "tools": ["postgres_read_query"],
                     "highPrivilegeTools": [], "guardrails": [
                        { "kind": "regex_applied_to_arguments", "pattern": "\\b(DROP|UPDATE|DELETE)\\b", "mustMatch": false } ] }],
  "delegationAllowed": false, "escalationAllowed": true, "expiresInSeconds": 86400 }
// 201
{ "key": { "id": "key_...", "name": "sales-agent", "keyType": "agent", "keyPrefix": "mcp_ag_ab12",
           "serverGrants": [...], "delegationAllowed": false, "escalationAllowed": true,
           "expiresAt": "...", "revokedAt": null, "createdAt": "...", "lastUsedAt": null },
  "plaintext": "mcp_ag_..." }              // shown exactly once

GET    /mcp/v1/admin/keys                  → { "keys": KeySummary[] }
GET    /mcp/v1/admin/keys/:id              → { "key": KeySummary }
POST   /mcp/v1/admin/keys/:id/revoke       → { "key": KeySummary }
```

### Servers
```jsonc
POST /mcp/v1/admin/servers
{ "name": "echo", "runtime": "node", "transport": "stdio",
  "command": "node", "args": ["tests/fixtures/mcp-echo-server.mjs"],
  "env": {}, "highPrivilegeTools": ["danger_delete"], "delegationSupported": false }
// 201 → { "server": ServerRecord }

GET    /mcp/v1/admin/servers               → { "servers": ServerRecord[] }
POST   /mcp/v1/admin/servers/:id/start     → { "server": ServerRecord }
POST   /mcp/v1/admin/servers/:id/stop      → { "server": ServerRecord }
POST   /mcp/v1/admin/servers/:id/restart   → { "server": ServerRecord }
DELETE /mcp/v1/admin/servers/:id           → { "deleted": true }
GET    /mcp/v1/admin/servers/:id/logs?limit=200 → { "lines": [{ "ts": "...", "stream": "stdout", "line": "..." }] }
POST   /mcp/v1/admin/servers/import        { "url": "https://github.com/org/repo", "name"?: "...", "startAfterBuild"?: true }
                                            → { "server": ServerRecord }
```

### Vault (master key only)
```jsonc
GET    /mcp/v1/admin/vault/secrets              → { "enabled": true, "secrets": [{ "name": "GITHUB_PAT_TOKEN", "createdAt": "...", "updatedAt": "..." }] }
PUT    /mcp/v1/admin/vault/secrets/:name        { "value": "ghp_..." } → { "secret": { "name": "...", "createdAt": "...", "updatedAt": "..." } }
DELETE /mcp/v1/admin/vault/secrets/:name        → { "deleted": true }
```
When `MCP_VAULT_SECRET` is unset the vault endpoints return **503** with
`{ "error": { "code": -32008, "message": "Vault is not configured (set MCP_VAULT_SECRET)", "data": { "reason": "VAULT_DISABLED" } } }`.

### Tools (RBAC scope grid)
```jsonc
GET /mcp/v1/admin/tools → { "tools": [{ "id": "...", "name": "...", "description": "...",
                                        "server_id": "...", "high_privilege": false, "inputSchema": {...} }],
                            "total": 0 }
```

### Audit / delegations / escalations
```jsonc
GET  /mcp/v1/admin/audit?keyId&serverId&toolId&method&status&search&since&until&limit&offset
     → { "entries": AuditEntry[], "total": 0 }
GET  /mcp/v1/admin/delegations?limit=100        → { "traces": DelegationTrace[] }
GET  /mcp/v1/admin/escalations?status=pending   → { "escalations": EscalationTicket[] }
POST /mcp/v1/admin/escalations/:ticket/resolve  { "status": "approved" | "denied", "note"?: "..." }
     → { "escalation": EscalationTicket }
```

## 4. Live logs — `WebSocket /mcp/v1/admin/ws/logs`

Browser WS cannot set headers, so the key is passed as a query parameter:
`ws://<host>/mcp/v1/admin/ws/logs?api_key=<key>&serverId=<optional>`
Server frames: `{ "type": "log", "serverId": "srv_...", "ts": "...", "stream": "stdout", "line": "..." }`.
On invalid key the socket closes with code `4401`.

## 5. Web UI routes (SPA, served from `ui/dist`)

`/` overview · `/catalog` · `/computer-use` · `/connectors` · `/rbac` · `/vault` · `/audit` · `/delegation` · `/playground`

Unknown non-API paths fall back to `index.html`.

## 6. Computer use (v0.9)

Admin routes are mounted under `/mcp/v1/admin/computer-use` and are **master-only** (Bearer
master key or an authenticated console session). The broker bearer token is used server-side
only: `POST /settings` accepts it write-only, and no response ever returns it. Allowed/error
responses use the standard envelope above. Response types are declared in the
`v0.9 — computer use` block of `src/core/types.ts`; the feature guide, availability
semantics, tool catalogue and runbook are in [`COMPUTER-USE.md`](./COMPUTER-USE.md).

| Method | Route | Body | Result |
|---|---|---|---|
| `GET` | `/` | — | `ComputerUseOverview` (settings, broker health, availability, managed server, tools, counts) |
| `GET` | `/computers` | — | `ComputerUseComputersResponse` (fleet + merged availability + `liveUrl`) |
| `POST` | `/settings` | `ComputerUseSettingsInput` | `ComputerUseOverview` (persists URL/CA/enabled + write-only token, restarts the managed server) |
| `POST` | `/availability` | `ComputerUseAvailabilityInput` | `ComputerUseOverview` |
| `POST` | `/sync` | — | `ComputerUseOverview` (reconnect, re-register, refresh tools) |
| `POST` | `/computers/:id/start` | — | `{ "computer": ComputerUseComputerInfo }` |
| `POST` | `/computers/:id/stop` | — | `{ "computer": ComputerUseComputerInfo }` |
| `GET` | `/computers/:id/frame?maxWidth=480` | — | image bytes (`content-type` from broker, `cache-control: private, no-store`, `x-frame-time`); `maxWidth` clamped 160–1600 |
| `GET` | `/activity?limit=50` | — | `{ "activity": AuditEntry[] }`; `limit` clamped 1–500 |

### Settings

```jsonc
POST /mcp/v1/admin/computer-use/settings
{ "brokerUrl": "https://127.0.0.1:7443", "publicBrokerUrl": "https://broker.example.com",
  "caFile": "/certs/broker-ca.pem", "token": "…", "enabled": true }
// → 200 ComputerUseOverview; secrets are never echoed:
//   settings.tokenConfigured / settings.tokenSource ("env" | "vault")
//   server { id: "srv_computer_use", name: "computer-use", status, toolCount }
```

`brokerUrl`/`publicBrokerUrl` must be absolute `http(s)` base URLs (no path/query/fragment);
`caFile` is validated for existence when saved; `token: ""`/`null` clears the **vault** token
(an env-supplied token cannot be cleared and must be unset on the environment).

### Availability

```jsonc
// Global pause with auto-resume (ISO `until` must be in the future), or per-computer pause:
POST /mcp/v1/admin/computer-use/availability
{ "scope": "global", "available": false, "reason": "INC-1234 maintenance",
  "until": "2026-10-30T02:00:00.000Z" }
{ "scope": "computer", "computerId": "cc-1a2b", "available": true }
// → 200 ComputerUseOverview
```

A paused computer-use call is refused before approvals/upstream dispatch with
`-32001 ACCESS_DENIED`, `data: { status: "COMPUTER_UNAVAILABLE", reason:
"COMPUTER_USE_PAUSED" | "COMPUTER_PAUSED", server_id, tool_id, details: { computer_id,
resume_at } }` and an audit row with `status: "denied"`. Calls are never queued.

### Fleet, frames and activity

```jsonc
GET /mcp/v1/admin/computer-use/computers
// → { broker: ComputerUseBrokerInfo, availability: ComputerUseAvailability,
//     computers: ComputerUseComputerInfo[] }
//   ComputerUseComputerInfo includes state, desktop, connector, control lease,
//   availability and liveUrl ( <publicBrokerUrl>/#/d/<computerId> ).

GET /mcp/v1/admin/computer-use/computers/cc-1a2b/frame?maxWidth=480
// → 200 image/jpeg — proxied server-side; no broker credential reaches the browser.

POST /mcp/v1/admin/computer-use/sync
// → 200 ComputerUseOverview

GET /mcp/v1/admin/computer-use/activity?limit=50
// → { "activity": AuditEntry[] }
```

## 7. Connector onboarding & terminal (v0.10)

The console gains a **Connectors** page for onboarding physical Linux PCs as Computer Broker
device connectors. It lists enrolled devices (online/offline, hostname/platform/capabilities)
and pending pairings, and its **Add Linux PC** wizard mints a single-use enrollment plus a
one-line install command. Terminal sessions to a connected device are opened, driven and read
through the gateway, which proxies them server-side.

All routes are mounted under `/mcp/v1/admin/computer-use/connectors` and are **master-only**
(Bearer master key or an authenticated console session). The broker bearer token stays in the
gateway process: the enrollment token is the only per-device secret that crosses the API and it
is returned exactly once, on creation. Response types are declared in the
`v0.10 — connector onboarding` block of `src/core/types.ts`; the architecture, pairing
walkthrough, terminal policy and runbook are in [`COMPUTER-USE.md`](./COMPUTER-USE.md).

| Method | Route (after the prefix) | Body | Result |
|---|---|---|---|
| `GET` | `/` | — | `ComputerUseConnectorsResponse` (broker info, `devices`, `enrollments`, `publicBrokerUrl`, `counts`) |
| `POST` | `/enrollments` | `ComputerUseEnrollmentInput` | `ComputerUseEnrollmentResponse` (`enrollment.token` shown once + `install.command`) |
| `DELETE` | `/enrollments/:id` | — | `{ "deleted": true }` (revokes a pending pairing; the token is dead) |
| `POST` | `/devices/:id/terminal/open` | `{ "rows"?, "cols"?, "shell"?, "cwd"? }` | `{ "session": "…" }` |
| `POST` | `/devices/:id/terminal/send` | `{ "session": "…", "input": "…", "enter"?: true }` | `{ "ok": true }` |
| `GET` | `/devices/:id/terminal/read?session=&lines=&waitSeconds=` | — | `{ "session": "…", "lines": string[], "changed": boolean }` (`lines` 1–2000, default 200; `waitSeconds` 0–30, default 0) |
| `POST` | `/devices/:id/terminal/close` | `{ "session": "…" }` | `{ "ok": true }` |

### Pairing

```jsonc
POST /mcp/v1/admin/computer-use/connectors/enrollments
{ "name": "workshop-pc", "ttlSeconds": 3600, "allowTerminal": false }
// → 200 ComputerUseEnrollmentResponse
{
  "enrollment": {
    "id": "enr_…", "kind": "device",
    "expiresAt": "2026-10-30T01:00:00.000Z", "createdAt": "2026-10-30T00:00:00.000Z",
    "token": "…"                       // single-use; returned exactly once, never listed again
  },
  "install": {
    "command": "curl -fsSLk 'https://broker.example.com/install/install-connector.sh' | bash -s -- --broker 'wss://broker.example.com/connector' --enroll '…' --name 'workshop-pc'",
    "brokerUrl": "https://broker.example.com",
    "connectorUrl": "wss://broker.example.com/connector",
    "caUrl": "https://broker.example.com/install/broker-ca.pem",
    "allowTerminal": false,
    "expiresAt": "2026-10-30T01:00:00.000Z"
  }
}
```

`kind` is `"device"` (default) or `"computer"`; `name` defaults to `linux-pc`. `ttlSeconds`
is clamped to 60–86400 (default 3600; the console wizard offers 15–1440 minutes). Creating an
enrollment requires a **public broker URL** to be configured in Computer-use settings, because
the new machine must be able to reach it — without one the request fails with an explanatory
error. `GET /` is also the polling source for the wizard: it reports the same
`publicBrokerUrl` and the current pending `enrollments`, so the console can detect the new
device appearing after the token is claimed.

### Terminal

```jsonc
POST /mcp/v1/admin/computer-use/connectors/devices/dev_…/terminal/open
{ "rows": 30, "cols": 120 }
// → { "session": "ts_…" }

POST /mcp/v1/admin/computer-use/connectors/devices/dev_…/terminal/send
{ "session": "ts_…", "input": "uptime", "enter": true }     // enter defaults to true
// → { "ok": true }

GET /mcp/v1/admin/computer-use/connectors/devices/dev_…/terminal/read
    ?session=ts_…&lines=200&waitSeconds=1
// → { "session": "ts_…", "lines": ["…"], "changed": true }

POST /mcp/v1/admin/computer-use/connectors/devices/dev_…/terminal/close
{ "session": "ts_…" }
// → { "ok": true }
```

Terminal access is **opt-in on the connector**: the enrollment must have been created with
`allowTerminal: true` (the installer receives `--terminal` and writes
`terminal.enabled: true` into the connector policy), and the device must advertise the
connector's `term.*` capabilities. A device that does not is refused with the standard error
envelope — opening a shell is a real command channel, so it is never silently enabled. The
default installer policy keeps the terminal off.

