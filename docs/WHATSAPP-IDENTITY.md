# WhatsApp sender identity — diagnosis and fix

Status: **A, B and C implemented and verified on cleo (2026-11-02).**

## Symptom

Remy saw opaque identifiers instead of the sender’s name/phone number:

- webhook `sender` was a bare LID such as `261821390962921`
- webhook `conversation.name` could be Craig’s own LID `5849879732462`
- Remy then had to cross-reference Nextcloud contacts / WhatsApp contacts manually

## Root cause

1. The Go bridge stored `msg.Info.Sender.User` — a bare LID or PN with the domain
   stripped — and did not store the `SenderAlt` phone-number alternative.
2. `GetChatName` returned the first cached `chats.name` forever. For a LID chat
   whose first cached sender was Craig’s own LID, the chat name became
   `5849879732462` (which maps to Craig’s PN `447779274274`, not Matt).
3. `remy_watchers.py` sent the raw `messages.sender` and `chats.name` straight
   into the webhook. It did not use the MCP’s LID resolver.
4. The MCP had LID resolution, but `contact_name()` only looked up the PN contact
   row; it did not fall back to the `@lid` contact row’s `push_name`.

## A — watcher enrichment

`~/.local/share/remy-watchers/remy_watchers.py` now reads whatsmeow’s
`whatsmeow_lid_map` and `whatsmeow_contacts` read-only and adds:

| Payload field | Meaning |
|---|---|
| `sender` | human label, e.g. `Matt Frost (447702088231)` |
| `sender_raw` | the bridge’s raw value, e.g. `261821390962921` |
| `sender_name` / `sender_number` / `sender_kind` | structured identity |
| `conversation.name` / `conversation.phone` | resolved chat identity, never a raw LID |

Unmapped LIDs are labelled `Name (unresolved LID …, not a phone number)` or
`unresolved LID … (not a phone number)`; they are never presented as a phone
number. Tests: 7/7 pass (`test_remy_watchers.py`). Service restarted; 7-day
backups `remy_watchers.py.bak-before-identity-*` and test backup kept.

Example real payload for Matt’s 14:30 message:

```json
{"sender":"Matt Frost (447702088231)","sender_raw":"261821390962921",
 "sender_name":"Matt Frost","sender_number":"447702088231","sender_kind":"person"}
{"id":"261821390962921@lid","name":"Matt Frost","phone":"447702088231"}
```

## B — bridge identity storage

`whatsapp-bridge/main.go`:

- added `messages.sender_pn` and `messages.sender_name`
- resolves `SenderAlt` / `whatsmeow_lid_map` / `whatsmeow_contacts`
- `GetChatName` refreshes stale numeric names and never falls back to the raw
  sender (which is our own LID for outgoing messages)
- `StoreChat` now updates a better name instead of caching the first one
- LID chats resolve to contact name, then `@lid` push_name, then PN

Built and installed; bridge authenticated and reconnected. One-time backfill:

- **37 chats** renamed (e.g. `261821390962921@lid` → `Matt Frost`)
- **915 messages** given `sender_pn` / `sender_name`

Backups: `main.go.bak-before-identity-*`, `whatsapp-bridge.bak-before-identity-*`,
`store/messages.db.bak-before-identity-*`.

Old **group history** rows whose participant was never stored still show
`sender not recorded`; new incoming group messages store `Info.Sender`
(participant). A history resync would be needed to repair old group rows.

## C — MCP hardening

`whatsapp-mcp-server/whatsapp.py`:

- `contact_name()` now checks full/first/push/business names
- new `contact_name_for_lid()` fallback for LID-only contacts
- `sender_info()` uses the LID contact name when no PN mapping exists
- `display_chat_name()` never returns a raw LID; falls back to the LID contact
  name, then PN, then `Unresolved WhatsApp contact`
- `sender_label()` shows `Name (unresolved LID …, not a phone number)` when a
  name exists but the phone number is unknown

Verified live through the gateway with Remy’s key:

```
Chat: Matt Frost From: Matt Frost (447702088231): 👍
{"jid":"261821390962921@lid","name":"Matt Frost","last_sender":"Matt Frost (447702088231)"}
```

## Operational note

Restarting a MCP facade can leave the gateway’s attached profile headers
unapplied (the existing gateway 404 issue). The 5-minute
`mcp-gateway-heal.timer` re-applies them; for an immediate fix, re-apply the
`omb-whatsapp-auth` profile to the `whatsapp` server. The gateway currently
reports the `whatsapp` server with 12 tools and a successful test.
