# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately via
GitHub Security Advisories: <https://github.com/craigst/mcp-gateway/security/advisories/new>

Include reproduction steps, affected endpoint, and impact. You can expect an initial
response within 72 hours and a coordinated disclosure timeline within 90 days.

## Threat model & controls

### Assets
- API keys (agent / dev / sub / supervisor / master).
- Vault secrets (third-party tokens, DB connection strings).
- Tool execution capability, including high-privilege operations.
- Audit records and delegation lineage.

### Trust boundaries
1. **Agent → gateway ingress** (`/mcp/v1`): untrusted; every request authenticated and authorized.
2. **Gateway → sub-server**: semi-trusted child process; sandboxed by container + unprivileged user.
3. **Gateway → remote agent harness**: untrusted network peer; outbound allowlist, timeouts.
4. **Gateway → GitHub (import engine)**: supply-chain boundary; URL allowlist, shell-free builds.

### Controls

| Threat | Control |
|---|---|
| Key theft / replay | High-entropy keys, SHA-256 storage, optional pepper, expiry, instant revocation, last-used tracking. |
| Tool enumeration / probing | Censored catalog before serialization; identical `Tool Not Found` for invisible tools. |
| Privilege escalation via high-risk tools | `HIGH_PRIVILEGE` flag, default hidden, explicit per-tool grants only. |
| Prompt-injected destructive arguments | Regex + JSON-Schema argument guardrails enforced gateway-side. |
| Secret exfiltration | AES-256-GCM at rest, scrypt KDF, secrets only injected into the granted child process, never returned by APIs or logs. |
| Delegation recursion / loops | Hard depth cap (default 3) via `X-MCP-Delegation-Depth`, structured `-32003`, parent-child audit rows. |
| Supply-chain code execution via import | Clone URL allowlist, shell-free build/start, 180 s timeout, isolated workspace. |
| Oversized/fuzzed payloads | 1 MiB body cap, batch cap of 20, strict JSON-RPC validation. |
| Audit tampering | Append-only SQLite log written by the gateway; export/backup recommended. |

### Secure deployment checklist
- [ ] Set a strong, unique `MCP_MASTER_KEY` and `MCP_VAULT_SECRET` (never commit them).
- [ ] Put the gateway behind TLS (reverse proxy) — it speaks plain HTTP by default.
- [ ] Keep `MCP_GIT_IMPORT_ALLOWED_PREFIXES` as narrow as possible; disable when unused.
- [ ] Run the provided container (unprivileged `node` user) rather than root.
- [ ] Back up `data/` (SQLite DB) and protect it at rest.
- [ ] Rotate vault secrets and revoke stale keys regularly; review the audit explorer.
- [ ] Treat `mcp_master_*` keys as root credentials — never hand them to autonomous agents.
