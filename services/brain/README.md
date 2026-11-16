# Managed brain staging

This service is a migration target, not an automatic cutover. Existing brain
adapters continue using their current backend until their endpoints are changed.
A staged database and vector snapshot taken at different times is not a
consistent final migration if the source is still accepting writes.

The compose stack defaults to read-only mode. Its PostgreSQL and Qdrant ports
are private to its internal network; the brain service also joins the gateway
network. Provide `BRAIN_HOME`, `BRAIN_PG_PASSWORD`, `BRAIN_API_KEY` and
`BRAIN_OLLAMA_URL` in a private environment file, with the same embedding model
and dimensions as the source. `BRAIN_HOME` must be a new private directory with
enough free space for restored snapshots, archived documents and backups.
Restore all collections, the PostgreSQL catalogue, document trees and Mem0
history; document paths must resolve to the same locations in the container.
The source's original data remains authoritative until cutover.

Configure the gateway's `MCP_KNOWLEDGE_URL` to the brain service and place its
backend key in the gateway vault as `BUILTIN_BRAIN_API_KEY` (or, if vault is
unavailable, use the private `MCP_KNOWLEDGE_API_KEY` environment variable).
The master-only Knowledge screen can then upload a document with a category
selected from the service. Uploads are refused while `BRAIN_READ_ONLY=1`.
Trusted MCP adapters can also use `brain_import_memories`: each source and
external ID uniquely identifies one item. Retrying the same import is safe;
changing an already imported item under the same ID is rejected. Preserve source
references and scope when importing. This import is separate from restoring an
existing Mem0/Qdrant snapshot and is intended for other memory systems.

Before enabling writes or changing adapters, obtain an application-consistent
final snapshot while every writer to the source is paused, and verify every
snapshot and file transfer. Run `migration/audit.py` against the restored copy,
check all collections and Mem0 history, compare representative searches and
permissions, and verify files and citations. The audit's `index_consistent`
result covers only catalogue/vector correspondence; it is not cutover approval.
`migration/reconcile.py` is dry-run by default and requires matching markers on
both a disposable staging database and vector store before it will modify them.
Do not point it at the live source. Review any recovered legacy vectors and
unresolved inconsistencies before proceeding.

At cutover, preserve the original adapter identities, grants and tool names,
verify each bot's actual searches and writes, and keep the source and its backups
available for rollback. The adapter identity is configured per server process;
it is not an automatically isolated per-gateway-key identity. A rollback after
new writes must preserve those writes and reconcile them before changing back;
simply switching endpoints back would lose access to new data.

For a marked staging target, `migration/sync_incremental.py` reports source-only
vectors and can copy them with `--apply`; it never overwrites or deletes an
existing point. It refuses to apply diverged memory collections. Document
comparison checks IDs only because the staging repair may legitimately add or
change catalogue metadata. Run reconciliation and audit afterwards. Repeated
incremental syncs reduce drift but do not replace a final coordinated snapshot:
concurrent updates, deletions and changes to PostgreSQL or files still require
independent checks.
