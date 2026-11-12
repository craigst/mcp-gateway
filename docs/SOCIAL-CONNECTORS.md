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

## Story auto-like

Story auto-like is now a first-class watcher option:

- `WatcherAutoLike.cleoStories` (default **on** for this deployment).
- Visible in the Configuration → Instagram watcher card as **“New stories from Cleo”**.
- The Python watcher polls `user_stories()` for each configured Cleo account and
  calls `story_like()` for every active story, tracking liked PKs in the watcher
  state DB so a restart does not re-like the same story.
- Gateway image deployed: `localhost/mcp-gateway:0.15.4`.
- Current setting saved as:

```json
{
  "cleoPosts": true,
  "cleoStories": true,
  "mentions": true,
  "cleoPostComments": true,
  "selectedAccounts": false,
  "cleoAccounts": ["livecleo", "livecleotv"]
}
```

### Current blocker

The saved Instagram session became invalid during the audit (`login_required`).
The Instagram watcher therefore exits code 2 and waits for re-authentication; it
does **not** restart-loop. After a new session is placed at
`/data/secrets/instagram/session.json`, call `watchers_restart` on the
`social-watchers` MCP server. Until then, story auto-like and Instagram
monitoring cannot make API calls.

### Session status in the console

The Configurations page used to call a session **present** whenever the file
existed, so an expired cookie still showed a green badge. It now reports the
real state, both on `GET /mcp/v1/admin/social/instagram`:

| Field | Meaning |
|---|---|
| `status` | `valid`, `expired` or `unknown`. Derived from the connector's own `secrets/instagram/state.json`: an error newer than the last success is `expired`. The connector updates that state on every call, so the badge is current without hitting Instagram. |
| `lastOkAt` / `lastErrorAt` / `lastError` | The state timestamps and the connector's message, shown under the badge when expired. |
| `?verify=1` | Makes a real `status --verify` call to Instagram (≈3 s) and returns `verifiedAt` / `verifyError`. The card's **Refresh** button uses this; page load does not, so opening the page stays fast and does not poll Instagram. |

Saving a new sessionid still restarts the Instagram and watcher servers. If the
badge flips back to `expired` within minutes, Instagram rejected the cookie
again — take a fresh `sessionid` from a browser session that is still logged in.

### Auto-like is paced, not batched (2026-11-05)

Auto-like used to fire every new item in one automation pass: the story loop
liked **every** active story back-to-back, then posts and comment likes followed.
On 2026-11-05 18:32 the watcher made four `story_like` calls in seven seconds and
every one came back `LoginRequired` — the session was dead from the first write
onwards, which is the "invalid after one use" pattern.

`scripts/remy_watchers.py` now routes every automatic like through a `LikeGate`:

| Behaviour | Default | Env override |
|---|---|---|
| Likes per automation pass (all kinds combined) | **1** | `REMY_INSTAGRAM_MAX_LIKES_PER_PASS` |
| Minimum gap between likes across passes | **300 s** | `REMY_INSTAGRAM_LIKE_MIN_GAP_SECONDS` |
| Order | stories first (they expire), then posts/comments | — |
| On `LoginRequired` / `ChallengeRequired` / `SessionError` | halt the whole pass immediately; do not retry other items | — |
| While the connector state says the session is expired | no writes at all, and skipped items stay unseen for a later pass | — |

The automation pass runs every 900 s (`REMY_INSTAGRAM_AUTOMATION_INTERVAL_SECONDS`),
so the defaults allow roughly one like per 15 minutes. The watcher logs
`instagram auto-like pass used=N/M halted=… skipped=…` each pass and
`instagram writes disabled this pass: <reason>` when the session blocks writes.

Why this matters: a burst of likes is the strongest bot signal the watcher emits,
and Instagram's response (a block on writes) takes the whole session with it —
reads and DMs stop too. If a fresh session still dies on its first write, the
cookie is being rejected by Instagram itself (a web `sessionid` used with the
Android client fingerprint is the usual mismatch), not by our rate. In that case
re-authenticate with the password flow (`ig-mcp login`) rather than a browser
cookie.

**Paused 2026-11-05 18:47.** The batching fix was verified live: after a fresh
session was accepted at 18:44:44, a read succeeded at 18:45:04 and the watcher
made exactly **one** `story_like` at 18:45:08 — rejected `LoginRequired`, after
which reads died too. So the write itself invalidates this session kind; pacing
cannot fix it. All four auto-like switches are therefore **off** (the UI toggles
are off; `autoLike.*` false in `watcher:instagram:settings`) until a session that
accepts a write exists, so a pasted session survives for DM monitoring.

