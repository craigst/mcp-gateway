# VPS deployment (WireGuard-only)

The gateway runs on the USA VPS (`root@10.10.1.4`, public `74.208.55.116`) next
to OpenMausBot. It is deliberately **not** published to the internet:

| Client | Address |
|---|---|
| OMB container | `http://mcp-gateway:8080/mcp/v1` (shared `openmausbot_default` Docker network) |
| DSH / LAN agents | `http://10.10.1.4:8484/mcp/v1` (WireGuard `wg0`) |
| Host-side admin scripts | `http://127.0.0.1:8484/mcp/v1` |

No Cloudflare hostname, DNS record, Caddy change or new public port is needed.

## Layout

```
/opt/mcp-gateway
├── docker-compose.yml
├── gateway.env          # 0600 root: master key, vault secret, UI password, broker token
├── certs/
│   ├── broker-ca.pem    # mkcert CA for the gpc Computer Broker
│   └── combined-ca.pem  # broker CA + DeviceBridge CA (NODE_EXTRA_CA_CERTS)
├── data/                # SQLite + repo checkouts, uid 1000
├── backups/             # OMB config backups and gateway backups
├── seed_gateway.py
├── cutover_omb.py
└── verify_gateway.py
```

`certs/` must be mode `755` and the PEMs `644`; the container runs as uid 1000
and Node refuses to load `NODE_EXTRA_CA_CERTS` otherwise (`Permission denied`,
then `unable to verify the first certificate`).

## Deploy

```bash
# on gpc (this checkout)
npm run build && podman build -t localhost/mcp-gateway:0.14.0 .
podman save localhost/mcp-gateway:0.14.0 | ssh root@10.10.1.4 'docker load'

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

## Env that matters

| Variable | Value |
|---|---|
| `MCP_MASTER_KEY` | `mcp_master_` + 64 hex chars (bootstrap, first boot only) |
| `MCP_VAULT_SECRET` | 48 random bytes, base64 |
| `MCP_KEY_PEPPER` | random hex, keep stable |
| `MCP_UI_USERNAME` / `MCP_UI_PASSWORD` | console login (`MCP_UI_COOKIE_SECURE=false` for WG HTTP) |
| `MCP_GIT_IMPORT_ALLOWED_PREFIXES` | `https://github.com/` |
| `MCP_TOOL_TIMEOUT_MS` | `120000` (WG adds ~100 ms per LAN hop) |
| `MCP_COMPUTER_BROKER_URL` / `_PUBLIC_URL` | `https://10.10.254.49:7443` |
| `MCP_COMPUTER_BROKER_CA` | `/certs/broker-ca.pem` |
| `MCP_COMPUTER_BROKER_TOKEN` | a broker agent token (mint with `broker.cli token create`) |
| `MCP_COMPUTER_APPROVAL_REQUIRED_TOOLS` | `destroy_computer` (OMB automation needs `device_exec`) |
| `NODE_EXTRA_CA_CERTS` | `/certs/combined-ca.pem` (DeviceBridge 8443 + broker) |

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
