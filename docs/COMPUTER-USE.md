# Computer use (v0.9)

The gateway can front an external, self-hosted **Computer Broker** as a managed built-in MCP
server named `computer-use`. The broker owns the virtual desktops, the desktop viewer and the
device connectors; the gateway owns the policy plane — authentication, per-key RBAC, catalog
censorship, argument guardrails, approvals and audit. Agents therefore get computer-use and
device tools through the same `/mcp/v1` endpoint as every other sub-server, while the browser
console gains a fleet view, live frame previews and availability (pause/resume) controls.

The broker token never leaves the gateway process: it is not stored on the managed server row,
never returned by the API, and screenshots are proxied server-side.

## Architecture

```
┌─────────────┐   JSON-RPC 2.0 over HTTP           ┌────────────────────────────┐
│  AI agent / │ ─────────────────────────────────► │         MCP Gateway        │
│  harness    │   POST /mcp/v1  (mcp_ag_… key)     │                            │
│             │ ◄───────────────────────────────── │  ingress → RBAC → audit    │
└─────────────┘   tools/list · tools/call          │  computer-use supervisor   │
                                                   └──────┬──────────────┬──────┘
                          HTTPS + bearer (server-side only)│              │ session cookie
                                                          ▼              ▼
                                              ┌────────────────────┐  ┌──────────────┐
                                              │  Computer Broker   │  │   Console    │
                                              │  :7443  /mcp + REST│  │  (browser)   │
                                              └─────────┬──────────┘  └──────────────┘
                                                        │
                                        ┌───────────────┴───────────────┐
                                        ▼                               ▼
                                 virtual desktops                 device connectors
                                 (viewer / frame source)          (files · exec · terminal)
```

Two paths reach the broker:

1. **Agent path (server-side):** the gateway's managed `computer-use` MCP client speaks
   Streamable HTTP to `<MCP_COMPUTER_BROKER_URL>/mcp` with the broker bearer token, and proxies
   MCP results back to the agent. Agents never see the broker URL or token.
2. **Console path (browser):** the console uses the gateway's admin API. Live frame previews
   come from `GET /mcp/v1/admin/computer-use/computers/:id/frame`, which the gateway fetches
   from the broker server-side. The "open live desktop" link points the browser at the broker's
   own public viewer URL; the gateway only renders the link.

The broker surface consumed by the gateway is deliberately small:

| Broker route | Used for |
|---|---|
| `GET /healthz` | Broker status/version and fleet counts shown on the console card (unauthenticated by the broker). |
| `GET /api/computers` · `GET /api/computers/{id}` | Fleet list and per-computer snapshot (`state`, viewer, connector, control lease). |
| `POST /api/computers/{id}/start` · `/stop` | Computer lifecycle actions. |
| `GET /api/computers/{id}/frame?max_width=` | JPEG stills proxied to the console. |
| `POST /mcp` | Streamable-HTTP MCP JSON-RPC — the tool surface agents see. |

## Configuration

All settings are read at boot (`src/core/config.ts`, `loadComputerUse`). The **environment
seeds the stored settings on first boot**; after that the settings row in SQLite is
authoritative and is changed from the console (`POST /settings`) or the admin API. Changing an
env var on a gateway whose settings row already exists does not reconfigure it — use the
console, or remove/reset the row deliberately.

The integration is **active** only when all three are true: `enabled`, a broker URL is
configured, and a token resolves. While inactive, the managed `computer-use` server row is not
registered (an existing one is removed) and no computer-use tools are exposed.

| Variable | Default | Meaning |
|---|---|---|
| `MCP_COMPUTER_USE_ENABLED` | `true` | Master switch. `false` disables the integration; the managed server is removed/not registered. |
| `MCP_COMPUTER_BROKER_URL` | *(unset)* | Server-side broker base URL, e.g. `https://127.0.0.1:7443`. **Unset = integration disabled/unconfigured.** Must be an absolute `http(s)` base URL with no path, query or fragment. |
| `MCP_COMPUTER_BROKER_PUBLIC_URL` | broker URL | Browser-facing base URL used for "open live desktop" links (e.g. `https://broker.example.com` behind a reverse proxy). |
| `MCP_COMPUTER_BROKER_TOKEN` | *(unset)* | Optional **bootstrap** bearer token for the broker. Takes precedence over a vault token; the preferred long-term store is the console/vault. |
| `MCP_COMPUTER_BROKER_CA` | *(unset)* | Optional PEM CA bundle path for a mkcert/self-signed broker certificate. The path is validated when settings are saved, so in Docker it must be the mounted container path. |

