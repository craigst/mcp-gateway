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
| **Selected contacts only** | Only the chosen contact/thread keys can push. A **person** key matches their **direct messages** only; a group message passes only when that **group** key is selected. Empty selection = nothing. |
| **Selected contacts** | Searchable chips/list from the watcher's synced catalog; manual `Add` for a key not in the catalog yet. |
| **Auto-reply** | Locked **OFF**. The API refuses `autoReply: true` (HTTP 400). Remy drafts and waits for confirmation. |

Settings are stored per source in the gateway's `settings` table
(`watcher:whatsapp:*`, `watcher:instagram:*`) and are separate — changing one
source never changes the other.

### Group filtering (fixed 2026-11-06)

A WhatsApp **group** is its own contact key (`group:<jid>`). Before the fix the
watcher also matched a group message against the *sender's* phone/LID, so a
selected individual posting in an unselected group pulled the whole group in —
"Daily walk around checks" reached Remy whenever a selected driver posted a
walk-around photo, and Remy ran its WhatsApp webhook routine and drafted a
reply. The filter now ignores sender keys for `@g.us` chats: selecting a person
exposes their DMs only, and a group pushes only when that group itself is
selected. Deployed to the gateway's `social-watchers` worker on 2026-11-06
(`/data/repos/remy-watchers/remy_watchers.py`), verified with synthetic group
and DM events.

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
- Watcher unit suite: **11/11 pass** (filters, cursor advance, catalog, LID).
- Gateway tests: **1014 pass**.
- WhatsApp and Instagram tools still answer through the gateway after the
  0.14.2 restart; heal timer reports 0 missing profiles.

## Backups

- cleo watcher code: `remy_watchers.py.bak-before-watcher-settings-*`
- gateway compose: `/opt/mcp-gateway/backups/docker-compose.yml.pre-0.14.2-*`
- gateway DB: `/opt/mcp-gateway/backups/gateway.db.pre-0.14.2-*`

## Instagram auto-like

The Instagram card has an **Auto-like (Instagram)** section. Liking is the only
automatic action; comments, replies and mentions stay drafts.

| Toggle | Default | Behaviour |
|---|---|---|
| **New posts from Cleo** | ON | Likes a new post from any account in **Cleo accounts** (`livecleo`, `livecleotv` by default). |
| **Comments that mention me** | ON | Polls the activity feed for `mention`, `reply_to_comment` and `usertag`; likes a new comment that references the logged-in account. |
| **New comments on Cleo's posts** | OFF | Polls the latest posts from Cleo accounts and likes new comments by other people. Cleo's own comments and the watcher account's comments are excluded. Off by default. |
| **New posts from selected accounts** | OFF | Likes new posts from the Instagram contacts chosen in **Selected contacts only**. Off by default. |

**First-run baseline:** the first automation poll after a toggle is enabled marks
the current posts/comments/activity as seen and performs **no likes**. Only items
arriving afterwards are liked, so enabling a toggle never likes a backlog.
Disabling and re-enabling a toggle creates a new baseline at that moment.

**How a post counts as new (fixed 2026-11-10):** the poll reads a page of
`REMY_INSTAGRAM_POSTS_AMOUNT` posts (**default 12**, never fewer than 4 — below
that Instagram's ranked feed can answer 200 with an empty list), sorts them by
`taken_at` instead of trusting profile order (pinned posts sit first), and
ignores anything older than `REMY_INSTAGRAM_POST_MAX_AGE_DAYS` (**default 7**).
A post the account has already liked is marked seen without spending a like.
An empty page is logged as a warning, because "no posts returned" means the
poll is blind, not that there is nothing new.

Polling: automation/activity every **15 minutes** (`REMY_INSTAGRAM_AUTOMATION_INTERVAL_SECONDS`),
DMs every **30 minutes**, settings every 15 seconds. The watcher account is
`cra1gst`; it likes Cleo's posts and comments from that account, never posts
comments itself. Every activity/comment match is also published as a draft
webhook event for Remy, subject to the same selected-contact push filter.

State is kept in the watcher's SQLite `meta` table (`ig:auto:*`, `ig:seen:*`);
the `instagram-activity` cursor is separate from the DM cursor.
