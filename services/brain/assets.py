"""The asset register: one current answer per thing, with its history.

WHY THIS IS NOT A DOCUMENT. A document search answers "what do we know about X" and
returns passages — several of them, of unknown age, with no statement of which is
current. The questions an agent actually asks about an estate are different:

    what IP is archive-host?
    where does sample-project read its env from?
    which host runs the databases?
    where is the Nextcloud data?

Those need ONE answer, attributable to someone, with a timestamp, that a later agent
can safely overwrite. So an asset is a row, not a passage:

    key        device/archive-host, ip/archive-host, path/sample-env, project/sample-project
    value      the answer
    category   the SAME access boundary documents use
    updated_by who last changed it
    history    every previous value, so "who moved it and when" is answerable

Assets are ALSO embedded into the document collection, so `knowledge_search` can
find one by meaning ("where is the database") and then read the current value from
the register rather than from a stale passage.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

import httpx

import db
from knowledge import DOCS_COLLECTION, _qdrant_request, _q, embed
from settings import QDRANT_TIMEOUT

#: Fixed namespace so the same key always produces the same Qdrant point id, which
#: means re-setting an asset REPLACES its vector instead of accumulating duplicates.
_ASSET_NS = uuid.UUID("6f1b4f9e-3a2c-4d5e-9b7a-1c2d3e4f5a6b")


def _point_id(key: str) -> str:
    return str(uuid.uuid5(_ASSET_NS, f"asset:{key}"))


def _text_for(key: str, value: str, note: str | None) -> str:
    """How an asset reads when found by search. The key is spelled out because a
    searcher may look for 'ip' or for 'archive-host' and this must match either."""
    kind, _, name = key.partition("/")
    words = {
        "ip": "IP address",
        "device": "device",
        "path": "file location",
        "folder": "folder location",
        "project": "project",
        "host": "host",
        "service": "service",
        "url": "URL",
        "port": "port",
        "note": "note",
    }.get(kind, kind)
    line = f"{words} {name}: {value}"
    if note:
        line += f" — {note}"
    return line


def _index(key: str, value: str, note: str | None, category: str, actor: str) -> None:
    """Embed the asset into the document collection so search can find it."""
    text = _text_for(key, value, note)
    vector = embed([text])[0]
    _qdrant_request(
        "PUT",
        f"/collections/{DOCS_COLLECTION}/points?wait=true",
        json_body={
            "points": [
                {
                    "id": _point_id(key),
                    "vector": vector,
                    "payload": {
                        "asset_key": key,
                        "original_path": f"asset://{key}",
                        "filename": key,
                        "category": category,
                        "text": text,
                        "source_kind": "asset-register",
                        "updated_by": actor,
                        "is_asset": True,
                    },
                }
            ]
        },
    )


def _unindex(key: str) -> None:
    _qdrant_request(
        "POST",
        f"/collections/{DOCS_COLLECTION}/points/delete?wait=true",
        json_body={"filter": {"must": [{"key": "asset_key", "match": {"value": key}}]}},
    )


def set_asset(
    key: str,
    value: str,
    category: str,
    actor: str,
    note: str | None = None,
    source: str | None = None,
) -> dict[str, Any]:
    """Create or update one asset, recording the previous value in history."""
    key = (key or "").strip()
    value = (value or "").strip()
    if not key:
        raise ValueError("an asset needs a key, e.g. ip/archive-host")
    if not value:
        raise ValueError("an asset needs a value")
    if "/" not in key:
        raise ValueError(
            "asset keys are namespaced as <kind>/<name> — e.g. ip/archive-host, device/pi5, "
            "path/sample-env, project/sample-project"
        )

    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT value, category FROM assets WHERE key = %s", (key,))
        row = cur.fetchone()
        created = row is None
        previous = row["value"] if row else None
        if row and row["value"] == value and row["category"] == category:
            return {
                "ok": True,
                "key": key,
                "value": value,
                "category": category,
                "created": False,
                "changed": False,
                "note": "already current — nothing written",
            }
        cur.execute(
            """INSERT INTO assets (key, value, category, note, source, updated_by, updated_at)
               VALUES (%s,%s,%s,%s,%s,%s, now())
               ON CONFLICT (key) DO UPDATE
                 SET value = EXCLUDED.value,
                     category = EXCLUDED.category,
                     note = COALESCE(EXCLUDED.note, assets.note),
                     source = COALESCE(EXCLUDED.source, assets.source),
                     updated_by = EXCLUDED.updated_by,
                     updated_at = now()""",
            (key, value, category, note, source, actor),
        )
        cur.execute(
            """INSERT INTO asset_history (key, value, category, note, changed_by)
               VALUES (%s,%s,%s,%s,%s)""",
            (key, value, category, note, actor),
        )
        c.commit()

    # The vector is a convenience copy, so a failure here must not undo the write:
    # the register is the truth and search can be re-indexed from it.
    try:
        _index(key, value, note, category, actor)
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": True,
            "key": key,
            "value": value,
            "category": category,
            "created": created,
            "changed": True,
            "previous": previous,
            "warning": f"stored, but not searchable yet: {exc}",
        }

    return {
        "ok": True,
        "key": key,
        "value": value,
        "category": category,
        "created": created,
        "changed": True,
        "previous": previous,
    }


def get_asset(key: str, allowed: list[str]) -> dict[str, Any]:
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            "SELECT key, value, category, note, source, updated_by, updated_at, created_at"
            " FROM assets WHERE key = %s",
            (key,),
        )
        row = cur.fetchone()
        if not row:
            raise ValueError(f"no asset with key '{key}'")
        if row["category"] not in allowed:
            raise PermissionError(
                f"asset '{key}' is in category '{row['category']}', which you may not read"
            )
        cur.execute(
            "SELECT value, changed_by, changed_at FROM asset_history"
            " WHERE key = %s ORDER BY changed_at DESC LIMIT 6",
            (key,),
        )
        history = cur.fetchall()
    return {
        "ok": True,
        "asset": {
            **{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in row.items()},
        },
        "recent_changes": [
            {**{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in h.items()}}
            for h in history
        ],
    }


def list_assets(allowed: list[str], prefix: str | None = None) -> dict[str, Any]:
    with db.conn() as c, c.cursor() as cur:
        if prefix:
            cur.execute(
                "SELECT key, value, category, note, updated_by, updated_at FROM assets"
                " WHERE key LIKE %s AND category = ANY(%s) ORDER BY key",
                (f"{prefix}%", allowed),
            )
        else:
            cur.execute(
                "SELECT key, value, category, note, updated_by, updated_at FROM assets"
                " WHERE category = ANY(%s) ORDER BY key",
                (allowed,),
            )
        rows = cur.fetchall()
    return {
        "ok": True,
        "count": len(rows),
        "categories_searched": sorted(allowed),
        "assets": [
            {**{k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in r.items()}}
            for r in rows
        ],
    }


def delete_asset(key: str, allowed: list[str], actor: str) -> dict[str, Any]:
    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT category FROM assets WHERE key = %s", (key,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"no asset with key '{key}'")
        if row["category"] not in allowed:
            raise PermissionError(
                f"asset '{key}' is in category '{row['category']}', which you may not read"
            )
        cur.execute("DELETE FROM assets WHERE key = %s", (key,))
        cur.execute(
            "INSERT INTO asset_history (key, changed_by, deleted) VALUES (%s,%s,true)",
            (key, actor),
        )
        c.commit()
    try:
        _unindex(key)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "key": key, "deleted": True}


def as_search_results(allowed: list[str], query: str, top_k: int = 5) -> list[dict[str, Any]]:
    """Assets matching a query, so a caller gets the CURRENT value alongside passages.

    Documents can be months old and there may be several of them; the register is
    the current answer. Returning it first is the difference between an agent
    quoting a stale note and an agent quoting the estate.
    """
    words = [w for w in query.lower().split() if len(w) > 2]
    if not words:
        return []
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """SELECT key, value, category, note, updated_by, updated_at
                 FROM assets
                WHERE category = ANY(%s)
                  AND (key ILIKE ANY(%s) OR value ILIKE ANY(%s) OR COALESCE(note,'') ILIKE ANY(%s))
                ORDER BY key
                LIMIT %s""",
            (allowed, [f"%{w}%" for w in words], [f"%{w}%" for w in words],
             [f"%{w}%" for w in words], top_k),
        )
        rows = cur.fetchall()
    return [
        {
            "key": r["key"],
            "value": r["value"],
            "category": r["category"],
            "note": r["note"],
            "updated_by": r["updated_by"],
            "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
        }
        for r in rows
    ]