Docker Compose already passes the block through with empty/disabled-safe defaults, and the
runtime image ships `ca-certificates`. For a self-signed broker CA, mount the PEM read-only
and point the variable at the container path:

```yaml
services:
  gateway:
    environment:
      MCP_COMPUTER_BROKER_URL: https://broker.internal:7443
      MCP_COMPUTER_BROKER_CA: /certs/broker-ca.pem
    volumes:
      - ./data:/data
      - ./certs/broker-ca.pem:/certs/broker-ca.pem:ro
```

## Managed server and RBAC

When active, the gateway registers and starts a built-in MCP server:

| Field | Value |
|---|---|
| Name | `computer-use` |
| Id | `srv_computer_use` (stable, so RBAC grants survive a broker reconfiguration) |
| Runtime | `remote-agent` |
| Transport | `http` (Streamable HTTP MCP) |
| URL | `<MCP_COMPUTER_BROKER_URL>/mcp` |
| High-privilege tools | Explicit allowlist (`highPrivilegeTools` on the server record) |
| Approval-required tools | `destroy_computer`, `device_exec` (`approvalRequiredTools`) |

The server shows up in **Catalog → Installed** like any other server and can be inspected.
It is a managed integration: deleting it does not delete the broker, and `POST /sync`
re-registers it and refreshes the tool catalogue. Applying new settings also stops and
restarts it automatically.

Tools are ordinary gateway tools once registered, so RBAC works exactly as elsewhere. A key
must hold a grant for the `computer-use` server. High-privilege tools are hidden from
`tools/list` / `tools/search` and denied with `-32001 HIGH_PRIVILEGE_RESTRICTION` unless
explicitly granted in `highPrivilegeTools`.

```jsonc
// Grant a least-privilege agent read-only computer access plus explicit click/type.
POST /mcp/v1/admin/keys/create
{
  "name": "desktop-operator",
  "keyType": "agent",
  "serverGrants": [{
    "serverId": "srv_computer_use",
    "tools": [
      "list_computers", "computer_status", "computer_screenshot", "computer_windows",
      "list_templates", "list_devices", "device_file_list", "device_file_read",
      "device_terminal_read"
    ],
    "highPrivilegeTools": [
      "computer_click", "computer_move", "computer_type", "computer_key",
      "computer_scroll", "computer_open_app"
    ]
  }],
  "escalationAllowed": true
}
```

Grant the read-only tools above rather than the whole server if the agent only needs to
observe: the input and lifecycle tools act on real machines.

## Tool catalogue and privilege model

| Tool | Purpose | Read-only | High privilege | Approval required |
|---|---|:---:|:---:|:---:|
| `list_templates` | List templates available for new computers | ✅ | — | — |
| `list_computers` | List broker computers and their state | ✅ | — | — |
| `computer_status` | Status of one computer | ✅ | — | — |
| `computer_screenshot` | Capture a frame/desktop screenshot | ✅ | — | — |
| `computer_windows` | List open windows on a computer | ✅ | — | — |
| `list_devices` | List device connectors | ✅ | — | — |
| `device_file_list` | List files on a device | ✅ | — | — |
| `device_file_read` | Read a file from a device | ✅ | — | — |
| `device_terminal_read` | Read terminal output | ✅ | — | — |
| `create_computer` | Create a computer from a template | — | ✅ | — |
| `start_computer` | Start a stopped computer | — | ✅ | — |
| `stop_computer` | Stop a computer | — | ✅ | — |
| `destroy_computer` | Destroy a computer | — | ✅ | ✅ |
| `computer_click` | Mouse click | — | ✅ | — |
| `computer_move` | Move the pointer | — | ✅ | — |
| `computer_type` | Type text | — | ✅ | — |
| `computer_key` | Press a key / key chord | — | ✅ | — |
| `computer_scroll` | Scroll | — | ✅ | — |
| `computer_open_app` | Open an application | — | ✅ | — |
| `device_exec` | Execute a command on a device | — | ✅ | ✅ |
| `device_terminal_open` | Open a terminal session | — | ✅ | — |
| `device_terminal_send` | Send input to a terminal session | — | ✅ | — |
| `device_terminal_close` | Close a terminal session | — | ✅ | — |

Privilege semantics:

- **Read-only** tools are visible to a key that holds the server grant.
- **High privilege** tools are omitted from discovery. A call without an explicit
  `highPrivilegeTools` grant is denied with `-32001 HIGH_PRIVILEGE_RESTRICTION` (plus an
  escalation ticket when escalation is allowed).
- **Approval required** tools additionally return `-32004 ESCALATION_REQUIRED` with a
  `tool_approval` ticket. The operator resolves it in the console; the gateway executes the
  stored call once and the agent collects the result with the ticket
  (`_meta.escalation_ticket` or the `x-mcp-escalation-ticket` header). Use this for
  destructive or shell-level actions (`destroy_computer`, `device_exec`).

Agent calls go through the normal gateway JSON-RPC surface:

```bash
KEY="mcp_ag_…"
curl -s localhost:8080/mcp/v1 -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"computer_screenshot","arguments":{ }}}'
```

(Arguments are the broker's own tool arguments; run `tools/search`/`tools/list` first to see
the schema the key is permitted to view.)

## Availability (pause / resume)

Availability is **operational state, not a grant**. A paused computer stays visible to a
permitted key; it is simply refused. The console exposes a global switch and a per-computer
switch, each with an optional free-text `reason` (trimmed, max 200 chars, default
`Paused by operator`) and an optional ISO `until` auto-resume.

| Scope | Storage | Effect |
|---|---|---|
| Global | `computer_use_settings.agents_available` | Pauses computer use for every computer and every agent call. |
| Per-computer | `computer_use_availability` row | Pauses that one computer; absence of a row = available. |
| Recorded attribution | `updated_by` | The operator/API-key principal that last changed availability. |

Effective availability is global availability **and** per-computer availability. In the fleet
response each computer reports the merged result, so a global pause is shown on every tile.

Change semantics:

- `available: false` with no `until` = open-ended pause until an operator resumes it.
- `available: false` with `until` = pause that auto-resumes when `until` passes. `until` must
  be a **future** ISO timestamp (past timestamps are rejected); it is normalised to UTC ISO.
  Expiry is evaluated on read: **an expired pause is not a pause**, no background job is
  required.
- `available: true` clears the stored pause, reason and `until`, and records `updatedBy`.
- A per-computer pause is enforced on calls whose arguments identify a computer — the gateway
  reads `computer_id`, `computerId` or `id` from the call arguments. Fleet-level and device
  tools without a computer id are covered by the global switch.

The availability gate runs after RBAC and **before** approvals or upstream dispatch. A paused
call therefore fails immediately and is never queued — a click buffered for minutes could
otherwise land on whatever is under the cursor later:

```jsonc
// -32001 ACCESS_DENIED response data for a paused scope
{
  "status": "COMPUTER_UNAVAILABLE",
  "reason": "COMPUTER_USE_PAUSED",          // global pause
  // reason: "COMPUTER_PAUSED",             // per-computer pause
  "tool_id": "srv_computer_use:computer_click",
  "server_id": "srv_computer_use",
  "details": {
    "computer_id": null,                    // set for COMPUTER_PAUSED
    "resume_at": "2026-10-30T02:00:00.000Z" // paused `until`, or null for open-ended
  }
}
```

The audit row is written with `status: "denied"` and the reason, so a pause is verifiable
afterwards. Starting/stopping a computer from the console is an operator action and is not
blocked by the agent availability gate.

Taking or releasing the broker's **live-control lease** remains a broker-UI concern. The
console only displays the lease (`control.held`, `control.holder`, `control.expiresAt`) and
links to the broker viewer; the gateway pause is a separate, agent-facing kill switch.

## Admin REST API

All routes are mounted under `/mcp/v1/admin/computer-use` and require a **master** key or an
authenticated console session. They return the standard error envelope
`{ "error": { "code": …, "message": "…", "data": {…} } }`. Response types are declared in the
`v0.9 — computer use` section of `src/core/types.ts`; `docs/API.md` has the route table.

