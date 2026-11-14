# Version 0.15.5

The release that unifies the two lines of work that had diverged after `ec83a38`.

`0.15.1`–`0.15.4` (the email line: per-mailbox access control, Jev triage, the
reversible filing and the consolidated **Devices & computers** console) were
committed locally but never pushed, so `origin/main` was still at `ec83a38` when
CodeX branched from it and published its console refresh as `0.15.0`. 0.15.5 is
the merge: one image, every page from both lines.

## CodeX's 0.15.0 work, now on main

- New console navigation: **Overview**, **Servers**, **API keys & access**,
  **Activity**, **Approvals**.
- Light/dark appearance switch, persisted in `localStorage`, plus a light palette
  mapped onto the existing slate classes.
- Page-enter transition (`prefers-reduced-motion` respected).
- Refreshed Overview/dashboard and API-key screens, including explicit tool
  selection for new keys and controls for changing individual tool grants.
- `agents/delegate` removed from the JSON-RPC surface; the delegation screen is
  the approvals queue, and `_meta.gateway.delegation_max_depth` is gone.

## Kept from 0.15.1–0.15.4

- Email access controller (bots/API keys, server switch, per-mailbox switches)
  enforced inside the email MCP server from `_meta.key_id`.
- Jev-backed triage, per-mailbox triage switches, confidence floor, one card
  event per email, reversible filing and the triage report.
- Consolidated **Devices & computers** page (Computers, Connectors, VM
  providers, Agent access) and the hash router with legacy aliases
  (`#/computer-use`, `#/connectors`, `#/vaultwarden`).
- `register_remote_mcp.py --header-name` and the social/watcher surfaces.

## Upgrade notes

Image swap only. `data/` (SQLite, repo checkouts, secrets, SSH identity),
`gateway.env`, `certs/` and the compose network are untouched, so API keys,
server records, grants, watchers and mailbox access survive the upgrade. Take a
database backup first (`data/gateway.db`); nothing in this release drops a table.

Delegation note: any client that still calls `agents/delegate` now receives
`method not found`. That is CodeX's removal, kept deliberately for consistency
with the approvals-only console.
