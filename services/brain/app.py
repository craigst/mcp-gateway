"""HTTP service for managed memory and document knowledge.

Trusted MCP adapters enforce their configured local grants before calling this
service. Actor and category headers are assertions by those trusted adapters,
not independent per-caller authentication by this backend.
"""

from __future__ import annotations

import hmac
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

import db
import assets as assets_mod
import knowledge as know
import memory as mem
import memory_import
from settings import (
    BRAIN_API_KEY,
    DOCS_COLLECTION,
    MEM0_COLLECTION,
    MEM0_EMBED_DIMS,
    MEM0_EMBED_MODEL,
    MEM0_LLM_MODEL,
    OLLAMA_URL,
    UPLOAD_DIR,
    MAX_INGEST_BYTES,
    QDRANT_HOST,
    QDRANT_PORT,
    VERSION,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
log = logging.getLogger("brain.api")

app = FastAPI(
    title="Second Brain API",
    version=VERSION,
    description=(
        "Shared long-term memory and document knowledge for the homelab's agents.\n\n"
        "Trusted MCP adapters enforce their configured grants; this backend is not "
        "directly exposed to agents."
    ),
)


@app.middleware("http")
async def staging_read_only(request: Request, call_next):
    """Keep a migration target from accepting writes before cutover."""
    readonly = os.environ.get("BRAIN_READ_ONLY", "").lower() in ("1", "true", "yes")
    safe_posts = {"/memory/search", "/memory/get_all", "/knowledge/search"}
    if readonly and request.method.upper() not in ("GET", "HEAD", "OPTIONS") and request.url.path not in safe_posts:
        return JSONResponse({"detail": "migration target is read-only"}, status_code=503)
    return await call_next(request)


# ── identity ────────────────────────────────────────────────────────────────
def require_key(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="bearer token required")
    presented = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(presented, BRAIN_API_KEY):
        raise HTTPException(status_code=401, detail="bad brain key")


def actor_of(x_brain_actor: str | None) -> str:
    """The caller's claimed identity. Trimmed and length-capped so one agent
    cannot write another's name plus a novel into the audit trail."""
    if not x_brain_actor:
        return "unknown"
    return x_brain_actor.strip()[:96] or "unknown"


def allowed_categories(header: str | None) -> list[str]:
    """The categories THIS CALLER may search, as asserted by brain-mcp.

    The value is derived there from the server's configured grant and passed on
    a header, the same trust shape as `X-Brain-Actor`: brain-api believes the MCP
    layer, and the MCP layer does not take this from the agent. That matters —
    if the agent could supply it, it would simply name every category.

    Absent or empty is a REFUSAL, not "everything": a caller that does not say what
    it may see must not be shown the archive.
    """
    if not header:
        raise HTTPException(
            status_code=403,
            detail=(
                "no allowed categories were asserted for this call. brain-mcp supplies them "
                "from the server's configured grant; without it nothing is readable."
            ),
        )
    known = know.CATEGORIES
    wanted = [c.strip() for c in header.split(",") if c.strip()]
    unknown = [c for c in wanted if known and c not in known]
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown categories: {', '.join(unknown)}")
    if not wanted:
        raise HTTPException(status_code=403, detail="no allowed categories were asserted for this call")
    return wanted


def assert_scope_access(scope: str, actor: str) -> None:
    """Private agent namespaces are accessible only to their configured owner."""
    if scope.lower().startswith("agents/") and (actor == "unknown" or scope != f"agents/{actor}"):
        raise HTTPException(status_code=403, detail="private memory scope belongs to another agent")


def assert_memory_access(memory_id: str, actor: str) -> None:
    # The memory API accepts IDs from agents, so validate and inspect the stored
    # scope before changing or deleting a record. Never infer it from the caller.
    try:
        point_id: str | int = int(memory_id) if memory_id.isdecimal() else str(uuid.UUID(memory_id))
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="invalid memory identifier") from exc
    try:
        response = know._qdrant_request("POST", f"/collections/{MEM0_COLLECTION}/points",
                                        json_body={"ids": [point_id], "with_payload": ["user_id"], "with_vector": False})
        points = response.json().get("result") or []
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="could not verify memory access") from exc
    if not points:
        raise HTTPException(status_code=404, detail="memory not found")
    scope = (points[0].get("payload") or {}).get("user_id")
    if not isinstance(scope, str) or not scope:
        raise HTTPException(status_code=403, detail="memory has no verifiable scope")
    assert_scope_access(scope, actor)


