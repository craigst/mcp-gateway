# Computer use (v0.10)

The gateway can front an external, self-hosted **Computer Broker** as a managed built-in MCP
server named `computer-use`. The broker owns the virtual desktops, the desktop viewer and the
device connectors; the gateway owns the policy plane — authentication, per-key RBAC, catalog
censorship, argument guardrails, approvals and audit. Agents therefore get computer-use and
device tools through the same `/mcp/v1` endpoint as every other sub-server, while the browser
console gains a fleet view, live frame previews and availability (pause/resume) controls.

v0.10 adds **Connectors** — onboarding physical Linux PCs as device connectors with a
single-use pairing token, plus an operator terminal proxied through the gateway. See
[Connectors: onboarding Linux PCs](#connectors-onboarding-linux-pcs-v010).

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
   from the broker server-side. The "open live desktop" link goes through the gateway
   (`GET /mcp/v1/admin/computer-use/computers/:id/live-desktop`), which mints a **one-time,
   60-second sign-in hand-off** on the broker and redirects the browser to the broker's own
   viewer. That means the operator's gateway console session carries into the broker console
   without retyping the broker password. If the hand-off cannot be minted, the gateway falls
   back to the plain broker URL (which shows the broker's own login page).

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
      "list_computers", "computer_status", "computer_screenshot", "computer_displays",
      "computer_windows",
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
| `computer_screenshot` | Capture a frame/desktop screenshot; optional `display` picks one display | ✅ | — | — |
| `computer_displays` | List a computer's displays, geometry and combined bounds | ✅ | — | — |
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
    "toolCount": 24, "lastError": null
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

## Connectors: onboarding Linux PCs (v0.10)

A **connector** is the broker's small agent that runs on a real machine (a Linux PC, laptop or
server) and dials out to the broker. The gateway does not talk to the connector directly: it
asks the broker for a single-use enrollment token, hands the operator a one-line install
command, and thereafter proxies device operations (terminal included) to the broker's
`/api/devices/{id}/call` route.

This replaces the legacy **DeviceBridge** connector/service, which is retired. The gateway
registers **no DeviceBridge MCP server** and there is no DeviceBridge configuration to keep:
device onboarding now happens in **Connectors**, and the `device_*` tools continue to come
from the managed `computer-use` server covered above.

The flow is deliberately outbound-only:

```text
console → POST /admin/computer-use/connectors/enrollments
             │  gateway mints the enrollment on the broker (admin token, server-side)
             ▼
       Computer Broker ── POST /api/enrollments ──► single-use token (hash stored at rest)
             │
             │  operator pastes the returned one-liner on the new PC:
             │  curl -fsSLk 'https://broker.example.com/install/install-connector.sh' \
             │    | bash -s -- --broker 'wss://broker.example.com/connector' \
             │                --enroll '<token>' --name 'workshop-pc' [--terminal]
             ▼
       new Linux PC: installer downloads the connector bundle (+ the broker CA when one is
       published), installs a systemd --user unit; the connector dials OUT to
       wss://<broker>/connector
             │
             ▼
       broker claims the token once, the device goes online, and the pending pairing
       disappears from Connectors. No inbound port is opened on the new PC.
```

The gateway never stores the connector's identity and never sees the enrollment token again
after returning it: the token lives only in the pairing response and the installer, the
broker keeps a hash, and the connector keeps its identity in its own state directory
(`~/.local/share/computer-broker-connector-device`).

### Broker HTTP endpoints

These broker routes back the installer and pairing flow. The `/api/enrollments` routes are
authenticated with the same broker bearer token the gateway already uses (admin scope); the
`/install/*` routes are intentionally public, but the connector bundle is gated by the
single-use enrollment token.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/enrollments` | Pending (unclaimed, unexpired) pairings: `[{id,kind,expires_at,created_at}]`. Token hashes are never returned. |
| `POST` | `/api/enrollments` | Mint a pairing: `{kind?, ttl_s?, computer_id?}` where `kind` is `device` (default) or `computer` (a `computer` enrollment also carries `computer_id`) → `201 {id,kind,token,expires_at,created_at}`. `ttl_s` clamped 60–86400 (default 3600); `token` is returned exactly once. |
| `DELETE` | `/api/enrollments/{id}` | Revoke a pending pairing: `{ok:true}`; `404` when unknown. |
| `GET` | `/install/install-connector.sh` | The installer script (`text/x-shellscript`) that the one-liner pipes to `bash`. |
| `GET` | `/install/broker-ca.pem` | The broker's CA certificate (`application/x-pem-file`). Public by design — it is a certificate, not a secret. |
| `GET` | `/install/connector.tar.gz?enroll=<token>` | Connector bundle for a `device` enrollment, gated only by the single-use token; `403 {"error":"enrollment_invalid"}` when the token is unknown, already claimed or expired. |

### Gateway admin endpoints

Mounted under `/mcp/v1/admin/computer-use/connectors`; **master key or console session only**,
never an agent key. Response types are in the `v0.10 — connector onboarding` block of
`src/core/types.ts`; the request/response walkthrough is repeated in
[`API.md`](./API.md).

| Method | Route (after the prefix) | Body | Result |
|---|---|---|---|
| `GET` | `/` | — | `ComputerUseConnectorsResponse`: `broker`, `devices` (`ComputerUseDeviceInfo[]`), pending `enrollments`, `publicBrokerUrl`, `counts {devices, online, pendingEnrollments}` |
| `POST` | `/enrollments` | `{kind?, name?, ttlSeconds?, allowTerminal?}` | `{enrollment: {id, kind, expiresAt, createdAt, token}, install: {command, brokerUrl, connectorUrl, caUrl, allowTerminal, expiresAt}}` |
| `DELETE` | `/enrollments/:id` | — | `{deleted:true}` |
| `POST` | `/devices/:id/terminal/open` | `{rows?, cols?, shell?, cwd?}` | `{session}` |
| `POST` | `/devices/:id/terminal/send` | `{session, input, enter?}` | `{ok:true}` |
| `GET` | `/devices/:id/terminal/read?session=&lines=&waitSeconds=` | — | `{session, lines: string[], changed: boolean}` |
| `POST` | `/devices/:id/terminal/close` | `{session}` | `{ok:true}` |

`kind` defaults to `device` — the normal path for onboarding a Linux PC; `computer` pairs a
desktop-kind connector instead. `name` is trimmed/collapsed to 60 characters and defaults to
`linux-pc`; `ttlSeconds` is clamped to 60–86400 and defaults to 3600 (the console wizard offers
15–1440 minutes); `allowTerminal` defaults to `false`. Creating an enrollment **requires a
configured public broker URL** (`MCP_COMPUTER_BROKER_PUBLIC_URL`, or the server-side broker URL
when no public one is set): the token would be useless if the new PC cannot reach the broker,
so the request fails with a message pointing at Computer-use settings. `GET /` is what the
wizard polls to detect the device appearing.

### Pairing walkthrough

1. **Make the broker reachable from the new PC.** In **Computer Use → Settings**, set the
   *public broker URL* to the address the new machine will use (LAN hostname and port, or the
   reverse-proxied `https://` origin). The install command is built from it.
2. **Connectors → Add Linux PC.** Give the machine a name, choose whether it may host an
   interactive terminal (off by default), pick a pairing lifetime, and submit. The wizard
   shows the **one-line install command**, its expiry and the CA download URL. The command
   shape is:

   ```bash
   curl -fsSLk 'https://broker.example.com/install/install-connector.sh' \
     | bash -s -- --broker 'wss://broker.example.com/connector' \
                 --enroll '<single-use token>' --name 'workshop-pc' [--terminal]
   ```

3. **Run it on the new PC as the user who should own the connector** (no root, no SSH keys
   touched). The installer:
   - fetches the broker CA over a TLS bootstrap (`curl -k`) when the broker publishes one, then
     **pins** it for every later request (otherwise the host's system trust store applies);
   - downloads the connector bundle (`/install/connector.tar.gz?enroll=…`), creates a private
     venv and installs its requirements under `~/.local/opt/computer-broker/connector`;
   - writes the connector policy (terminal disabled unless `--terminal`; a policy written by an
     earlier install is kept, never overwritten), the `0600` `connector.env` and a systemd
     `--user` unit, then enables/starts it and applies `loginctl enable-linger`;
   - dials **out** to `wss://<broker>/connector` — no inbound port and no listening service.
4. **Wait for the device to appear online.** The broker claims the token exactly once, records
   the connector identity, and the device shows in Connectors with hostname/platform and
   capabilities. The pending pairing disappears; the token is spent (once an identity exists,
   the installer removes the bootstrap token from `connector.env`).
5. **Pending pairings** are listed with their expiry and can be revoked at any time
   (`DELETE …/enrollments/:id`); revocation kills the token immediately. Expiry (default 60
   minutes) has the same effect — a dead token cannot be claimed and the operator simply
   creates a new pairing.
6. **Operate the device.** Its card shows online/offline state, hostname/platform, last seen
   and capability badges. The **Terminal** button is offered only when the connector
   advertises its `term.*` capabilities, and *Broker UI* opens the broker's own UI when a
   public broker URL is configured.

Re-run the command only with a **fresh** token: a claimed, expired or revoked token is refused
by the bundle endpoint (`enrollment_invalid`) and by the websocket `enroll` handshake.
Installation is idempotent per machine, but a second token only replaces the identity if the
connector state directory is cleared — treat re-pairing as re-enrollment.

### Terminal control

The console terminal is a thin, authenticated proxy: the gateway opens a session on the
broker (`term.open`), relays input (`term.send`) and incrementally reads output (`term.read`;
`changed` distinguishes new output from an unchanged screen) until the dialog closes
(`term.close`). Agent keys reach the same connector through the managed `computer-use`
server's high-privilege tools (`device_terminal_open`, `device_terminal_send`,
`device_terminal_read`, `device_terminal_close`), subject to their RBAC grants as before.
`open` accepts optional `rows`/`cols` (the console uses 30×120), `shell` and `cwd`; `read`
defaults to 200 lines (clamped 1–2000) and 0 wait seconds (clamped 0–30), returning the session
and whether the output `changed` (the console polls about every 1.5 s with
`lines=500&waitSeconds=1`); `send` defaults `enter` to true.

Terminal access is **opt-in in two places**:

1. **The enrollment must request it** — `allowTerminal: true` makes the generated command pass
   `--terminal`, which writes `terminal.enabled: true` into the connector's local
   `policy.json`. The installer default is `"terminal": {"enabled": false}`: an interactive
   shell is never a default.
2. **The device must advertise the connector's terminal operations** (`term.open`,
   `term.send`, `term.read`, `term.close`, surfaced as `terminalCapable` on
   `ComputerUseDeviceInfo`). A connector that does not advertise them is refused rather than
   half-supported.

