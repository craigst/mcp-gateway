# Full migration: every agent uses only the MCP gateway

Status (2026-10-31): **OMB, the gpc DSH, and the cleo DSH web / split-sandbox /
headless profiles are on the gateway.** The developer harnesses (Claude Code,
opencode), the ai-messenger/Odysseus/CubeFarm/n8n agents, the server runtimes and
the device fleet still need their waves. This is the plan for those waves.

## 1. Goal and invariants

1. No agent talks to an upstream MCP server directly. Every call goes to
   `http://mcp-gateway:8080/mcp/v1` (OMB) or `http://10.10.1.4:8484/mcp/v1`
   (WG clients), with that agent's own key.
2. One key = one identity. The key name is the agent identity; the gateway logs
   and audit attribute every call to it.
3. A key sees only its granted servers/tools. Cross-agent access is denied
   before any upstream call (proven by `scripts/vps/verify_per_bot.py`).
4. Upstream credentials live only in the gateway's encrypted vault/config
   profiles. Agent config files carry only a scoped gateway key.
5. Every call is observable: key, upstream server, tool, status, latency.
6. Rollback is per wave: the old config and old upstream key stay valid until
   the wave's acceptance gate passes.

## 0. Executed so far (2026-10-31)

- Gateway **v0.14.1** on the VPS: **25 servers**, 650 tools, all running; one
  structured `tool call` log line per call (key/server/tool/status/latency).
- OMB: 11 per-bot keys, 11 entries, `verify_per_bot.py` 11/11 pass (key matches
  entry, only its own servers, one denied probe each, audit attribution).
- gpc DSH: `dsh-harness-vps2`, 25 servers/650 tools; ssh/n8n/media facades added.
- cleo DSH: `web`/`split-sandbox`/`headless` profiles replaced their stdio MCP
  rows with one gateway row (`dsh-cleo-web`, `dsh-cleo-split`,
  `dsh-cleo-headless`). `console` stays stdio because its facade does not bind
  while the Odysseus console singleton is running.
- **OMB OpenCode fix (2026-10-31 23:57):** the free Zen model
  (`opencode/beam-free`) had hit its free-usage limit, not a gateway or MCP
  fault. The DeepSeek key was added as an OpenCode provider key
  (`opencodeGo.providerKeys.DEEPSEEK_API_KEY`) and Remy/Nora were moved to
  `deepseek/deepseek-flash`. A test webhook run then completed in 8.4 s with
  `llm.provider=deepseek llm.model=deepseek-flash`; its reply listed the
  WhatsApp read tools and confirmed no send tools. Backup:
  `/opt/mcp-gateway/backups/omb-opencode-20261031T235651Z`. The OMB default
  model for new bots was also moved from `opencode-go/qwen3.8-flash` to
  `deepseek/deepseek-flash`, so a new bot cannot inherit the unavailable Go
  model; backup `/opt/mcp-gateway/backups/omb-default-model-20261101T000006Z`.
- New HTTP facades on cleo: ssh 8816, n8n 8817, media 8818, media-devices 8819.
  `media-devices` needs the hub's `cleo-messages`/`cleo-media-registry` units,
  which are not installed on cleo, so bus-dependent tools return `Connection
  refused`; `media_probe`/Kodi tools work. `n8n`'s 207-char legacy API key is
  rejected by n8n (401) — a pre-existing key issue, not the facade.

## 2. Current state (2026-10-31)

| Agent | Host | Config | Today | Status |
|---|---|---|---|---|
| 11 OMB bots | VPS | `/data/.openmausbot/{config,bots}.json` | 11 `gateway-<bot>` entries, one key each | **done** |
| DSH desktop | gpc | `~/.dsh/profiles/desktop/cordis.patch.yml` | `http://10.10.1.4:8484/mcp/v1` | **done** |
| DSH web / split-sandbox | cleo | `~/.dsh/profiles/*/cordis.patch.yml` | one `gateway` row + the local `console` row | **done (console exception)** |
| DSH headless | cleo | `~/.dsh/profiles/headless/cordis.patch.yml` | one `gateway` row (brain-only key) | **done** |
| Claude Code | gpc, cleo | `~/.claude.json` | `qdrant`, `credcheck`, `vault`, `mobile-mcp`, `godot` | wave 1 |
| opencode | gpc, cleo | `~/.config/opencode/opencode.json` | 18 MCP servers (`n8n`, `homeassistant`, `postgres`, `searxng`, `adguard`, `unifi`, `cloudflare`, `ssh`, …) | wave 1 |
| Odysseus app | cleo | app config / SQLite | connectors and tool rows | wave 2 |
| ai-messenger hub + runner | cleo | `~/.config/ai-messenger/` | hub MCP grants, direct servers | wave 2 |
| CubeFarm floors | to confirm | CubeFarm config | to confirm | wave 2 |
| n8n workflows | zues | n8n credentials/workflows | HTTP/MCP nodes with direct keys | wave 2 |
| Pi harness / other CLIs | pi5/gpc/cleo | to confirm | to confirm | wave 2 |

The gateway currently fronts all 20 OMB servers + `computer-use`. **The server
runtimes are still on cleo**; moving them is wave 3, independent of which agents
consume them.

## 3. Identity model

