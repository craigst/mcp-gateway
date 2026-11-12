# VPS deployment (WireGuard-only)

The gateway runs on the USA VPS (`root@10.10.1.4`, public `74.208.55.116`) next
to OpenMausBot. It is deliberately **not** published to the internet:

| Client | Address |
|---|---|
| OMB container | `http://mcp-gateway:8080/mcp/v1` (shared `openmausbot_default` Docker network) |
| DSH / LAN agents | `http://mcp-gateway.lan:8484/mcp/v1` (AdGuard rewrite → `10.10.1.4`) |
| DSH / LAN agents (no DNS) | `http://10.10.1.4:8484/mcp/v1` (WireGuard `wg0`) |
| Host-side admin scripts | `http://127.0.0.1:8484/mcp/v1` |

Upstreams are reached **directly over WireGuard**: the **Computer Broker now
runs on this VPS** at `https://10.10.1.4:7443` (moved off gpc on 2026-11-05), and
the cleo facades `http://10.10.254.91:8808/mcp` (vaultwarden), `:8814`
(messenger), `:8819` (media-devices). There are no SSH reverse tunnels and no
compose `extra_hosts` any more — the 2026-11-01 tunnel fallback was retired on
2026-11-05 (see `docs/FULL-MIGRATION.md`).

Because the broker is local, **computer-use survives any home machine being
off**. Only the connectors for machines that are switched off show offline;
the broker, the gateway and every awake connector keep working.

No Cloudflare hostname, DNS record, Caddy change or new public port is needed.

## Layout

```
/opt/mcp-gateway
├── docker-compose.yml
├── gateway.env          # 0600 root: master key, vault secret, UI password, broker token
├── certs/
│   ├── broker-ca.pem    # mkcert CA for the Computer Broker (now local)
│   └── combined-ca.pem  # broker CA + DeviceBridge CA (NODE_EXTRA_CA_CERTS)
├── data/                # SQLite + repo checkouts, uid 1000
├── backups/             # OMB config backups, gateway + broker backups
├── seed_gateway.py
├── cutover_omb.py
└── verify_gateway.py

/opt/computer-broker      # broker source, owned by craigst (moved from gpc 2026-11-05)
├── broker/ connector/ web/ scripts/ deploy/ docs/
└── venv/                 # python deps (fastapi, uvicorn, websockets, httpx, cryptography)

/etc/systemd/system/computer-broker.service       # runs as craigst, enabled at boot
/home/craigst/.config/computer-broker/broker.env  # 0600: BRK_BIND=10.10.1.4, :7443, password hash
/home/craigst/.local/share/computer-broker/       # broker.db, secret.key, tls/, computers/Roster
```

`certs/` must be mode `755` and the PEMs `644`; the container runs as uid 1000
and Node refuses to load `NODE_EXTRA_CA_CERTS` otherwise (`Permission denied`,
then `unable to verify the first certificate`).

## Deploy

```bash
# on gpc (this checkout) — the tag is a variable, default 0.15.0
npm run build && podman build -t localhost/mcp-gateway:${MCP_IMAGE_TAG:-0.15.0} .
podman save localhost/mcp-gateway:${MCP_IMAGE_TAG:-0.15.0} | ssh root@10.10.1.4 'docker load'

# on the VPS
install -d -m 700 /opt/mcp-gateway/{data,certs,backups}
chown 1000:1000 /opt/mcp-gateway/data
scp deploy/vps/docker-compose.yml root@10.10.1.4:/opt/mcp-gateway/
# write /opt/mcp-gateway/gateway.env (0600) from the example
docker compose -f /opt/mcp-gateway/docker-compose.yml up -d
curl -s http://127.0.0.1:8484/mcp/v1/health
```

Docker publishes bypass `ufw`; the compose file binds `127.0.0.1` and
`10.10.1.4` only. Add a `DOCKER-USER` rule allowing `10.10.0.0/16` to 8484 as
defence in depth.

**Image tag note (fixed 2026-11-05).** The image deployed on 2026-11-01 was
tagged `localhost/mcp-gateway:0.15.5` while its `package.json` and
`/mcp/v1/health` both reported **`0.14.2`** — the tag was mislabelled, not a
newer build. It has been retagged to `localhost/mcp-gateway:0.14.2` and the
compose `MCP_IMAGE_TAG` default now matches; `docker ps` and `/mcp/v1/health`
agree. Tag by the version in `package.json` next time, and bump `package.json`
before calling a build `0.15.x`.

