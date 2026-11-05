# MCP Server Migration Plan — Odysseus laptop → MCP Gateway

Status: **migration in progress — AdGuard, Cloudflare, n8n and Nextcloud are source-backed gateway-local installs; brain is blocked on the messenger-hub dependency.**
Last updated: 2026-11-04 (migration log appended)

## Why

Most MCP servers are currently **remote-agent endpoints** reached through SSH
tunnels from the Odysseus laptop (`cleo`, `10.10.254.91`) into the gateway host.
If the laptop, Odysseus, or DeepSeek Harness goes down, the gateway loses those
MCP servers with it.

Target: every MCP server is installed and run by the gateway, with the private
GitHub source as the source of truth, so the Catalog/Update path is authoritative.

## What the gateway can run

Verified in the live `mcp-gateway` container:

- Node **24.22** and npm 11
- Python **3.11**, `python3-venv`, `uv`
- `git`, `curl`, `openssh-client`
- persistent `/data` volume (`/data/repos` for catalog installs)
- **no Docker socket**, no display/browser
- LAN reachability from the container: AdGuard `200`, Home Assistant `200`,
  UniFi `301`, n8n `200`, OMB `200`; public services reachable.

Consequences:

- **Node/Python API-client MCPs** can run in the gateway.
- **Docker/display/phone/bridge-bound** MCPs cannot simply be moved.
- Python dependencies can be installed with `uv`; native binaries (e.g. `bw`) need a
  custom image layer or package.

## Private source coverage

Catalog sources now present:

| Source | Kind | Entries | Notes |
|---|---|---:|---|
| Private MCPs — DSH-Plugins | `dsh-umbrella` | 18 | Private token in gateway vault; 12 entries match current server names |
| btt-bca-mcp | `github-repo` | 1 | Private repo source added |
| UniFi Network MCP | `github-repo` | 1 | Private repo source added |
| Web Search SearXNG MCP | `github-repo` | 1 | Private repo source added |

Read-only pilot: **`github-mcp`** installed from the DSH-Plugins source as
`github-catalog-test`, built/started, passed `gh_verify`, `gh_repo_get` and
`gh_file_get` with `GITHUB_READ_ONLY=1`, then removed. No live server was replaced.

Existing inventory: **25 servers**, 24 are `remote-agent` with `sourceUrl: null`;
`here-hgv` is the only gateway-local server.

## Migration matrix

Legend: **Ready** = source available and runtime fits, credentials/config still
required. **Needs work** = source or packaging gap. **Remote** = keep on its host
for now.

| Server | Source | Runtime | Gateway fit | Main blocker |
|---|---|---|---|---|
| adguard | DSH umbrella | Node | **Ready** | AdGuard URL/user/pass |
| brain | DSH umbrella | Node | **Ready** | brain data/API |
| btt-bca | private repo | Python | **Needs work** | Python deps + BCA config |
| cloudflare | DSH umbrella | Node | **Ready** | API token |
| computer-use | host/gpc | remote | **Remote** | display/VM control |
| devicebridge | DSH umbrella | Node | **Ready** | hub URL/token |
| email-gmail / mum / personal / work | local Odysseus Python | Python | **Needs work** | no private repo; IMAP/SMTP creds |
| github | DSH umbrella | Node | **Ready** (pilot) | PAT; read-only verified |
| here-hgv | local repo | Node | **Ready** | already local |
| homeassistant | local `ha-mcp` | Python | **Needs work** | no private repo; HA token |
| homepage | local DSH plugin | Node | **Needs work** | no repo (known gap) |
| instagram | local Python instagrapi | Python | **Needs work** | session/state; no private repo |
| media | DSH umbrella | Node | **Needs work** | SSH/hub keys |
| media-devices | DSH umbrella | Node | **Needs work** | SSH/hub keys |
| messenger | DSH umbrella | Node | **Ready** | hub URL/token |
| n8n | DSH umbrella | Node | **Ready** | n8n URL/API key |
| nextcloud | DSH umbrella | Node | **Ready** | URL/app password |
| omb | local | Node/HTTP | **Needs work** | source gap + OMB API |
| searxng | private repo | Node | **Ready** | SearXNG URL |
| ssh | DSH umbrella | Node | **Ready** | SSH keys/security review |
| unifi | private repo | Node | **Ready** | UniFi credentials |
| vaultwarden | DSH umbrella | Node + `bw` | **Needs work** | `bw` CLI/cache packaging |
| whatsapp | local bridge + Python + Go | complex | **Remote initially** | phone bridge/SQLite/session |

## Hard dependencies to migrate

Credentials currently live on the Odysseus side, not in the gateway's facade
profiles. The existing `omb-*-auth` profiles are only the upstream gateway
X-API-Key headers. For each migrated server we must create a **local env/config
profile** in the gateway vault (or a vault-ref profile), not copy plaintext.

Stateful data:

