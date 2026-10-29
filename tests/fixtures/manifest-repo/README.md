# manifest-repo fixture

Minimal repository used by the Git import engine tests.

- `mcp-manifest.json` — manifest consumed by `src/git_engine/manifest.ts`
- `scripts/build.mjs` — successful build (writes `built.txt` at repo root)
- `scripts/fail.mjs` — failing build used to test rollback

Tests copy this directory into a temporary location and run `git init` themselves;
this fixture is intentionally **not** a git repository.
