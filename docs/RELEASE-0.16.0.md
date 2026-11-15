# Version 0.16.0

The consolidation release. Two agents' work had drifted into three separate
places at once; 0.16.0 is where they are one thing again, and where the Second
Brain's access model stops living as an uncommitted file on a server.

## What was drifting

| Drift | Where it was | Where it is now |
|---|---|---|
| CodeX's console refresh (v15) | `origin/main` @ `c4818ff`, numbered 0.15.0, branched from a stale `main` | merged in 0.15.5 |
| The email/watch line | local commits 0.15.1–0.15.4, never pushed, deployed on the VPS | pushed, in `main` |
| YouTube + X watchers | hand patches copied into the running container | in the source since 0.15.6 |
| The brain's local grant | **an uncommitted edit** in the VPS brain checkout — the only copy | `craigst/brain-mcp` v1.2.0 |

## In this release

**CodeX's console** — navigation as Overview / Servers / API keys & access /
Activity / Approvals, a light-dark appearance switch with a light palette, page
transitions, a refreshed Overview and API-key screens with explicit tool
selection. `agents/delegate` is removed; the Delegation page is the approvals
queue.

**The email and watch line** — per-mailbox email access control enforced inside
the email MCP server from `_meta.key_id`, Jev triage with per-mailbox switches, a
confidence floor, reversible filing and the triage report; YouTube and X watcher
sources with their settings cards (previously container patches).

**Light-theme legibility** — the tonal fills (`*-800/900/950`) are remapped to
pale in `html.light`, so a `running` badge is no longer dark-green-on-dark-green.

**Streamable HTTP session recovery** — remote HTTP sub-servers (`computer-use`,
`scrypted`, `x`) can drop a session at the far end; the client now re-initializes,
replays the session header, and serializes concurrent callers behind one recovery
handshake. Carried in from `fix/http-session-recovery` with its own 9-test suite
and `docs/TRANSPORT-SESSIONS.md`.

**The Second Brain, visible per API key** — `GET /mcp/v1/admin/keys/{id}/access`
now returns a `memory[]` block for any key granted a brain server, and the key's
Access tab renders it. It reports two facts that are decided in different places,
and deliberately does not merge them:

- `tools` — what **this key** may call, from its own grant.
- `agent` / `actions` / `categories` / `canRead|canWrite|canForget|canIngest` —
  what the **brain** authorises, from the server record's `BRAIN_LOCAL_GRANT`
  env (`brain` → `omb-maus`, `brain-full` → `dsh-cleo`).

A brain server is recognised by `BRAIN_LOCAL_GRANT=1`, not by name. The panel
states the caveat on screen: the action grant lives on the server record, so
every key granted that record shares it. **Per-key action scoping is not
enforced** — that needs the gateway to pass caller identity into the brain, and
is not pretended here.

## Upgrade notes

Image swap only. `data/`, `gateway.env`, `certs/` and the compose network are
bind mounts, so keys, servers, grants, watchers, mailboxes, config profiles and
the vault are untouched. No schema change: `KeyAccessView.memory` is derived on
read from the server record's env.

The brain side is separate: `craigst/brain-mcp` **v1.2.0** carries the local grant
that had only ever existed as an uncommitted edit, on top of v1.1.1's
extraction-fallback fix (a failed Mem0 extraction stores the text verbatim
instead of losing it). Deploy it into the checkout the gateway runs from, then
restart the `brain` and `brain-full` server records — the env grants in the
database are unchanged.
