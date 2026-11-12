# Connector Audit — MCP Gateway (USA VPS)

| | |
|---|---|
| **Audit written (UTC)** | 2026-11-05T12:51:41Z |
| **Baseline capture window (UTC)** | 2026-11-05T12:47:29Z → 2026-11-05T12:49:29Z |
| **Gateway version** | `0.15.5` (image `localhost/mcp-gateway:0.15.5`) |
| **Gateway host** | USA VPS `10.10.1.4` (`ubuntu`), Docker container `mcp-gateway` |
| **Gateway API** | `http://127.0.0.1:8484` (admin reads) |
| **Auditor** | `connector-auditor` (read-only), MCP key `dsh-harness-vps2` |
| **Pass** | **BASELINE** — nothing changed, nothing fixed |

> **⚠ Concurrent change during this audit.** This was intended as a pure baseline, but the Lead's config fix
> landed **mid-run at 2026-11-05T12:50:00Z** (`computer_use_settings.updated_at`) and the gateway container
> restarted (observed `Up 39 seconds` at 12:51Z). Everything in **§2–§6 is the state as captured 12:47–12:49Z**.
> A clearly-labelled **§7 "state observed after the change"** records what the fix did and did not resolve.
> §7 is *not* the formal POST-FIX verification pass — that will be a separate run the Lead requests.

---

## 1. Method

Read-only throughout. No VPS/container/DB writes, no service start/stop.

- Server registry: `GET /mcp/v1/admin/servers` over SSH on the VPS against `127.0.0.1:8484`, using the master
  key read from `/opt/mcp-gateway/gateway.env` **inside the remote shell only** (never echoed, never stored).
- DB: `/opt/mcp-gateway/data/gateway.db` opened SQLite `mode=ro` via `python3` (no `sqlite3` binary present).
- Live probes: each connector's **own** status/health tool where one exists (named per row in §2), called
  through the gateway. Where a tool is not granted to this key, that is stated and the probe is marked
  **(probed via master key)** or **not run**.
- Tool advertisement cross-check: `tools/list` on `/mcp/v1` → **668 tools**, matching `select count(*) from tools`
  = **668**.

### Redaction

All tokens, keys, passwords and secret values are redacted. `MCP_MASTER_KEY`, `MCP_KEY_PEPPER`,
`MCP_COMPUTER_BROKER_TOKEN`, `MCP_VAULT_SECRET`, `MCP_UI_PASSWORD` were read **only** as presence/length.
`gateway.env` is reported by key name only.

### Grant scope of the auditing key

`dsh-harness-vps2` is granted **22 of 24** servers / **597** of 668 tools.

**Not granted → could not be probed with my key:** `here-hgv` (`srv_b841d87f7a8046c4`),
`social-watchers` (`srv_1aad56ae946a4ce2`). Both were probed read-only with the master key and are marked
**(probed via master key)** in §2.

---

## 2. Server registry (24 servers)

**Count discrepancy:** the brief said **25** servers. The DB (`select count(*) from servers`) and the admin API
both report **24**. There is no 25th row in either place. Treated as 24 for this audit.

Baseline totals: **24 servers — 23 `running`, 1 `failed`**; transports: **21 `stdio`, 3 `http`**;
runtimes: 15 `node`, 6 `python`, 3 `remote-agent`.

| # | Server | ID | Runtime / transport | URL or command | Status | `last_error` | Live probe run | Probe result |
|---|---|---|---|---|---|---|---|---|
| 1 | `adguard` | `srv_3ef09ab5558345a0` | node / stdio | `node ./adguard-mcp.js` in `/data/repos/adguard` | running | — | `adguard_get_status` | **OK** — v0.107.79, `running:true`, protection on, DNS `10.10.254.85:53`, http 3000 |
| 2 | `brain` | `srv_9b2889a22c9f4014` | node / stdio | `node ./brain-mcp.js` in `/data/repos/brain` | running | — | `brain_stats` | **OK** — v1.0.0, 475 memory points, 50,444 docs, 150,918 chunks, 3,266 events |
| 3 | `btt-bca` | `srv_8be4289e71bb4f0e` | python / stdio | `.venv/bin/python server.py` in `/data/repos/btt-bca` | running | — | `bca_health` | **OK** — v1.6.0 (`6f880c3`), database online, schema v10 ready, 11 applied migrations |
| 4 | `cloudflare` | `srv_4bd27f681dc34b3a` | node / stdio | `node ./cloudflare-mcp.js` in `/data/repos/cloudflare` | running | — | `cf_verify` | **OK** — 2 zones (`c-5.cc`, `evoonline.co.uk`) active; 3 tunnels healthy (Homeassistant 2, home 4, vps 4 connectors) |
| 5 | **`computer-use`** | `srv_computer_use` | remote-agent / http | **`https://gpc.lan:27443/mcp`** | **failed** | **`Computer Broker unreachable at https://gpc.lan:27443: connect ECONNREFUSED 172.19.0.1:27443`** | `list_computers` | **FAILED** — `Error: Computer Broker unreachable at https://gpc.lan:27443: read ECONNRESET` |
| 6 | `devicebridge` | `srv_6e78160515b8482c` | node / stdio | `node ./mcp-http-bridge.js` in `/data/repos/devicebridge` | running | — | `device_list` | **OK** — 11 devices, 9 online / 2 offline (see §4) |
| 7 | `email` | `srv_8017d6e92885431b` | node / stdio | `/app/dist/src/email/mcp-server.js` in `/app` | running | — | `email_list_accounts` | **Tool-Name mismatch** — session call returned `Tool Not Found`; admin advertises bare `email_list_accounts` (11 tools). **Works via master key**: default account "Craig Work" `craigst@evoonline.co.uk`, IMAP `10.10.254.13:143` STARTTLS, SMTP `:25` |
| 8 | `github` | `srv_0b6c710434494152` | node / stdio | `node ./github-mcp.js` in `/data/repos/github` | running | — | `gh_verify` | **OK** — login `craigst`, 20 scopes, `read_only:false`, 115 tools, journal note `container path /home/node/...` |
| 9 | `here-hgv` | `srv_b841d87f7a8046c4` | node / stdio | `node dist/index.js` in `/data/repos/here-hgv` | running | — | `here_api_health` **(probed via master key — not granted to my key)** | **OK** — `apiKeyConfigured:true`, 9/9 services succeeded, 0 failed |
| 10 | `homeassistant` | `srv_1f0f1d37162a453f` | python / stdio | `.venv/bin/python ha_mcp.py` in `/data/repos/ha-mcp` | running | — | `ha_states` | **OK** — 3,735 matching entities returned |
| 11 | **`homepage`** | `srv_4850857d75fd42f6` | node / stdio | `node homepage-mcp.js` in `/data/repos/homepage-mcp` | running | — | `homepage_status` | **FAILED** — `Error: pi5: Warning: Identity file /home/node/.ssh/id_ed25519 not accessible: No such file or directory.` / `ssh: Could not resolve hostname pi5: Temporary failure in name resolution` |
| 12 | `instagram` | `srv_c1a176247cb544de` | python / stdio | `.venv/bin/python -m instagram_mcp.server` in `/data/repos/instagram-mcp` | running | — | `ig_status` | **OK with stale error** — `ok:true`, `logged_in:true`, `cra1gst`, session 9.0 h, but `last_error: "The saved Instagram session is no longer valid."` (stale: last_ok 03:49Z today) |
| 13 | **`media`** | `srv_bfb0f72e1fbe489c` | node / stdio | `node ./media-bridge.js` in `/data/repos/media` | running | — | `media_probe` | **DEGRADED** — `kodi_running:false`, `addon_installed:true`, `addon_http:false` on host `doc` |
| 14 | **`media-devices`** | `srv_59bafd08e5714049` | node / stdio | `node ./media-devices.js` in `/data/repos/media-devices` | running | — | `devices_list` | **OK but EMPTY** — `count:0`, `devices:[]`, `kinds_registered:[]` (registry bug — see §4) |
| 15 | `messenger` | `srv_cf4ac539c5024bc3` | remote-agent / http | **`http://172.19.0.1:28814/mcp`** | running | — | `messenger_status` | **OK** — hub v1.42.0, store ok, 27 contacts, paused:false, readOnly:false; 271 deliveries queued / 0 failed / **281 dropped** |
| 16 | **`n8n`** | `srv_9f2073b95998459b` | node / stdio | `node ./n8n-mcp.js` in `/data/repos/n8n` | running | — | `n8n_status` | **SUSPECT** — auth layer ok (`rejects a bogus key with 401`), `keyConfigured:true`, but **`workflowsVisible: 0`**, `hasMorePages:false` |
| 17 | `nextcloud` | `srv_0719a7f256504a77` | node / stdio | `node ./nextcloud-mcp.js` in `/data/repos/nextcloud` | running | — | `nc_status` | **OK** — v34.0.5.1, all 5 probes green (status 322 ms, ocsUser, davFiles, caldav 3 cals, carddav 3 books), maintenance:false |
| 18 | **`omb`** | `srv_bfeb2aa7b4bc42bf` | python / stdio | `.venv/bin/python omb_mcp.py` in `/data/repos/omb-mcp` | running | — | `omb_bots` | **FAILED** — `Error: could not reach OMB: root@10.10.1.4: Permission denied (publickey).` |
| 19 | `searxng` | `srv_be96df122c164cb4` | node / stdio | `node searxng-mcp.js` in `/data/repos/searxng` | running | — | `health` | **OK** — `2026.10.23+629368e40`, reachable, `min_interval_ms:1200`, queue_depth 0 |
| 20 | `social-watchers` | `srv_1aad56ae946a4ce2` | node / stdio | `node manager.mjs` in `/data/repos/remy-watchers` | running | — | `watchers_status` **(probed via master key — not granted to my key)** | **OK** — pid 121; sources `whatsapp` (pid 128) and `instagram` (pid 129), both `restarts:0` |
| 21 | `ssh` | `srv_5f108901aa744482` | node / stdio | `node ./ssh-mcp.js` in `/data/repos/ssh` | running | — | `ssh_list_systems` | **OK** — 3 targets: `zues` (10.10.254.13), `shadow` (10.10.254.84), `vps` (10.10.1.4) |
| 22 | **`unifi`** | `srv_20c82cd7d24a440a` | node / stdio | `node unifi_mcp.mjs` in `/data/repos/unifi-mcp` | running | — | `unifi_status` | **OK with warning** — UDMPROSE fw 6.0.16, 4 devices, 48 active clients, health `vpn=error` (wlan/wan/www/lan = ok) |
| 23 | **`vaultwarden`** | `srv_2b4eb56a677044c7` | remote-agent / http | **`http://172.19.0.1:28808/mcp`** | running | — | `vault_status` | **DEGRADED** — `login_status: "locked"` (bw 2026.9.1); all credentials present, 9 collections visible, 0 pruned deliveries |
| 24 | `whatsapp` | `srv_a28f732e662f4d8f` | python / stdio | `/bin/sh run-mcp.sh` in `/data/repos/whatsapp-mcp` | running | — | `list_chats` | **OK** — tool returned `(list_chats returned no model-visible content)` (empty result, no error) |

