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

---

## 7. v0.4 — update manager

Installed servers keep their upstream metadata in `server_sources` (repo, requested ref/commit,
installed version/commit, latest known version/commit, update flag, changelog URL).

```jsonc
GET  /mcp/v1/admin/updates
→ { "sources": [{
      "serverId": "srv_…", "sourceKind": "catalog", "catalogSourceId": "cat_…",
      "catalogEntryId": "brain-mcp", "repoUrl": "https://github.com/example/brain-mcp",
      "requestedRef": "v1.1.0", "installedVersion": "1.1.0", "installedCommit": "a1b2c3…",
      "latestVersion": "1.2.0", "latestCommit": "d4e5f6…", "latestRef": "v1.2.0",
      "updateAvailable": true, "checkedAt": "2026-10-29T19:00:00.000Z",
      "checkError": null,
      "changelogUrl": "https://github.com/example/brain-mcp/compare/a1b2c3…d4e5f6…" }] }

POST /mcp/v1/admin/updates/check            { "serverIds": ["srv_…"] }   // omit for all
→ { "results": [{ "serverId": "srv_…", "serverName": "brain", "status": "update-available",
                  "updateAvailable": true, "fromVersion": "1.1.0", "toVersion": "1.2.0",
                  "fromCommit": "a1b2c3…", "toCommit": "d4e5f6…", "latestRef": "v1.2.0",
                  "checkedAt": "…", "error": null }] }

POST /mcp/v1/admin/updates/servers/:id/check
→ { "update": UpdateCheckResult }

POST /mcp/v1/admin/updates/backfill
→ { "recorded": 6, "skipped": 0, "errors": [] }   // records sources for pre-v0.4 servers
                                                   // (catalog markers / name / repo URL match)

POST /mcp/v1/admin/updates/servers/:id/update   { "ref": "v1.2.0", "restart": true, "test": true }
→ { "result": {
      "server": ServerRecord,
      "before": { "version": "1.1.0", "commit": "a1b2c3…" },
      "after":  { "version": "1.2.0", "commit": "d4e5f6…" },
      "test":   { "ok": true, "toolCount": 12, "tools": ["…"], "latencyMs": 3.1, "error": null },
      "changed": true } }
```

Update behaviour: staged clone/build into a fresh directory; the live server and its
config (env, envFile, headers, protection lists, attached profiles) are untouched until the
build succeeds, then the directory is swapped, the server restarted and probe-tested. A failed
build leaves the running server exactly as it was. Private repos use the catalog source's
vault token (or `GITHUB_TOKEN`/`GH_TOKEN`).

## 8. v0.4 — configuration profiles (gateway-managed, encrypted)

No env files. Every configuration and credential value lives in the gateway's **AES-256-GCM
vault**; a profile is a named, reusable reference set that can be attached to many MCP servers.
A value is either profile-owned (`encrypted`, stored as `PROFILE_<id>_ENV_<KEY>`) or a reference
to an existing named secret from the Vault page (`vault-ref`). The API never returns values —
only keys and where they live.

```jsonc
GET /mcp/v1/admin/config-profiles
→ { "profiles": [{ "id": "cfg_…", "name": "Internal services", "description": "…",
                   "entries": [
                     {"key":"N8N_BASE_URL","source":"encrypted","ref":null},
                     {"key":"N8N_API_KEY","source":"vault-ref","ref":"N8N_API_KEY"} ],
                   "headers": [],
                   "attachedServerIds": ["srv_…"] }] }

POST /mcp/v1/admin/config-profiles
{ "name": "Internal services",
  "entries": [
    { "key": "N8N_BASE_URL", "value": "http://10.0.0.5:5678" },   // encrypted now, never returned
    { "key": "N8N_API_KEY",  "secretRef": "N8N_API_KEY" }          // reuse a Vault-page secret
  ],
  "headers": [] }
→ 201 { "profile": ConfigProfileSummary }

PUT    /mcp/v1/admin/config-profiles/:id      → { "profile": … }
DELETE /mcp/v1/admin/config-profiles/:id      → { "deleted": true }

POST /mcp/v1/admin/config-profiles/:id/apply
{ "serverIds": ["srv_…"], "restart": true, "test": true }
→ { "results": [{ "serverId": "srv_…", "serverName": "n8n", "applied": true,
                  "restarted": true, "test": { "ok": true, "toolCount": 36, … }, "error": null }] }

DELETE /mcp/v1/admin/config-profiles/:id/servers/:serverId → { "detached": true }

POST /mcp/v1/admin/config-profiles/migrate-env-file
{ "serverId": "srv_…", "name": "Migrated n8n config" }
→ { "profile": ConfigProfileSummary }     // reads the legacy env file once, encrypts every value,
                                          // attaches the profile, then clears server.envFile
```