- **brain** — its data store/backend
- **vaultwarden** — `bw` binary/cache and session state
- **media / media-devices** — SSH keys and hub config
- **instagram** — instagrapi session files (IP/session risk)
- **email** — IMAP/SMTP credentials
- **homeassistant** — HA long-lived token
- **omb** — OMB API endpoint/auth
- **whatsapp** — bridge SQLite databases, WhatsApp session, phone link
- **ssh** — SSH keys/config

## Phases

### Phase 0 — safety

- Back up gateway database, catalog source/token metadata, config profiles, OMB bot MCP list and current server definitions.
- Freeze changes while one server is being tested.
- Keep the existing remote-agent server until the replacement passes.

### Phase 1 — complete the private source set

- Add private sources for missing repos (btt-bca, unifi, searxng already added).
- Create private repositories (or add to DSH-Plugins) for local-only servers:
  email, homeassistant, homepage, instagram, omb; document WhatsApp separately.
- Every future install must come from a catalog source; no more hand-registered servers.

### Phase 2 — low-risk read-only pilots

Install each under `<name>-catalog-test`, with its local env/profile, start it, and test only read tools. Remove the test server after each. Good order:

1. adguard
2. cloudflare
3. searxng
4. unifi
5. n8n
6. nextcloud
7. messenger
8. github (already tested)

### Phase 3 — Python/simple APIs

btt-bca, email, homeassistant, omb, instagram. Package Python dependencies with `uv`; copy only the required state into `/data`; test read-only.

### Phase 4 — stateful/device-adjacent

brain, media, media-devices, devicebridge, ssh, vaultwarden. These need SSH keys, hub config, a `bw` package or state migration. Test carefully.

### Phase 5 — host-bound

- **computer-use** — keep on gpc unless a headless/VM equivalent is designed.
- **whatsapp** — keep the bridge and phone link on the current host initially; migrating means moving the Go bridge, SQLite state and session, which is a separate project.

### Phase 6 — cutover and decommission

For each server:

1. Install under a test name; verify tool list and read-only calls.
2. Compare the tool schema/count with the current server.
3. Stop the old remote server; install the source-backed server under the production name with the same config profile.
4. Update the gateway key grants for the affected OMB bot keys.
5. Test read-only through the gateway and through the bot.
6. Keep the old endpoint/config for rollback for at least a week.
7. Remove the SSH tunnel/facade only after all consumers are switched.

## Cutover rules

- Do not remove the old server before the new one passes.
- Do not paste credentials into the catalog, a repo, a task or a chat; use gateway config profiles/vault refs.
- Do not use `update`/`reinstall` on an existing `remote-agent` server until it is migrated: the update engine can replace its runtime with a local process.
- Gateway is the bots' own tool provider: deployment and restart of the gateway itself must be out-of-band (CI or a detached script), never from a tool call the gateway is serving.
- Update OMB bot key grants only after the new server's read-only tests pass.

## Risks

- The gateway VPS becomes a single point of failure; it needs backups and a recovery procedure.
- Credentials/state are the hard part, not the code.
- Server names/IDs are referenced by OMB keys; renaming during cutover must be planned.
- Python/native dependencies increase the gateway image and update surface.
- Instagram/WhatsApp sessions may be IP- or device-bound.
- Do not assume a catalog entry with the same name means the existing server is source-linked; `installedServerId` can be a name match only.

## Recommended first production pilot

**adguard** — Node, read-only-friendly, LAN reachable, no persistent state, and the credential requirements are isolated. If that passes, proceed to cloudflare, searxng, unifi, n8n, nextcloud and messenger.


## Progress log

### AdGuard — migrated 2026-11-04

- Installed from `DSH-Plugins` catalog source with `ADGUARD_URL=https://adguard.lan`.
- Tested read-only first: status, stats, filters, rewrites.
- Production server replaced: `srv_3ef09ab5558345a0`, runtime `node`, workDir `/data/repos/adguard`, source markers set.
- OMB/harness key grants updated from the old remote server ID.
- Old remote process on cleo left running temporarily as a rollback; gateway registration removed.
- Backup: `backups/adguard-remote-before-cutover-*.json`, `backups/adguard-key-grants-before-cutover-*.json`.

### Cloudflare — migrated 2026-11-04

- Installed from `DSH-Plugins` catalog source with the live `CF_*` environment.
- Tested read-only: `cf_verify`, `cf_zones`, `cf_tunnels`.
- Production server replaced: `srv_4bd27f681dc34b3a`, runtime `node`, workDir `/data/repos/cloudflare`, source markers set.
- OMB/harness key grants updated.
- Old remote process on cleo left running temporarily as a rollback.
- Backup: `backups/cloudflare-remote-before-cutover-*.json`, `backups/cloudflare-key-grants-before-cutover-*.json`.

### n8n — migrated 2026-11-04 (after credential fix)