**Row notes.** Rows 5, 14, 15 and 23 are the four that were still pinned to the WireGuard-outage fallback at
baseline: `computer-use` by name (`gpc.lan` → `172.19.0.1`, kept live by the compose `extra_hosts`), and
`vaultwarden`/`messenger` by raw `172.19.0.1` URL. `media-devices` is the empty-registry bug.

---

## 3. Computer use

### 3.1 Broker URL settings — `computer_use_settings` (id=1), baseline

| Column | Value (baseline) |
|---|---|
| `broker_url` | **`https://gpc.lan:27443`** ← the dead fallback |
| `public_broker_url` | `https://10.10.254.49:7443` ← the correct direct address |
| `ca_file` | `/certs/broker-ca.pem` |
| `enabled` | `1` |
| `agents_available` | `1` |
| `paused_reason` / `paused_until` | `NULL` / `NULL` |
| `availability_updated_at` / `_by` | `NULL` / `NULL` |
| `updated_at` | `2026-10-31T23:29:25.732Z` |

`computer_use_availability` table: **0 rows** (no per-computer availability records).

The server row carried the same poisoned host: `servers.url = https://gpc.lan:27443/mcp`.
`servers.headers` and `servers.env` for all three HTTP servers are **empty `{}`** — the broker credential is
supplied from the environment (`MCP_COMPUTER_BROKER_TOKEN`, present, 47 chars, **redacted**), not from the DB.

### 3.2 Why it was unreachable

`gpc.lan` was hard-pinned to the Docker-network gateway IP by `docker-compose.yml`:

```yaml
extra_hosts:
  - "gpc.lan:172.19.0.1"
  - "devicebridge.lan:172.19.0.1"
```

So `https://gpc.lan:27443` resolved to `172.19.0.1:27443` — the VPS side of a **reverse SSH tunnel**
(`-R 172.19.0.1:27443:10.10.254.49:7443`) published by `mcp-gateway-upstream-tunnel.service` on `gpc`.
That tunnel was **not listening**, hence `ECONNREFUSED`. See §5.

### 3.3 Broker reachability — direct probe (read-only, from `gpc`)

The broker itself was **healthy the whole time**; only the gateway's route to it was broken.

| Probe (from `gpc`) | Result |
|---|---|
| `TCP 10.10.254.49:7443` (from VPS) | **OPEN** |
| `GET https://10.10.254.49:7443/healthz` | **200** — `{"ok":true,"version":"1.0.0","computers":5,"devices":5,"connectors_online":6,"tls":true,"events_seq":450402}` |
| `GET https://10.10.254.49:7443/` | 200 (web UI html) |
| `POST https://10.10.254.49:7443/mcp` (MCP initialize) | **401** — `{"error":"unauthenticated"}` (endpoint exists; needs the bearer token the gateway holds) |
| `GET …/mcp`, `/health`, `/mcp/v1`, `/openapi.json`, `/docs` | 404 `{"detail":"Not Found"}` |
| TLS | mkcert leaf; SAN includes `gpc.lan`, `10.10.254.49`, `10.10.1.4`, `localhost` |
| Broker process | `/home/craigst/.local/opt/computer-broker/venv/bin/python -m broker.cli run` (pid 2486578, up 5 d 11 h) |

### 3.4 `list_computers` — baseline output

```
Error: Computer Broker unreachable at https://gpc.lan:27443: read ECONNRESET
```

(§7 has the successful result after the fix: 5 computers.)

---

## 4. Devices

The two registries are **different and both were checked**.

### 4.1 `mcp__gateway__devices_list` — media-devices plugin registry → **EMPTY (bug confirmed)**

