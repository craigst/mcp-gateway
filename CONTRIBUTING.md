# Contributing

Thanks for improving the MCP Gateway. This project is deliberately small in
dependencies: Node built-ins (`node:http`, `node:sqlite`, `node:crypto`,
`node:child_process`), React + Tailwind for the console, and Vitest for tests.

## Development setup

```bash
git clone https://github.com/craigst/mcp-gateway.git
cd mcp-gateway
npm ci
cp .env.example .env          # fill MCP_MASTER_KEY / MCP_VAULT_SECRET
npm run build:ui              # one-time, so the gateway can serve the console
npm run dev                   # tsx watch on src/index.ts
```

Open <http://localhost:8080>/mcp/v1/health to verify. The UI dev server is
`npm run ui:dev` (proxying `/mcp/v1` to the gateway).

## Quality gates

All PRs must pass the CI workflow:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Guidelines:

- **TypeScript strict** — no `any` in new public interfaces; prefer `unknown` + narrowing.
- **Imports use `.js` extensions** (NodeNext module resolution).
- **No new runtime dependencies** without discussion — prefer Node built-ins.
- **Every behaviour change needs a test**, ideally at unit level plus an integration
  assertion if it crosses module boundaries.
- **Never log secrets or full API keys.** Use `keyPrefix` for identification.
- **Security-sensitive changes** (RBAC, guardrails, vault, import engine) require a
  test that proves the denial path as well as the allow path.

## Architecture rules

- `src/core/ports.ts` defines the only cross-module contracts. Modules receive
  interfaces, never concrete peer classes; wiring lives in `src/container.ts`.
- All SQL lives in `*.store.ts` / repository modules; no SQL in route handlers.
- JSON-RPC errors use `GatewayError` + `ErrorCodes` — do not invent ad-hoc shapes.
- Structured logging via `createLogger(module)`.

## Commit style

Conventional commits, e.g.:

```
feat(catalog): censored tools/search with scope filtering
fix(vault): reject tampered GCM auth tags
test(delegation): cover depth cap of 3
docs: document mcp-manifest.json capabilities
```

## Reporting bugs / requesting features

Use GitHub Issues. For security vulnerabilities follow [`SECURITY.md`](./SECURITY.md).
