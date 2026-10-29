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
| 🔄 | **Update manager** | Per-server upstream tracking (tag/commit): "update available" badges, check-all, and one-click staged updates (clone → build → swap → restart → probe) with automatic rollback on a failed build. |
| ⚙️ | **Encrypted configuration profiles** | Save credentials/endpoints (IPs, ports, API keys, headers) once **in the AES-256 vault**, reference named secrets, and apply one profile to many MCP servers. No env files — values are decrypted only into the sub-process environment. |
| 🔬 | **Server inspector** | Open any MCP server: every tool (with schema + live Try), prompts, resources and templates, capabilities/instructions, encrypted configuration with audited reveal, version/update/changelog, and per-server request history — ok, failed **and denied** — with the API key that used it. |
| 🚀 | **First-run onboarding** | A fresh gateway starts in setup mode: the Web UI wizard creates the operator account, offers an optional master API key (shown once) and can restore an existing backup — no env files or manual key bootstrapping needed. |
| 💾 | **Password-encrypted backups** | One-click backup of the whole gateway — accounts, API keys, servers, profiles, catalog sources and **every vault secret** — encrypted with scrypt + AES-256-GCM using your account password. Restore on any fresh gateway (setup wizard or Settings) with that password; servers whose code was not in the backup get a one-click **Reinstall**. |
| 🖥️ | **Web UI console** | Dashboard, catalog manager, RBAC grid, vault, audit explorer, delegation observer, live log stream, JSON-RPC playground. |
| 🔑 | **Built-in console login** | Username/password sessions (scrypt, HttpOnly SameSite=Strict cookie, CSRF protection). API keys are for AI/external clients only. |
| 📊 | **Audit everything** | Every discovery/execution/denial recorded with latency, key, tool, delegation depth and payload (truncated). |
| 🧪 | **Real tests** | Vitest unit + integration + E2E against live stdio sub-processes; CI builds the Docker image and smoke-tests `/health`. |

## Console

![Installed servers with version and update awareness](docs/screenshots/v04/installed.png)

![First-run setup — create the operator account or restore a backup](docs/screenshots/v06/setup-welcome.png)

![Server inspector — activity with ok, error and denied requests](docs/screenshots/v05/activity.png)

<details>
<summary>More screenshots (settings & backups · inspector · configurations · update dialog · login · dashboard · catalog · Vault Warden)</summary>

| Settings & encrypted backups | Backup creation |
|---|---|
| ![Settings and backups](docs/screenshots/v06/backup-list.png) | ![Create backup](docs/screenshots/v06/backup-create.png) |

| Inspector overview | Inspector configuration |
|---|---|
| ![Inspector overview](docs/screenshots/v05/overview.png) | ![Inspector configuration](docs/screenshots/v05/configuration.png) |

| Inspector tools | Prompts & resources |
|---|---|
| ![Inspector tools](docs/screenshots/v05/tools.png) | ![Prompts & resources](docs/screenshots/v05/prompts-resources.png) |

| Encrypted configurations | Update confirmation |
|---|---|
| ![Configurations](docs/screenshots/v04/configurations.png) | ![Update dialog](docs/screenshots/v04/update-dialog.png) |

| Sign-in page | Dashboard |
|---|---|
| ![Login](docs/screenshots/v03/login.png) | ![Dashboard](docs/screenshots/v04/dashboard.png) |

| Catalog import | Vault Warden |
|---|---|
| ![Catalog import](docs/screenshots/v03/catalog-import.png) | ![Vault Warden](docs/screenshots/v03/vaultwarden.png) |

</details>

The console signs in with a username/password session; **API keys are only for AI agents and
external management clients**. Screenshots use generic demo data (no personal configuration).

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

Open <http://localhost:8080> and sign in with the Web UI credentials
(`MCP_UI_USERNAME`, default `admin`, and `MCP_UI_PASSWORD`; when no password is set a random
one is generated and printed once to the logs). The console uses a session cookie — API
keys are only needed by AI/external clients.

On first boot (empty key table) the bootstrap master key from `MCP_MASTER_KEY` is registered;
if it is unset a random master key is generated and printed once to the container logs:

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