| Method | Path | Body | Result |
|---|---|---|---|
| `GET` | `/` | — | `ComputerUseOverview` |
| `GET` | `/computers` | — | `ComputerUseComputersResponse` |
| `POST` | `/settings` | `ComputerUseSettingsInput` | `ComputerUseOverview` (managed server restarted) |
| `POST` | `/availability` | `ComputerUseAvailabilityInput` | `ComputerUseOverview` |
| `POST` | `/sync` | — | `ComputerUseOverview` (re-register + refresh tools) |
| `POST` | `/computers/:id/start` | — | `{ "computer": ComputerUseComputerInfo }` |
| `POST` | `/computers/:id/stop` | — | `{ "computer": ComputerUseComputerInfo }` |
| `GET` | `/computers/:id/frame?maxWidth=480` | — | image bytes, `cache-control: private, no-store`, `x-frame-time` |
| `GET` | `/activity?limit=50` | — | `{ "activity": AuditEntry[] }` |

`maxWidth` defaults to 480 and is clamped to 160–1600. `limit` defaults to 50 and is clamped
to 1–500. Health and fleet reads are briefly cached (a few seconds) to keep console polling
cheap.

### Settings

```jsonc
POST /mcp/v1/admin/computer-use/settings
{
  "brokerUrl": "https://127.0.0.1:7443",
  "publicBrokerUrl": "https://broker.example.com",
  "caFile": "/certs/broker-ca.pem",
  "token": "…",              // write-only; "" or null clears the vault token
  "enabled": true
}
// → 200 ComputerUseOverview (tokenConfigured/tokenSource only; no secret)
{
  "settings": {
    "brokerUrl": "https://127.0.0.1:7443",
    "publicBrokerUrl": "https://broker.example.com",
    "caFile": "/certs/broker-ca.pem",
    "tokenConfigured": true,
    "tokenSource": "vault",
    "enabled": true,
    "updatedAt": "2026-10-29T23:40:00.000Z"
  },
  "broker": {
    "configured": true, "reachable": true, "url": "https://127.0.0.1:7443",
    "version": "1.4.0", "tls": true, "computers": 2, "devices": 1,
    "connectorsOnline": 2, "checkedAt": "2026-10-29T23:40:00.000Z", "error": null
  },
  "availability": {
    "available": true, "state": "available", "reason": null, "until": null,
    "updatedAt": null, "updatedBy": null
  },
  "server": {
    "id": "srv_computer_use", "name": "computer-use", "status": "running",
    "toolCount": 23, "lastError": null
  },
  "tools": [
    { "name": "computer_screenshot", "description": "…", "highPrivilege": false,
      "approvalRequired": false, "readOnly": true }
  ],
  "counts": {
    "computers": 2, "available": 2, "paused": 0, "ready": 1, "connectorsOnline": 2
  }
}
```

### Availability

```jsonc
// Pause everything for a maintenance window
POST /mcp/v1/admin/computer-use/availability
{ "scope": "global", "available": false,
  "reason": "INC-1234 maintenance", "until": "2026-10-30T02:00:00.000Z" }
// → 200 ComputerUseOverview, availability.state = "paused"

// Pause one computer, then resume it
POST /mcp/v1/admin/computer-use/availability
{ "scope": "computer", "computerId": "cc-1a2b", "available": false,
  "reason": "patching", "until": null }

POST /mcp/v1/admin/computer-use/availability
{ "scope": "computer", "computerId": "cc-1a2b", "available": true }
// → 200 ComputerUseOverview (reason/until cleared)
```

### Fleet and computer control

```jsonc
GET /mcp/v1/admin/computer-use/computers
// → 200 ComputerUseComputersResponse
{
  "broker": { "configured": true, "reachable": true, "version": "1.4.0",
              "tls": true, "computers": 1, "devices": 1,
              "connectorsOnline": 1, "checkedAt": "…", "error": null },
  "availability": { "available": true, "state": "available", "reason": null,
                    "until": null, "updatedAt": null, "updatedBy": null },
  "computers": [{
    "id": "cc-1a2b", "name": "Desktop 1", "template": "ubuntu", "provider": "…",
    "state": "running", "viewer": "…", "error": null,
    "createdAt": "…", "ttlAt": "…",
    "desktop": { "viewer": "…", "width": 1920, "height": 1080 },
    "connector": { "state": "online", "version": "…", "lastSeen": "…" },
    "control": { "held": false, "holder": null, "heldSince": null, "expiresAt": null },
    "availability": { "available": true, "state": "available", "reason": null,
                      "until": null, "updatedAt": null, "updatedBy": null },
    "liveUrl": "https://broker.example.com/#/d/cc-1a2b"
  }]
}

POST /mcp/v1/admin/computer-use/computers/cc-1a2b/start
// → 200 { "computer": ComputerUseComputerInfo }
POST /mcp/v1/admin/computer-use/computers/cc-1a2b/stop
// → 200 { "computer": ComputerUseComputerInfo }

GET /mcp/v1/admin/computer-use/computers/cc-1a2b/frame?maxWidth=480
// → 200 image/jpeg (broker content-type); cache-control: private, no-store;
//   x-frame-time: <broker frame timestamp, when supplied>
POST /mcp/v1/admin/computer-use/sync
// Re-read settings, rebuild the broker client, re-register/start the managed server
// and refresh its tool catalogue → 200 ComputerUseOverview
GET /mcp/v1/admin/computer-use/activity?limit=50
// → { "activity": AuditEntry[] }   (ok / error / denied rows for the managed server)
```

