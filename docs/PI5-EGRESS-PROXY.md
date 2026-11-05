# pi5 UK egress proxy

Instagram rejects the VPS datacentre IP. A small authenticated SOCKS5 proxy now
runs on pi5 so Instagram MCP and the Instagram watcher exit through the UK home
WAN.

- Host: pi5 `10.10.254.85`
- Proxy: `10.10.254.85:1080` (SOCKS5, username/password, CONNECT only)
- Service: `pi-egress-proxy.service` (enabled, restarts automatically)
- Files: `/opt/pi-egress/socks5.py`, `/opt/pi-egress/proxy.env` (0600)
- It binds the LAN/WireGuard address only; it is **not** exposed on the WAN.

The gateway uses:

```text
IG_PROXY=socks5h://<user>:<password>@10.10.254.85:1080
```

in both `/data/secrets/instagram.env` and `/data/secrets/remy-watchers.env`.
The Instagram client was patched to apply `IG_PROXY` via `Client.set_proxy()`
so DNS and traffic both leave through pi5 and the UK WAN.

Verified from the gateway with Python/requests:

```text
https://api.ipify.org -> 86.156.161.101
```

Curl in the gateway image lacks SOCKS support, so use Python for the check.

Re-authentication still requires a **fresh, unchallenged** Instagram sessionid.
The previous token had already been invalidated by Instagram and cannot be
reused.

## Web UI

Configuration → Instagram now has an **Instagram session** card:

- paste a fresh `sessionid`
- `ds_user_id` defaults to `268219632`
- save session → runs `instagram_mcp.cli login` through the proxy, then restarts the Instagram MCP and watcher
- set/replace the `IG_PROXY` URL
- shows session present / proxy configured state

The token is sent to the Python process over stdin and is never returned by the
gateway API.

## WhatsApp

The Go bridge was rebuilt with `client.SetProxyAddress()` support. It now reads
`WHATSAPP_PROXY` from `/data/secrets/whatsapp.env`, so WhatsApp also exits
through the pi5 UK proxy. It connected successfully through the proxy and
`list_messages` still works.

SearXNG itself runs on zues, so its searches already exit through the UK home
WAN. The gateway SearXNG connector only calls the internal zues instance; it
does not need the proxy.
