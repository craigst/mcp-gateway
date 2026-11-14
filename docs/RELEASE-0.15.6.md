# Version 0.15.6

0.15.5 put CodeX's console refresh live. 0.15.6 is the follow-up that fixes what
that deployment exposed: the YouTube and X watcher support had only ever existed
as **hand patches copied into the running container**, so the new image served a
console with no YouTube or X settings and left a 0.15.4-era bundle unused in
`/app/ui/dist/assets/`.

## Why this release exists

`ensure-patches.sh` on the VPS copies two files into the container after every
recreate:

- `service.js.with-x` → `youtube` and `x` added to the watcher `SOURCES`
- `ui.patched.js` → a **compiled 0.15.4 UI bundle** with the YouTube/X tabs

That works only while the asset filename is unchanged. 0.15.5 renamed the bundle
(`index-DDgyg_Gk.js` → `index-DHQHCZag.js`), so the backend patch re-applied and
the UI patch silently stopped being served. The features were live in the API
and invisible in the console — the worst combination.

## What moved into the source

- `WatcherSource` is now `whatsapp | instagram | youtube | x`, and
  `parseWatcherSource` accepts all four.
- Per-source auto-like defaults: `DEFAULT_AUTO_LIKE_YOUTUBE` (`videos`,
  `shorts`, `comments`, `replies`, `mentions`; account `livecleo`) and
  `DEFAULT_AUTO_LIKE_X` (`posts`, `replies`, `quotes`, `mentions`; account
  `LiveCleoPatra`, mentions-only by default). `normalizeAutoLike` validates and
  returns the shape for its own source only, so X classes can never be written
  onto an Instagram row.
- `WatcherAutoLike` is one documented superset with optional per-source classes
  rather than a single Instagram shape.
- Console: YouTube and X cards in **Configurations → Push to Remy**, with quick
  links, a per-class auto-like block and the watched-handle input. The Instagram
  card is unchanged.

## Upgrade notes

Image swap only; `data/`, `gateway.env`, `certs/` and the compose network are
untouched. Existing `watcher:*:settings` rows for YouTube and X (written by the
old patch) are read by the same normaliser, so saved values are preserved.

After this release the hand patches are redundant. Disable
`mcp-gateway-patches.timer` on the VPS once 0.15.6 is healthy: with the classes
in the source, the patch marker matches, but leaving a timer that can re-copy a
0.15.4-era bundle into a future image is a landmine.