- First test install exposed a **401** from n8n; the existing remote server returned the same 401. This was an invalid old API key.
- A new 289-character n8n API key was added to Vaultwarden alias `n8n-api-key-workstation`, validated (`HTTP 200`), and used for a fresh test install. Read-only `n8n_status`, `n8n_list_workflows` and `n8n_list_executions` passed with zero workflows (new n8n instance).
- Production replaced: `srv_9f2073b95998459b`, runtime `node`, workDir `/data/repos/n8n`, source markers set, 36 tools.
- OMB/harness key grants updated.
- Old remote n8n registration removed; old process left temporarily as a rollback.
- Vault cleanup: `n8n-api-key-workstation` left active/valid; the two dead aliases (`n8n-api-key-credcheck-config`, `n8n-c5-api-key`) soft-deleted to the Bitwarden trash.
- Backup: `backups/n8n-remote-before-cutover-*.json`, `backups/n8n-key-grants-before-cutover-*.json`.


### Nextcloud — migrated 2026-11-04

- Installed from `DSH-Plugins` catalog source; app password copied from the live cleo config to `/data/secrets/nextcloud-app-password` (0600).
- Tested read-only with writes disabled: `nc_status`, `nc_files_list`, `nc_calendars_list`.
- Production server: `srv_0719a7f256504a77`, runtime `node`, workDir `/data/repos/nextcloud`, writes preserved (`NEXTCLOUD_ALLOW_WRITES=1`).
- OMB/harness key grants updated.
- Test server and test workdir removed.

### brain — STOPPED 2026-11-04

- Catalog install and tool discovery succeeded (12 tools).
- Read-only calls failed because brain needs the messenger hub at `127.0.0.1:7317` on cleo for caller identity, and the hub is loopback-only. The gateway can reach cleo's LAN IP but not that loopback port.
- Test server removed; production brain left untouched.
- Blocker: brain's ACL identity depends on the messenger hub. Either migrate/relay the hub, or expose it on a LAN-bound address with a scoped credential, before brain can move.


## 2026-11-05 migration continuation

- **GitHub** migrated from the remote-agent facade to a gateway-local catalog
  install (`srv_0b6c710434494152`, 115 tools, workDir `/data/repos/github`).
  Read-only `gh_verify`, `gh_repo_get` and `gh_file_get` passed. 11 keys updated.
- **DeviceBridge** migrated to a gateway-local catalog install
  (`srv_6e78160515b8482c`, 56 tools). It uses the existing `devicebridge.env`
  and CA copied to `/data/secrets`; `device_list` and `device_alerts` passed.
  14 keys updated.
- **Messenger MCP** was installed and passed read-only tests against the VPS
  hub (`messenger_status`, `messenger_whoami`, `messenger_contacts`,
  `messenger_conversations`), but it was **not cut over**: the hub is still a
  replica and full messenger cutover is pending. Test server removed.
- Second Brain MCP is now gateway-local and uses the VPS hub/API:
  `srv_9b2889a22c9f4014`, 12 tools, 27 keys updated.
- Gateway was restarted once to clear stale remote tool routing; health is ok
  and OMB returns 200.


## 2026-11-05 continuation 2

- **GitHub**: `srv_0b6c710434494152`, 115 tools, local source install; 11 keys.
- **DeviceBridge**: `srv_6e78160515b8482c`, 56 tools, local source install; 14 keys.
- **media**: `srv_bfb0f72e1fbe489c`, 45 tools, local source install; read-only
  `media_probe` passes (Kodi was off, so TV state calls were unavailable).
- **media-devices**: `srv_59bafd08e5714049`, 39 tools, local source install;
  `devices_list` returns the three registered devices.
- SSH key/config and media helper configs were copied to `/data/secrets` with mode
  0600; the gateway can reach the Pi as `craigst@10.10.254.85`.
- **Messenger MCP** passed read-only tests against the VPS hub but remains on the
  old remote registration pending full messenger cutover.
- **btt-bca** is blocked by the import autodetector: the repository keeps the
  Python server at `src/server.py`, but the catalog import reports no entry point
  even with a `src` subpath source. It needs a checked-in manifest or a small
  importer/source adjustment before it can be migrated.


## 2026-11-05 continuation 3 — host applications stay put

- **homeassistant** connector migrated into the gateway. HA itself remains at
  `10.10.254.84:8123`; the VPS reaches it over WireGuard. The connector runs as
  a local Python venv (`mcp==1.30.0`), `srv_1f0f1d37162a453f`, 3 tools;
  `ha_states` and `ha_get` passed. 6 keys updated. No HA data or add-ons moved.
- **searxng** migrated (`srv_be96df122c164cb4`, 6 tools); `health` and `search`
  passed. SearXNG itself stays at `10.10.254.13:8010`.
- **ssh** migrated (`srv_5f108901aa744482`, 10 tools); its key/config copied;
  `ssh_list_systems` and a read-only `ssh_run` passed. 3 keys updated.
- **unifi** migrated (`srv_20c82cd7d24a440a`, 28 tools); `unifi_health` and
  `unifi_status` passed. 6 keys updated.
- Remaining remote: btt-bca (import entry-point gap), computer-use (host-bound),
  email x4 (source/packaging gap), homepage (SSH/source), instagram (session),
  messenger (hub cutover), omb (SSH/Docker-inside-VPS coupling), vaultwarden
  (`bw` CLI), whatsapp (bridge/phone).