| Symptom | Cause | Remedy |
|---|---|---|
| Terminal button disabled / "does not support terminal control" | Connector does not advertise `term.*`, normally because its policy has `terminal.enabled: false` | On the device, set `terminal.enabled` to `true` in `policy.json` and restart the connector's user unit; a **fresh** machine can instead be installed from a terminal-enabled enrollment. |
| Session open fails with a policy refusal | Connector policy has `terminal.enabled: false` | Set `terminal.enabled` to `true` in the connector's `policy.json` and restart its user unit (an existing policy is never overwritten by the installer). |
| `open` fails on the shell or cwd | The connector policy rejects that shell/working directory | Use a shell/cwd the connector allows; the gateway does not override connector policy. |
| Session dies or `read` stays empty while the device is online | The session was closed by the connector, or the connector restarted | Open a new session — sessions live on the connector, not the gateway. |
| Any terminal call fails while the device is online | Device went offline between listing and the call | Check the connector service on the PC (see the runbook). |

The terminal runs as the **connector user** on the device. It is not an elevation mechanism:
neither the installer nor the broker offers a root path. Treat an allowed terminal exactly as
an SSH session to that machine — same privileges, same data.

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

The **Connectors** page (sidebar: *Connectors*, `connectors`) is the device-onboarding surface:

- **Broker status** — configured/reachable, version, TLS, online device and pending-pairing
  counts; when the broker is unreachable the page says so instead of pretending.
- **Add Linux PC** — the wizard (name, *allow interactive terminal* with an explicit warning
  that it is a real shell, pairing lifetime in minutes). Submitting shows the one-line install
  command with a copy button, the CA URL and the expiry, and polls the connector list so the
  dialog can report the machine connecting.
- **Pending pairings** — expiry countdown and *Revoke*.
- **Devices** — name, online/offline state, hostname/platform, last seen, capability badges
  (terminal capability highlighted), a *Terminal* button (disabled with the reason when the
  connector does not support it) and a *Broker UI* link.
- **Terminal dialog** — opens a 30×120 session, polls output, sends a line on Enter and closes
  the session when dismissed. Policy refusals are shown verbatim rather than swallowed.

The pause dialog uses local time and converts it to the ISO `until` the API expects; leaving
it empty creates an open-ended pause that only an operator can clear.

## Physical host desktops (v0.11)

The broker can also register an **existing Linux PC** as a computer instead of provisioning a
container: `provider: "host"`. It shows up in the gateway fleet like any other computer, the
fleet thumbnail and live-desktop hand-off work, and agents use the same `computer_*` tools.
The connector for a host runs on that machine with `--kind computer --backend wayland`; it is
not a container.

