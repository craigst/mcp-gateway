# Gateway API v0.2 — catalog, harness import, approvals & Vault Warden

Additive to [`API.md`](./API.md). Auth rules are unchanged: admin routes require a **master**
key unless stated; vault secrets are master-only. All new admin routes live under
`/mcp/v1/admin`. Errors keep the `{ "error": { "code", "message", "data" } }` shape.

---

## 1. Plugin catalog (GitHub / private repositories)

### Sources

```jsonc
GET    /mcp/v1/admin/catalog/sources
→ { "sources": [{
      "id": "cat_ab12", "label": "Internal MCP catalog", "kind": "dsh-umbrella",
      "repoUrl": "https://github.com/example/private-mcp-catalog",
      "ref": "main", "subpath": null,
      "tokenSecretName": "CATALOG_cat_ab12_TOKEN",   // never the token itself
      "createdAt": "...", "updatedAt": "..." }] }

POST   /mcp/v1/admin/catalog/sources
{ "label": "Internal MCP catalog", "kind": "dsh-umbrella" | "github-repo" | "catalog-json",
  "repoUrl": "https://github.com/…", "ref": "main", "subpath": null,
  "token": "ghp_…" }                    // optional; stored in the AES-256 vault, never returned
→ 201 { "source": CatalogSource }

DELETE /mcp/v1/admin/catalog/sources/:id → { "deleted": true }
```

### Entries & install

```jsonc
GET  /mcp/v1/admin/catalog/sources/:id/entries[?refresh=1]
→ { "source": CatalogSource, "entries": [{
      "id": "brain-mcp", "sourceId": "cat_ab12", "name": "brain-mcp",
      "repoUrl": "https://github.com/…/brain-mcp", "ref": "v1.1.0",
      "entry": "brain-mcp.js", "kind": "mcp", "serverName": "brain",
      "description": "…", "installCommand": "./scripts/dsh-wire.sh --deploy",
      "supported": true, "unsupportedReason": null,
      "installedServerId": "srv_…" | null }] }

POST /mcp/v1/admin/catalog/install
{ "sourceId": "cat_ab12", "entryId": "brain-mcp", "name": "brain",
  "env": { "BRAIN_URL": "http://…" }, "envFile": "~/.config/example/mcp.env",
  "start": true, "test": true }
→ 201 { "server": ServerRecord,
        "test": { "ok": true, "toolCount": 7, "tools": ["brain_whoami", "…"],
                  "latencyMs": 42.1, "error": null } | null,
        "buildLogTail": ["…"] }

POST /mcp/v1/admin/catalog/import-url
{ "url": "https://github.com/org/mcp-server", "ref": "main", "subpath": null,
  "name": "custom", "env": {}, "envFile": null, "start": true, "test": true }
→ same shape as install
```

`kind` semantics:
- `dsh-umbrella` — umbrella repo whose `.gitmodules` lists plugin repos and whose
  `pinned.json` carries `mcp[]` / `bundles[]` metadata (private catalogs supported through the token).
- `github-repo` — a single MCP server repository (auto-manifest detection applies).
- `catalog-json` — a raw JSON URL returning `{ "entries": [ … ] }` (no auth).

Private repos are cloned with a token from the vault or `GITHUB_TOKEN`/`GH_TOKEN`.
Tokens are never returned by any endpoint or written to logs/build output.

### Auto-manifest detection

When a repository has no `mcp-manifest.json`, the importer derives one:
- Node: `package.json` → `bin`/`main` entry, `node <entry>`, and
  `npm install --omit=dev` when `dependencies` is non-empty.
- Python: `pyproject.toml`/`setup.py` + `server.py` → `uv sync` + `uv run python server.py`.
- If no entry can be detected the entry is reported `supported: false` with a reason.

---

## 2. Harness discovery (import existing MCP servers)

```jsonc
GET  /mcp/v1/admin/discovery/sources
→ { "sources": [{ "id": "claude", "label": "Claude Code", "configPath": "/home/user/.claude.json",
                  "exists": true, "serverCount": 4 }] }

POST /mcp/v1/admin/discovery/scan          // body optional: { "harnessIds": ["claude"] }
→ { "sources": [ … ],
    "entries": [{
      "id": "claude:brain", "harness": "claude", "name": "brain", "transport": "stdio",
      "command": "node", "args": ["/path/brain-mcp.js"], "url": null,
      "envKeys": ["BRAIN_API_KEY"],            // NAMES only — values are never returned
      "envFile": null,
      "headerKeys": [],
      "enabled": true }],
    "errors": [{ "harness": "opencode", "error": "…" }] }

POST /mcp/v1/admin/discovery/import
{ "harness": "claude", "name": "brain", "transport": "stdio",
  "command": "node", "args": ["/path/brain-mcp.js"],
  "env": { "BRAIN_API_KEY": "…" },            // optional; the user supplies values
  "envFile": "~/.config/opencode/mcp.env",    // optional; values stay on disk
  "highPrivilegeTools": [], "approvalRequiredTools": [] }
→ 201 { "server": ServerRecord }
```

