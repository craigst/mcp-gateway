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
```

## Deployment

Image `localhost/mcp-gateway:0.15.3` was built and deployed to the VPS. The
gateway data volume is unchanged; the email tables are created idempotently on
first start. The old `email-gmail`, `email-mum`, `email-personal` and
`email-work` gateway servers were retired after the new server passed read-only
checks, and the ten affected API keys now carry an `email` grant.