**0.15.0 (deployed 2026-11-06).** `package.json`, `/mcp/v1/health`, the image
tag and the UI footer all report `0.15.0`. This build adds the Email tab access
controller (bots/API keys, server switch and per-mailbox switches) and enforces
the per-mailbox layer inside the email MCP server from the gateway's
`_meta.key_id`. The live `email` server record was also given its
`highPrivilegeTools` (`email_move`, `email_delete`, `email_send`,
`email_reply`); without that list a new grant would have treated the write
tools as ordinary tools. See `docs/EMAIL.md` for the feature and
`/mcp/v1/admin/email/access`.

## WireGuard restored, fallback retired (2026-11-05)

WireGuard is healthy again (handshake < 60 s; gpc `10.10.254.49` and cleo
`10.10.254.91` reachable from the VPS at ~98 ms), so the 2026-11-01 fallback is
gone: no `extra_hosts`, no gpc SSH reverse tunnels, no `172.19.0.1` upstream
URLs. Full detail and rollback: `docs/FULL-MIGRATION.md`, section
"2026-11-05 — WireGuard restored; fallback retired".

```bash
# 1. AdGuard: mcp-gateway.lan must resolve to the VPS, not the gpc tunnel host
#    (delete needs the exact old answer; the gateway's `adguard` server exposes
#    adguard_delete_rewrite / adguard_add_rewrite for the same two calls)
curl -sk -u "$ADGUARD_USER:$ADGUARD_PASS" https://adguard.lan/control/rewrite/delete \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mcp-gateway.lan","answer":"10.10.254.49"}'
curl -sk -u "$ADGUARD_USER:$ADGUARD_PASS" https://adguard.lan/control/rewrite/add \
  -H 'Content-Type: application/json' \
  -d '{"domain":"mcp-gateway.lan","answer":"10.10.1.4"}'

# 2. gpc: stop and disable the duplicate fallback tunnel units
#    (upstream was restart-looping: ExitOnForwardFailure, exit 255 every 5 s)
systemctl --user stop mcp-gateway-upstream-tunnel.service mcp-gateway-ui-tunnel.service
systemctl --user disable mcp-gateway-upstream-tunnel.service mcp-gateway-ui-tunnel.service
systemctl --user reset-failed mcp-gateway-upstream-tunnel.service

# 2b. cleo: the SYSTEM unit that actually held the live forwards, plus its
#     2-minute watchdog. Disable the WATCHDOG FIRST — it probes 172.19.0.1:28801
#     and restarts the tunnel within two minutes if the probe fails, so
#     disabling only the tunnel unit leaves it resurrected.
ssh craigst@10.10.254.91 '
  sudo systemctl disable --now usvps-mcp-tunnels-watchdog.timer
  sudo systemctl stop usvps-mcp-tunnels-watchdog.service
  sudo systemctl disable --now usvps-mcp-tunnels.service'
ssh root@10.10.1.4 'ss -tlnp | grep "172.19.0.1" || echo "0 fallback listeners"'

# 3. VPS: compose has no extra_hosts any more; recreate and check
docker compose -f /opt/mcp-gateway/docker-compose.yml up -d
curl -s http://127.0.0.1:8484/mcp/v1/health

# 4. LAN verification (with the tunnels stopped, this proves the WG path)
getent hosts mcp-gateway.lan     # must be 10.10.1.4
curl -s http://mcp-gateway.lan:8484/mcp/v1/health
```

If a `172.19.0.1` port is still held after step 2b, an orphan `sshd-session` on
the VPS owns it — find it with `ss -tlnp`, kill that process, and check
`systemctl status usvps-mcp-tunnels.service` on cleo (do not re-enable it).

## Container SSH identity

Three connectors shell out to `ssh`: `ssh` (zues/shadow/vps), `homepage`
(`pi5`) and `omb` (`root@10.10.1.4`). The container's `$HOME` is ephemeral and
contains no key, so identity and host aliases live on the data volume and are
mounted at `/home/node/.ssh`:

```bash
install -d -m 700 /opt/mcp-gateway/data/ssh-home/.ssh
install -m 600 /path/to/id_ed25519 /opt/mcp-gateway/data/ssh-home/.ssh/id_ed25519
# config: pi5 -> 10.10.254.85 (craigst), zues -> 10.10.254.13 (root),
#         shadow -> 10.10.254.84 (root), plus IdentityFile/known_hosts defaults
ssh-keyscan -H 10.10.1.4 10.10.254.13 10.10.254.84 10.10.254.85 \
  >> /opt/mcp-gateway/data/ssh-home/.ssh/known_hosts
chown -R 1000:1000 /opt/mcp-gateway/data/ssh-home
```

The compose file mounts `./data/ssh-home/.ssh:/home/node/.ssh`; the `ssh`
connector's `SSH_KEY` and `homepage`'s `SSH_KEY` both point at
`/home/node/.ssh/id_ed25519`. Without this mount all three connectors fail with
`Identity file … not accessible` or `Could not resolve hostname`.

## Computer Broker (now on this VPS, 2026-11-05)

The broker used to run on gpc, so computer-use died whenever the bedroom PC was
off. It now runs on this VPS as `computer-broker.service`; the gateway reaches it
at `https://10.10.1.4:7443` and every connector dials
`wss://10.10.1.4:7443/connector`. Only the connector for a switched-off machine
goes offline — the broker and gateway stay up.

```bash
# 1. code + venv (source: the sibling "computer broker" checkout, as craigst)
tar czf - --exclude='__pycache__' --exclude='.git' \
    broker connector web scripts deploy images README.md docs \
  | ssh root@10.10.1.4 'mkdir -p /opt/computer-broker && tar xzf - -C /opt/computer-broker'
ssh root@10.10.1.4 '
  chown -R craigst:craigst /opt/computer-broker
  runuser -u craigst -- python3 -m venv /opt/computer-broker/venv
  runuser -u craigst -- /opt/computer-broker/venv/bin/pip install \
      -r /opt/computer-broker/broker/requirements.txt'

# 2. identity + state — copy while the OLD broker is stopped (so SQLite
#    checkpoints and broker.db-wal disappears): broker.db, secret.key, tls/,
#    computers/ -> ~/.local/share/computer-broker/ ; broker.env -> ~/.config/
#    Then set in broker.env:
#      BRK_BIND=0.0.0.0        # see "bind" note below
#      BRK_PORT=7443
#      BRK_PUBLIC_URL=         # empty: containers use host.containers.internal
#
# 3. service (unit is kept in this repo: deploy/vps/computer-broker.service)
install -m 644 deploy/vps/computer-broker.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now computer-broker

# 4. firewall: UFW's default deny is what keeps the broker off the internet.
#    Verified from a LAN host: https://74.208.55.116:7443 times out, the WG
#    address answers 200.
ufw allow from 10.10.0.0/16  to any port 7443 proto tcp   # WG peers + connectors
ufw allow from 172.16.0.0/12 to any port 7443 proto tcp   # gateway container -> host
```

