# umbrella fixture

Generic umbrella catalog repository used by the plugin-catalog tests.

- `.gitmodules` — submodule path → repository URL mapping
- `pinned.json` — pinned `mcp[]` and `bundles[]` metadata
- `servers/*` — vendored (non-git) copies of submodule content so the provider's
  probe helper can be exercised without network access

Tests copy this directory into a temporary location and run `git init` themselves;
this fixture is intentionally **not** a git repository. All URLs use the reserved
`github.com/example/...` namespace.