`liveUrl` is built as `<publicBrokerUrl>/#/d/<computerId>` (or `<brokerUrl>` when no public URL
is set). Poll the frame route at a modest interval (e.g. 1–2 s) for previews; it is not
intended for live streaming — use the broker viewer/live desktop for that.

## Token storage: env vs encrypted vault

| Path | Where the secret lives | When to use |
|---|---|---|
| `MCP_COMPUTER_BROKER_TOKEN` | Process environment, injected by Compose/systemd | Bootstrapping, or when the vault is not configured. **Wins over the vault.** |
| Console → settings → token | AES-256-GCM encrypted vault (`MCP_VAULT_SECRET`) | Preferred. Survives restarts, never in a plaintext env file. |

- Resolution order is **env bootstrap token first, then the vault**; the console reports
  `tokenConfigured` / `tokenSource` (`env` / `vault`) and never the value.
- The token is **never persisted on the `computer-use` server row**, never included in server
  detail responses, never logged and never sent to the browser.
- `POST /settings` with `token: ""` or `token: null` removes the **vault** token. If an env
  token is set, the gateway refuses to clear it — unset `MCP_COMPUTER_BROKER_TOKEN` and
  restart instead.
- Saving a vault token requires `MCP_VAULT_SECRET`; without it the request fails with
  `VAULT_DISABLED` and you must use the env bootstrap path. Vault secrets, including the
  broker token, are covered by password-encrypted backups.
- Rotate the broker token by saving the new value and calling `POST /sync`; there is no
  plaintext copy to scrub.

## TLS / CA notes

- Use `https://` for `MCP_COMPUTER_BROKER_URL`. The gateway verifies the broker certificate;
  there is no "skip verification" switch.
- With `MCP_COMPUTER_BROKER_CA` unset, the broker certificate must chain to the container's
  public trust store. When set, that PEM bundle is supplied as the trust anchor for the
  gateway→broker TLS connection — so for mkcert point it at the **root CA** (`rootCA.pem`),
  not the leaf certificate. Include any intermediate certificates in the bundle if the broker
  chain needs them, and leave it unset for a publicly trusted certificate.
- The file must be readable by the gateway process. The container runs as the unprivileged
  `node` user, so the mounted CA file should be world-readable (`chmod 644`).
- The certificate must be valid for the hostname in the URL. A certificate issued only for
  `broker.internal` will not validate against `https://127.0.0.1:7443`; use the matching name
  (or add a SAN).
- `MCP_COMPUTER_BROKER_PUBLIC_URL` is only used to build browser links (`liveUrl`); it is
  never used for gateway→broker traffic. Set it to the externally reachable URL when the
  broker is behind a reverse proxy.
- If the broker is proxied, keep `/mcp` and the `/api/computers…`/`/healthz` routes reachable
  at the configured base URL. No WebSocket is required by the gateway.

## Console walkthrough

The **Computer Use** page (sidebar: *Computer Use*, `computer-use`) is available to the
signed-in operator:

1. **Connection settings** — broker URL, public URL, CA path, write-only token and enabled
   switch. Saving persists the settings and restarts the managed server; **Sync** re-registers
   it and refreshes tools.
2. **Broker card** — configured/reachable, version, TLS, computer/device/online-connector
   counts and the last error. A red card is the fastest way to distinguish a TLS/CA problem
   from a paused fleet.
3. **Fleet view** — one tile per computer with state, connector state, control-lease holder, a
   periodically refreshed frame preview (`/frame` with a cache-buster) and an **Open live
   desktop** link when a public URL is set. Tiles expose the per-computer pause/resume control
   with reason and auto-resume.
4. **Global availability** — pause all agent computer use with a reason and optional
   auto-resume; the banner stays visible while paused and shows the expiry.