```sh
# on the broker host (or POST /api/computers/host with an admin token)
cd "/path/to/computer broker"
python -m broker.cli computer attach --name gpc --kind host   # prints a one-time token

# on the physical PC, from a checkout of the broker repo
scripts/install-connector.sh \
  --broker wss://<broker>:7443/connector --enroll <TOKEN> \
  --kind computer --backend wayland --name gpc \
  --ca ~/.local/share/computer-broker/tls/broker-ca.pem
```

The gateway does not create host computers itself; after registration it discovers the
computer on the next computer-use sync, and the fleet card's **Open live desktop** goes
through the normal one-time hand-off into the broker viewer.

**Displays.** The host connector reports enabled outputs from `kscreen-doctor` (name, virtual
position, resolution, scale, rotation, primary) plus the combined desktop bounds. The broker
viewer offers **All displays** and one tab per display; frames are cropped server-side from the
same capture. Gateway agents get the layout from `computer_displays` and can request a
per-display frame with `computer_screenshot`'s `display` argument. `mouse.*` coordinates are
virtual-desktop pixels (origin = `bounds.x, bounds.y`), so a click in a display view lands on
that display. Display **layout changes** are not exposed; rotate/resolution/enable stay local.

**Input.** Absolute pointer and keyboard go through `/dev/uinput` on the host, gated by the
same control lease as containers: a person holding the viewer must send their lease with input
calls, and agent calls are refused while held (never queued). The viewer's keyboard bar types
text, Return/Esc/Tab/Backspace and Ctrl+C/Ctrl+V.