**Bind note.** `BRK_BIND=0.0.0.0` is deliberate, not sloppy: a rootless podman
container reaches the host as `host.containers.internal` (which SNATs to the
host's primary address), so a `10.10.1.4`-only listener is not reachable from a
container computer. UFW is the boundary — 7443 is admitted only from the WG
range and the Docker subnets, and the public address is dropped by the default
policy.

Verify from the host, from inside the gateway container, and from the internet
(the last one must fail):

```bash
curl -sk https://10.10.1.4:7443/healthz
docker exec mcp-gateway node -e \
  "fetch('https://10.10.1.4:7443/healthz').then(r=>r.text()).then(console.log)"
curl -sk -m 8 https://74.208.55.116:7443/healthz || echo "public: blocked (correct)"
```

Connector config is one env line per host — `BRK_BROKER_URL=wss://10.10.1.4:7443/connector`:

| Host | Env file | Unit |
|---|---|---|
| gpc | `~/.config/computer-broker/connector-computer.env` | user `computer-broker-connector-computer.service` |
| pi5-doc (android, Docker) | `/opt/computer-broker-android/connector-android.env` | compose service `android-connector` (`computer-broker-connector-android`) |
| cleo, doc, roof | `~/.config/computer-broker/connector-device.env` | user `computer-broker-connector-device.service` |
| us-vps | `/root/.config/computer-broker/connector-device.env` | root user `computer-broker-connector-device.service` |

**The Razer Phone connector must not run on gpc or cleo** (moved to the pi5 hub
2026-11-06). Both machines are meant to be switched off, and the phone's
computer-use went offline with them for days. It now runs as a small Docker
container on **pi5-doc** (`10.10.254.85`, the always-on DNS/ingress box), in
`/opt/computer-broker-android`:

* `docker-compose.yml` — `restart: unless-stopped`, 256 MB cap, state in
  `./state`, ADB keys in `./adb-keys`, and a healthcheck that re-runs
  `adb connect 10.10.254.80:5555` every 30 s. Required: the connector's frame
  pump does **not** reconnect ADB on its own when the Wi-Fi transport drops, so
  without this a dead transport silently freezes the viewer.
* `connector-android.env` — `BRK_KIND=android`, `BRK_STATE_DIR=/state`,
  `BRK_CA_FILE=/state/broker-ca.pem`, `BRK_NAME=Razer Phone`.
* `build/Dockerfile` — `python:3.12-slim` + `adb` from apt, connector source
  copied from the same `connector/` package as every other host (v1.1.1).
* `state/policy.json` — `android.adb_serial = 10.10.254.80:5555` (Wi-Fi ADB;
  the phone is not USB-attached to the pi5). The phone must already trust the
  ADB key mounted at `./adb-keys/adbkey` (copied from gpc). Templates for all
  of this live in `deploy/vps/computer-broker-android/`.

Management: `cd /opt/computer-broker-android && docker compose up -d --build`,
`docker logs -f computer-broker-connector-android`, `docker compose down`.
Only the connector moved — the broker and gateway stay on the VPS.

The CA needs no change: each connector already trusts the mkcert root, and the
broker cert's SAN list includes `10.10.1.4`.

### Container computers (agent-desktop) — podman + image on this VPS

Container computers need a container runtime **and** the `desktop-base` image on
the broker host. Podman is required, not Docker: the broker's run argv uses
`--userns=keep-id`, which is podman-only.

```bash
apt-get install -y podman uidmap slirp4netns passt
usermod --add-subuids 100000-165535 --add-subgids 100000-165535 craigst
loginctl enable-linger craigst            # keeps /run/user/1000 at boot
systemctl start user@1000.service

# build the golden image as the broker user (Containerfile COPYs connector/ and
# images/..., so the build context is the repo root)
cd /opt/computer-broker
runuser -u craigst -- env XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  podman build --network=host -t localhost/computer-broker/desktop-base:1 \
  -f images/desktop-base/Containerfile .

# pin the build the broker will verify (image inspect {{.Digest}})
runuser -u craigst -- env XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  podman image inspect --format '{{.Digest}}' localhost/computer-broker/desktop-base:1
# then set BRK_IMAGE_DIGEST=<that digest> in broker.env and restart the broker
```

The unit sets `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` — without the
user bus, rootless podman cannot use systemd cgroups and every `podman run`
fails with `unable to start unit … interactive authentication`. A container
computer created before the move holds its connector identity in its **podman
volume**, which does not travel with `broker.db`: recreate the record
(`broker.cli computer destroy --id …` then `POST /api/computers`) so the new
volume gets a fresh enrolment token. The old home volume stays on gpc.

### VM computers — VM hosts are reached over SSH from this VPS

`zues` is a `libvirt-ssh` host: the broker shells out to `ssh`/`virsh`/`qemu-img`
on the hypervisor, so it only needs an SSH path. Its `vm_hosts.config` must name
a reachable target and a key the **broker user** can read:

```bash
# on the VPS, as the broker user
install -d -m 700 -o craigst -g craigst /home/craigst/.ssh
install -m 600 -o craigst -g craigst <gpc-key> /home/craigst/.ssh/id_ed25519
ssh-keyscan -H 10.10.254.13 >> /home/craigst/.ssh/known_hosts
runuser -u craigst -- ssh -i /home/craigst/.ssh/id_ed25519 root@10.10.254.13 'virsh --version'

# config: host/ssh_host -> 10.10.254.13, user/ssh_user -> root,
#         ssh_key -> /home/craigst/.ssh/id_ed25519
# verify through the gateway:
#   POST /mcp/v1/admin/computer-use/vm-hosts/<id>/test   -> {"ok": true, "baseReady": true}
```

An existing VM's cloud-init seed embeds the broker URL from **creation time**, so
a VM made before the move still dials gpc. Stop it through the broker API first
(otherwise the reconciler restarts the domain), then edit the guest env offline:

```bash
# on zues — stop via the gateway API, THEN:
virsh domstate brk-zues-vm-1-25304a          # must be "shut off"
modprobe nbd max_part=8
qemu-nbd --connect=/dev/nbd0 /mnt/user/domains/brk/vms/computers/brk-zues-vm-1-25304a/disk.qcow2
mount /dev/nbd0p1 /mnt/brk-edit
sed -i 's|^BRK_BROKER_URL=.*|BRK_BROKER_URL=wss://10.10.1.4:7443/connector|' /mnt/brk-edit/etc/brk/env
sync; umount /mnt/brk-edit; qemu-nbd --disconnect /dev/nbd0
# then start the computer through the gateway again
```

**Rollback:** `systemctl disable --now computer-broker` on the VPS, restore the
gpc broker unit (`systemctl --user enable --now computer-broker.service`) and put
`MCP_COMPUTER_BROKER_*` / `computer_use_settings` / `servers.url` back to
`https://10.10.254.49:7443`, then reverse each connector's `BRK_BROKER_URL`.
The pre-move broker DB is in `/opt/mcp-gateway/backups/broker-<stamp>/`.

**Known limits after the move**

- `roof` (10.10.254.205) was powered off during the move, so its connector still
  points at gpc. When it is back:
  `sed -i 's|^BRK_BROKER_URL=.*|BRK_BROKER_URL=wss://10.10.1.4:7443/connector|' ~/.config/computer-broker/connector-device.env && systemctl --user restart computer-broker-connector-device.service`
- `gpc-vm-1` was a **`qemu-local`** VM host ("this machine runs
  `qemu-system-x86_64`"), which cannot work once the broker is not on gpc. It was
  retired and recreated as **`zues-vm-2`** on the `zues` hypervisor (2 vCPU /
  4 GB / 30 GB, XFCE); the old disk and base images are still on gpc under
  `~/.local/share/computer-broker/vm/` if its state is ever wanted back.
- The broker host needs **`genisoimage`** (`mkisofs`) to build VM cloud-init
  seeds; without it every VM create fails with
  `vm create failed: genisoimage was not found`.
- VMs are created on `zues` only. There is no supported way to run a VM on a
  machine that is not the broker host unless that machine is a `libvirt-ssh`
  host — the `qemu-local` provider is, by definition, local to the broker.

## Env that matters

| Variable | Value |
|---|---|
| `MCP_MASTER_KEY` | `mcp_master_` + 64 hex chars (bootstrap, first boot only) |
| `MCP_VAULT_SECRET` | 48 random bytes, base64 |
| `MCP_KEY_PEPPER` | random hex, keep stable |
| `MCP_UI_USERNAME` / `MCP_UI_PASSWORD` | console login (`MCP_UI_COOKIE_SECURE=false` for WG HTTP) |
| `MCP_GIT_IMPORT_ALLOWED_PREFIXES` | `https://github.com/` |
| `MCP_TOOL_TIMEOUT_MS` | `120000` (WG adds ~100 ms per LAN hop) |
| `MCP_COMPUTER_BROKER_URL` / `_PUBLIC_URL` / `_INSTALL_BASE_URL` | `https://10.10.1.4:7443` — the broker is **local to this VPS** since 2026-11-05 (it listens on 7443, not 27443) |
| `MCP_COMPUTER_BROKER_CA` | `/certs/broker-ca.pem` |
| `MCP_COMPUTER_BROKER_TOKEN` | a broker agent token (mint with `broker.cli token create`) |
| `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS` | `destroy_computer` (OMB automation needs `device_exec`) |
| `NODE_EXTRA_CA_CERTS` | `/certs/combined-ca.pem` (DeviceBridge 8443 + broker) |
| upstream `servers.url` (gateway DB, not env) | `computer-use` → `https://10.10.1.4:7443`; `vaultwarden` → `http://10.10.254.91:8808/mcp`; `messenger` → `http://10.10.254.91:8814/mcp`; `devicebridge` (env `DEVICEBRIDGE_URL`) → `https://10.10.254.91:8443/mcp`. `media-devices` is gateway-local stdio with `MEDIA_DEVICES_DIR=/data/secrets/media-devices` |
| compose `extra_hosts` | **none** — `gpc.lan` / `devicebridge.lan` → `172.19.0.1` removed 2026-11-05 with the fallback |
| compose volume | `./data/ssh-home/.ssh:/home/node/.ssh` — required by the `ssh`, `homepage` and `omb` connectors |

## Seed the 20 OMB servers and the per-bot keys

`seed_gateway.py` reads OMB's live `config.json` on the VPS, creates one
encrypted config profile per upstream (`X-API-Key`, or `Authorization` for
DeviceBridge), registers the 20 remote HTTP servers plus the managed
`computer-use` server, and mints one agent key per OMB bot. It is deliberately
curated: the four email servers collide on 16 bare names, so the gateway exposes
them as `<server>__<tool>`, and each bot's grant is kept under OMB's 127-tool
cap.

```bash
python3 /opt/mcp-gateway/seed_gateway.py
python3 /opt/mcp-gateway/verify_gateway.py   # read-only: tools/list, permitted servers, audit
```

`provisioning.json` (0600) holds the plaintext keys exactly once; the cutover
consumes it and OMB stores each key in its own config entry.

## Cut OMB over (no fork)

OMB's per-bot MCP config is a name allowlist, so each bot gets its own gateway
entry (`gateway-remy`, `gateway-cleo`, …) carrying that bot's key. The 20 direct
entries are removed; the backup is the rollback.

```bash
python3 /opt/mcp-gateway/cutover_omb.py --dry-run
python3 /opt/mcp-gateway/cutover_omb.py --apply
# rollback:
python3 /opt/mcp-gateway/cutover_omb.py --rollback /opt/mcp-gateway/backups/omb-<stamp>
```

The cutover stops the compose project (Caddy shares OMB's netns), rewrites
`config.json` and `bots.json` atomically as uid 1001, starts it again, waits for
`/api/health`, and asserts `/api/mcp/servers` shows exactly the 11 gateway
entries.

## DSH-only facades

The OMB facades cover 20 servers; DSH also used `ssh`, `n8n`, `media` and
`media-devices` directly over stdio. `scripts/vps/create_dsh_facades.sh` creates
HTTP facades for them on cleo (ports 8816-8819) with per-facade API keys. Register
those as gateway servers exactly like the OMB ones, then give the DSH key the
extra servers. `console` (Odysseus, port 8820) is intentionally left out: it does
not bind while the Odysseus console singleton is running.

`media-devices` needs the hub's message/registry units (`cleo-messages`,
`cleo-media-registry`); those are not installed on cleo, so the tools that need
the bus return `Connection refused` even though the facade is healthy. The plain
media-bridge tools (`media_probe`, TV/Kodi) work.

## Verification

- Gateway: master `tools/list` = 520 tools / 21 servers; email names qualified;
  each bot key ≤ 127 tools; Remy cannot see UniFi or any WhatsApp/Instagram send
  tool; Nora can see `devicebridge__device_exec` and `computer_use__device_exec`.
- OMB: `/api/mcp/servers/<entry>/test` returns `ok:true` per bot (the probe caps
  its preview at 100 tools); `/api/bots/<id>/system-prompt` names the bot's
  `gateway-<bot>` entry; logs show no `skipping MCP server` / `duplicate tool
  name` / `128-tool` line for a gateway entry.
- Computer use / DeviceBridge: `list_devices`, `device_list` and
  `computer_status` through a bot key are read-only calls that must succeed.

## Bot access policy

`seed_gateway.py` is the source of truth. It keeps Remy draft-only (email
draft/read plus WhatsApp/Instagram reads; no social send tools), gives Cleo the
messenger/vault/devicebridge scopes, and leaves every other bot at its previous
server allowlist. Re-running the script against a populated gateway is
idempotent for servers/profiles but will create duplicate keys; revoke old keys
first or adjust the script intentionally.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Permission denied` loading `/certs/combined-ca.pem` | `certs/` not traversable by uid 1000; `chmod 755 certs && chmod 644 certs/*.pem`, then restart |
| DeviceBridge server `fetch failed` | DeviceBridge CA missing from `combined-ca.pem`, or the 8443 endpoint is down |
| OMB `skipping MCP server "gateway-x": MCP tool count exceeds the 128-tool limit` | the bot's curated grant is too wide; trim it in `seed_gateway.py` and re-mint the key |
| `Ambiguous tool name` | call `<server>__<tool>`; the four email servers are the only collision today |