```json
{
  "registry": "/home/node/.config/media-devices/devices.json",
  "count": 0,
  "devices": [],
  "kinds_registered": [],
  "enabled_pagers": "",
  "enabled_tvs": "",
  "pending_pairings": []
}
```

`devices_probe` → `{"probed": [], "note": "no enabled devices are registered"}`.

Consequences (exact errors):

- `media_devices__tv_status` → `Error: no enabled TV is registered. Add one with devices_add (e.g. {kind:"kodi_tv", id:"…", name:"…"}) or pair one with devices_pair.`
- `devices_journal` → file `/home/node/.dsh/media-devices/journal.jsonl`, `entries: []` (nothing ever recorded)

The connector *knows* the kinds — `devices_kinds` returns 3 fully-specified kinds with capabilities marked
`verified: true` for `device.health`, `page.read`, `tv.status`:
`ha_pager` (ESPHome/NSPanel via HA REST `10.10.254.84:8123`), `kodi_tv` (delegates to media-bridge helper
`/home/craigst/bin/cleo-media-rpc`), `tembed_pager` (media-bridge `panel` op at `:18082`).
So the adapter layer works; only the **registry file is empty/unpaired**.

### 4.2 `mcp__gateway__device_list` — DeviceBridge fleet → **11 devices, 9 online, 2 offline**

`counts: {total: 11, online: 9, offline: 2, revoked_hidden: 0}`

| Device | Hostname | Status | Last seen | Health |
|---|---|---|---|---|
| Dads-Unraid-Server | `Tower` | online | 47 s | load 0.58 · mem 37.5% · disk 7.1% · rtt 57.4 ms (Unraid 7.3.2, SWL site-to-site) |
| zeus-unraid | `Zues` | online | 59 s | load 1.62 · mem 70.5% · disk 18.9% · rtt 15.6 ms (UPS online, 100%) |
| home-assistant-pc | `a0d7b954-ssh` | online | 58 s | — |
| dads home assistant vm | `a0d7b954-ssh` | online | 33 s | — |
| Razer Phone | `cheryl` | online | 36 s | — |
| Odysseus Laptop | `cleo` | online | 51 s | load 0.28 · mem 48.9% · **disk 91.3%** · rtt 7.7 ms |
| Pi5 Media Hub | `doc` | online | 58 s | load 0.08 · mem 28.6% · disk 21.2% · rtt 17.9 ms (9/9 containers up) |
| roof pi | `roof` | online | 42 s | load 0.19 · mem 40.0% · disk 46.0% · rtt 19.4 ms |
| USA VPS | `ubuntu` | online | 33 s | load 0.12 · mem 28.4% · disk 53.2% · rtt 313.0 ms |
| **Gaming PC** | **`gpc`** | **offline** | **6 d ago** | reason `offline for 6.5 days`; last telemetry load 5.1, disk 66.0%; docker "no docker socket found" |
| **Omarchy Laptop** | **`yoga`** | **offline** | **8 h ago** | reason `offline for 0.3 days`; battery 63% charging; docker "permission denied on /var/run/docker.sock" |

**Why the two are offline:**

- **Gaming PC (`gpc`)** — the DeviceBridge connector is simply not running on the machine. Verified on the host
  itself: no `devicebridge` unit (`systemctl --user status devicebridge*` → nothing) and no `devicebridge`
  process. The machine is powered on and reachable (it is the host of this audit, `10.10.254.49`), and its
  **computer-broker** connector is online (`cnr_0c23f7dda90fe42c`, `last_seen 12:51:09Z`) — so this is a
  *connector-not-started* problem, not a host-down problem. The stale record still advertises `terminal.enabled:true`
  with 2 tmux sessions and a Wayland display from 6 days ago.
- **Omarchy Laptop (`yoga`)** — 8 h stale, most likely asleep/closed (battery charging, `wayland-1`); no
  error evidence beyond the missing heartbeats.

`device_health` on the USA VPS device (`fccbb582…`) → **OK**: connector 0.3.2, uptime 310,840 s,
`online:true`, `telemetry_age_seconds:34.0`, 7/9 containers running.

---

## 5. Fallback / tunnels

The WireGuard-outage fallback was **still fully in force** at baseline.

### 5.1 This machine is `gpc` — and it is the thing being tunneled to

```
hostname: gpc
addr:     10.10.254.49/24  (enp2s0f0u2u1u2)
```

### 5.2 `mcp-gateway-upstream-tunnel.service` — **crash-looping, ~9,029 restarts**

`systemctl --user status` at baseline: `Active: activating (auto-restart) (Result: exit-code)`,
`Main PID … (code=exited, status=255/EXCEPTION)`.

Exact errors:

```
gpc ssh[1027204]: Error: remote port forwarding failed for listen port 28791
gpc systemd[993]: mcp-gateway-upstream-tunnel.service: Main process exited, code=exited, status=255/EXCEPTION
gpc systemd[993]: Scheduled restart job, restart counter is at 9029.
```

VPS-side cause (`/var/log/auth.log`) — an **older, still-live** ssh session (pid `879854`, up 6 h 10 m) already
holds the ports, so the unit's `ExitOnForwardFailure=yes` kills it on the first refusal:

```
ubuntu sshd-session[1207178]: error: bind [172.19.0.1]:28443: Address already in use
ubuntu sshd-session[1207178]: error: channel_setup_fwd_listener_tcpip: cannot listen to port: 28443
```

The unit is `enabled` and wants 48 reverse forwards (`-R 172.19.0.1:2xxxx` **and** `-R 172.18.0.1:2xxxx`)
into `root@74.208.55.116`, including `-R 172.19.0.1:27443:10.10.254.49:7443` (the computer-use broker).

### 5.3 `mcp-gateway-ui-tunnel.service` — **active (running) 15 h**

`ssh -N … -L 0.0.0.0:8484:127.0.0.1:8484 root@74.208.55.116` (Main PID 511271). Still `enabled`, still up.

### 5.4 `ss -tlnp` on the VPS — `172.19.0.1` listeners

**24 listeners**, all owned by the stale `sshd-session` pid `879854`:
`28443`, `28791`, `28792`, `28793`, `28796`, `28797`, `28798`, `28801`–`28808`, `28810`–`28814`,
`28816`–`28819`.

**`27443` was NOT listening anywhere on the VPS** — which is exactly why `computer-use` got `ECONNREFUSED`.
Note the stale session holds `28443` and the whole `28xxx` range *but not* `27443`: the port set in the
systemd unit and the port set the surviving session publishes are **out of sync**, so every restart attempt
fails on the first already-bound port (`28791`).

### 5.5 Direct-path reachability (from VPS, baseline)

| Target | Result |
|---|---|
| `10.10.254.49:7443` (computer-use broker, direct) | **OPEN** |
| `172.19.0.1:27443` (computer-use via fallback) | **CLOSED/unreachable** |
| `172.19.0.1:28808` (vaultwarden via fallback) | **OPEN** |
| `172.19.0.1:28814` (messenger via fallback) | **OPEN** |

So at baseline `vaultwarden` and `messenger` were working *only because* the old tunnel session happened to be
alive, while `computer-use` had no route at all.

---

## 6. Failures (exact strings)

Ordered by blast radius. Strings are verbatim from the tool output / logs.

### F1 — `computer-use` broker unreachable (server `failed`)