def _client_error(exc: Exception) -> HTTPException:
    detail = str(exc)
    status = 404 if "not found" in detail.lower() else 400
    return HTTPException(status_code=status, detail=detail)


# ── models ──────────────────────────────────────────────────────────────────
class SearchBody(BaseModel):
    query: str = Field(..., min_length=1, description="What to look for.")
    scope: str = Field("shared", description="shared | homelab | media | work | vehicles | agents/<id>")
    top_k: int = Field(8, ge=1, le=50)
    threshold: float | None = Field(None, ge=0.0, le=1.0)
    include_agent_private: bool = Field(
        False, description="Also search this agent's private `agents/<id>` scope."
    )


class RememberBody(BaseModel):
    text: str = Field(..., min_length=1, description="The fact, preference, decision or event.")
    scope: str = Field("shared")
    source_ref: str | None = Field(
        None,
        description="Where this came from (a path, a URL, a message id). Provenance is not optional "
        "in spirit: an unprovable fact cannot be audited.",
    )
    metadata: dict[str, Any] | None = None
    ttl_days: int | None = Field(None, ge=1, le=3650, description="Expire the memory after N days.")
    infer: bool = Field(True, description="Let Mem0 extract atomic facts rather than storing the blob.")


class MemoryImportItem(BaseModel):
    external_id: str = Field(..., min_length=1, max_length=256)
    text: str = Field(..., min_length=1, max_length=65536)
    scope: str = Field("shared", min_length=1, max_length=128)
    source_ref: str | None = Field(None, max_length=2048)
    created_at: str | None = Field(None, max_length=64)
    metadata: dict[str, Any] = Field(default_factory=dict)


class MemoryImportBody(BaseModel):
    source: str = Field(..., min_length=1, max_length=100)
    items: list[MemoryImportItem] = Field(..., min_length=1, max_length=100)


class UpdateBody(BaseModel):
    memory_id: str
    text: str | None = None
    metadata: dict[str, Any] | None = None


class ForgetBody(BaseModel):
    memory_id: str | None = None
    scope: str | None = Field(None, description="Delete every memory in this scope. Admin action.")


class KnowledgeSearchBody(BaseModel):
    query: str = Field(..., min_length=1)
    path_prefix: str | None = Field(None, description="Restrict to originals whose stored path starts with this.")
    top_k: int = Field(8, ge=1, le=30)


class KnowledgeIngestBody(BaseModel):
    path: str = Field(..., min_length=1, description="A path inside the document share, e.g. inbox/letter.pdf.")
    source_kind: str = Field("inbox")
    category: str = Field(
        "personal",
        description="Which category this document belongs to. Defaults to the most restrictive one.",
    )
    force: bool = Field(
        False,
        description=(
            "Re-index even if these exact bytes are already stored. Use when the extraction has "
            "improved — for example to give existing PDFs their page numbers."
        ),
    )
    keep_original: bool = Field(
        True,
        description=(
            "Copy the file into the brain's own originals store (the default, right for a drop-box). "
            "Set false for a file already living in a backed-up archive, so it is cited in place instead "
            "of duplicated."
        ),
    )


class IngestTextItem(BaseModel):
    path: str = Field(..., min_length=1, description="Where the text came from, for the citation.")
    text: str = Field(..., description="The already-extracted text. This route does no OCR or Tika.")
    page: int = Field(
        0,
        ge=0,
        description=(
            "Which page this text came from, so a citation can name it. 0 means 'not a paginated "
            "document' — a note or an email — and is deliberately not the same as page 1."
        ),
    )
    category: str = Field("personal")
    filename: str | None = None
    mime: str | None = None
    source_kind: str = Field("archive")
    metadata: dict[str, Any] | None = None


class IngestTextBatchBody(BaseModel):
    items: list[IngestTextItem] = Field(..., min_length=1, max_length=2000)


class AssetSetBody(BaseModel):
    key: str = Field(..., min_length=3, description="Namespaced, e.g. ip/archive-host, device/pi5, path/sample-env, project/sample-project")
    value: str = Field(..., min_length=1, description="The current answer.")
    category: str = Field("personal", description="The access boundary this fact belongs to.")
    note: str | None = None
    source: str | None = None


