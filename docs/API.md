# Gateway API Contract (v0.1.0)

All JSON bodies are `application/json`. Auth is `Authorization: Bearer <key>` unless noted.
Admin routes require a **master** key, except audit, delegations, escalations and tools which
accept `master` **or** `sup`. Vault routes are master-only. Errors use
`{ "error": { "code": <jsonrpc-code|http>, "message": "...", "data": {...} } }`.

## 1. JSON-RPC ingress — `POST /mcp/v1`

Accepts a single request or a batch (max 20). `id` is echoed verbatim. Notifications
(no `id`) return `204`.

### `initialize`
```jsonc
// result
{
  "protocolVersion": "2025-06-18",
  "serverInfo": { "name": "mcp-gateway", "version": "0.1.0" },
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
| `GET /mcp/v1/health` | none | `{ "status": "ok", "version": "0.1.0", "uptimeMs": 1234 }` |
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

`/` overview · `/catalog` · `/rbac` · `/vault` · `/audit` · `/delegation` · `/playground`

Unknown non-API paths fall back to `index.html`.
