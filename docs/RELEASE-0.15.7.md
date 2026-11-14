# Version 0.15.7

A light-theme legibility fix for CodeX's appearance switch.

## What was wrong

The console maps its slate palette onto light surfaces under `html.light`, but the
tonal fills were left alone: a status pill is `border-emerald-800
bg-emerald-950/70 text-emerald-300`, and while `emerald-300` was darkened for
light mode the `950`/`800` shades stayed near-black. Ten pills in a row — every
`running` badge on Overview, every `encrypted`/`attached` badge on Configurations
— rendered dark green text on a dark green fill, i.e. a solid blob with no
readable label. The `-400` text shades (`rose-400`, `emerald-400`, `indigo-400`)
had the same problem in reverse: pale text on a pale surface.

## What changed

`src/ui/styles.css` extends the `html.light` palette:

- `emerald|amber|rose|sky|indigo` `800/900/950` → pale fills, so tonal badges
  and panels read as light pills with the already-darkened 300-level text.
- `emerald-400`, `rose-400`, `indigo-300`, `indigo-400` → their dark
  light-theme equivalents.

Dark theme is untouched. No markup, API or data change: the console renders the
same pages, only the light palette is corrected.
