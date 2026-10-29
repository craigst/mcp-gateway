# node-repo fixture

A plain Node MCP server (no `mcp-manifest.json`). Tests copy this directory into a
temporary location and run `git init` themselves; this fixture is intentionally
**not** a git repository.

`server.js` is a copy of `tests/fixtures/mcp-echo-server.mjs` and exposes five tools.