**Requirements / limits:** KDE Plasma Wayland session logged in and unlocked; `spectacle`,
`kscreen-doctor`, Pillow and read/write `/dev/uinput` for the connector user; US keyboard
layout; frames are polled roughly every 900 ms, so this is remote monitoring/control rather
than a game stream. `computer_windows` is not implemented for a host; the broker reports
not-supported. See the broker repo's `docs/HOST-DESKTOP.md` for the full story.

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
| Connector device shows offline | Connector service stopped or restarted, broker unreachable, or TLS/CA failure | On the PC: `systemctl --user status computer-broker-connector-device` and `journalctl --user -u computer-broker-connector-device -n 40 --no-pager`; confirm the broker URL resolves and its port is reachable; restart the unit. |
| Add Linux PC fails with a public-URL error | No public broker URL configured | Set the browser/PC-reachable broker URL in **Computer Use → Settings**, save, then create the enrollment again. |
| Install command fails at `curl` | `publicBrokerUrl` not reachable from the new PC (DNS, port, firewall) | Resolve the URL from that machine; ensure the broker is reachable on its LAN port or through the reverse proxy, then re-run with a fresh token. |
| Installer reports `enrollment_invalid` | Token already claimed, expired (default 60 min) or revoked | Create a new pairing — a spent token cannot be reused. |
| Connector fails its TLS/CA bootstrap | CA URL unreachable, or the certificate does not cover the hostname used | Check `/install/broker-ca.pem` from the new PC; use the hostname/SAN the certificate actually covers; pass `--ca /path/broker-ca.pem` when the CA is pre-provisioned. |
| Device online but terminal unavailable | Connector policy has `terminal.enabled: false`, so it does not advertise `term.*` | Set `terminal.enabled` to `true` in the device's `policy.json` and restart the connector unit; for a fresh machine, install from a terminal-enabled enrollment. |
| Terminal open refused by policy | Connector `terminal.enabled` is false | Same fix — enable terminal in the connector policy and restart its unit (the installer never overwrites an existing policy). |
| Device shows the wrong name | The name is captured at enrollment/install time | Create a new enrollment with the desired `name` and reinstall the connector. |
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
- **The live desktop link is the broker's UI, entered through a one-time hand-off.** The gateway
  (master/console session only) asks the broker for a single-use, 60-second sign-in token and
  redirects the browser to consume it; the broker sets its own HttpOnly session cookie. The
  hand-off token is stored in broker memory, expires quickly, can be used once, and is audited
  (`handoff.create` / `handoff.login`). If it cannot be minted the link falls back to the
  broker's login page.
  Protect the broker with its own authentication, TLS and network policy; do not expose the
  broker or its viewer publicly unless that is deliberate.
- **The broker is a separate trust boundary.** It can drive desktops and device connectors,
  so treat it as a high-value service: keep it on an internal network, limit who can reach it,
  and scope its token to what the gateway needs.
- **CA files are read-only mounts.** Never disable certificate verification and never bake a
  private key into the gateway image.
- **Pairing tokens are single-use and short-lived.** The broker stores only a token hash; the
  plaintext is returned exactly once, is consumed by the connector's first websocket
  enrollment (default lifetime 60 minutes), and never appears in an enrollment listing. The
  installer removes it from `connector.env` once the connector has an identity.
- **The CA bootstrap is a one-time trust-on-first-use step.** The generated one-liner uses
  `curl -k` only to fetch the installer, and the installer uses it once for the broker CA when
  one is published; the downloaded CA is then pinned for every later request. Check the host in
  the command before running it, and prefer `--ca` when the CA can be provisioned out of band.
- **No inbound port on the connector machine.** The connector dials out to the broker's
  `/connector` websocket. There is no SSH or remote-shell listener, and the installer never
  touches SSH configuration or `authorized_keys`.
- **The shell is opt-in and unprivileged.** Terminal access requires an `allowTerminal`
  enrollment *and* a connector policy that enables it (`terminal.enabled`); the shell runs as
  the connector user, with no elevation path through the broker or the gateway.
- **Device operations use the broker admin token server-side.** Console terminal routes
  authenticate the operator (master key or console session) and proxy through the gateway; no
  broker credential reaches the browser.
- **DeviceBridge is retired.** The gateway registers no DeviceBridge MCP server and there is
  nothing to configure: device onboarding is **Connectors** only. Remove any legacy
  DeviceBridge service still running on formerly-enrolled machines.
- **Backups.** With a vault-stored token, the broker token is included in the
  password-encrypted gateway backup; protect the backup password accordingly. An env-injected
  token lives outside the backup and must be re-supplied on restore. Pairing tokens are not
  backed up — an enrollment is short-lived and is simply recreated.