```
<host>-<harness>[-<bot>]        e.g. dsh-gpc, dsh-cleo-web, claude-gpc,
                                     opencode-gpc, omb-remy, messenger-hub,
                                     cube-<floor>-<agent>
```

- Key type `agent`; `delegationAllowed: false` unless the agent is an approved
  delegator; `escalationAllowed: true` for operator-visible tickets.
- Metadata: `{owner, host, harness, purpose, expiresAt?}`.
- Grants: server-level plus an explicit tool list; high-privilege tools only
  where the agent had them before. Keep each key under the consumer's cap
  (OMB 127; audit other harnesses' tool-list limits before granting everything).
- Temporary agents get `expiresInSeconds`; a completed project's key is revoked,
  not reused.
- Breaks the "all agents" rule only for a documented break-glass operator key
  (master), kept off agent hosts.

## 4. Waves

### Wave 0 — OMB (done)
- 11 per-bot entries, 11 keys, draft-only Remy, backup at
  `/opt/mcp-gateway/backups/omb-20261031T233029Z`.
- Verification: `verify_per_bot.py` (all 11 pass: key matches entry, allowlist
  contains only its entry, permitted servers match, one denied probe per bot
  returns `-32002`, audit rows name the key).

### Wave 1 — Developer harnesses (DSH profiles, Claude Code, opencode)
1. Create one key per profile/harness: `dsh-cleo-web`, `dsh-cleo-headless`,
   `dsh-cleo-split`, `claude-gpc`, `claude-cleo`, `opencode-gpc`,
   `opencode-cleo`. Grant only the servers each config actually used; start with
   `tools: null` (all non-high-privilege) and tighten after a week of audit.
2. Replace each MCP row with **one** gateway row. For harnesses that can set
   headers, the row is `Authorization: Bearer <key>`; for harnesses that cannot,
   use one row per identity (the OMB pattern).
3. Remove the old direct entries and old keys from the config; keep a timestamped
   backup on the host.
4. Verify: each harness lists tools, a read-only call lands in the gateway log
   with the right key and server, a tool outside the grant is absent/denied.
5. Gate: all three harnesses run for 48 h with no direct endpoint in their config
   and no un-attributed call in the audit.
6. Rollback: restore the host config backup; the old key is still valid until the
   gate passes, then revoke it.

### Wave 2 — Application agents (Odysseus, ai-messenger, CubeFarm, n8n, Pi)
1. Inventory each agent's MCP rows and its effective tool use from the old
   audit/grants. Create `agent-<name>` keys.
2. ai-messenger: the hub's MCP grants become gateway keys/grants; the runner and
   the hub use the same identity only if they truly share permissions, otherwise
   separate keys. The hub's own `messenger_mcp_*` tools remain; they no longer
   hold upstream service credentials.
3. Odysseus: replace direct connectors with the gateway row; its tool picker
   should show only the granted subset.
4. n8n: replace direct HTTP/MCP nodes with one gateway credential per workflow
   group; keep the workflow's own least-privilege identity.
5. CubeFarm/Pi: same pattern; confirm the config path and whether the harness
   supports per-agent headers. If not, one entry per agent.
6. Gate: every agent's calls appear in the gateway log with its key; no upstream
   credential remains in that agent's config. Revoke the old upstream key.
7. Rollback per agent (config backup + old key kept for the gate window).

### Wave 3 — Move the server runtimes (optional for access, required for the VPS goal)
1. Move the 6 already-private, pinned node servers to VPS stdio installs:
   `brain`, `nextcloud`, `github` (pin `GITHUB_MCP_GROUPS` so it stays 62 tools),
   `cloudflare`, `adguard`, `vaultwarden` (last, approval-gated).
2. Stage the 9 non-reproducible servers into private repos with
   `mcp-manifest.json` + tag + umbrella `.gitmodules`/`pinned.json` entry:
   `searxng-mcp`, `email-mcp` (four accounts via env), `whatsapp-mcp` (private
   fork of the local patch), `instagram-mcp` (today only on cleo's disk),
   `omb-mcp`, `homepage-mcp`, `ha-mcp`, `btt-bca-mcp` (the 35-tool Python server),
   `unifi-mcp` (the 28-tool deployed file, or reconcile with `unifi-network`).
3. Keep the five loopback-bound servers on cleo behind the gateway: `whatsapp`
   (bridge `127.0.0.1:8081`), `instagram` (session state), `omb`
   (`127.0.0.1:8799`), `homepage` (`127.0.0.1:3001` + pi5 SSH), `messenger`
   (hub `127.0.0.1:7317`).
4. Change one upstream URL at a time; diff the tool list against the captured
   baseline; a moved server is accepted only when its tools are unchanged (or the
   difference is signed off).
5. Retire the cleo `*-mcp-http.service` units only after every consumer points at
   the gateway; keep the unit files and keys for one rollback window.

### Wave 4 — Devices / computer use
1. Enrol the six Linux machines in the broker (`gpc` already; `cleo`, `doc`,
   `roof`, `VPS`, `yoga`). Keep DeviceBridge for the Razor Phone, 2× Unraid and
   2× HAOS until the broker grows android tools / a non-systemd bootstrap.
2. Add `device_file_write` to the broker MCP surface (the one daily-use parity
   gap), and keep `device_exec` un-gated for OMB automation via
   `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS=destroy_computer`.
3. Grant `computer-use`/`devicebridge` per agent from the same key model; do not
   put the broker token in any agent config.
4. Retire DeviceBridge when the exceptions are accepted.

### Wave 5 — Decommission
1. Revoke every old upstream key after its consumer's gate.
2. Stop the old direct endpoints; remove them from agent configs.
3. Keep the gateway master key offline and the operator UI over WireGuard only.
4. Final report: per-agent key, grants, last-used, audit rows, and the list of
   retired credentials.

## 5. Observability (what "see in logs" means)

The gateway now writes one line per tool call (v0.14.1+):

```json
{"level":"info","module":"router","msg":"tool call",
 "key":"omb-remy","keyType":"agent","server":"whatsapp",
 "tool":"list_messages","status":"ok","latency_ms":412.7}
```

- No arguments are logged (they can contain secrets); the audit row keeps the
  payload for the operator.
- Denied calls log `status:"denied"` and the `reason`; unknown tools log the
  requested name with `server:null`.
- The audit table carries `keyId`, `serverId`, `toolId`, status, latency and the
  request payload for the console/RBAC views.

Useful checks:

```bash
ssh root@10.10.1.4 "docker logs --since 10m mcp-gateway 2>&1" \
  | jq -c 'select(.msg=="tool call") | {key,server,tool,status,latency_ms}'

# Is an old direct endpoint still being used?
ssh root@10.10.1.4 "docker logs --since 1h openmausbot-omb-1 2>&1" \
  | grep -E 'skipping MCP server|10\.10\.254\.91:8[78][0-9][0-9]'

# Per-bot key/scope proof (read-only)
ssh root@10.10.1.4 "python3 /opt/mcp-gateway/verify_per_bot.py"
```

Acceptance for "no old MCP servers": `config.json` has exactly the 11
`gateway-<bot>` entries; no bot allowlist names an old server; the gateway log
shows upstream server names only as the gateway's target, never as the agent's
configured server.

## 6. Key and secret handling

- Gateway keys: named per identity, stored only in the consumer's config (0600)
  or its secret store; rotated with the gateway API; paused/revoked immediately.
- Upstream keys: only in gateway config profiles (AES-256-GCM vault) or, for
  loopback-bound services, the gateway vault; never in agent files.
- Old upstream keys are revoked at the end of each wave, not before.
- The DSH/gpc profile and OMB config are 0600; the gateway `.env` is 0600 root.
- Backups: nightly gateway `.backup` + `/opt/mcp-gateway/data` rsync; OMB config
  backups before each cutover; broker DB + TLS backup before device work.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Consumer tool cap (OMB 128; other harnesses have their own) | Curate tool grants per key; validate counts before cutover; the gateway hides what is not granted |
| A harness cannot set per-identity headers | One gateway entry per agent identity (the OMB pattern) |
| Tool-name collisions beyond the four email servers | The gateway auto-namespaces any duplicate bare name; watch the audit for `-32602` and qualify prompts |
| Model/provider failure is mistaken for gateway failure | The gateway is verified independently; OMB's `opencodeGo` is currently failing before tool use (pre-existing) |
| Key sprawl | Naming convention + metadata + expiry; monthly unused-key review; revoke, never reuse |
| Gateway is a single point of failure | Restart policy, healthcheck, backups, local gateway retained until the final gate |
| Loopback-only servers keep cleo critical | Keep them behind the gateway; moving them is a separate project (bridge/session state) |
| Credentials left in old configs | Config diff per wave; grep for `10.10.254.91:8` and `X-API-Key` before the gate |

## 8. Acceptance criteria

- Every listed agent config contains only the gateway endpoint (or no MCP row).
- Every agent has a distinct key; `verify_per_bot.py` (generalised to all
  identities) passes for each.
- Cross-agent denial is proven with a read-only probe; no agent can see another's
  servers.
- Every tool call in the gateway log names the key, server and tool; the audit
  has the corresponding row.
- No direct upstream credential remains in an agent config; old keys are revoked.
- A full backup/restore of the gateway and OMB is rehearsed.

## 2026-11-01 — devices, .lan console, Vaultwarden, and the WG fallback

### Devices
Enrolled through the broker admin API and SSH (one-time tokens; temporary admin
tokens revoked afterwards):

| Device | How | State |
|---|---|---|
| `cleo` | SSH, install-connector.sh, terminal enabled | online |
| `doc` (Pi5) | installed `python3-venv` via sudo, then SSH enroll | online |
| `roof` | SSH enroll, terminal enabled | online |
| `us-vps` | SSH (root), terminal enabled | enrolled; connector offline until the home WG path returns (it dials the broker on gpc) |
| `gpc` | already enrolled | online |

### `.lan` console and Homepage
- AdGuard rewrite `mcp-gateway.lan → 10.10.254.49` (the gpc tunnel host).
- Homepage tile **MCP Gateway** in **System**: `http://mcp-gateway.lan:8484/`.
- Vaultwarden login: `local-ui/mcp-gateway/webui-login`, alias
  `mcp-gateway-webui-login`, username `admin`, URI
  `http://mcp-gateway.lan:8484/`. The stored password is the gateway's current
  `MCP_UI_PASSWORD`; a login POST with it returns 200 + session cookie.
- Verified from gpc, doc and roof: `mcp-gateway.lan` resolves and the console
  returns HTTP 200.

### WireGuard outage and fallback
The home WAN address changed and the UDM Pro SE rebooted; `wg.evoonline.co.uk`
updated to `86.131.61.197`, the VPS endpoint watcher updated the live peer after
`resolvectl flush-caches`, but the UDM's `vpn` subsystem stayed in `error` and
WireGuard handshakes stopped. Fallback, with gpc as the home anchor:

- `mcp-gateway-ui-tunnel.service` (gpc): SSH local forward
  `0.0.0.0:8484 → VPS 127.0.0.1:8484`.
- `mcp-gateway-upstream-tunnel.service` (gpc): SSH remote forwards for the 23
  HTTP MCP facades (`287xx`), the broker (`27443`) and DeviceBridge (`28443`),
  bound to the VPS docker bridge IPs.
- Gateway `servers.url` for the 23 HTTP servers → `172.19.0.1:2<port>`;
  `computer-use` → `https://gpc.lan:27443/mcp`; `devicebridge` →
  `https://devicebridge.lan:28443/mcp`.
- Compose `extra_hosts`: `gpc.lan` and `devicebridge.lan` → `172.19.0.1`
  (certificate SANs include both names).
- UFW allows only the docker subnets to `28700:28899`, `27443`, `28443`.
- DSH gateway URL is `http://mcp-gateway.lan:8484/mcp/v1`.

Revert when the UDM's VPN subsystem is healthy again: point the rewrite back at
`10.10.1.4`, restore the original gateway URLs, remove `extra_hosts`, stop the
two gpc tunnel units. The gateway data backup from before the URL change is
`/opt/mcp-gateway/backups/gateway.db.bak-tunnel-20261101T002121Z`.

## 2026-11-01 — OMB MCP-access admin for Cleo and Sentinel

Both bots have the **same 9 `omb` admin tools** in their gateway keys:
`omb_bots`, `omb_servers`, `omb_list_grants`, `omb_bot_prompt`, `omb_bot_soul`,
`omb_grant_servers`, `omb_revoke_grant`, `omb_set_bot_servers`,
`omb_set_bot_profile`.

Setup/fixes:
- The gateway's `omb` server had no config profile (it returned HTTP 404). Added
  `cleo-omb-auth` (`X-API-Key` for the cleo OMB MCP facade) and applied it; the
  server test now returns 9 tools.
- The OMB MCP server's SSH host was `root@10.10.1.4` (WireGuard, currently down).
  Changed `~/.config/omb-mcp/env` to `root@74.208.55.116` (backup
  `env.bak-before-public-*`); the `omb_*` tools now work over the public SSH path.

Checks:
- Cleo: `omb_bots` and `omb_servers` read OK; a no-op
  `omb_set_bot_servers` on Cleo (same `["gateway-cleo"]`, `confirm`=bot id)
  returned `before`/`after` and `isError:false` — the write path works.
- Sentinel: `omb_bots` read OK (same admin tool set).
- This is **OMB MCP-access admin**, not the gateway master/admin API. The
  gateway master key and web-console credentials remain operator-only; bots
  cannot mint gateway keys or change gateway server definitions.
- Souls updated via `omb_set_bot_profile` (Cleo 7,481 bytes, Sentinel 3,707;
  `drift:false`). Both now carry the usage and limits section.
- Shared 2nd-brain memories:
  `db6dee82-7266-4c28-969a-19538dd6ff5b` (how),
  `42742049-6a20-4e4f-a1fc-c9fd2a87f027` (admin limits),
  `2c031e95-b668-4493-ae1f-9bc212dec2c7` (gateway use limits).
- Internal OMB messages sent and acknowledged by both; no access was changed by
  them. Backup before soul edits:
  `/opt/mcp-gateway/backups/omb-bots-before-admin-prompts-20261101T003617Z.json`.

Limits recorded for both: never change own/Sentinel security access without
Craig's approval; never remove `omb`, `brain` or a `gateway-*` entry; prefer
time-limited grants; read before write; report bot, before/after, grant id and
reason; never expose keys; 128-tool cap; changes take effect next turn.

## 2026-11-02 — Vaultwarden console login visibility

The gateway console credential was already in Vaultwarden, but only in the
organization collection `security-agent`, which the web vault shows under the
organization, not under **My vault**. The owner (`evocraigst@proton.me`,
`access_all=1` on org `Security Agent`) can see it, but the technical item name
was easy to miss.

Added a second, clearly named item:
- **MCP Gateway (admin)** in the `cleo` and `infra` collections of the
  **Security Agent** organization; username `admin`; URI
  `http://mcp-gateway.lan:8484/`; same current `MCP_UI_PASSWORD`.
- The original `local-ui/mcp-gateway/webui-login` remains in the
  `security-agent` collection.

Vaultwarden UI: open the **Security Agent** organization in the left sidebar,
not **My vault**, then search `MCP Gateway`. The browser extension needs the
organization vault selected to autofill the `.lan` URL. A login POST with the
stored password returns 200 + session cookie.

The gateway's `vaultwarden` server had briefly returned HTTP 404 because its
config profile was not loaded; reapplying `omb-vaultwarden-auth` restored the
47 tools. The profile is persisted in `servers.config_profile_ids`.

## 2026-11-02 — gateway 404 outage (Nora and all bots)

Symptom: every upstream tool returned `Remote MCP server returned HTTP 404`.
Nora's calls at 16:53 all failed; the gateway was healthy and all servers showed
`running`.

Cause: the servers had their auth config profiles attached
(`servers.config_profile_ids`) but the live HTTP clients were not sending the
profile headers, so each cleo facade answered 404 (missing `X-API-Key`). The
profile association was persisted; the runtime headers were stale. Reapplying
the profile restarts the server and resolves the header.

Fix:
- Reapplied all 24 attached profiles (`cleo-*-auth` / `omb-*-auth`); each test
  returned `ok` with the expected tool count. All 25 servers now test clean;
  `computer-use` returns 26 tools.
- The home→VPS upstream tunnel unit was in a 269-restart loop because an orphan
  `sshd-session` on the VPS still held ports 287xx. Killed the orphan, reset and
  restarted the unit; 48 listeners active. Added sshd
  `ClientAliveInterval 30` / `ClientAliveCountMax 3` so a dead client cannot
  leave the ports held for hours.
- Self-heal: `scripts/vps/heal_gateway_profiles.py` every 5 minutes
  (`mcp-gateway-heal.timer`) tests each profiled server and re-applies the
  profile only when the failure is 401/403/404; transport failures are skipped.
- Usage visibility: the console **Audit** page has the per-call key/server/tool
  records (676 entries at the time of the fix). `scripts/vps/usage_report.py`
  prints per-key calls/errors and error servers; run on the VPS:
  `python3 /opt/mcp-gateway/usage_report.py --since 6h`.

Verified after the fix: `omb-nora` unifi/searxng/brain/homepage/adguard/cloudflare
all return data; `omb-remy` WhatsApp `list_chats`/`list_messages` return data;
`dsh-harness-vps2` computer-use `list_devices` returns all 5 devices.

## 2026-11-05 — WireGuard restored; fallback retired

WireGuard is healthy again: latest handshake under 60 s, and both home hosts
answer from the VPS over `wg0` (gpc `10.10.254.49` and cleo `10.10.254.91`,
~98 ms). The 2026-11-01 fallback — SSH reverse tunnels from gpc, upstream URLs
on `172.19.0.1`, compose `extra_hosts` and the gpc-hosted `.lan` console path —
was therefore retired.

By the time of the revert most connectors had already been migrated to
gateway-local installs, so only **three** servers were still remote HTTP and
pinned to the fallback: `computer-use`, `vaultwarden` and `messenger`.
`devicebridge` also still used the tunnel for its HTTP hub. The first table
below describes the fallback as it was built on 2026-11-01; the "New direct
URLs" table is the state after this revert.

### What was still pinned to the fallback

| Thing | Fallback value | Where |
|---|---|---|
| 23 HTTP upstreams | `http://172.19.0.1:2<port>/mcp` (the facade's `88xx` port with a leading `2`, e.g. `8808 → 28808`) | gateway `servers.url` (DB) |
| `computer-use` | `https://gpc.lan:27443/mcp` — also the wrong port: the broker had already moved to `7443` | gateway DB |
| `devicebridge` | `https://devicebridge.lan:28443/mcp` | gateway DB |
| name resolution | `extra_hosts`: `gpc.lan`, `devicebridge.lan` → `172.19.0.1` | `deploy/vps/docker-compose.yml` on the VPS |
| console DNS | AdGuard rewrite `mcp-gateway.lan → 10.10.254.49` (the gpc tunnel host) | AdGuard Home |
| console path | `mcp-gateway-ui-tunnel.service` (gpc): SSH local forward `0.0.0.0:8484 → VPS 127.0.0.1:8484` | gpc `~/.config/systemd/user/` |
| upstream path | `mcp-gateway-upstream-tunnel.service` (gpc): SSH `-R` forwards for the 23 facades, broker and DeviceBridge, bound to the VPS docker bridge IPs — crash-looping: `ExitOnForwardFailure`, exit 255 every 5 s because the old forwards were already held | gpc `~/.config/systemd/user/` |
| upstream path (**the live one**) | `/etc/systemd/system/usvps-mcp-tunnels.service` on **cleo** — a system unit that actually held all 24 `172.19.0.1:2xxxx` forwards. The gpc unit above was a duplicate that could never bind, which is exactly why it looped forever while the ports stayed up | cleo `/etc/systemd/system/` |

The deployed compose file also still carried the pre-fallback image tag
`0.14.1`; it is now parameterised as `${MCP_IMAGE_TAG:-0.15.5}` and the
`extra_hosts` block is gone.

### New direct URLs (over WireGuard)

| Gateway server | New `servers.url` |
|---|---|
| `computer-use` (broker) | `https://10.10.254.49:7443` |
| `vaultwarden` | `http://10.10.254.91:8808/mcp` |
| `messenger` | `http://10.10.254.91:8814/mcp` |
| `media-devices` | **no longer remote**: kept as a gateway-local stdio install, but its state now lives at `MEDIA_DEVICES_DIR=/data/secrets/media-devices` (see "Connector fixes" below) |
| the other cleo facades | cleo `10.10.254.91` + the facade's original `88xx` port (the `2` prefix disappears: `28814 → 8814`) |
| `devicebridge` | `https://10.10.254.91:8443/mcp` (cleo's DeviceBridge hub; CA already in `/certs/combined-ca.pem`) |

The broker certificate is mkcert-issued with SANs `10.10.254.49` and `gpc.lan`,
so using the IP avoids DNS and `extra_hosts` entirely.
`MCP_COMPUTER_BROKER_URL`, `MCP_COMPUTER_BROKER_PUBLIC_URL` and
`MCP_COMPUTER_INSTALL_BASE_URL` are all `https://10.10.254.49:7443`;
`deploy/vps/gateway.env.example` is aligned.

### Connector fixes applied with the revert

Retiring the tunnel exposed four connectors that had been silently relying on
home-host state or on defaults that do not exist in the container. All were
repaired in the gateway DB (`servers.env`) and verified with
`POST /mcp/v1/admin/servers/:id/test` — **24/24 pass**.

| Connector | Failure | Fix |
|---|---|---|
| `computer-use` | `ECONNREFUSED 172.19.0.1:27443` — stale fallback URL *and* the wrong port | `servers.url` + `computer_use_settings.broker_url` → `https://10.10.254.49:7443`; broker healthy (5 computers, `list_computers` OK) |
| `media-devices` | registry empty: env used `MEDIA_DEVICES_CONFIG`, which the plugin **does not read** (`lib/config.js` only honours `MEDIA_DEVICES_DIR` / `_REGISTRY` / `_SSH_CONFIG` / `_HELPER` / `_HA_*`), so it fell back to `$HOME/.config/media-devices` — a directory that does not exist for uid 1000 in the container | env → `MEDIA_DEVICES_DIR=/data/secrets/media-devices`, `_SSH_CONFIG=/data/secrets/media-ssh-config`, `_SSH_TARGET=craigst@10.10.254.85`, `_JOURNAL=.../journal.jsonl`, `_READ_ONLY=1`; registry seeded from cleo's pre-cutover `~/.config/media-devices/devices.json` (3 devices: `bathroomsw/ha_pager`, `tembed/tembed_pager`, `tv-bedroom/kodi_tv`) |
| `ssh`, `homepage`, `omb` | all shell out to `ssh`; `SSH_KEY` pointed at `/home/node/.ssh/id_ed25519`, which never existed (ephemeral `$HOME`), and `zues`/`shadow`/`pi5` did not resolve | created `./data/ssh-home/.ssh` (key + `known_hosts` + config: `pi5`→`10.10.254.85` user `craigst`, `zues`→`10.10.254.13` root, `shadow`→`10.10.254.84` root) and mounted it at `/home/node/.ssh`; `SSH_KEY` repointed for the two servers that read it |
| `devicebridge` | MCP bridge still dialled `devicebridge.lan:28443` (tunnel) | `DEVICEBRIDGE_URL=https://10.10.254.91:8443/mcp` |
| DeviceBridge fleet | `gpc` device offline 6 days — the connector was `disabled`/`inactive` on the host | `systemctl --user enable --now devicebridge-connector.service` on gpc; it dials `wss://10.10.254.91:8443/ws/connector` and is online again |

Still outstanding, all **application/credential** state rather than gateway
config, and each needs the operator:

- `vaultwarden` — `login_status: "locked"`; unlock with the master password.
- `instagram` — `login_required`: save a fresh session with `ig-mcp login`.
- `n8n` — key authenticates (HTTP 200) but the instance returns
  `{"data":[],"nextCursor":null}`: there are no workflows to list.
- `tv-bedroom` (Kodi on `doc`) — `media_probe` reports `kodi_running: false`,
  so the device probe fails with `ConnectionRefusedError`; Kodi has to be
  running on the media hub.

### Revert commands

AdGuard — replace the rewrite (the delete must match the old answer exactly;
the gateway's `adguard` server exposes `adguard_delete_rewrite` /
`adguard_add_rewrite` for the same two calls):

```bash
curl -sk -u "$ADGUARD_USER:$ADGUARD_PASS" https://adguard.lan/control/rewrite/delete \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mcp-gateway.lan","answer":"10.10.254.49"}'
curl -sk -u "$ADGUARD_USER:$ADGUARD_PASS" https://adguard.lan/control/rewrite/add \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mcp-gateway.lan","answer":"10.10.1.4"}'
```

gpc tunnel units:

```bash
systemctl --user stop mcp-gateway-upstream-tunnel.service mcp-gateway-ui-tunnel.service
systemctl --user disable mcp-gateway-upstream-tunnel.service mcp-gateway-ui-tunnel.service
systemctl --user reset-failed mcp-gateway-upstream-tunnel.service
# prove the reverse forwards are really gone
ssh root@10.10.1.4 'ss -tlnp | grep -E ":(287[0-9]{2}|27443|28443)\b" || echo "no fallback listeners"'
```

cleo — the system unit that actually owned the live forwards (this is the one
that keeps the ports up; stopping only the gpc unit changes nothing). Its
2-minute watchdog **must be disabled first**: the watchdog probes
`172.19.0.1:28801` and restarts the tunnel whenever the probe fails, so
disabling only the tunnel unit leaves it resurrected within two minutes.

```bash
ssh craigst@10.10.254.91 '
  sudo systemctl disable --now usvps-mcp-tunnels-watchdog.timer
  sudo systemctl stop usvps-mcp-tunnels-watchdog.service
  sudo systemctl disable --now usvps-mcp-tunnels.service'
ssh root@10.10.1.4 'ss -tlnp | grep "172.19.0.1" || echo "0 fallback listeners"'
```

`reset-failed` matters because the upstream unit was in a restart loop. If a
port is still held, an orphan `sshd-session` on the VPS owns it — kill that
process rather than re-enabling the unit.

Compose (after removing `extra_hosts` from
`/opt/mcp-gateway/docker-compose.yml`):

```bash
docker compose -f /opt/mcp-gateway/docker-compose.yml up -d
curl -s http://127.0.0.1:8484/mcp/v1/health
```

Verify from the LAN — with the tunnel units stopped this proves the WG path:

```bash
getent hosts mcp-gateway.lan          # must be 10.10.1.4
curl -s http://mcp-gateway.lan:8484/mcp/v1/health
```

### Rollback

Re-enable the tunnel units (both the gpc duplicates **and** cleo's system unit —
the cleo one is what actually binds the ports) and restore the pre-fallback
gateway data:

```bash
# gpc
systemctl --user enable --now mcp-gateway-upstream-tunnel.service mcp-gateway-ui-tunnel.service
# cleo — without this the 172.19.0.1 forwards never come back; the watchdog
# is what keeps them up afterwards
ssh craigst@10.10.254.91 '
  sudo systemctl enable --now usvps-mcp-tunnels.service
  sudo systemctl enable --now usvps-mcp-tunnels-watchdog.timer'

# on the VPS: keep the current DB under a fresh name, then restore the snapshot
docker compose -f /opt/mcp-gateway/docker-compose.yml down
cp -a /opt/mcp-gateway/data/gateway.db \
  /opt/mcp-gateway/backups/gateway.db.bak-before-restore-$(date -u +%Y%m%dT%H%M%SZ)
install -m 600 -o 1000 -g 1000 \
  /opt/mcp-gateway/backups/gateway.db.bak-tunnel-20261101T002121Z \
  /opt/mcp-gateway/data/gateway.db
rm -f /opt/mcp-gateway/data/gateway.db-wal /opt/mcp-gateway/data/gateway.db-shm
docker compose -f /opt/mcp-gateway/docker-compose.yml up -d
```

Caveat, so nobody restores the wrong state: `gateway.db.bak-tunnel-20261101T002121Z`
was taken **before** the 2026-11-01 URL rewrite (see that section), so it brings
back the pre-fallback rows, not the `172.19.0.1` ones. To reproduce the fallback
exactly, also re-add the `extra_hosts` block (`gpc.lan`, `devicebridge.lan` →
`172.19.0.1`) and set the `172.19.0.1:2<port>`, `gpc.lan:27443` and
`devicebridge.lan:28443` URLs again using the 2026-11-01 table above. Snapshot
the DB *before* starting the revert if the fallback URLs need to be recoverable
verbatim.

### Follow-ups found after the post-revert audit (2026-11-05, later)

- **`computer_screenshot` → `connector_unavailable: connector disconnected`**
  while the broker listed gpc's connector as online. Two `python -m connector`
  processes were alive with the *same* identity/state dir
  (`~/.local/share/computer-broker-connector-computer`, `BRK_NAME=gpc`) — a
  stale duplicate next to the systemd-managed one. Killed the duplicate and
  `systemctl --user restart computer-broker-connector-computer.service`; a real
  gpc frame then came back. If a screenshot fails again, count the connector
  processes first (`pgrep -af 'connector-venv/bin/python -m connector'`).
- **gpc container inventory read unavailable**
  (`docker socket is not present (/run/user/1000/podman/podman.sock)`) although
  `podman.socket` was `active`: the socket file itself had been deleted.
  `systemctl --user restart podman.socket` recreated it; after restarting the
  DeviceBridge connector, `device_docker` on gpc reports `available: true`
  (17 containers).
- **Email tool names:** the gateway advertises the 11 bare `email_*` tools
  (confirmed with `tools/list`, and `tools/call email_list_accounts` returns the
  accounts). A session that offers `email_<account>__<tool>` names is showing a
  stale client-side tool cache from before the four per-account email servers
  were retired — reconnect the harness; the gateway is correct.
- **`computer_use_availability` has zero rows and that is correct:**
  `src/computer_use/settings-store.ts` treats absence as *available*; rows exist
  only for per-computer overrides or a global pause.
- **`devicebridge` on gpc:** the connector is a user unit and was
  `disabled`/`inactive` (the device had read offline for 6 days). It is
  `enable --now`'d again and dials `wss://10.10.254.91:8443/ws/connector`.

## 2026-11-05 (later) — Computer Broker moved from gpc to the USA VPS

**Why.** The broker ran on gpc, so every computer-use tool died whenever the
bedroom PC was off — the gateway stayed up but its only broker did not. The
broker now runs next to the gateway, so computer-use needs nothing but the VPS:
gpc and every other machine are just connectors that come and go.

**What moved**

| Thing | Before (gpc) | After (VPS) |
|---|---|---|
| broker process | user unit `computer-broker.service` on gpc | system unit `computer-broker.service`, `/opt/computer-broker`, venv in `/opt/computer-broker/venv` |
| listen | `0.0.0.0:7443` on gpc | `10.10.1.4:7443` (WireGuard only; UFW also admits the Docker subnets) |
| state | `~/.local/share/computer-broker` on gpc | same path for `craigst` on the VPS (`broker.db` 53 MB, `secret.key`, `tls/`, `computers/`) |
| config | `~/.config/computer-broker/broker.env` | same path on the VPS, plus `BRK_BIND=10.10.1.4`, `BRK_PORT=7443`, `BRK_PUBLIC_URL=https://10.10.1.4:7443` |
| TLS | mkcert cert/key in `tls/` | unchanged files — SANs already include `10.10.1.4`, `127.0.0.1`, `localhost`, `gpc.lan` |
| gateway | `MCP_COMPUTER_BROKER_URL=https://10.10.254.49:7443` | `https://10.10.1.4:7443` (env, `computer_use_settings`, `servers.url`) |
| connectors | `wss://10.10.254.49:7443/connector` (gpc) or `127.0.0.1` (gpc) | `wss://10.10.1.4:7443/connector` on gpc, cleo, doc, us-vps |

**Cutover order that was used** (downtime ≈ 1 minute): install code + venv +
unit on the VPS → stop gpc's broker → rsync `broker.db`/`secret.key`/`tls/`/
`computers/`/`broker.env` (a clean stop checkpoints the WAL; `quick_check` was
`ok`, 5 computers / 10 connectors / 5 devices / 2 agents) → append the bind to
`broker.env` → `systemctl enable --now computer-broker` (healthz proved
`tls:true`) → prove the gateway container can reach it
(`docker exec mcp-gateway node -e "fetch('https://10.10.1.4:7443/healthz')…"`) →
repoint the gateway (stop container, patch env + DB, start) → repoint and restart
each connector → `computer_screenshot` through the gateway returned a real gpc
frame.

**Enrolment is not needed again:** `broker.db` carries the connector pubkeys and
the two agent tokens, so connectors re-attach as their existing `cnr_…` identity
and `MCP_COMPUTER_BROKER_TOKEN` keeps working.

**Rollback:** re-enable gpc's `computer-broker.service`, restore the
`10.10.254.49:7443` URLs, and reverse `BRK_BROKER_URL` on each connector. The
pre-move broker DB/config are in `/opt/mcp-gateway/backups/broker-<stamp>/`.

**Still to do, when the device is next on:** `roof` (10.10.254.205) was powered
off during the move, so its `BRK_BROKER_URL` still names gpc; the one-liner is in
`docs/VPS-DEPLOY.md` ("Known limits after the move").

### 2026-11-05 (later still) — VM hosts and container computers made to work from the VPS

The move left three computers that were tied to gpc. All three were addressed:

| Computer | What was wrong | Fix |
|---|---|---|
| `zues-vm-1` | VM host `libvirt-ssh` used `host: "zues"`, which does not resolve from the VPS, and had no key; the VM's cloud-init seed also embedded the old broker URL `wss://10.10.254.49:7443/connector` | `vm_hosts.config` → `host/ssh_host=10.10.254.13`, `ssh_key=/home/craigst/.ssh/id_ed25519` (key authorised on zues); `POST …/vm-hosts/:id/test` → `{ok:true, baseReady:true}`; then the guest's `/etc/brk/env` edited **offline** through `qemu-nbd` on zues (stop the computer through the API first or the reconciler restarts the domain). VM boots, connector online, `computer_screenshot` returned its XFCE desktop |
| `agent-desktop` (container) | the host had no podman and no `desktop-base` image; the old record's connector identity lived in a podman volume that did not travel with `broker.db`, so its connector refused to start ("no identity and no BRK_BOOTSTRAP_TOKEN") | installed podman + uidmap, `loginctl enable-linger craigst`, put `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS` in the broker unit (rootless podman cannot pick systemd cgroups without the user bus), built `localhost/computer-broker/desktop-base:1` from `images/desktop-base/Containerfile` and pinned `BRK_IMAGE_DIGEST`; then destroyed and re-created the record via `POST /api/computers` so the fresh volume gets an enrolment token. Container runs, connector online, screenshot OK |
| `gpc-vm-1` | its VM host is `qemu-local` — "this machine runs qemu-system-x86_64" — and the broker no longer runs on gpc | retired (old disk and base images kept on gpc under `~/.local/share/computer-broker/vm/`) and **recreated as `zues-vm-2`** on the zues hypervisor (2 vCPU / 4 GB / 30 GB, XFCE): ready, connector online, screenshot OK. Creating it also exposed a missing host dependency: the broker builds the cloud-init seed locally and needs `genisoimage` (`apt-get install genisoimage`), otherwise every VM create fails with `vm create failed: genisoimage was not found` |

Two things that surprised and are worth remembering:

- The broker's `_env_contents` prefers `BRK_PUBLIC_URL` for the URL it writes into
  container computers. If that is set to the host's WG address, a rootless
  container dials an address it cannot reach; leaving `BRK_PUBLIC_URL` empty makes
  it use `host.containers.internal`, which the mkcert cert already covers.
- `BRK_BIND` had to become `0.0.0.0`: a rootless container's connection to the
  host SNATs to the host's primary address, so a `10.10.1.4`-only listener is
  unreachable from a container computer. UFW remains the boundary — verified that
  `https://74.208.55.116:7443` times out from the LAN while the WG address
  answers 200.
