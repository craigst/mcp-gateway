# Instagram and WhatsApp in the gateway

Both connectors now run inside `mcp-gateway` (2026-11-05). The laptop services
were stopped after the gateway passed read-only checks.

## Instagram

- Server: `srv_c1a176247cb544de` (`instagram`), Python, 34 tools.
- Source: `/data/repos/instagram-mcp`
- Session/state: `/data/secrets/instagram` (`session.json`, `state.json`, `queue.db`)
- Media: `/data/repos/instagram-media`
- Env file: `/data/secrets/instagram.env`
- Writes are enabled (`IG_READ_ONLY=0`).
- Read tests: `ig_status` returned logged-in `cra1gst`; `ig_list_threads`
  returned live threads.
- Old `instagram-mcp-http.service` and its manual Python process were stopped;
  the old gateway remote record was removed.

## WhatsApp

- Server: `srv_a28f732e662f4d8f` (`whatsapp`), Python + Go bridge, 12 tools.
- Source/bridge/session: `/data/repos/whatsapp-mcp`
- Linked-device store: `whatsapp-bridge/store/whatsapp.db` and `messages.db`
- Env file: `/data/secrets/whatsapp.env`
- Runner: `/data/repos/whatsapp-mcp/run-mcp.sh` starts the Go bridge with
  `</dev/null`, waits for port 8081, then runs the MCP server in the foreground.
- Read tests: `list_chats` and `list_messages` returned live chats/messages;
  bridge authenticated and connected.
- Old `whatsapp-mcp-http.service` and bridge process were stopped; the old
  gateway remote record was removed.

## Catalog

Catalog source `cat_728d0f29e5d94ffd` (`Local social connectors`,
`catalog-json`) points at `/data/catalog/instagram-whatsapp.json`. It links both
servers in the Catalog view. They are marked as local-reference entries rather
than one-click reinstall entries because their value is the copied session /
linked-device state and the custom WhatsApp bridge wrapper.

## Watch out

The Remy watcher processes (`remy-instagram-watcher`, `remy-whatsapp-watcher`)
are separate Python workers, not MCP servers, and are still on the laptop. The
gateway watcher settings currently force `autoReply: false` and `draftOnly:
true`; true auto-reply still needs those workers moved/ported and the draft-only
guard changed.

## Watchers / auto-apply / monitoring

The two Remy watcher workers were moved off the laptop into the gateway as one
local MCP server:

- Server: `social-watchers` → `srv_1aad56ae946a4ce2` (2 tools: `watchers_status`, `watchers_restart`)
- Manager: `/data/repos/remy-watchers/manager.mjs`
- Worker: `/data/repos/remy-watchers/remy_watchers.py`
- State snapshot: `/data/secrets/remy-watchers/state.sqlite3`
- Settings/credentials env: `/data/secrets/remy-watchers.env`
- Logs: `/data/repos/remy-watchers/watchers.log`

The workers read their allowlist and `autoLike` settings from the gateway
watcher API (`http://127.0.0.1:8080/mcp/v1/watcher`) using a copied scoped
watcher key. That keeps auto-apply/auto-like driven by the gateway settings
instead of laptop state. The state database (cursor + outbox) was snapshotted
after stopping the old services, so monitoring resumes without duplicates.

The old `remy-whatsapp-watcher.service` and `remy-instagram-watcher.service`
were stopped on the laptop. Auto-reply remains draft-only by design in the
gateway; auto-like/auto-apply is enabled through `autoLike` in the watcher
settings.
