# update-repo fixture (v1)

A plain Node MCP server (no `mcp-manifest.json`) used by the v0.4 update tests.

Tests copy this directory into a temporary location, `git init` it, and install it
through the Git import engine. `v2/` contains the next version of the same server
(version bump + an extra `update_marker` tool) and `broken/` contains an
`mcp-manifest.json` with a failing build command.

`server.js` is a copy of `tests/fixtures/mcp-echo-server.mjs`.