At process start the gateway resolves the attached profiles from the vault and injects the
values into the sub-process environment/headers. Merge precedence: attached profiles (in order) <
server-specific env/headers. Secrets are decrypted only in the gateway process, never written to
SQLite, logs, or API responses.

## 9. v0.5 — MCP server inspector

Everything an AI (or an operator) can use from one server, plus its encrypted configuration,
upstream version and per-server request history.

```jsonc
GET /mcp/v1/admin/servers/:id/inspector
→ {
  "server": ServerRecord,                 // includes runtime/transport/status/pid/workDir, manifest,
                                          // capabilities, instructions, prompts[], resources[],
                                          // env, headers, protection lists, configProfileIds
  "source": ServerSourceInfo | null,      // repo/ref/installed+latest version+commit/changelog
  "tools": ToolDescriptor[],              // full inputSchema for each tool
  "prompts": [{ "name": "…", "description": "…",
                "arguments": [{ "name": "…", "required": true }] }],
  "resources": [{ "uri": "demo://readme", "name": "…", "mimeType": "text/markdown" }],
  "config": {
    "env":     [{ "key": "N8N_API_KEY", "masked": true, "value": null, "source": "server" }],
    "headers": [{ "key": "Authorization", "masked": true, "value": null, "source": "header" }],
    "profiles": [{ "id": "cfg_…", "name": "n8n connection", "description": "…",
                   "entries": [{ "key": "N8N_API_KEY", "source": "encrypted", "ref": null }],
                   "headers": [] }],
    "vaultRefs": ["SHARED_DEMO_TOKEN"]
  },
  "stats": { "total": 142, "ok": 130, "error": 4, "denied": 8, "errorRate": 0.0845,
             "lastUsedAt": "…", "avgLatencyMs": 12.4, "p50LatencyMs": 9.1, "p95LatencyMs": 41.0,
             "distinctKeys": 3,
             "toolUsage": [{ "toolId": "srv_…:ssh_run", "name": "ssh_run", "count": 40,
                             "lastUsedAt": "…", "avgLatencyMs": 15.2 }] },
  "keysUsed": [{ "keyId": "key_…", "keyName": "dsh-harness", "keyPrefix": "mcp_master_",
                 "keyType": "master", "count": 120, "lastUsedAt": "…" }],
  "activity": [ AuditEntry, … ]          // most recent 20 (ok/error/denied)
}

GET /mcp/v1/admin/servers/:id/activity?status=ok|error|denied&toolId=&keyId=&limit=&offset=
→ { "summary": ServerUsageStats, "entries": AuditEntry[], "total": 0 }

POST /mcp/v1/admin/servers/:id/reveal
{ "kind": "env" | "header" | "profile", "key": "N8N_API_KEY", "profileId": "cfg_…" }
→ { "key": "N8N_API_KEY", "value": "…" }   // master-only; every reveal writes an
                                          // audit entry (method "admin.reveal") — the value
                                          // itself is never logged
```

### Proxied MCP capabilities (JSON-RPC)

The gateway now also proxies prompts/resources for permitted servers (server-level grants;
invisible servers are indistinguishable from unknown). Audit rows record the server.

```jsonc
{ "method": "prompts/list",             "params": { "serverId": "srv_…" } }   // serverId optional
{ "method": "prompts/get",              "params": { "name": "summarize", "arguments": {…}, "serverId": "…" } }
{ "method": "resources/list",           "params": { "serverId": "srv_…" } }
{ "method": "resources/templates/list", "params": { "serverId": "srv_…" } }
{ "method": "resources/read",           "params": { "uri": "demo://readme", "serverId": "…" } }
```