class KnowledgeForgetBody(BaseModel):
    document_id: int = Field(..., ge=1)


class KnowledgeRetryBody(BaseModel):
    document_id: int = Field(..., ge=1)


# ── health and inspection ───────────────────────────────────────────────────
def _probe(url: str, timeout: float = 4.0) -> dict[str, Any]:
    try:
        response = httpx.get(url, timeout=timeout)
        return {"ok": response.status_code == 200, "status": response.status_code}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def _qdrant_collections() -> dict[str, Any]:
    try:
        response = httpx.get(f"http://{QDRANT_HOST}:{QDRANT_PORT}/collections", timeout=6.0)
        response.raise_for_status()
        names = [c["name"] for c in response.json()["result"]["collections"]]
        return {"ok": True, "collections": names}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@app.get("/livez", include_in_schema=False)
def livez() -> dict[str, Any]:
    """Liveness only — the container is up and the process answers.

    Deliberately separate from /healthz: a container whose Ollama is rebooting
    must NOT be marked unhealthy and recycled, because that would take down the
    half that still works (the catalogue, and search on existing vectors).
    """
    return {"ok": True, "version": VERSION}


@app.get("/healthz", include_in_schema=False)
def healthz() -> JSONResponse:
    qdrant = _qdrant_collections()
    # /api/version, NOT /api/tags: listing 21 models is the expensive call and it
    # was the one that timed out cold from a container while every model was fine.
    # A health check should cost nothing.
    ollama = _probe(f"{OLLAMA_URL}/api/version", timeout=8.0)
    postgres = {"ok": db.healthy()}
    ok = bool(qdrant.get("ok") and ollama.get("ok") and postgres["ok"])
    body = {
        "ok": ok,
        "version": VERSION,
        "mem0": {"llm": MEM0_LLM_MODEL, "embedder": MEM0_EMBED_MODEL, "dims": MEM0_EMBED_DIMS},
        "collections": {"memories": MEM0_COLLECTION, "documents": DOCS_COLLECTION},
        "categories": len(know.CATEGORIES),
        "qdrant": qdrant,
        "ollama": ollama,
        "postgres": postgres,
    }
    return JSONResponse(body, status_code=200 if ok else 503)


@app.get("/categories", dependencies=[Depends(require_key)])
def list_categories() -> dict[str, Any]:
    """The category vocabulary and which of them are sensitive.

    `sensitive` is the part that matters to a caller: it says which categories a
    grant must name explicitly rather than being covered by plain `knowledge`.
    """
    cats = know.CATEGORIES
    return {
        "ok": True,
        "categories": [{"name": name, "sensitive": bool(flag)} for name, flag in cats.items()],
        "public": [name for name, flag in cats.items() if not flag],
        "sensitive": [name for name, flag in cats.items() if flag],
    }


@app.get("/stats", dependencies=[Depends(require_key)])
def stats(limit: int = 20) -> dict[str, Any]:
    out: dict[str, Any] = {"version": VERSION, "scope_counts": {}, "recent_events": []}
    try:
        with db.conn() as c, c.cursor() as cur:
            cur.execute("SELECT count(*) AS n FROM events")
            out["event_count"] = cur.fetchone()["n"]
            cur.execute("SELECT count(*) AS n FROM documents")
            out["document_count"] = cur.fetchone()["n"]
            cur.execute("SELECT count(*) AS n FROM chunks")
            out["chunk_count"] = cur.fetchone()["n"]
    except Exception as exc:  # noqa: BLE001
        out["postgres_error"] = str(exc)
    try:
        response = httpx.get(
            f"http://{QDRANT_HOST}:{QDRANT_PORT}/collections/{MEM0_COLLECTION}", timeout=6.0
        )
        out["memory_points"] = response.json().get("result", {}).get("points_count")
    except Exception as exc:  # noqa: BLE001
        out["mem0_collection_error"] = str(exc)
    try:
        out["recent_events"] = [
            {"at": str(r["at"]), "actor": r["actor"], "action": r["action"]}
            for r in db.recent_events(limit=limit)
        ]
    except Exception as exc:  # noqa: BLE001
        out["events_error"] = str(exc)
    return out