Built-in adapters: **claude** (`~/.claude.json`), **opencode**
(`~/.config/opencode/opencode.json` + `mcp.env`), **openmausbot**
(`~/.openmausbot/config.json`), **generic** (`MCP_DISCOVERY_CONFIG` env pointing at a
JSON file with `mcpServers`). Paths can be overridden per adapter with
`MCP_DISCOVERY_<ID>_CONFIG`. Discovery is read-only and local-only.

---

## 3. Tool approval gating

A server may list `approvalRequiredTools` (set at import or via the policy endpoint).
Calling such a tool returns:

```jsonc
{ "jsonrpc": "2.0", "id": 9, "error": {
    "code": -32004,
    "message": "Approval required: 'vault_deliver_credential' needs a supervisor ticket before execution.",
    "data": { "status": "ESCALATION_REQUIRED", "reason": "APPROVAL_REQUIRED",
              "ticket_id": "esc-20261029-ab12", "escalation_supported": true,
              "tool_id": "srv_…:vault_deliver_credential", "server_id": "srv_…" } } }
```

A supervisor approves/denies it with the existing escalation route:

```jsonc
POST /mcp/v1/admin/escalations/:ticket/resolve
{ "status": "approved" | "denied", "note": "…" }
→ { "escalation": EscalationTicket,
    "result": { "content": [ … ], "isError": false } | undefined }   // approved tool_approval only
```

On approval the gateway **executes the stored tool call once** and stores the MCP result.
The agent then retries the same `tools/call` with the ticket:

```jsonc
{ "jsonrpc": "2.0", "id": 10, "method": "tools/call",
  "params": { "name": "vault_deliver_credential", "arguments": { "item": "…" },
              "_meta": { "escalation_ticket": "esc-20261029-ab12" } } }
```

or sends the header `X-MCP-Escalation-Ticket: esc-…`. The stored result is returned once
(ticket is consumed); subsequent attempts fail. Results never contain raw secret values —
Vaultwarden tools return a short-lived file path instead.

### Server policy endpoint

```jsonc
PATCH /mcp/v1/admin/servers/:id/policy
{ "highPrivilegeTools": ["vault_deliver_credential"],
  "approvalRequiredTools": ["vault_deliver_credential", "vault_rotate_webui_login"],
  "envFile": "~/.config/vaultwarden/mcp.env" }
→ { "server": ServerRecord }
```

### Server tools + test endpoints

```jsonc
GET /mcp/v1/admin/servers/:id/tools
→ { "serverId": "srv_…", "approvalRequiredTools": ["…"], "highPrivilegeTools": ["…"],
    "tools": [{ "id": "srv_…:vault_status", "name": "vault_status", "description": "…",
                "highPrivilege": false, "approvalRequired": false, "inputSchema": {…} }],
    "total": 12 }
```

### Server test endpoint

```jsonc
POST /mcp/v1/admin/servers/:id/test
→ { "ok": true, "toolCount": 12, "tools": ["vault_status", "…"], "latencyMs": 38.2, "error": null }
```

---

## 4. Vault Warden

```jsonc
GET /mcp/v1/admin/vaultwarden
→ { "installed": true,
    "serverId": "srv_…", "serverName": "vaultwarden", "status": "running",
    "tools": [{ "name": "vault_deliver_credential", "description": "…",
                "highPrivilege": true, "approvalRequired": true }],
    "defaults": { "approvalTools": ["vault_deliver_credential", "…"],
                  "highPrivilegeTools": ["vault_deliver_credential", "…"] },
    "pendingApprovals": [ EscalationTicket … ],
    "accessLog": [ AuditEntry … ] }        // recent vault_* tool calls (who/what/when)

POST /mcp/v1/admin/vaultwarden/protect
{ "serverId": "srv_…" }                    // applies the default protection sets
→ { "server": ServerRecord, "protectedTools": ["vault_deliver_credential", "…"] }
```

When the plugin is not installed the response is
`{ "installed": false, "defaults": {…}, "pendingApprovals": [], "accessLog": [] }` so the UI
can render an install call-to-action (import `vaultwarden-mcp` from the catalog/harness tab).

---

## 5. Data-model additions

- `ServerRecord.envFile: string | null` — env file read at start; values never persisted.
- `ServerRecord.approvalRequiredTools: string[]` — tools gated by approval.
- `EscalationTicket.ticketType: 'scope' | 'tool_approval'`, `toolArguments`, `result`,
  `consumedAt`.
- `catalog_sources` table (sources above), schema version 2 with automatic migration.

## 6. UI routes

`/` dashboard · `/catalog` (tabs: Installed · Discover · Sources · Import) ·
`/vaultwarden` · `/rbac` · `/vault` · `/audit` · `/delegation` · `/playground`.