5. **Activity** — recent ok/error/denied audit rows for the `computer-use` server, including
   the refusal reason, so pauses and RBAC denials are visible in one place.

The pause dialog uses local time and converts it to the ISO `until` the API expects; leaving
it empty creates an open-ended pause that only an operator can clear.

## Runbook / failure modes

| Symptom | Likely cause | Action |
|---|---|---|
| Overview shows `configured: false`, server `absent` | No broker URL, no resolving token, or `enabled: false` | Set URL + token, enable, then **Sync**. |
| `broker.error` is `No broker token configured` | No env token and no vault token | Save a token in the console (requires `MCP_VAULT_SECRET`) or set `MCP_COMPUTER_BROKER_TOKEN` and restart. |
| `broker.reachable: false` with a TLS error | Self-signed/mkcert certificate not trusted | Mount the root CA read-only, set `MCP_COMPUTER_BROKER_CA` to the container path, restart. Check hostname/SAN. |
| `broker.error` mentions 401/403 | Broker token missing, wrong or expired | Save a new token in the console (vault) or fix `MCP_COMPUTER_BROKER_TOKEN`, then Sync. |
| Agent gets `-32001 COMPUTER_USE_PAUSED` | Global availability pause | Resume global availability in the console (or `POST /availability`). |
| Agent gets `-32001 COMPUTER_PAUSED` | Per-computer pause | Resume that computer; check `resume_at` — expired pauses resume automatically. |
| Agent gets `-32001 HIGH_PRIVILEGE_RESTRICTION` | Tool is high privilege and not granted | Add it to `highPrivilegeTools` (and the key's server grant). |
| Agent gets `-32002 Tool Not Found` | Tool not permitted, or the managed server is stopped/absent | Check the grant; run **Sync** and re-check `server.status`. |
| Agent gets `-32004 ESCALATION_REQUIRED` | `destroy_computer` / `device_exec` approval | Approve the escalation in the console, collect the result with the ticket. |
| Frame endpoint fails while tools work | Frame route unreachable, or computer stopped | Check the computer's `state`/`error` and broker health; start the computer. |
| "Open live desktop" link is unreachable but agent tools work | `MCP_COMPUTER_BROKER_PUBLIC_URL` wrong or not browser-reachable | Set the public URL (reverse proxy DNS/TLS) and Sync. |
| Broker restarted/upgraded | Managed client errored, tool catalogue stale | **Sync** (or restart the managed server) to reconnect and refresh tools. |
| All calls denied after a change | Availability or key grant changed | Inspect `availability.updatedBy`/reason and the key's access view; audit has denied rows. |

## Security notes

- **The broker token is server-side only.** It is never stored on the server row, never
  returned by any API, never logged and never placed in a URL/query string. Browsers talk to
  the gateway, not to the broker, for frames and settings.
- **Frames are proxied server-side.** `GET …/frame` authenticates the operator (master key or
  console session), then fetches the image from the broker. No broker credential reaches the
  browser.
- **Refusals fail closed and are not queued.** A paused or denied call returns `-32001`
  immediately; nothing is buffered or replayed when availability resumes.
- **Availability is not authorisation.** Pausing removes nothing from a key's grants; grants
  are still required. Treat pause as a defence-in-depth kill switch, not as revocation.
- **Least privilege by default.** Read-only tools are the observation surface; every input,
  lifecycle and shell tool is `highPrivilege` and invisible until explicitly granted.
  Destructive actions (`destroy_computer`, `device_exec`) are additionally approval-gated.
- **Audit is complete.** Allowed, failed and denied calls (including pause refusals) are
  recorded with key, tool, latency and payload (truncated), so availability and RBAC changes
  are verifiable after the fact.
- **The live desktop link is the broker's UI.** Gateway authentication does not apply to it.
  Protect the broker with its own authentication, TLS and network policy; do not expose the
  broker or its viewer publicly unless that is deliberate.
- **The broker is a separate trust boundary.** It can drive desktops and device connectors,
  so treat it as a high-value service: keep it on an internal network, limit who can reach it,
  and scope its token to what the gateway needs.
- **CA files are read-only mounts.** Never disable certificate verification and never bake a
  private key into the gateway image.
- **Backups.** With a vault-stored token, the broker token is included in the
  password-encrypted gateway backup; protect the backup password accordingly. An env-injected
  token lives outside the backup and must be re-supplied on restore.