`initialize` now advertises `prompts` and `resources` capabilities alongside `tools`. Prompts,
resources, instructions and capabilities are discovered automatically at server start and stored
on the server record so the inspector always has them.

## 10. v0.6 — first-run onboarding, settings & encrypted backups

### First-run setup

A fresh gateway with no Web UI user starts in **setup mode** (no env password needed).
`GET /mcp/v1/auth/me` answers `200 { authenticated: false, setupRequired: true, restoreSupported: true }`
until the operator account exists.

```jsonc
POST /mcp/v1/auth/setup              { "username": "admin", "password": "…" }
→ 201 { "user": { "username": "admin" }, "expiresAt": "…", "setupRequired": false }
     + Set-Cookie: mcp_session=…      // 409 once a user exists, 400 on invalid input

POST /mcp/v1/auth/setup/restore      { "backup": <object | base64 envelope>, "password": "…" }
→ { "result": RestoreResult }         // first-run only (409 after setup); restores users,
                                      // keys, servers, profiles, catalog sources and vault
                                      // secrets, then the operator signs in with the original
                                      // account password
```

If `MCP_UI_PASSWORD` is set in the environment the bootstrap user is created as before and
setup is skipped (backwards compatible).

### Settings

```jsonc
GET /mcp/v1/admin/settings
→ { "settings": {
      "version": "0.6.0", "host": "0.0.0.0", "port": 8080,
      "dataDir": "/data", "dbPath": "/data/gateway.db", "reposDir": "/data/repos",
      "uiDistDir": "/app/ui/dist", "vaultEnabled": true,
      "gitImportEnabled": true, "gitImportAllowedPrefixes": ["https://github.com/"],
      "delegationMaxDepth": 3, "autostart": "all", "logLevel": "info",
      "uiUsername": "admin", "userCount": 1, "sessionCount": 1, "setupRequired": false },
    "account": { "username": "admin", "sessionCount": 1 } }
```

These are read-only views of the environment/container configuration (change them in the
deployment env and restart), so the console documents the running setup without exposing secrets.

### Password-encrypted backups

A backup contains the complete gateway state — Web UI accounts (password hashes), API keys
(hashes), servers/tools/protection, catalog sources, configuration profiles, escalation and
delegation history, settings, optional audit rows, and **every vault secret** — serialised to
gzip JSON and encrypted with **AES-256-GCM using a scrypt-derived key from the operator's login
password**. The password is never stored anywhere. Restoring requires the same password.

```jsonc
POST /mcp/v1/admin/backups          { "password": "…", "includeAudit": true }
→ 201 BackupMetadata { "id": "backup_…", "fileName": "backup_….mcpbak",
      "createdAt": "…", "sizeBytes": 123456, "gatewayVersion": "0.6.0",
      "includeAudit": true,
      "counts": { "users": 1, "keys": 3, "servers": 6, "tools": 276, "profiles": 1,
                  "catalogSources": 1, "secrets": 14, "auditEntries": 812 } }

GET    /mcp/v1/admin/backups                 → { "backups": BackupMetadata[] }
GET    /mcp/v1/admin/backups/:id/download    → the .mcpbak file (attachment)
DELETE /mcp/v1/admin/backups/:id             → { "deleted": true }

POST /mcp/v1/admin/backups/restore
{ "backup": <object | base64 envelope>, "password": "…", "confirm": "RESTORE" }
→ { "result": {
      "usersRestored": 1, "keysRestored": 3, "serversRestored": 6, "toolsRestored": 276,
      "profilesRestored": 1, "catalogSourcesRestored": 1, "secretsRestored": 14,
      "auditEntriesRestored": 812,
      "reinstallRequired": [ { "serverId": "srv_…", "name": "brain" } ] } }
```

Restore semantics: decrypt + validate, then atomically replace the account/key/server/tool/
profile/catalog/audit/settings tables; vault secrets are re-encrypted into the local vault
(requires `MCP_VAULT_SECRET`); sessions are cleared; restored servers are stopped. Repository
checkouts are **not** included in the backup — servers whose working directory is missing are
returned in `reinstallRequired` and can be rebuilt from their tracked source with
`POST /mcp/v1/admin/updates/servers/:id/reinstall` (staged clone/build/swap/start/probe).
