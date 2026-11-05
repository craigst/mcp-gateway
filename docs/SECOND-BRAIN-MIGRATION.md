# Second Brain migration — US VPS staging

Status: **data plane deployed and verified on the US VPS; old cleo stack is still the live producer; not yet cut over. Archive copy is still running.**

Last updated: 2026-11-05

## Why

The Second Brain (brain-api, Postgres, Qdrant, Tika, brainboard) lived on the
Odysseus laptop. A laptop shutdown took the memory, RAG and web UI with it.
The target host is the US VPS (`74.208.55.116`), alongside the MCP gateway.

## New stack on the VPS

Path: `/opt/brain`

| Piece | Container | Endpoint |
|---|---|---|
| Brain API | `brain-api` | `10.10.1.4:8642` → `8000` |
| Postgres 17 | `brain-postgres` | internal `postgres:5432` |
| Qdrant | `brain-qdrant` | internal `qdrant:6333`, local `127.0.0.1:6333` |
| Tika | `brain-tika` | internal `tika:9998` |
| Brainboard UI | host systemd `brainboard.service` | `127.0.0.1:8096` |

- Compose: `/opt/brain/compose/docker-compose.yml`
- Env: `/opt/brain/brain.env` (0600), `/opt/brain/db.env` (0600)
- API key: `/opt/brain/brain-api-key` (0600)
- Source: `/opt/brain/src` (copied from `/srv/brain/src`)
- Image: `brain-api:1.0.0` loaded from cleo
- Data: `/opt/brain/data`, `/opt/brain/secondbrain`, `/opt/brain/archive`
- Postgres data: `/opt/brain/postgres-data`
- Qdrant storage: `/opt/brain/qdrant-storage`
- Backups: `/opt/brain/backups` (`brain.sql`, Qdrant snapshots)

`brain.env` was adjusted to use `postgres`, `qdrant`, `tika` service names.
`OLLAMA_URL` still points at zeus (`10.10.254.13:11434`); this is intentional for
now and is a remaining cross-host dependency.

## Data moved and verified

- **Postgres `brain` DB** — `pg_dump` 244 MB, restored; table counts match cleo:
  - `documents` 50,444
  - `chunks` 150,918 (cleo 150,937 at snapshot time)
  - `assets` 142
  - `asset_history` 204
  - `events` 3,262 (cleo 3,261)
- **Qdrant** — `brain_docs` 149,820 points; `brain_memories` 475 points;
  `mem0migrations` restored. Per-collection snapshots were used.
- **`/srv/brain/data`** and **`/srv/brain/secondbrain`** copied.
- **`/srv/brain/archive`** — copy in progress (6.9 GB of ~11 GB at last check).
- **Brainboard** — `api/overview` reports 50,444 documents, 150,918 chunks,
  142 assets and 204 asset changes; health checks for Postgres, Qdrant and
  Ollama are green.
- **RAG** — `/knowledge/search` with `x-brain-allowed-categories: homelab`
  returned 8 live hits from the restored data.
- **Web UI** — `https://memory.evoonline.co.uk` published through the `vps`
  Cloudflare tunnel; Basic auth works (200 authenticated, 401 unauthenticated).
  Homepage tile added as **Brain Board**; Vault item URI updated.

## Not yet cut over

The old cleo stack remains running:

- `/srv/brain` on cleo still has the live `brain-api`, Postgres, Qdrant, Tika.
- The old `brain-mcp-http.service` still points at `http://10.10.254.91:8642`.
- The gateway `brain` server is still `remote-agent` on cleo.
- The archive copy is incomplete.
- Nothing writes to the new VPS brain yet except the new Brainboard reads.

**Do not stop the old stack until the cutover below is complete.**

## Remaining blocker: brain MCP identity

brain-mcp deliberately has no fallback identity. It reads
`MESSENGER_CRED_FILE` and then asks the AI Messenger hub for the caller's granted
categories. The hub is loopback-only on cleo (`127.0.0.1:7317`), so a brain MCP
running in the gateway cannot reach it.

Options, in preference order:

1. Migrate/relay the messenger hub to the VPS (or give it a scoped LAN/public
   endpoint with auth) and then run brain-mcp in the gateway.
2. Keep brain-mcp on cleo temporarily and point it at the new VPS brain API;
   this moves the data plane but not the MCP runtime.
3. Do not add a fallback identity; it would bypass the ACL boundary.

## Cutover checklist

1. Finish the archive copy and verify file count.
2. Verify Postgres/Qdrant counts again after the archive sync settles.
3. Stop writes to the old brain API (or switch brain-mcp's `BRAIN_URL` to the VPS).
4. Point brain-mcp at `http://10.10.1.4:8642`; restart it; test read-only
   (`brain_whoami`, `brain_search`, `knowledge_search`).
5. Decide the brain MCP runtime: gateway-local if the hub dependency is solved,
   otherwise keep it remote temporarily and document the remaining laptop link.
6. Stop old brain-api/Postgres/Qdrant/Tika only after a verified rollback window.
7. Keep `/opt/brain/backups` and the old `/srv` tree until the new host has run
   cleanly for at least a week.