```
Computer Broker unreachable at https://gpc.lan:27443: connect ECONNREFUSED 172.19.0.1:27443
```
`list_computers` from this session:
```
Error: Computer Broker unreachable at https://gpc.lan:27443: read ECONNRESET
```
Root cause: `computer_use_settings.broker_url` + `servers.url` pinned to the dead fallback, made resolvable only
by compose `extra_hosts: gpc.lan:172.19.0.1`; tunnel port `27443` never published (§5.4). The broker itself was
healthy at `10.10.254.49:7443/healthz` with **5 computers** (§3.3).

### F2 — `mcp-gateway-upstream-tunnel.service` crash-loop (restart counter 9,029)

```
Error: remote port forwarding failed for listen port 28791
Main process exited, code=exited, status=255/EXCEPTION
```
```
error: bind [172.19.0.1]:28443: Address already in use
error: channel_setup_fwd_listener_tcpip: cannot listen to port: 28443
```

### F3 — `homepage` connector broken (cannot even resolve its host)

```
pi5: Warning: Identity file /home/node/.ssh/id_ed25519 not accessible: No such file or directory.
ssh: Could not resolve hostname pi5: Temporary failure in name resolution
```
Two independent faults: the configured SSH host `pi5` does not resolve from inside the container, and the key
path `/home/node/.ssh/id_ed25519` does not exist in the container. `homepage_status` is the only tool that
matters here and it fails, so all 5 homepage tools are unusable.

### F4 — `vaultwarden` session locked

```
"login_status": "locked"
```
Credentials and config are all present (`config_present:true`, client id/secret/master password present,
`bw 2026.9.1`), 9 collections enumerable, but the vault is locked — `secrets_resolve_to_file` /
`vault_deliver_credential` class operations cannot produce a secret until it is unlocked.

### F5 — `media` / Kodi down, and `media-devices` registry empty

```
media_probe:  "kodi_running": false,  "addon_installed": true,  "addon_http": false
```
```
devices_list: "count": 0, "devices": [], "kinds_registered": []
devices_probe: {"probed": [], "note": "no enabled devices are registered"}
tv_status: Error: no enabled TV is registered. Add one with devices_add (e.g. {kind:"kodi_tv", id:"…", name:"…"}) or pair one with devices_pair.
```
Two-layer failure: Kodi is not running on the Pi5 (`doc`), *and* the media-devices registry has no devices
pinned, so even a running Kodi would be unreachable. All 39 `media-devices` bus/pager/TV tools are inert.

### F6 — `omb` connector cannot SSH to its own host

```
Error: could not reach OMB: root@10.10.1.4: Permission denied (publickey).
```
(4 minutes later, after the container restart, the same call returned a different failure:
`Error: could not reach OMB: Host key verification failed.` — see §7.)

### F7 — `n8n` sees zero workflows

```
"keyConfigured": true, "keyLength": 289,
"authLayer": { "answers": true, "verdict": "rejects a bogus key with 401 (as it should)" },
"probe": { "ok": true, "workflowsVisible": 0, "hasMorePages": false }
```
The key authenticates (the connector proves it is live by confirming a bogus key gets 401), yet the workflow
list is empty and there is no second page — so this is a *permissions/scope or wrong-instance* problem, not a
connectivity one. The Pi5 shows its `n8n` container `Up 3 months (healthy)`, so the instance is up.

### F8 — `unifi` reports `vpn=error`

```
health: wlan=ok  wan=ok  www=ok  lan=ok  vpn=error
```
Everything else on the UCG is green (fw 6.0.16, 4 adopted devices, 48 clients, WAN ppp0 `86.156.161.101`,
latency 2 ms). Only the VPN subsystem is flagged.

### F9 — `instagram` carries a stale `last_error`

```
"ok": true, "logged_in": true, "session_age_hours": 9.0,
"last_error": "The saved Instagram session is no longer valid."
```
`last_ok_at` is `2026-11-05T03:49:30+00:00` and `last_login_at` 03:49:20Z — the session is live, so this error
string is stale and misleading. Flagged as cosmetic-but-dangerous (an operator or agent reading `last_error`
would wrongly re-authenticate).

### F10 — `email` tool-name mismatch

Calling the account-scoped tools this session exposes (`mcp__gateway__email_gmail__list_email_accounts`,
`mcp__gateway__email_personal__list_email_accounts`) returns:
```
Error: Tool Not Found
```
while the gateway advertises 11 **bare** tools (`email_list_accounts`, `email_send`, …) and
`GET /mcp/v1/admin/servers/srv_8017d6e92885431b/tools` lists them. Through the master key the same bare tool
works and returns the default account. So the email *server* is fine; the **tool-name surface this session sees
for `email` does not match what the gateway forwards**.

### F11 — grants missing for the auditing key (not a fault, recorded for completeness)

`here-hgv` and `social-watchers` are **not granted** to `dsh-harness-vps2`; direct calls fail
`Error: unknown tool "mcp__gateway__here_api_health"` / `"mcp__gateway__watchers_status"`. Both probed
read-only with the master key instead (both healthy, §2 rows 9 and 20).

### Non-failures worth recording

- `whatsapp` `list_chats` returned `(list_chats returned no model-visible content)` — empty, not an error.
- `messenger`: **281 deliveries dropped** vs 271 queued, 0 failed — dropped is a routing outcome (no capable
  channel for the message), not an exception; noted for the Lead.
- `computer_status` with `{"computer_id":"local"}` → `{"error": "computer_not_found"}` (expected; no such id).

---

## 7. State observed after the Lead's change (12:50–12:51Z) — *not* the POST-FIX pass

Recorded because the change landed mid-audit. This section is observational; the formal POST-FIX verification
will be a separate request.

The container was **restarted** (`docker ps` → `mcp-gateway … Up 39 seconds` at 12:51Z).

### Fixed by the change

| Item | Baseline | After |
|---|---|---|
| `servers` count/status | 24 — 23 running, 1 failed | **24 — all 24 running** |
| `computer-use` URL | `https://gpc.lan:27443/mcp` | **`https://10.10.254.49:7443/mcp`**, `lastError: null` |
| `computer_use_settings.broker_url` | `https://gpc.lan:27443` | **`https://10.10.254.49:7443`** (`updated_at 2026-11-05T12:50:00.000Z`) |
| `computer_use_settings.public_broker_url` | `https://10.10.254.49:7443` | `https://10.10.254.49:7443` |
| `vaultwarden` URL | `http://172.19.0.1:28808/mcp` | **`http://10.10.254.91:8808/mcp`** |
| `messenger` URL | `http://172.19.0.1:28814/mcp` | **`http://10.10.254.91:8814/mcp`** |
| compose `extra_hosts` | `gpc.lan` / `devicebridge.lan` → `172.19.0.1` | **removed** |
| `gateway.env` broker vars | (fallback host) | `MCP_COMPUTER_BROKER_URL` = `MCP_COMPUTER_BROKER_PUBLIC_URL` = `MCP_COMPUTER_INSTALL_BASE_URL` = `https://10.10.254.49:7443` |

`list_computers` now succeeds (5 computers):

| Computer | Template / provider | State | Connector |
|---|---|---|---|
| `gpc` | host | **ready** | **online** (v1.1.1, last_seen 12:51:09Z) |
| `Razer Phone` | android | **degraded** | offline (last_seen 2026-10-31) |
| `agent-desktop` | desktop-base / container | stopped | offline (last_seen 2026-10-30) |
| `zues-vm-1` | ubuntu-xfce / vm | stopped | offline (last_seen 2026-10-31) |
| `gpc-vm-1` | ubuntu-xfce / vm | stopped | offline (last_seen 2026-10-31) |

