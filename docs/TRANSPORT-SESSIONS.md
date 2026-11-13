# Remote MCP transport sessions

The gateway talks to remote MCP servers over the MCP **Streamable HTTP** transport.
A remote host may terminate an idle transport session — `mcp-proxy`, for example,
drops one after 30 minutes — and then reject any request that still carries the old
`mcp-session-id` before it reaches the MCP server:

```
HTTP/1.1 404 Not Found
{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Session not found"}}
```

`HttpMcpClient` (`src/gateway/transport/http.ts`) treats that reply as an expired
session, not a tool failure:

1. It opens a fresh session with `initialize` and `notifications/initialized`.
2. It replays the rejected request exactly once.
3. Concurrent calls share one recovery handshake instead of opening a session each.
4. If the new session is rejected too, the call fails with `UPSTREAM_ERROR`
   (`reason: SESSION_EXPIRED`) instead of retrying in a loop.

Replay is safe for writes: the remote validates `mcp-session-id` before dispatching
the message, so the 404 proves the tool never ran and re-sending it cannot duplicate
a side effect. A 404 on a request that carried **no** session id is an ordinary
upstream error and is not retried.

## Scope

A transport session is not the same as an upstream account login. Re-initializing
the transport does not touch stored credentials, cookies or API keys used by the
remote MCP server, and an expired transport session does not mean those expired.

## Operational note

Where the remote is `mcp-proxy`, running it with `--sessionIdleTimeout 0` disables
the idle drop and avoids the extra round trip. That is a deployment change on the
proxy host, not a requirement for this client-side recovery.
