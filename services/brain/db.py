"""PostgreSQL catalogue for document chunks, events, assets and import state."""

from __future__ import annotations

import json
import logging
import threading

#: One connection per thread — see conn() for why sharing one was a bug.
_local = threading.local()
from typing import Any

import psycopg
from psycopg.rows import dict_row

from settings import (
    BRAIN_PG_DB,
    BRAIN_PG_HOST,
    BRAIN_PG_PASSWORD,
    BRAIN_PG_PORT,
    BRAIN_PG_USER,
)

log = logging.getLogger("brain.db")


SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor       text,
    action      text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS events_at_idx ON events (at DESC);
CREATE INDEX IF NOT EXISTS events_actor_idx ON events (actor, at DESC);

CREATE TABLE IF NOT EXISTS documents (
    id           bigserial PRIMARY KEY,
    content_hash text NOT NULL UNIQUE,
    original_path text NOT NULL,
    derived_path text,
    filename     text NOT NULL,
    mime         text,
    bytes        bigint,
    ocr_applied  boolean NOT NULL DEFAULT false,
    source_kind  text NOT NULL DEFAULT 'inbox',
    -- The access boundary. Defaults to the most restrictive category on purpose:
    -- a document nobody classified must not be readable by everyone.
    category     text NOT NULL DEFAULT 'personal',
    embed_model  text,
    embed_dims   integer,
    page_count   integer,
    ingested_at  timestamptz NOT NULL DEFAULT now(),
    meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS chunks (
    id               bigserial PRIMARY KEY,
    document_id      bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal          integer NOT NULL,
    text             text NOT NULL,
    qdrant_point_id  text NOT NULL,
    chars            integer NOT NULL,
    UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks (document_id);
CREATE INDEX IF NOT EXISTS chunks_point_idx ON chunks (qdrant_point_id);

-- Idempotency and provenance for memories imported from another system.
CREATE TABLE IF NOT EXISTS external_memory_imports (
    source       text NOT NULL,
    external_id  text NOT NULL,
    point_id     text NOT NULL UNIQUE,
    actor        text NOT NULL,
    scope        text NOT NULL,
    signature    text NOT NULL,
    state        text NOT NULL DEFAULT 'pending',
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, external_id)
);
"""

# Added after the first documents were ingested, so existing tables need it too.
MIGRATIONS = """
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'personal';
-- Existing catalogues predate index state; new writes are marked pending until
-- every corresponding vector has been confirmed by Qdrant.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS index_state text NOT NULL DEFAULT 'ready';
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (category);

-- Page numbers, added after ~44k chunks existed. 0 means "not a paginated
-- document" (a note, an email), which is deliberately distinct from page 1.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS page integer NOT NULL DEFAULT 0;
"""

#: The ASSET REGISTER — structured, one answer per thing.
#:
#: Prose is the wrong shape for "what IP is archive-host" or "where does sample-project read its
#: env from": a document search returns passages that may be stale, several of them,
#: and no way to tell which is current. An asset is a single row with a single
#: value, an owner, a timestamp, and a HISTORY, so an agent can both answer the
#: question and see who last changed the answer.
#:
#: Keys are namespaced — `device/archive-host`, `ip/archive-host`, `path/sample-env`, `project/sample-project`
#: — which keeps them self-describing and globally unique.
ASSETS = """
CREATE TABLE IF NOT EXISTS assets (
    id          bigserial PRIMARY KEY,
    key         text NOT NULL UNIQUE,
    value       text NOT NULL,
    category    text NOT NULL DEFAULT 'personal',
    note        text,
    source      text,
    updated_by  text,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assets_category_idx ON assets (category);
CREATE INDEX IF NOT EXISTS assets_key_idx ON assets (key);

-- Every change, kept. "Who moved the database and when" is exactly the question
-- a shared register has to answer, and an overwritten row cannot.
CREATE TABLE IF NOT EXISTS asset_history (
    id         bigserial PRIMARY KEY,
    key        text NOT NULL,
    value      text,
    category   text,
    note       text,
    changed_by text,
    changed_at timestamptz NOT NULL DEFAULT now(),
    deleted    boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS asset_history_key_idx ON asset_history (key, changed_at DESC);
"""


def _connect() -> psycopg.Connection:
    return psycopg.connect(
        host=BRAIN_PG_HOST,
        port=BRAIN_PG_PORT,
        dbname=BRAIN_PG_DB,
        user=BRAIN_PG_USER,
        password=BRAIN_PG_PASSWORD,
        connect_timeout=8,
        row_factory=dict_row,
    )


def conn() -> psycopg.Connection:
    """A connection reused PER THREAD, reopened if the server went away.

    This was ONE SHARED connection until two bulk imports ran at the same time. A
    psycopg connection is not safe for concurrent use, so one thread committing
    while another was mid-statement tore the socket out from under it, and every
    call in the other request failed with psycopg's "the connection is closed" —
    which surfaced to the caller as a 502 from an apparently unrelated subsystem.

    Thread-local fixes the actual defect (unsafe sharing) rather than hiding it
    behind retries, and costs nothing: FastAPI serves sync endpoints on a bounded
    worker pool, so connections are bounded by that pool, and each is probed before
    reuse. A process-wide pool would be tidier, but it would mean a new dependency
    for behaviour that already works this way.
    """
    existing = getattr(_local, "conn", None)
    if existing is not None and not existing.closed:
        try:
            with existing.cursor() as cur:
                cur.execute("SELECT 1")
            return existing
        except Exception:
            try:
                existing.close()
            except Exception:
                pass
    fresh = _connect()
    _local.conn = fresh
    return fresh


def ensure_schema() -> None:
    with conn() as c:
        with c.cursor() as cur:
            cur.execute(SCHEMA)
            cur.execute(MIGRATIONS)
            cur.execute(ASSETS)
        c.commit()


def healthy() -> bool:
    try:
        with conn() as c, c.cursor() as cur:
            cur.execute("SELECT 1 AS ok")
            return cur.fetchone()["ok"] == 1
    except Exception as exc:  # noqa: BLE001 - surfaced as health, not raised
        log.warning("postgres unhealthy: %s", exc)
        return False


def record_event(actor: str | None, action: str, detail: dict[str, Any] | None = None) -> None:
    """Append to the audit trail. Never raises: an audit write must not break a
    memory call, but it must be visible in the log when it fails."""
    try:
        with conn() as c:
            with c.cursor() as cur:
                cur.execute(
                    "INSERT INTO events (actor, action, detail) VALUES (%s, %s, %s)",
                    (actor, action, json.dumps(detail or {}, default=str)),
                )
            c.commit()
    except Exception as exc:  # noqa: BLE001
        log.warning("could not record event %s: %s", action, exc)


def recent_events(limit: int = 50, actor: str | None = None) -> list[dict[str, Any]]:
    with conn() as c, c.cursor() as cur:
        if actor:
            cur.execute(
                "SELECT at, actor, action, detail FROM events WHERE actor = %s ORDER BY at DESC LIMIT %s",
                (actor, limit),
            )
        else:
            cur.execute("SELECT at, actor, action, detail FROM events ORDER BY at DESC LIMIT %s", (limit,))
        return cur.fetchall()