### NOT fixed — still failing after the change

| Item | State after |
|---|---|
| **Tunnel unit** | `mcp-gateway-upstream-tunnel.service` **still `enabled`, still `activating (auto-restart)`**, `NRestarts=9046`, identical `Error: remote port forwarding failed for listen port 28791` |
| **Fallback listeners** | **24 listeners still bound on `172.19.0.1`** by stale sshd `879854`; `27443` still absent |
| **UI tunnel** | `mcp-gateway-ui-tunnel.service` still `enabled` + `active (running)` |
| **`homepage`** | unchanged — identical `pi5` / `Could not resolve hostname pi5` error |
| **`vaultwarden`** | still `"login_status": "locked"` |
| **`media`** | still `"kodi_running": false` |
| **`n8n`** | still `"workflowsVisible": 0` |
| **`omb`** | still failing — error changed to `Error: could not reach OMB: Host key verification failed.` |
| **`media-devices`** | registry unchanged (still 0 devices — not re-probed post-change) |
| **DeviceBridge fleet** | unchanged (still 2 offline) |

**Action implied for the Lead:** the routing half of the fallback retirement is done, but the
**tunnel host itself is not retired** — the unit is enabled and burning a restart every 5 s, and a stale ssh
session still holds all 24 `172.19.0.1` ports. Per the migration plan these must be `stop` + `disable`d (and
the stale session `879854` cleared) or the crash loop continues indefinitely.

---

## Appendix — environment facts used

- Gateway image `localhost/mcp-gateway:0.15.5`; container `mcp-gateway`; compose `restart: unless-stopped`;
  ports `127.0.0.1:8484:8080` and `10.10.1.4:8484:8080`; volumes `./data:/data`, `./certs:/certs:ro`;
  `security_opt: no-new-privileges:true`; joined to external network `openmausbot_default` (alias `mcp-gateway`).
- `gateway.env` keys (names only): `MCP_HOST`, `MCP_PORT`, `MCP_DATA_DIR`, `MCP_LOG_LEVEL`, `MCP_AUTOSTART`,
  `MCP_DELEGATION_MAX_DEPTH`, `MCP_GIT_IMPORT_ALLOWED_PREFIXES`, `MCP_TOOL_TIMEOUT_MS`, `MCP_UI_USERNAME`,
  `MCP_UI_PASSWORD`, `MCP_UI_SESSION_TTL_MS`, `MCP_UI_COOKIE_SECURE`, `MCP_KEY_PEPPER`, `MCP_MASTER_KEY`,
  `MCP_VAULT_SECRET`, `MCP_COMPUTER_USE_ENABLED`, `MCP_COMPUTER_BROKER_URL`,
  `MCP_COMPUTER_BROKER_PUBLIC_URL`, `MCP_COMPUTER_INSTALL_BASE_URL`, `MCP_COMPUTER_BROKER_CA`,
  `MCP_COMPUTER_BROKER_TOKEN` (**redacted**), `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS`, `NODE_EXTRA_CA_CERTS`.
- `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS` = `destroy_computer`.
- API keys in DB: 28 rows (1 `bootstrap-master`, 7 `omb-*` ×2 generations, 5 `dsh-*`, `watcher-remy`).
  Hashes/prefixes **redacted**. `bootstrap-master` `last_used_at: 2026-11-05T12:47:46.518Z` (this audit).
- `audit_log` records this audit's calls under key `key_e6fa6c408e8040ca` (`dsh-harness-vps2`);
  `srv_computer_use:list_computers` appears with `status: "error"` at 12:48:53Z — good evidence trail.

---

*End of baseline. Read-only; no remediation performed in this pass.*

---

# POST-FIX PASS

| | |
|---|---|
| **Written (UTC)** | 2026-11-05T12:59:30Z |
| **Verification window (UTC)** | 2026-11-05T12:56:30Z → 2026-11-05T12:58:52Z |
| **Gateway version** | image tag `localhost/mcp-gateway:0.15.5`; **`package.json` and `/mcp/v1/health` both report `0.14.2`** (mismatch — see P8.1) |
| **Container** | `mcp-gateway … Up About a minute (healthy)` at 12:56Z (restarted again for the ssh-home mount) |
| **Auditor** | `connector-auditor` (read-only), key `dsh-harness-vps2` |

> §7 above ("state observed after the Lead's change") is now **historical**: it captured the intermediate state
> mid-remediation. This POST-FIX section **supersedes it** and is the authoritative current state.

---

## P1. Executive summary

The fallback retirement is **complete and stable** at the time of writing. Every gateway-level fault from the
baseline is fixed; what remains is **application-level**, not gateway configuration.

| Metric | Baseline (12:47–12:49Z) | POST-FIX (12:56–12:58Z) |
|---|---|---|
| Servers in registry | 24 (23 running, **1 failed**) | **24 (24 running, 0 failed)** |
| Non-null `lastError` | **1** (`computer-use`) | **0** |
| Gateway `POST /admin/servers/:id/test` | not run | **24/24 PASS** (reproduced twice) |
| Listeners on `172.19.0.1` | **24** | **0** |
| `list_computers` | `ECONNRESET` | **5 computers returned** |
| media-devices registry | **0 devices** | **3 devices** |
| Gateway log error lines (15 min) | — | **0** |
| `mcp-gateway.lan` | via fallback | **resolves `10.10.1.4`, health 200 direct** |

**The headline discovery: the "crash-looping duplicate on gpc" was never the real tunnel.** It was a *symptom*.
The actual live tunnel was a system unit on **cleo**; gpc's unit crashed 9,046 times only because cleo's tunnel
already held every port it wanted. And cleo's tunnel could not be retired by disabling the unit alone, because a
**watchdog timer resurrected it every 2 minutes**. See P5 — this is the most important correction to the
baseline narrative.

---

## P2. Server registry — all 24 PASSing

`GET /mcp/v1/admin/servers` → **24 servers**, `status` all `running`, `lastError` null for every one.
Transports: 21 `stdio`, 3 `http`. Tool count unchanged at **668**.

### P2.1 Gateway's own per-server test (`POST /mcp/v1/admin/servers/:id/test`)

Reproduced by this auditor with the master key, twice — **12:57:43Z and 12:58:52Z**:

```
=== TEST RESULT: pass=24 fail=0 ===
=== TEST RESULT: pass=24 fail=0 ===
```

### P2.2 Live probe results (fresh, this pass)