Re-authenticate with the password flow (creates a proper instagrapi session and
saves credentials for future `refresh`), then restart both servers and re-enable
the toggles:

```bash
# on the VPS; prompts for the password (and 2FA if asked)
docker exec -it mcp-gateway sh -c '
  cd /data/repos/instagram-mcp
  set -a; . /data/secrets/instagram.env; set +a
  export IG_CONFIG_DIR=/data/secrets/instagram
  ./.venv/bin/python -m instagram_mcp.cli login --username cra1gst'

# then restart the connector + watcher (or restart the containers)
curl -s -X POST -H "authorization: Bearer $MCP_MASTER_KEY" \
  http://127.0.0.1:8484/mcp/v1/admin/servers/srv_c1a176247cb544de/restart
curl -s -X POST -H "authorization: Bearer $MCP_MASTER_KEY" \
  http://127.0.0.1:8484/mcp/v1/admin/servers/srv_1aad56ae946a4ce2/restart
```

A sessionid exported from the **mobile app** (not a browser) is the other option;
it is bound to a device fingerprint Instagram will accept writes from.





### Automatic re-login (password + TOTP)

The console can re-authenticate Instagram by itself, so a dead session no
longer means pasting a browser cookie by hand.

- **Where the secrets live:** the account password and the 2FA **authenticator
  seed** are stored in the gateway vault (AES-256, `MCP_VAULT_SECRET`) as
  `INSTAGRAM_PASSWORD` and `INSTAGRAM_TOTP_SECRET`. They are never written to
  the Instagram data directory, never returned by the API (only
  `hasPassword` / `hasTotp` booleans) and never logged. The CLI's own
  `credentials.json` is deleted after each login.
- **Code generation:** `src/social/totp.ts` implements RFC 6238 (SHA-1, 6
  digits, 30 s) and is covered by the RFC test vectors. The code is generated
  in-process at login time and passed to the CLI with `--code`.
- **When it runs:** a 15-minute scheduler checks the connector state and only
  acts when the session is **not valid**. A working session is never touched.
- **How often:** `minIntervalHours` (default **12 h**, 1–168 in the UI) is a
  floor between attempts, so a dead session cannot cause a login loop. The
  clock resets when credentials are saved or the feature is switched on, so the
  first repair is not delayed. Set it to 24 for one login a day.
- **Controls:** the Configurations page has the enable checkbox, username,
  password, 2FA seed, the interval, **Save credentials** and **Test login
  now**. The test performs a real sign-in and replaces the current session; it
  is also the quickest way to confirm the password/seed pair.
- **Kill switch:** untick *Enable automatic re-login* and save. Nothing is
  deleted, so it can be re-enabled later.
- **Failure behaviour:** a failed attempt is recorded (`lastError`,
  `lastErrorAt`) and shown in the card; the next automatic attempt is held back
  by the same interval. Manual attempts and the scheduler cannot run at the same
  time.


### Why the password login needs connector patches