## Run persistently with rootless podman (Linux)

The gateway runs happily as a systemd user quadlet, surviving reboots:

```bash
# 1. Secrets (0600). Generate strong values:
install -d -m700 ~/.config/mcp-gateway
cat > ~/.config/mcp-gateway/gateway.env <<EOF
MCP_DATA_DIR=/data
MCP_MASTER_KEY=mcp_master_$(openssl rand -hex 24)
MCP_VAULT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
MCP_UI_USERNAME=admin
MCP_UI_PASSWORD=$(openssl rand -base64 18 | tr -d '\n=')
MCP_AUTOSTART=all
MCP_GIT_IMPORT_ALLOWED_PREFIXES=https://github.com/
EOF
chmod 600 ~/.config/mcp-gateway/gateway.env
podman build -t localhost/mcp-gateway:0.3.0 .

# 2. Quadlet unit
cat > ~/.config/containers/systemd/mcp-gateway.container <<EOF
[Unit]
Description=MCP Gateway
After=network-online.target

[Container]
ContainerName=mcp-gateway
Image=localhost/mcp-gateway:0.3.0
PublishPort=8080:8080
Volume=%h/.local/share/mcp-gateway/data:/data:Z
EnvironmentFile=%h/.config/mcp-gateway/gateway.env
UserNS=keep-id
NoNewPrivileges=true

[Service]
Restart=always
TimeoutStartSec=300

[Install]
WantedBy=default.target
EOF

# 3. Start + start on boot
systemctl --user daemon-reload
systemctl --user start mcp-gateway.service
loginctl enable-linger "$USER"
```

`MCP_AUTOSTART=all` (or `name1,name2`) starts catalogued sub-servers after each boot, so the
gateway is ready for agents without manual clicks. `systemctl --user status mcp-gateway`.

## Connect to the DeepSeek Harness (DSH)

DSH's `@deepseek-ai/dsh-mcp-client` can point straight at `/mcp/v1` over Streamable HTTP, so
every tool the key may see appears as `mcp__gateway__<tool>`:

```yaml
- insert:
    - id: mcp-gateway
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: gateway
        transport: streamable-http
        url: http://127.0.0.1:8080/mcp/v1
        headers:
          Authorization: "Bearer mcp_master_…"   # AI/external API key
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

Restart DSH after adding the row (MCP rows are read at profile load). Full guide:
[`docs/DSH.md`](./docs/DSH.md).

## Updates & encrypted configuration

### Manage upstream updates per server

Every server installed from a Git/catalog source records its repo, ref and installed
commit. **Catalog → Installed** shows a Version column and an Update badge:
- tag-tracked servers compare against the newest semver tag in the repo;
- branch-tracked servers compare the latest commit;
- **Check all** re-reads every upstream through the catalog's vault token;
- **Update** runs a staged update for that one server: clone into a temp directory,
  build, stop, swap, restart and probe-test. A failed build leaves the running server and
  its configuration untouched (automatic rollback).

### Encrypted configuration profiles (no env files)

Save endpoints, IPs, ports, API keys and headers once, encrypted in the gateway's
**AES-256-GCM vault**, then apply a profile to as many MCP servers as you like:
- profile values are either **profile-owned encrypted secrets** or **references to named
  secrets** from the Vault page;
- values are never stored in SQLite in plaintext and never returned by the API;
- attach/detach profiles from a server's **Details** drawer, then **Apply & test** (restart
  + MCP `tools/list` probe) to verify the connection;
- legacy env-file configs can be migrated with one click — the gateway reads the file once,
  encrypts every value into a profile, attaches it and clears the env-file reference.

## Inspect any MCP server

Click a server in **Catalog → Installed** (or **Open**) to land on its inspector page:

- **Overview** — status/actions, runtime/transport/PID/workdir, tool/prompt/resource counts,
  request stats (ok, error, denied, error rate, p50/p95, last used), source & updates with
  changelog, manifest/capabilities/instructions.
- **Tools** — every tool with its full input schema, high-privilege/approval flags, usage
  count/last used, and a **Try** playground that calls the tool and shows result + latency.
- **Prompts & Resources** — MCP prompts (arguments + *Get prompt*) and resources
  (*Read*), plus resource templates; the gateway also proxies `prompts/list`, `prompts/get`,
  `resources/list`, `resources/templates/list` and `resources/read` to agents.
- **Configuration** — the encrypted configuration actually reaching this server: attached
  profiles (encrypted / vault-ref), server env/headers with masked values and one-shot
  **audited reveal** (every reveal is written to the audit log).
- **Activity** — per-server requests with filters (All / Failed / Denied / OK, tool, API key),
  latency, payload and the exact key (`dsh-harness`, `demo-agent`, …) that used the server.
  Failed and denied requests are first-class — they are what the manager is for.

## First start, onboarding & backups

A fresh install needs **no pre-set password**:

1. Open the console — it shows the **first-run wizard**.
2. Create the operator account (username + password); the console signs you in.
3. Optionally generate a **master API key for AI/external clients** (shown once), or skip.
4. Add a catalog source / import servers from the dashboard.

> Setting `MCP_UI_PASSWORD` still pre-creates an account and skips the wizard (backwards compatible);
> leave it empty for the guided setup. `MCP_UI_USERNAME` defaults to `admin`.

**Settings** (⚙ in the sidebar) centralises account/password changes, read-only system
configuration, quick API-key creation, and **Backups**:

- **Create backup** — asks for your account password, snapshots the complete gateway state
  (accounts + hashes, API keys, servers, tools, catalog sources, configuration profiles,
  escalations/delegations, settings, optional audit and **all vault secret values**), and
  encrypts it with a scrypt-derived AES-256-GCM key. The password is never stored.
- **Download / delete** local backups (mode 0600, under `data/backups`).
- **Restore** — on a fresh gateway choose *Restore from backup* in the wizard, or use
  Settings → Restore on a running gateway: upload the `.mcpbak`, enter the account password,
  type `RESTORE`. Accounts keep their original password, API-key hashes keep working, vault
  secrets are re-encrypted into the local vault, sessions are cleared and servers are stopped.
- Servers whose repository checkout was not part of the backup are listed as **reinstall
  required**; one click rebuilds them from their tracked upstream source (staged clone → build
  → restart → probe).

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

The suite is **800 tests across 81 files**: unit suites per module, an integration suite that
boots a real gateway on an ephemeral port and spawns fixture MCP servers, and an end-to-end
scenario covering vault → git import → catalog → execution → delegation → depth guard → escalation,
plus jsdom UI tests. CI also builds the Docker image and smoke-tests `/health` inside the container.

## Security

- Every request is authenticated; API keys are stored only as SHA-256 hashes.
- The console uses scrypt-hashed passwords and HttpOnly `SameSite=Strict` session cookies;
  cookie-authenticated writes are same-origin checked.
- The catalog is filtered server-side before serialization (no client-side trust).
- Denials for invisible tools are indistinguishable from unknown tools.
- Sub-processes run unprivileged inside the container; build/clone URLs are allowlisted.
- Secrets are encrypted at rest with AES-256-GCM and never returned by the API.

Read [`SECURITY.md`](./SECURITY.md) for the full threat model and disclosure process.

## Status

| Release | Scope | State |
|---|---|---|
| v0.1.0 | Core engine, JSON-RPC ingress, RBAC/zero-trust catalog, UI, delegation, vault + git import | ✅ shipped |
| v0.2.0 | Private GitHub catalogs, harness discovery/import, auto-manifest detection, approval-gated Vault Warden, UI marketplace | ✅ shipped |
| v0.3.0 | Built-in username/password Web UI login, session-authenticated console + WebSocket logs, master-key rotation, persistent podman/systemd deployment | ✅ shipped |
| v0.4.0 | Upstream update manager (checks + staged per-server updates) and encrypted configuration profiles replacing env files | ✅ shipped |
| v0.5.0 | Full MCP server inspector (tools/prompts/resources/config/activity), proxied prompts & resources, audited credential reveal, per-server failed/denied request history | ✅ shipped |
| **v0.6.0** | **First-run onboarding wizard, in-UI settings, password-encrypted full backups with restore & server reinstall** | ✅ **current** |

## License

[MIT](./LICENSE) © 2026 Craig CXS
