# Social watcher settings — WhatsApp and Instagram → Remy

Status: **implemented and deployed (gateway 0.14.2, 2026-11-02).**

The Configurations page has a **Push to Remy** heading with quick links at the top, then one card per source:

- **WhatsApp → Remy**
- **Instagram → Remy**

Each card controls what is pushed to Remy, with the same two scopes and the
same locked draft-only behaviour.

## What the operator can change

| Control | Effect |
|---|---|
| **Push incoming messages to Remy** | Off pauses pushes; the watcher still advances its cursor so nothing is replayed later. |
| **All incoming messages** | Every DM/group/thread event is pushed (historical behaviour). |
| **Selected contacts only** | Only the chosen contact/thread keys can push. Empty selection = nothing. |
| **Selected contacts** | Searchable chips/list from the watcher's synced catalog; manual `Add` for a key not in the catalog yet. |
| **Auto-reply** | Locked **OFF**. The API refuses `autoReply: true` (HTTP 400). Remy drafts and waits for confirmation. |

Settings are stored per source in the gateway's `settings` table
(`watcher:whatsapp:*`, `watcher:instagram:*`) and are separate — changing one
source never changes the other.

## How the watchers get the settings

The watcher processes on cleo poll the gateway over the WireGuard address every
15 seconds:

```
GET  http://10.10.1.4:8484/mcp/v1/watcher/whatsapp/settings
GET  http://10.10.1.4:8484/mcp/v1/watcher/instagram/settings
POST /mcp/v1/watcher/{source}/contacts        (catalog sync, every 5 minutes)
```

Environment:

```
WATCHER_BASE_URL=http://10.10.1.4:8484/mcp/v1/watcher
WATCHER_KEY_FILE=/home/craigst/.config/remy-watchers/watcher.key
```

The key is a scoped agent key named `watcher-remy`, with **no MCP server
grants**, stored mode 0600 on cleo. Only a key with metadata
`{"role":"watcher"}` or a name starting `watcher-` may call the watcher
endpoints; the admin endpoints require a master key or Web UI session.

## Contact catalogs

- **WhatsApp** — synced from `whatsmeow_contacts` / `whatsmeow_lid_map` plus group
  chat names. Keys are phone digits, `lid:<lid>`, or `group:<jid>`.
- **Instagram** — synced from the recent DM threads (`ig_list_threads`). Keys are
  `ig:<username>`; a thread with no user objects gets `thread:<thread_id>`.

A filtered event still advances the cursor, so paused/allowlisted-out messages
are not replayed when the scope changes.

## Admin API

```
GET  /mcp/v1/admin/watchers/whatsapp
POST /mcp/v1/admin/watchers/whatsapp
GET  /mcp/v1/admin/watchers/instagram
POST /mcp/v1/admin/watchers/instagram
```

GET returns `{settings, contacts, contactsUpdatedAt}`; POST accepts
`{enabled, mode, selected, autoReply}` and returns the same overview.

## Verification (2026-11-02)

- Both watcher services active; settings fetch HTTP 200 from cleo.
- Catalogs synced: **107 WhatsApp contacts/groups**, **13 Instagram contacts**.
- Saved an Instagram selection, got it back, restored `all`; `autoReply: true`
  returned HTTP 400 with the draft-mode message.
- Watcher unit suite: **10/10 pass** (filters, cursor advance, catalog, LID).
- Gateway tests: **1013 pass**.
- WhatsApp and Instagram tools still answer through the gateway after the
  0.14.2 restart; heal timer reports 0 missing profiles.

## Backups

- cleo watcher code: `remy_watchers.py.bak-before-watcher-settings-*`
- gateway compose: `/opt/mcp-gateway/backups/docker-compose.yml.pre-0.14.2-*`
- gateway DB: `/opt/mcp-gateway/backups/gateway.db.pre-0.14.2-*`
