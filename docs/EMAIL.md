# Email in the MCP Gateway

The gateway now owns email: one account-aware email service, one MCP server and
one Email tab. There is no longer one MCP server per mailbox.

## Accounts

Accounts live in the gateway database (`email_accounts`). Passwords are never
returned by the admin API. The account list is imported from the Odysseus
`app.db` rows and decrypted with Odysseus' own `_decrypt` helper; the profile
does not need manual YAML copying.

| Name | Address | Kind |
|---|---|---|
| Craig Work | craigst@evoonline.co.uk | IMAP / Proton Bridge |
| Work MUM | admin@evoonline.co.uk | IMAP / Proton Bridge |
| Personal Work | evocraigst@proton.me | Proton |
| Craig Gmail | evocraigst@gmail.com | Gmail |

All four accounts were verified read-only on 2026-11-05: IMAP login and folder
listing pass, and message list/read pass for each mailbox.

## MCP server

One local stdio server is registered as `email`:

```
node /app/dist/src/email/mcp-server.js
EMAIL_DB_PATH=/data/gateway.db
```

The server is registered with `highPrivilegeTools` set to the four write/destroy
tools — `email_move`, `email_delete`, `email_send`, `email_reply` — so they are
opt-in in a grant instead of inherited from a wildcard. (The access controller
also treats them as high-privilege if a record was registered without the list.)

Tools:

- `email_list_accounts`
- `email_test_account`
- `email_list_folders`
- `email_list_messages`
- `email_search`
- `email_read_message`
- `email_mark_read`
- `email_move`
- `email_delete`
- `email_send`
- `email_reply`

Every tool takes an optional `account` selector (id, name or address); omitting
it uses the default account. API keys share this one server; access is granted
per key through the normal gateway server grants rather than by running one
server per mailbox.

## Triage (which mailboxes are watched)

Access says *who* may use a mailbox. Triage says *whether* the watcher may read
it at all, and how far it may act. They are deliberately separate: granting a
bot a mailbox must not silently start reading it.

Every mailbox starts **off**. A mailbox is read only when a row in
`email_triage` says `enabled = 1` *and* the account itself is enabled.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `0` | triage this mailbox |
| `mode` | `important` | `important` = cards and drafts only · `full` = also file no-action mail |
| `pollSeconds` | `300` | how often this mailbox is checked (clamped 60 – 86 400) |
| `junkFolder` | `null` | where `full` files no-action mail; null uses the provider's Junk |
| `alwaysImportant` | `[]` | senders never filed and never skipped by a rule |
| `neverJunk` | `[]` | senders never filed |
| `lastUid`, `uidValidity` | `0`, null | the cursor, so a restart cannot judge the same mail twice |

Allowlist entries are addresses or domains (`@gov.uk`); a `Name <addr>` form is
normalised to the bare address.

**No triage path can send or delete.** `full` only moves mail, and the move is
reversible from the card. The cursor lives in the gateway, not the watcher, so a
watcher restart or a second watcher process re-delivers rather than skips.

### Console

The Email tab shows one line per mailbox (`Triage: off` / `on · cards only` /
`on · cards + filing`). Clicking it opens the drawer with the switch, the mode,
the poll interval, the junk folder, both allowlists, and the current cursor.

### Scoped watcher endpoints

`watcher-*` keys only (role `watcher`, no MCP grants):

```
GET  /mcp/v1/watcher/email/new   -> due mailboxes with new headers + `waitSeconds`
POST /mcp/v1/watcher/email/ack   -> { accountId, uidValidity, lastUid }
```

`new` decides due-ness from `last_run_at` + `poll_seconds`, so the watcher is a
dumb loop: ask, act, ack, sleep `waitSeconds`. It returns headers plus a short
preview read from the first 8 kB of each message — never the whole body, and
never an attachment. A first run (cursor 0) reads the newest batch rather than
the whole mailbox, so enabling triage on a large inbox does not read all of it.
An ack advances the cursor and nothing else; an ack for a mailbox that is not
enabled is refused.

Email is not a social source: it has its own two actions instead of the
`settings`/`contacts` pair, because its settings are per mailbox rather than one
selected-contacts list.

## Access control (who can use which mailbox)

The Email tab has an **Access** panel ("Who has access") that answers, in one
place, which OpenMausBot bots and which gateway API keys can use the email
server — and which of the four mailboxes each one may use.

Access has two layers, both editable from that panel:

1. **Server access** — the gateway `email` server grant. Turning it off pauses
   the grant (`paused: true`), so the key keeps its tool whitelist for when it
   is switched back on. Turning it on unpauses an existing grant, or adds a new
   full-tool grant (high-privilege tools included explicitly).
2. **Mailbox access** — a per-key, per-account decision in the
   `email_account_access` table. There is no row for a key/account pair by
   default, which means allowed; an explicit `allowed = 0` row denies that
   mailbox. The email MCP server enforces this on every `tools/call` using the
   `key_id` the gateway puts in the JSON-RPC `_meta`:
   - `email_list_accounts` only returns the mailboxes the key may use;
   - any other tool resolves the account (explicit selector or default) and
     refuses it before touching IMAP when the pair is denied.

Bots are resolved through the `omb` MCP server (`omb_bots`). Each bot's
`gateway-<slug>` entry binds it to the gateway key named `omb-<slug>`
(`gateway-cleo` → key `omb-cleo`), so a bot's email access is the access of the
key it calls the gateway with. A bot with no matching key is shown as
**No gateway key** and cannot reach email until it is provisioned one.

A master key always has full email access and is shown locked; revoked keys are
never listed. Every change made in the panel is written to the audit trail as
`admin.email.access` with the target key and the toggled mailboxes.

## Web UI

`#/email` adds the Email tab:

- account list with connected/not-connected status
- folder tabs (Inbox, Sent, Drafts, Trash, Archive and other mailboxes)
- message list with unread and flagged state
- reader pane with reply, forward and delete
- search and unread-only filter
- compose window with To/Cc/Bcc, subject and body
- account settings dialog: IMAP/SMTP host, ports, TLS/STARTTLS, credentials,
  default account, enabled state, add/remove account
- **Access** drawer: bots and API keys, master email switch, per-mailbox
  switches, and a per-mailbox "Access: N bots · M keys" summary in the
  mailbox column

Connection status is live: selecting an account performs an IMAP test and shows
the latency, folder count and any error.

## REST surface

All routes require a master key or Web UI session under
`/mcp/v1/admin/email`:

```
GET    /                              list accounts
POST   /                              create account
PATCH  /:id                           update account
DELETE /:id                           remove account
POST   /:id/test                      IMAP connection test
GET    /:id/folders                   list mailboxes
GET    /:id/messages                  list/filter messages
GET    /:id/messages/:uid             read message
POST   /:id/messages/:uid/read        set/clear read flag
POST   /:id/messages/:uid/move        move message
POST   /:id/messages/:uid/delete      delete message
POST   /:id/send                      send mail
GET    /access                        who can use email, which mailbox
PATCH  /access/keys/:keyId            toggle a key/bot's access
GET    /triage                        every mailbox with its triage state
GET    /:id/triage                    one mailbox's triage state
PATCH  /:id/triage                    change it (only the fields sent)
```

`GET /access` returns:

```jsonc
{
  "server": { "id": "srv_…", "name": "email", "status": "running",
              "toolCount": 11, "highPrivilegeTools": ["email_move", "email_delete", "email_send", "email_reply"] },
  "accounts": [{ "id": "email_…", "name": "Craig Work", "email": "…",
                 "isDefault": true, "enabled": true }],
  "bots": [{ "id": "bot:…", "kind": "bot", "name": "Cleo", "title": "Chief of Staff",
             "slug": "cleo", "keyId": "key_…", "keyName": "omb-cleo",
             "emailGranted": true, "emailPaused": false, "emailEnabled": true,
             "grantedToolCount": 11, "totalToolCount": 11, "locked": false,
             "accounts": { "email_…": true } }],
  "keys": [{ "id": "key:…", "kind": "key", "name": "dsh-harness-vps2", … }],
  "generatedAt": "…"
}
```

`PATCH /access/keys/:keyId` takes `{ "enabled": false }` (pause/unpause the
server grant), `{ "accounts": { "<accountId>": false } }` (mailbox access), or
both, and returns the updated effective state for that key. Setting an account
back to `true` deletes its explicit decision so it inherits the default again.

## Deployment

Image `localhost/mcp-gateway:0.15.0` was built and deployed to the VPS. The
gateway data volume is unchanged; the email tables (`email_accounts`,
`email_account_access`) are created idempotently on first start. The old
`email-gmail`, `email-mum`, `email-personal` and `email-work` gateway servers
were retired after the new server passed read-only checks, and the ten affected
API keys now carry an `email` grant.