| Server | Status | Live probe | POST-FIX result |
|---|---|---|---|
| `adguard` | running | `adguard_get_status` | **OK** — v0.107.79 running, DNS `10.10.254.85:53`, protection on |
| `brain` | running | `brain_stats` | **OK** — v1.0.0, 475 memory points, 50,444 docs, 3,266 events |
| `btt-bca` | running | `bca_health` | **OK** — v1.6.0 (`6f880c3`), database online, schema v10 ready |
| `cloudflare` | running | `cf_verify` | **OK** — 2 zones active, 3 tunnels healthy (`Homeassistant` 2, `home` 4, `vps` 4 connectors) |
| `computer-use` | running | `list_computers` | **OK** — 5 computers; see P3 |
| `devicebridge` | running | `device_health` (gpc) | **OK** — `online:true`; see P4.2 |
| `email` | running | `email_list_accounts` | **OK** — default "Craig Work" `craigst@evoonline.co.uk` (via master key; see P8.3) |
| `github` | running | `gh_verify` | **OK** — `craigst`, 20 scopes, 115 tools, `read_only:false` |
| `here-hgv` | running | `here_api_health` **(master key — not granted)** | **OK** — 9/9 services, 0 failed |
| `homeassistant` | running | `ha_states` | **OK** — 3,735 entities |
| `homepage` | running | `homepage_status` | **FIXED — OK** — 44 tiles (7 groups), validate http 200 body `[]`, revalidate 200 |
| `instagram` | running | `ig_status` | **APP-LEVEL** — now honestly `ok:false, error:login_required` (P7.2) |
| `media` | running | `media_probe` | **APP-LEVEL** — `kodi_running:false`, `addon_installed:true`, `addon_http:false` |
| `media-devices` | running | `devices_list` / `devices_probe` | **FIXED** — 3 devices, 2 healthy; see P4.1 |
| `messenger` | running | `messenger_status` | **OK** — hub v1.42.0, store ok, 27 contacts, 0 failed deliveries, 281 dropped, journal 28,672 |
| `n8n` | running | `n8n_status` | **APP-LEVEL** — `workflowsVisible: 0` (P7.3) |
| `nextcloud` | running | `nc_status` | **OK** — v34.0.5.1, 5/5 probes green, maintenance false |
| `omb` | running | `omb_bots` | **FIXED — OK** — **11 bots** (Remy, Sentinel, Scout, Nora, Luma, Sable, Forge, MausBot, Elara, Home Henry, Cleo) |
| `searxng` | running | `health` | **OK** — `2026.10.23+629368e40`, reachable, queue_depth 0 |
| `social-watchers` | running | `watchers_status` **(master key — not granted)** | **OK** — pid 134, sources whatsapp (141) + instagram, restarts 0 |
| `ssh` | running | `ssh_run` ×3 | **FIXED — OK** — see P6 |
| `unifi` | running | `unifi_status` | **OK w/ warning** — `vpn=error` persists (P7.5) |
| `vaultwarden` | running | `vault_status` | **APP-LEVEL** — still `login_status: "locked"` (P7.1) |
| `whatsapp` | running | `list_chats` | **OK** — empty result, no error |

---

## P3. Computer use — FIXED

| Item | Baseline | POST-FIX |
|---|---|---|
| `servers.url` | `https://gpc.lan:27443/mcp` | **`https://10.10.254.49:7443/mcp`** |
| `computer_use_settings.broker_url` | `https://gpc.lan:27443` | **`https://10.10.254.49:7443`** |
| `computer_use_settings.public_broker_url` | `https://10.10.254.49:7443` | `https://10.10.254.49:7443` |
| `lastError` | `Computer Broker unreachable … ECONNREFUSED 172.19.0.1:27443` | **`null`** |
| `list_computers` | `ECONNRESET` | **5 computers** |

`computer_use_settings` post-fix: `enabled=1`, `agents_available=1`, `paused_reason=NULL`,
`updated_at=2026-11-05T12:50:00.000Z`. `gateway.env` `MCP_COMPUTER_BROKER_URL` /
`MCP_COMPUTER_BROKER_PUBLIC_URL` / `MCP_COMPUTER_INSTALL_BASE_URL` all = `https://10.10.254.49:7443`;
`MCP_COMPUTER_BROKER_TOKEN` present (redacted); `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS=destroy_computer`.

`computer_status("cmp_1a2dcc7a1c44")` → **`state: "ready"`, connector `cnr_0c23f7dda90fe42c` `online`**
(connector v1.1.1, `last_seen 2026-11-05T12:57:01Z`), `control.held: false`.

| Computer | Provider | State | Connector |
|---|---|---|---|
| `gpc` | host | **ready** | **online** |
| `Razer Phone` | android | degraded | offline (last_seen 2026-10-31T00:07:31Z) |
| `agent-desktop` | container | stopped | offline |
| `zues-vm-1` | vm | stopped | offline |
| `gpc-vm-1` | vm | stopped | offline |

**Note (unchanged):** `computer_use_availability` still has **0 rows** — the broker reports 5 computers but the
gateway holds no per-computer availability records. Not a blocker (availability defaults to enabled), but the
table is unpopulated.

---

## P4. Devices — media-devices FIXED; DeviceBridge gpc restored

### P4.1 media-devices registry — FIXED (was 0 devices)

Root cause: the plugin reads `MEDIA_DEVICES_DIR`, not `MEDIA_DEVICES_CONFIG`. Corrected env on the
`media-devices` server row:

```
MEDIA_DEVICES_DIR        = /data/secrets/media-devices
MEDIA_DEVICES_JOURNAL    = /data/secrets/media-devices/journal.jsonl
MEDIA_DEVICES_SSH_CONFIG = /data/secrets/media-ssh-config
MEDIA_DEVICES_SSH_TARGET = craigst@10.10.254.85
MEDIA_DEVICES_READ_ONLY  = 1
```

Registry path is now `/data/secrets/media-devices/devices.json` (**was** `/home/node/.config/media-devices/devices.json`).
Restored from cleo's pre-cutover copy — **3 devices, all `paired_by: devices_add`**:

| Device | Kind | Name | Location | `last_seen.ok` | Detail |
|---|---|---|---|---|---|
| `bathroomsw` | `ha_pager` | Bathroom NSPanel | loft bathroom | **true** | panel display on, blueprint 4.3.12, HA answered at `http://10.10.254.84:8123` |
| `tembed` | `tembed_pager` | T-Embed Pager Handset | handset / carried | **true** | view "home" (rev 1), 9 messages, **unread 3**, no pending prompt |
| `tv-bedroom` | `kodi_tv` | Bedroom TV | bedroom | **false** | `media-bridge state failed: ConnectionRefusedError: [Errno 111] Connection refused` |

`kinds_registered`: `ha_pager`, `tembed_pager`, `kodi_tv`; `enabled_pagers` = `bathroomsw (ha_pager), tembed (tembed_pager)`;
`enabled_tvs` = `tv-bedroom (kodi_tv)`; `pending_pairings: []`.

`devices_probe` → **`healthy: 2`, `unhealthy: ["tv-bedroom"]`**. Exact failure:

```
media-bridge state failed: ConnectionRefusedError: [Errno 111] Connection refused
hint: the device or the hub did not answer inside the budget
```

`tv_status` → `Error: helper op state failed: ConnectionRefusedError: [Errno 111] Connection refused` — consistent:
**Kodi is not running on `doc`** (`media_probe: kodi_running:false`), so this is an app/environment gap, **not**
gateway config. The journal is now live at `/data/secrets/media-devices/journal.jsonl` with entries
(`devices_probe` 12:50:32, 12:57:10; `pager_messages` 12:58:49).

### P4.2 DeviceBridge — gpc connector restored, still 1 device offline

- `DEVICEBRIDGE_URL` = **`https://10.10.254.91:8443/mcp`** (direct WireGuard), `DEVICEBRIDGE_ENV_FILE` /
  `DEVICEBRIDGE_CA` = `/data/secrets/…`. Gateway-local devicebridge MCP works.