Automatic re-login is slow (~4–5 minutes) and historically failed at two
upstream points; both are fixed by `deploy/patches/instagram-mcp/apply.py`
(details in that folder's README):

1. **instagrapi 3.2.1 could not fetch the password-encryption keys** — its
   `qe/sync/` endpoint now returns a 404 HTML page, so `int(resp.headers[...])`
   raised `int() argument must be ... not 'NoneType'`. The venv runs
   **instagrapi 3.2.3**, which uses `launcher/sync/`.
2. **The TOTP was stale** — the CAA login flow makes ~10 requests and Instagram
   answers each in ~30 s through the UK proxy, so a code generated at spawn is
   long expired by the 2FA step. The connector now regenerates the code in
   `_login_with_bloks_two_factor` / `bloks_caa_resolve_two_step_verification`
   at submission time, from `IG_TOTP_SECRET` supplied by the gateway.

The login also sets `country_code=44` and `Europe/London` on the client so the
device fingerprint matches the account and the UK egress.

After a successful login the gateway runs the cheap live `status --verify`, so
the console flips to **Session valid** immediately, then restarts the Instagram
and watcher servers. The attempt is recorded and the 12 h floor applies to the
next automatic attempt.

Diagnostics: `/data/secrets/instagram/last-login.log` holds the request URLs of
the last login (no credentials). A full re-login takes ~4–5 minutes; the
gateway allows 10.


### Timing budgets (Instagram through the UK proxy)

Every Instagram request takes ~30 s through the pi5 SOCKS5 egress, so the
gateway needs generous budgets or it reports false failures:

| Path | Budget | Why |
|---|---|---|
| `MCP_TOOL_TIMEOUT_MS` (gateway env) | **180000** | a tool call is 1–3 requests; the 60 s default timed out on the first call after a restart |
| Live verify (`?verify=1`) | **180 s** | the CLI does a connect + `account_info` |
| Console **Refresh** request | **240 s** | same, with UI headroom |
| Password login (`ig-mcp login`) | **600 s** | the CAA flow makes ~10 requests |
| Console **Test login now** | **660 s** | same, with UI headroom |

A write (like) itself is one request and completes in ~30–60 s. Verified
2026-11-05: a story like from the watcher (`pass used=1/1`) and an
`ig_like_post` through the MCP tool both returned `liked: true` and the session
stayed **valid** (no new session needed).

### Post auto-like never fired: the poll asked for three (fixed 2026-11-10)

Symptom: story likes and comment likes worked, but **no post from `livecleo`
was ever auto-liked**, and nothing was logged to say why. The pass log sat at
`used=0/1 halted=None skipped=None` on every pass, so the gate was never even
consulted — the post path returned before it.

Cause, in `scripts/remy_watchers.py::_poll_account_posts`:

1. **A three-post poll is an empty poll.** Instagram's ranked
   `feed/user/<pk>/` endpoint answers **HTTP 200 with `items: []`** when the
   requested count is small for some accounts. Verified against the live
   session on 2026-11-10, same account, seconds apart:

   | `ig_user_posts("livecleo", amount=…)` | result |
   |---|---|
   | `3` | `count 0`, no posts (request: `count=3&ranked_content=true`) |
   | `4` | `count 4` |
   | `12` | `count 12` |

   The watcher asked for **3** every pass, got nothing, and treated "nothing"
   as "no new posts". That is why the failure was silent.
2. **Profile order is not chronological.** Three of `livecleo`'s posts are
   **pinned** (2024-02-02, 2023-08-21, 2023-08-17) and sit at the top of
   `user_medias`. Even a working three-item window would have been those three
   pinned posts, never the reel posted that morning.

Fix (deployed 2026-11-10, `remy_watchers.py`):

- the poll asks for `REMY_INSTAGRAM_POSTS_AMOUNT` (**default 12**, clamped to a
  minimum of 4 because below that Instagram serves an empty page);
- results are sorted by `taken_at`, not left in profile order;
- anything older than `REMY_INSTAGRAM_POST_MAX_AGE_DAYS` (**default 7**) is
  never a "new post" — this keeps a pinned 2023 reel from being liked, and
  avoids liking a stale backlog after a monitoring gap;
- an **empty** poll now logs
  `instagram posts poll returned 0 posts account=…`, and a page shorter than
  four (`page short account=…`) warns too — three pinned posts can fill a short
  page and hide a new one behind them. This class of blindness cannot be silent
  again;
- a throttled short page is not lossy: a post missed on one pass is still inside
  the age window on the next, and a fuller page picks it up;
- unseen posts are liked **oldest first**, so a burst of uploads drains in order
  and nothing starves behind the one-like-per-pass gate;
- `_cleo_comment_events` (comments on Cleo's posts) uses the same helper, so
  the "New comments on Cleo's posts" toggle is no longer looking at a blind
  three-post window either.

Supporting connector change (`deploy/patches/instagram-mcp/apply.py`, patch 4):
`formats.media_summary` now carries **`liked`** (`Media.has_liked`). Without it
the watcher cannot tell a post it has already liked (or one liked by hand in
the app) from an unseen one, and would spend its paced like budget re-liking
them. Any caller of `ig_user_posts` / `ig_post_info` now gets that field too.

State note: the three `ig:seen:post:*` keys in the watcher DB are only
`livecleotv`'s posts from the first baseline — proof that `livecleo` returned
its baseline nothing. When the fix was deployed, every recent `livecleo` post
was already liked (manually, in the app), so the first fixed pass **marks them
seen without writing a like**; only genuinely new posts are liked from then on.

Verification (offline, no network): `python3` harness covering pinned-post
exclusion, empty-poll warning, baseline marks seen, one-like-per-pass oldest
first, already-liked posts skipped, and stale backlog ignored — all pass.