@app.get("/events", dependencies=[Depends(require_key)])
def events(limit: int = 50, actor: str | None = None) -> dict[str, Any]:
    return {"ok": True, "events": db.recent_events(limit=min(limit, 500), actor=actor)}


# ── memory ──────────────────────────────────────────────────────────────────
@app.post("/memory/search", dependencies=[Depends(require_key)])
def memory_search(body: SearchBody, x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    assert_scope_access(body.scope, actor)
    try:
        result = mem.search(
            body.query,
            scope=body.scope,
            agent_id=actor,
            top_k=body.top_k,
            threshold=body.threshold,
            include_agent_private=body.include_agent_private,
        )
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "memory.search.error", {"query": body.query, "scope": body.scope, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"memory backend: {exc}") from exc
    results = result.get("results") if isinstance(result, dict) else result
    db.record_event(actor, "memory.search", {"query": body.query, "scope": body.scope, "hits": len(results or [])})
    return {"ok": True, "scope": body.scope, "count": len(results or []), "results": results or []}


@app.post("/memory/add", dependencies=[Depends(require_key)])
def memory_add(body: RememberBody, x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    assert_scope_access(body.scope, actor)
    try:
        result = mem.add(
            body.text,
            scope=body.scope,
            agent_id=actor,
            source_ref=body.source_ref,
            metadata=body.metadata,
            infer=body.infer,
            ttl_days=body.ttl_days,
        )
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "memory.add.error", {"scope": body.scope, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"memory backend: {exc}") from exc
    results = result.get("results") if isinstance(result, dict) else None
    db.record_event(
        actor,
        "memory.add",
        {"scope": body.scope, "source_ref": body.source_ref, "created": len(results or [])},
    )
    return {"ok": True, "scope": body.scope, "created": len(results or []), "results": results or []}


@app.post("/memory/import", dependencies=[Depends(require_key)])
def memory_import_batch(body: MemoryImportBody, x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    """Import verbatim records with stable external identifiers; retries are safe."""
    actor = actor_of(x_brain_actor)
    if actor == 'unknown':
        raise HTTPException(status_code=403, detail='an authenticated agent identity is required')
    source = body.source.strip()
    if not source or any(ord(char) < 32 or ord(char) == 127 for char in source):
        raise HTTPException(status_code=400, detail="invalid source name")
    items = [item.model_dump() for item in body.items]
    if len({item['external_id'] for item in items}) != len(items):
        raise HTTPException(status_code=400, detail="external identifiers must be unique in a batch")
    try:
        for item in items:
            memory_import.validate_item(item, actor)
        results = [memory_import.import_one(source, item, actor) for item in items]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.error("memory import failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="memory import failed; retry the same batch") from exc
    db.record_event(actor, "memory.import", {"source": source, "count": len(results), "created": sum(not row['skipped'] for row in results)})
    return {"ok": True, "results": results}


@app.post("/memory/update", dependencies=[Depends(require_key)])
def memory_update(body: UpdateBody, x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    assert_memory_access(body.memory_id, actor)
    try:
        result = mem.update(body.memory_id, text=body.text, metadata=body.metadata)
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "memory.update.error", {"memory_id": body.memory_id, "error": str(exc)})
        raise _client_error(exc) from exc
    db.record_event(actor, "memory.update", {"memory_id": body.memory_id})
    return {"ok": True, "result": result}


@app.post("/memory/forget", dependencies=[Depends(require_key)])
def memory_forget(body: ForgetBody, x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    if not body.memory_id and not body.scope:
        raise HTTPException(status_code=400, detail="pass memory_id, or scope to wipe a whole namespace")
    if body.memory_id:
        assert_memory_access(body.memory_id, actor)
    else:
        assert_scope_access(body.scope or "shared", actor)
    try:
        if body.memory_id:
            result = mem.forget(body.memory_id)
            db.record_event(actor, "memory.forget", {"memory_id": body.memory_id})
        else:
            result = mem.forget_scope(body.scope or "shared")
            db.record_event(actor, "memory.forget_scope", {"scope": body.scope})
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "memory.forget.error", {"detail": body.model_dump(), "error": str(exc)})
        raise _client_error(exc) from exc
    return {"ok": True, "result": result}


@app.post("/memory/get_all", dependencies=[Depends(require_key)])
def memory_get_all(body: dict[str, Any] = Body(default={}), x_brain_actor: str | None = Header(default=None)) -> dict[str, Any]:
    scope = str(body.get("scope") or "shared")
    assert_scope_access(scope, actor_of(x_brain_actor))
    limit = int(body.get("limit") or 200)
    try:
        return {"ok": True, "scope": scope, "result": mem.get_all(scope, limit=limit)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"memory backend: {exc}") from exc


@app.post("/knowledge/search", dependencies=[Depends(require_key)])
def knowledge_search(
    body: KnowledgeSearchBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    try:
        result = know.search(
            body.query,
            allowed_categories=permitted,
            path_prefix=body.path_prefix,
            top_k=body.top_k,
        )
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "knowledge.search.error", {"query": body.query, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"knowledge backend: {exc}") from exc
    # The register outranks the passages. A document may be months old and there
    # may be several disagreeing; the register is what the estate says NOW, so it
    # is returned alongside and the caller can prefer it.
    try:
        result["current_facts"] = assets_mod.as_search_results(permitted, body.query, top_k=5)
    except Exception as exc:  # noqa: BLE001 - search must not fail because of this
        result["current_facts"] = []
        result["current_facts_error"] = str(exc)
    db.record_event(
        actor,
        "knowledge.search",
        {
            "query": body.query,
            "hits": result.get("count", 0),
            "categories": permitted,
            "facts": len(result.get("current_facts") or []),
        },
    )
    return result


@app.post("/knowledge/ingest", dependencies=[Depends(require_key)])
def knowledge_ingest(
    body: KnowledgeIngestBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    # Writing into a category you may not read would be a way to plant, or to
    # confirm, material you are not allowed to see.
    permitted = allowed_categories(x_brain_allowed_categories)
    if body.category not in permitted:
        raise HTTPException(
            status_code=403,
            detail=f"this caller may not write category '{body.category}' (allowed: {', '.join(permitted)})",
        )
    try:
        outcome = know.ingest(
            body.path,
            source_kind=body.source_kind,
            actor=actor,
            category=body.category,
            keep_original=body.keep_original,
            force=body.force,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "knowledge.ingest.error", {"path": body.path, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"knowledge backend: {exc}") from exc
    db.record_event(actor, "knowledge.ingest", {"path": body.path, "outcome": outcome})
    return {"ok": True, **outcome}


@app.get("/knowledge/documents", dependencies=[Depends(require_key)])
def knowledge_documents(
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=1000000),
    category: str | None = None,
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    permitted = allowed_categories(x_brain_allowed_categories)
    if category is not None and category not in permitted:
        raise HTTPException(status_code=403, detail="category is not permitted for this caller")
    allowed = [category] if category else permitted
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute("""SELECT id, filename, category, index_state, ingested_at, page_count
                       FROM documents WHERE category = ANY(%s)
                       ORDER BY ingested_at DESC, id DESC LIMIT %s OFFSET %s""",
                    (allowed, limit + 1, offset))
        rows = cur.fetchall()
    documents = [{**row, "ingested_at": row["ingested_at"].isoformat() if row["ingested_at"] else None}
                 for row in rows[:limit]]
    return {"documents": documents, "has_more": len(rows) > limit}


@app.post("/knowledge/upload", dependencies=[Depends(require_key)])
async def knowledge_upload(
    request: Request,
    filename: str,
    category: str,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    """Stream a single classified file into a private, temporary staging area."""
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    if category not in permitted:
        raise HTTPException(status_code=403, detail="category is not permitted for this caller")
    if (not filename or len(filename) > 200 or filename in (".", "..") or
            Path(filename).name != filename or "\\" in filename or
            any(ord(char) < 32 or ord(char) == 127 for char in filename)):
        raise HTTPException(status_code=400, detail="invalid filename")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise HTTPException(status_code=415, detail="expected application/octet-stream")
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) < 0 or int(length) > MAX_INGEST_BYTES:
                raise HTTPException(status_code=413, detail="file exceeds upload limit")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid content length") from exc
    # Verify the configured staging root is an allowed document root before
    # creating anything. Do not use the inbox, whose watcher would race us.
    try:
        root = know._resolve(UPLOAD_DIR)
        root.mkdir(parents=True, mode=0o700, exist_ok=True)
        if not root.is_dir():
            raise OSError("upload staging path is not a directory")
        with tempfile.TemporaryDirectory(prefix="upload-", dir=root) as staging:
            target = Path(staging) / filename
            size = 0
            with open(target, "xb") as handle:
                os.chmod(target, 0o600)
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_INGEST_BYTES:
                        raise HTTPException(status_code=413, detail="file exceeds upload limit")
                    if chunk:
                        await run_in_threadpool(handle.write, chunk)
            if size == 0:
                raise HTTPException(status_code=400, detail="file is empty")
            outcome = await run_in_threadpool(know.ingest, str(target), "gateway-upload", actor, category)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=507, detail="could not stage the upload") from exc
    except Exception as exc:  # noqa: BLE001
        log.error("knowledge upload failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="document indexing failed; retry the upload") from exc
    db.record_event(actor, "knowledge.upload", {"category": category, "bytes": size, "document_id": outcome.get("document_id")})
    return {"ok": True, **outcome}


@app.post("/knowledge/retry", dependencies=[Depends(require_key)])
def knowledge_retry(
    body: KnowledgeRetryBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    try:
        if know.document_category(body.document_id) not in permitted:
            raise HTTPException(status_code=403, detail="document category is not permitted")
        outcome = know.retry_index(body.document_id, actor=actor)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail="document indexing failed; retry later") from exc
    db.record_event(actor, "knowledge.retry", {"document_id": body.document_id})
    return {"ok": True, **outcome}


@app.post("/knowledge/ingest-text", dependencies=[Depends(require_key)])
def knowledge_ingest_text(
    body: IngestTextBatchBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    """Index text the caller has ALREADY extracted — the bulk path for archives.

    Email archives are why this exists: one document at a time costs an HTTP round
    trip and an embedding call per message, which for ~40,000 messages is hours.
    MIME parsing stays with the importer that understands the archive; chunking,
    embedding, indexing and the catalogue stay here.
    """
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    offending = sorted({i.category for i in body.items if i.category not in permitted})
    if offending:
        raise HTTPException(
            status_code=403,
            detail=f"this caller may not write categories: {', '.join(offending)}",
        )
    try:
        outcome = know._store_batch(
            [item.model_dump() for item in body.items], actor=actor, default_category="personal"
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "knowledge.ingest_text.error", {"items": len(body.items), "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"knowledge backend: {exc}") from exc
    db.record_event(
        actor,
        "knowledge.ingest_text",
        {"items": len(body.items), "documents": outcome.get("documents"), "chunks": outcome.get("chunks")},
    )
    return outcome


@app.get("/assets", dependencies=[Depends(require_key)])
def list_assets(
    prefix: str | None = None,
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    """The current answer for every fact this caller may see."""
    permitted = allowed_categories(x_brain_allowed_categories)
    try:
        return assets_mod.list_assets(permitted, prefix=prefix)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"asset register: {exc}") from exc


@app.get("/assets/{key:path}", dependencies=[Depends(require_key)])
def get_asset(
    key: str,
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    permitted = allowed_categories(x_brain_allowed_categories)
    try:
        return assets_mod.get_asset(key, permitted)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.put("/assets", dependencies=[Depends(require_key)])
def set_asset(
    body: AssetSetBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    """Record the current value of one fact. This is how the estate stays current.

    Writing into a category you cannot read would let a caller plant or confirm
    material it is not allowed to see, so the same boundary applies as for ingest.
    """
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    if body.category not in permitted:
        raise HTTPException(
            status_code=403,
            detail=f"this caller may not write category '{body.category}' (allowed: {', '.join(permitted)})",
        )
    try:
        outcome = assets_mod.set_asset(
            body.key, body.value, body.category, actor, note=body.note, source=body.source
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"asset register: {exc}") from exc
    db.record_event(actor, "asset.set", {"key": body.key, "category": body.category, "changed": outcome.get("changed")})
    return outcome


@app.delete("/assets/{key:path}", dependencies=[Depends(require_key)])
def delete_asset(
    key: str,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    try:
        outcome = assets_mod.delete_asset(key, permitted, actor)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    db.record_event(actor, "asset.delete", {"key": key})
    return outcome


@app.post("/knowledge/forget", dependencies=[Depends(require_key)])
def knowledge_forget(
    body: KnowledgeForgetBody,
    x_brain_actor: str | None = Header(default=None),
    x_brain_allowed_categories: str | None = Header(default=None),
) -> dict[str, Any]:
    actor = actor_of(x_brain_actor)
    permitted = allowed_categories(x_brain_allowed_categories)
    # Deleting is the most destructive thing this API does, and it was the one
    # route that did not consult the category boundary: a caller that could not
    # READ the bank statements could still have deleted them. Check the document's
    # category before removing anything.
    try:
        target = know.document_category(body.document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if target not in permitted:
        raise HTTPException(
            status_code=403,
            detail=(
                f"document {body.document_id} is in category '{target}', which this caller may not "
                f"read (allowed: {', '.join(permitted)})"
            ),
        )
    try:
        outcome = know.forget(body.document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        db.record_event(actor, "knowledge.forget.error", {"document_id": body.document_id, "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"knowledge backend: {exc}") from exc
    db.record_event(actor, "knowledge.forget", {"document_id": body.document_id, "outcome": outcome})
    return {"ok": True, **outcome}


@app.on_event("startup")
def _startup() -> None:
    try:
        db.ensure_schema()
        db.record_event(None, "brain.start", {"version": VERSION})
        log.info("brain-api %s up; catalogue ready", VERSION)
    except Exception as exc:  # noqa: BLE001
        # Start anyway: a dead catalogue must not hide a working memory engine,
        # and /healthz reports it honestly.
        log.error("catalogue unavailable at startup: %s", exc)
    if os.environ.get("BRAIN_READ_ONLY", "").lower() in ("1", "true", "yes"):
        log.info("read-only migration target: background indexing is disabled")
        return
    threading.Thread(target=_warm_models, name="warm-models", daemon=True).start()
    threading.Thread(target=_warm_indexes, name="warm-indexes", daemon=True).start()
    # The drop-box watcher: a file that has settled in the inbox is ingested
    # without anyone asking, which is the whole point of a scan drop-box.
    know.start_watcher()


def _warm_indexes() -> None:
    """Create Qdrant's payload indexes once, out of band.

    ~60 s of Qdrant work on this array for four indexes, and Mem0 creates them
    itself on every construction with a 5 s client timeout — so they are made here
    first, where a long wait is acceptable, and every later attempt is a no-op.
    """
    try:
        mem.ensure_indexes()
    except Exception as exc:  # noqa: BLE001
        log.warning("payload index warm-up failed (Mem0 will retry them): %s", exc)
    try:
        report = know.ensure_collection()
        log.info("documents collection ready: %s", report)
    except Exception as exc:  # noqa: BLE001
        log.warning("documents collection warm-up failed: %s", exc)


def _warm_models() -> None:
    """Pull the extraction model and the embedder into memory once.

    Both are cold on the first call after a restart and the extraction model is a
    7B GGUF: measured at 53 s cold versus a couple of seconds warm, which is the
    difference between an agent's first `brain_remember` working and timing out.
    `keep_alive` then holds them, so the cost is paid once, here, and never in
    someone's tool call.
    """
    for label, url, payload in (
        (
            f"embedder {MEM0_EMBED_MODEL}",
            f"{OLLAMA_URL}/api/embed",
            {"model": MEM0_EMBED_MODEL, "input": "warm up", "keep_alive": "30m"},
        ),
        (
            f"llm {MEM0_LLM_MODEL}",
            f"{OLLAMA_URL}/api/generate",
            {
                "model": MEM0_LLM_MODEL,
                "prompt": "ready",
                "stream": False,
                "options": {"num_predict": 4},
                "keep_alive": "30m",
            },
        ),
    ):
        try:
            started = time.time()
            response = httpx.post(url, json=payload, timeout=180.0)
            log.info("warm-up %s: HTTP %s in %.1fs", label, response.status_code, time.time() - started)
        except Exception as exc:  # noqa: BLE001
            # Not fatal: the model loads on first use instead.
            log.warning("warm-up %s failed (will load on first use): %s", label, exc)


@app.get("/", include_in_schema=False)
def root(request: Request) -> dict[str, Any]:
    return {"service": "brain-api", "version": VERSION, "docs": str(request.base_url) + "docs"}