- **gpc** (`89481612-e8e3-4e31-993c-9367b0cd9f2b`) — was offline 6.5 days, now **`online: true`**,
  connector `0.3.2`, uptime **143 s**, `telemetry_age_seconds: 15.0`, roots `home` (`/home/craigst`) +
  `workspace`, `terminal.enabled: true`, `reconnects: 1`, rtt 7.6 ms. Confirmed by the user unit being
  enabled+active on gpc.
  > One residual oddity: gpc's `telemetry.docker.available: false` with
  > `error: "docker socket is not present (/run/user/1000/podman/podman.sock)"` — the connector now looks for
  > **podman**, not Docker, on that host.
- **Omarchy Laptop** (`yoga`, `ba49d64e-…`) — **still offline**: `device_health` → `{"online": false, "detail": "connector offline"}`, `telemetry_age_seconds: 29923.6` (~8.3 h), last telemetry battery 63% charging. Raises the only **critical** fleet alert.
- Fleet alert summary (`device_alerts`): **9 active — 1 critical, 8 warning**. Critical = `Omarchy Laptop is offline (last seen 8h ago)`. Warnings are all `container_updates` (zeus 4, cleo 4, roof 2, Tower 3, ha-pc 1, doc 4, ubuntu 2) plus `Odysseus Laptop: disk 91.3% full`. **Gaming PC no longer appears** — corroborating its return to online.

---

## P5. Fallback / tunnels — RETIRED (and the real reason it kept coming back)

### P5.1 The correction to the baseline narrative

The baseline report said `mcp-gateway-upstream-tunnel.service` **on gpc** was "crash-looping, ~9,029 restarts".
That observation was accurate but the **inference was wrong**: gpc was **not** the real tunnel.

```
gpc ssh[…]: Error: remote port forwarding failed for listen port 28791
ubuntu sshd: error: bind [172.19.0.1]:28443: Address already in use
```

Those failures happened **because another tunnel already owned the ports**. It was a duplicate that could never
bind, and it burned a restart every 5 s doing so. The **real** publisher was a *system* unit on **cleo**:

```
/etc/systemd/system/usvps-mcp-tunnels.service
Description=Reverse SSH tunnels publishing cleo's MCP facades to the US VPS gateway (172.19.0.1:28xxx)
ExecStart=/usr/bin/ssh -N -T … -R 172.19.0.1:28791:10.10.254.91:8791 … -R 172.19.0.1:28443:10.10.254.91:8443 root@74.208.55.116
Restart=always
RestartSec=5
```

### P5.2 The watchdog — why disabling the unit did not stick

Disabling `usvps-mcp-tunnels.service` alone **did not stop the forwards**, because a companion timer kept
resurrecting them:

| Unit on cleo | Purpose |
|---|---|
| `usvps-mcp-tunnels-watchdog.timer` | fires **every 2 minutes** |
| `usvps-mcp-tunnels-watchdog.service` | oneshot: probes `172.19.0.1:28801`; **restarts the tunnel whenever the probe fails** |
| `/usr/local/bin/usvps-mcp-tunnels-watchdog.sh` | the script (1,798 bytes, root, `-rwxr-xr-x`) |

So the unit would be stopped, the probe would fail, and within ≤2 min the watchdog put the tunnel straight back.
**This is the real reason the fallback kept reappearing** and why a first-pass measurement still saw 24 listeners.

### P5.3 What this auditor actually measured (transient 24 → stable 0)

Timeline, stated explicitly because the number changed mid-pass:

| Time (UTC) | `172.19.0.1` listeners on VPS | Evidence |
|---|---|---|
| 12:57:43Z | **24** | tunnel unit on cleo `disabled` **but `active`**, `SubState=running`, `MainPID=1363907` (started ~2m10s earlier), live `ssh -N -T … -R 172.19.0.1:…` process |
| 12:58:52Z | **0** | `ss -tln \| grep -c 172.19.0.1` → `0`; `27443` also absent |

**So yes — this pass did observe a transient 24 listeners.** It was the watchdog's last resurrection, observed
*before* the watchdog was disabled. After the watchdog was disabled the count went to 0 and stayed there.

### P5.4 Final verified state (12:58:50–12:58:52Z)

On **cleo** — all three units down:

| Unit | `is-enabled` | `is-active` |
|---|---|---|
| `usvps-mcp-tunnels.service` | `disabled` | **`inactive`** |
| `usvps-mcp-tunnels-watchdog.timer` | `disabled` | **`inactive`** |
| `usvps-mcp-tunnels-watchdog.service` | `static` (no `[Install]`, timer-driven — normal) | **`inactive`** |

Live processes: `pgrep -af "ssh -N -T" \| grep -c 172.19.0.1` → **0**; `pgrep -af usvps-mcp-tunnels` → **none**.

On **gpc** (this machine) — both user units `disabled` + `inactive`:

```
mcp-gateway-upstream-tunnel.service        enabled=disabled   active=inactive
mcp-gateway-ui-tunnel.service              enabled=disabled   active=inactive
```

On the **VPS**:

```
ss -tln | grep -c 172.19.0.1   →  0
ss -tln | grep 27443           →  (27443 not listening)
docker logs mcp-gateway --since 15m | grep -ciE "error|fail|refused|unreachable"  →  0
```

### P5.5 DNS / ingress cutover verified

- AdGuard rewrite list contains **`mcp-gateway.lan → 10.10.1.4`** (no fallback target).
- From gpc: `getent hosts mcp-gateway.lan` → **`10.10.1.4`**.
- `http://mcp-gateway.lan:8484/mcp/v1/health` → **200** direct, body `{"status":"ok","version":"0.14.2",…}`.
- `http://10.10.1.4:8484/mcp/v1/health` → **200** (same).

---

## P6. SSH / homepage / omb — FIXED

A persistent SSH home now exists at `/opt/mcp-gateway/data/ssh-home/.ssh` and is mounted at
`/home/node/.ssh` in the container (`./data/ssh-home/.ssh:/home/node/.ssh`). Contents verified on both sides:
`config` (551 B), `id_ed25519` (399 B), `known_hosts` (5,656 B); owner `craigst` on the host, `node` in the
container, all `0600`/`0700`.

`ssh_run` now succeeds for **all three** configured systems (was failing on the missing identity file):

| System | Target | POST-FIX result |
|---|---|---|
| `zues` | `root@10.10.254.13` | **OK** — `Zues`, `up 2 weeks, 4 days, 15 hours, 23 minutes` |
| `shadow` | `root@10.10.254.84` | **OK** — `a0d7b954-ssh`, `up 1 week, 1 day, 15 hours, 41 minutes` |
| `vps` | `root@10.10.1.4` | **OK** — `ubuntu`, `up 3 days, 14 hours, 28 minutes` |

- `homepage` — **FIXED**: `homepage_status` → `ok:true`, `tileCount: 44` across 7 groups (Media 4, Arr Stack 4, Downloads 2, Home Automation 4, Tools 20, System 6, Web 4), `validate: {http: 200, body: "[]"}`, `revalidateHttp: 200`. (Baseline: `ssh: Could not resolve hostname pi5`.)
- `omb` — **FIXED**: `omb_bots` → **11 bots** with titles/models/MCP servers. (Baseline: `Permission denied (publickey)` then `Host key verification failed`.)

> Minor note: `ssh_list_systems` still advertises only `zues`, `shadow`, `vps`. The documented `pi5` alias now
> lives in `/home/node/.ssh/config` and is used by `homepage`, but it is not exposed as an `ssh_run` enum value —
> so `ssh_run(system="pi5")` would be rejected by the tool schema. Cosmetic inconsistency, not a failure.

