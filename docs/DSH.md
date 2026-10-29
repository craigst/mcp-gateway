# Connect the gateway to the DeepSeek Harness (DSH)

The gateway exposes the same MCP JSON-RPC protocol on `POST /mcp/v1` (Streamable HTTP),
authenticated with an API key. DSH's official `@deepseek-ai/dsh-mcp-client` plugin can point
straight at it, so every catalogued tool becomes available inside the harness as
`mcp__gateway__<toolName>`.

## 1. Get an API key

- Open the gateway console → **RBAC → Master control key → Regenerate master key**, or
- create a key from the API:

```bash
curl -s localhost:8080/mcp/v1/admin/keys/create \
  -H "Authorization: Bearer $MASTER_KEY" -H 'content-type: application/json' \
  -d '{"name":"dsh-harness","keyType":"master"}'
```

The response contains `plaintext` **once**. A least-privilege alternative is an `agent` key
scoped to the servers/tools you want DSH to reach.

## 2. Add an MCP client row to your DSH profile

Edit `~/.dsh/profiles/<profile>/cordis.patch.yml` (create it with `[]` if absent) and add:

```yaml
- insert:
    - id: mcp-gateway
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: gateway
        transport: streamable-http
        url: http://127.0.0.1:8080/mcp/v1
        headers:
          Authorization: "Bearer mcp_master_REPLACE_ME"
        toolCallTimeoutMs: 120000
        failOnStartupError: false
```

Notes:

- The patch file is a top-level YAML array; keep existing entries and append the `- insert:`
  block (`insert` adds new plugin rows).
- **Restart DSH** after editing — MCP rows are read when the profile loads (unlike bundle
  edits, which hot-reload). Back up the patch file first.
- The harness will expose the tools as `mcp__gateway__<tool>`, e.g.
  `mcp__gateway__brain_search` or `mcp__gateway__vault_status`.
- If you rotate the master key, update the header and restart DSH.
- Treat the key as a secret: the profile file should be `chmod 600`, and do not commit it.

## 3. Verify

```bash
curl -s localhost:8080/mcp/v1/health
```

Then in DSH ask it to list/use a tool; the MCP client logs (`dsh` console) show
`mcp-client(gateway)` connect and tool discovery. A successful discovery registers every
tool the key may see — with a master key that is the whole catalog, censored for any scoped
key.

## Troubleshooting

| Symptom | Check |
|---|---|
| No tools appear | Restart DSH after editing the patch; check the YAML parses and ids are unique. |
| `401 Unauthorized` | The bearer key was revoked/rotated; regenerate and update the row. |
| Connection refused | Service not running: `systemctl --user status mcp-gateway`, `curl localhost:8080/mcp/v1/health`. |
| Tools listed but calls fail | The sub-server may be stopped — start it in **Catalog → Installed**, then retry. |
| Approval-required tools return `-32004` | Approve the pending ticket in **Vault Warden** (or the Delegation page), then retry with the ticket (`_meta.escalation_ticket`). |
