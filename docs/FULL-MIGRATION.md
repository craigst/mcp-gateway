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
  `/opt/mcp-gateway/backups/omb-opencode-20261031T235651Z`.
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