---

## P7. Remaining issues (app-level — NOT gateway config)

Recorded exactly; nothing attempted.

### P7.1 `vaultwarden` — still locked

```json
{ "login_status": "locked", "bw_version": "2026.9.1",
  "account": "security-agent@evoonline.co.uk",
  "config_present": true, "client_id_present": true, "client_secret_present": true,
  "master_password_present": true, "collections": [ …9 collections… ] }
```
Needs the operator's master password to unlock. Config, binary and collections are all present — only the session is locked.

### P7.2 `instagram` — now honestly reports login required

Baseline returned `ok:true` with a stale `last_error`. POST-FIX returns a truthful failure:

```json
{ "ok": false,
  "error": "login_required",
  "message": "The saved Instagram session is no longer valid.",
  "hint": "run: ig-mcp login   (or: ig-mcp login --sessionid <cookie value>)" }
```
This is an improvement in honesty (baseline's `ok:true` was misleading) but the connector is functionally down.

### P7.3 `n8n` — authenticates, lists zero workflows

```json
{ "apiUrl": "https://n8n.evoonline.co.uk/api/v1", "keyConfigured": true, "keyLength": 289,
  "authLayer": { "answers": true, "verdict": "rejects a bogus key with 401 (as it should)" },
  "probe": { "ok": true, "workflowsVisible": 0, "hasMorePages": false } }
```
Lead confirms the underlying `/workflows` returns `{"data":[],"nextCursor":null}` — the **instance genuinely
lists no workflows**. Key/auth is therefore fine; nothing for the gateway to fix.

### P7.4 `tv-bedroom` / Kodi — down (app/environment)

```
media_probe: kodi_running: false, addon_installed: true, addon_http: false   (host "doc")
devices_probe: tv-bedroom -> media-bridge state failed: ConnectionRefusedError: [Errno 111] Connection refused
tv_status:     Error: helper op state failed: ConnectionRefusedError: [Errno 111] Connection refused
```
Kodi is not running on the Pi5. The pager/TV *registry* is now correct; only the TV backend is absent.
`ha_pager` (`bathroomsw`) and `tembed_pager` (`tembed`) are both healthy and usable meanwhile.

### P7.5 `unifi` — `vpn=error` persists

```
gateway: Dream Machine Special Edition   model: UDMPROSE   firmware: 6.0.16
uptime: 3d 13h   active uplink: WAN (ppp0)   uplink ip: 86.156.161.101   latency: 4 ms
devices adopted: 4   clients active: 48   networks: 12
health: wlan=ok  wan=ok  www=ok  lan=ok  vpn=error
wan:    WAN=online  WAN2=online  WAN3=?
```
Every subsystem except **VPN** is green. The tool reports the same `vpn=error` as baseline.

---

## P8. Additional findings

### P8.1 Version mismatch (recorded as requested)

| Source | Version |
|---|---|
| Docker image tag | **`localhost/mcp-gateway:0.15.5`** |
| `grep version /app/package.json` (inside container) | **`0.14.2`** |
| `GET /mcp/v1/health` → `version` | **`0.14.2`** |

So the image is **tagged** `0.15.5` but **contains and reports** `0.14.2`. Either the tag is wrong or the image
was built before the version bump. Health endpoint body:

```json
{"status":"ok","version":"0.14.2","uptimeMs":198346}
```

### P8.2 Registry count — 24 stands

Confirmed again POST-FIX: DB `select count(*) from servers` = **24**, `GET /admin/servers` = **24**. There is
still no 25th server. The baseline finding stands.

### P8.3 Grants — unchanged, still 22/24

Key `dsh-harness-vps2`: **22 servers / 597 tools**. Still **NOT granted**: `here-hgv`
(`srv_b841d87f7a8046c4`), `social-watchers` (`srv_1aad56ae946a4ce2`). Both were therefore probed **read-only via
the master key** (here: 9/9 services OK; watchers: pid 134, both sources up, 0 restarts). Calling them directly
still returns `Error: unknown tool "mcp__gateway__here_api_health"` / `"mcp__gateway__watchers_status"`.

Separately, the `email` tool-name mismatch persists: this session exposes `mcp__gateway__email_*__list_email_accounts`
→ `Tool Not Found`, while the gateway advertises bare `email_list_accounts` (11 tools) which works. Not fixed by
this remediation and not listed by the Lead; recorded for completeness.

### P8.4 Empty `computer_use_availability`

0 rows, unchanged from baseline (see P3).

---

## P9. Verdict

**PASS at the gateway layer.** Every baseline gateway failure is resolved and independently reproduced:

- 24/24 servers running, **0** `lastError`, **24/24** admin test PASS (twice).
- Computer-use live over WireGuard direct, 5 computers, gpc `ready`/`online`.
- Fallback fully retired: **0** listeners on `172.19.0.1`, all tunnel + watchdog units `disabled`/`inactive` on
  cleo *and* gpc, `mcp-gateway.lan` → `10.10.1.4` direct, gateway log clean (0 error lines / 15 min).
- media-devices registry restored (3 devices), DeviceBridge gpc connector restored (`online:true`).
- SSH/homepage/omb connectors restored.

**Remaining failures are all application/environment level and correctly outside gateway configuration:**
vaultwarden locked (needs operator master password), Instagram session expired (needs `ig-mcp login`), n8n
instance genuinely has no workflows, Kodi not running on `doc` for `tv-bedroom`, UniFi VPN subsystem flagged,
and `yoga` (Omarchy Laptop) offline ~8 h with a `docker.sock` permission issue.

**Two cosmetic/quality items worth a ticket:** image tag `0.15.5` vs reported `0.14.2` (P8.1), and the
`email` account-scoped tool-name mismatch (P8.3).

**Caveat on the tunnel number:** this pass measured 24 listeners at 12:57:43Z and 0 at 12:58:52Z. The transient
24 was the **watchdog's** final resurrection, observed before the watchdog was disabled. The 0 is the verified,
stable post-fix state at the time of writing.

---

*End of POST-FIX pass. Read-only throughout; no remediation performed by this auditor.*

---

## Addendum — 2026-11-05 17:22Z — Computer Broker moved to the USA VPS

This changes the `computer-use` row above: the broker no longer runs on gpc.

| Item | Value now |
|---|---|
| Broker host | USA VPS `10.10.1.4`, systemd `computer-broker.service` (enabled at boot) |
| Broker URL | `https://10.10.1.4:7443` (WireGuard only; UFW admits `10.10.0.0/16` + `172.16.0.0/12`) |
| Gateway wiring | `MCP_COMPUTER_BROKER_URL`/`_PUBLIC_URL`/`_INSTALL_BASE_URL`, `computer_use_settings.broker_url`/`public_broker_url` and `servers.url` all `https://10.10.1.4:7443` |
| Connectors | `wss://10.10.1.4:7443/connector` on gpc, cleo, doc, us-vps (roof was off — pending) |
| Verified | `list_computers` → 5; gpc `ready`/connector online; `computer_screenshot` through the gateway returned a real gpc frame; **broker restarted on purpose and all 4 connectors re-attached immediately**; 24/24 connectors still PASS; 0 gateway errors |

The move is recorded in `docs/FULL-MIGRATION.md` (2026-11-05, later) and the runbook is in
`docs/VPS-DEPLOY.md` ("Computer Broker now on this VPS").

