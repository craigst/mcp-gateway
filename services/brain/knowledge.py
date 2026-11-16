"""Document knowledge: extract, chunk, embed, index, and cite.

The text side of the brain. Memories are what an agent concluded; knowledge is
what the paperwork actually says, and the difference matters when the two
disagree — so every passage comes back with the ORIGINAL FILE it came from and an
agent is expected to open that file when it needs more than the passage.

Pipeline, and why each part is where it is:

    /secondbrain/inbox/<file>
        │  OCRmyPDF, only when there is no text layer (a scan, not a born-PDF)
        │  Tika, over HTTP, for the text and metadata (hundreds of formats)
        │  sha256 of the bytes ── the idempotency key: re-drop, nothing changes
        ▼
    Qdrant  brain_docs      one point per chunk, payload carries the citation
    Postgres `documents`    the catalogue: hash, path, mime, OCR flag, counts
             `chunks`       ordinal + text + the Qdrant point id it maps to

Embeddings come from the same Ollama model as memory (`nomic-embed-text`, 768),
so one model change means one reindex for both.
"""

from __future__ import annotations

import hashlib
import json
import logging
import mimetypes
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

import db
from settings import (
    CHUNK_CHARS,
    categories as _categories,
    CHUNK_OVERLAP,
    DERIVED_DIR,
    DOCUMENT_ROOTS,
    DOCS_COLLECTION,
    INBOX_DIR,
    INBOX_QUIET_SECONDS,
    INBOX_CATEGORY,
    MAX_INGEST_BYTES,
    MEM0_EMBED_DIMS,
    MEM0_EMBED_MODEL,
    OLLAMA_URL,
    ORIGINALS_DIR,
    QDRANT_HOST,
    QDRANT_PORT,
    QDRANT_TIMEOUT,
    TIKA_URL,
)

log = logging.getLogger("brain.knowledge")

#: {category: sensitive} — a MAP, resolved once at import. `settings.categories`
#: is a function; exposing its result here means a caller writing `CATEGORIES`
#: gets the dict it expects, not a function object it cannot iterate.
CATEGORIES: dict[str, bool] = _categories()

TEXT_MIME_HINTS = (".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".eml")
MIN_USEFUL_TEXT = 200  # chars below which a PDF is assumed to be an un-OCR'd scan


# ── Qdrant ──────────────────────────────────────────────────────────────────
def _q(url: str) -> str:
    return f"http://{QDRANT_HOST}:{QDRANT_PORT}{url}"


def ensure_collection() -> dict[str, Any]:
    """Create `brain_docs` and its citation index if they are not there yet.

    Slow (payload index creation measured 15-20 s on this array) and therefore
    called from the startup warm-up thread, never from a request.
    """
    report: dict[str, Any] = {"collection": DOCS_COLLECTION, "created": False, "index": None}
    with httpx.Client(timeout=QDRANT_TIMEOUT) as client:
        existing = client.get(_q("/collections")).json()["result"]["collections"]
        names = {c["name"] for c in existing}
        if DOCS_COLLECTION not in names:
            response = client.put(
                _q(f"/collections/{DOCS_COLLECTION}"),
                json={"vectors": {"size": MEM0_EMBED_DIMS, "distance": "Cosine"}},
            )
            response.raise_for_status()
            report["created"] = True
        # `original_path` is what a citation filter runs on, and `category` is the
        # ACCESS filter — both need an index or every search is a full scan.
        for field in ("original_path", "category"):
            try:
                started = time.time()
                response = client.put(
                    _q(f"/collections/{DOCS_COLLECTION}/index?wait=true"),
                    json={"field_name": field, "field_schema": "keyword"},
                )
                response.raise_for_status()
                report.setdefault("indexes", {})[field] = round(time.time() - started, 1)
            except Exception as exc:  # noqa: BLE001 - already exists is the common case
                report.setdefault("indexes", {})[field] = f"skipped: {exc}"
    return report


def _upsert(points: list[dict[str, Any]]) -> None:
    _qdrant_request(
        "PUT",
        f"/collections/{DOCS_COLLECTION}/points?wait=true",
        json_body={"points": points},
    )


def _search_qdrant(
    vector: list[float],
    top_k: int,
    path_prefix: str | None,
    allowed_categories: list[str],
) -> list[dict[str, Any]]:
    must: list[dict[str, Any]] = [
        # HARD, SERVER-SIDE. This is not a convenience filter the caller may drop:
        # brain-api is handed the caller's allowed categories by brain-mcp (which
        # derives them from the messenger-hub grant) and applies them here. An
        # agent that omits every filter still gets only what its grant names.
        {"key": "category", "match": {"any": allowed_categories}},
    ]
    if path_prefix:
        must.append({"key": "original_path", "match": {"text": path_prefix}})
    body: dict[str, Any] = {"vector": vector, "limit": top_k, "with_payload": True, "filter": {"must": must}}
    response = _qdrant_request(
        "POST",
        f"/collections/{DOCS_COLLECTION}/points/search",
        json_body=body,
    )
    return response.json()["result"]


# ── embeddings ──────────────────────────────────────────────────────────────
def embed(texts: list[str], timeout: float = 180.0) -> list[list[float]]:
    if not texts:
        return []
    response = httpx.post(
        f"{OLLAMA_URL}/api/embed",
        json={"model": MEM0_EMBED_MODEL, "input": texts},
        timeout=timeout,
    )
    response.raise_for_status()
    vectors = response.json().get("embeddings") or []
    if len(vectors) != len(texts):
        raise RuntimeError(f"ollama returned {len(vectors)} embeddings for {len(texts)} chunks")
    if any(not isinstance(vector, list) or len(vector) != MEM0_EMBED_DIMS for vector in vectors):
        raise RuntimeError("embedding dimensions do not match the configured document index")
    return vectors


# ── extraction ──────────────────────────────────────────────────────────────
def tika_text(path: Path) -> tuple[str, dict[str, Any]]:
    with open(path, "rb") as handle:
        response = httpx.put(
            f"{TIKA_URL}/tika",
            content=handle.read(),
            headers={
                "Content-Type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                "Accept": "text/plain",
                "Content-Disposition": f'attachment; filename="{path.name}"',
            },
            timeout=300.0,
        )
    response.raise_for_status()
    return response.text, {}


def ocrmypdf(source: Path, target: Path) -> bool:
    """Add a text layer to a scan. Returns True when a new file was produced."""
    target.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ocrmypdf",
        "--skip-text",       # a page that already has text is passed through
        "--deskew",
        "--rotate-pages",
        "--jobs", "1",       # the box is shared with everything else on archive-host
        "--output-type", "pdf",
        str(source),
        str(target),
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=900, check=False)
    except subprocess.TimeoutExpired:
        log.warning("ocr timed out for %s", source.name)
        return False
    if result.returncode != 0:
        log.warning("ocrmypdf failed on %s: %s", source.name, result.stderr.decode("utf8", "replace")[-300:])
        return False
    return target.exists()


def pdf_page_count(path: Path) -> int:
    """How many pages, straight from poppler."""
    try:
        result = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 0
    match = re.search(r"^Pages:\s+(\d+)", result.stdout, re.M)
    return int(match.group(1)) if match else 0


def pdf_pages(path: Path) -> list[tuple[int, str]]:
    """Per-page text, using poppler's page separator.

    `pdftotext -layout` writes a form feed between pages, which is precisely the
    boundary a citation needs. THIS IS WHY PAGES ARE POSSIBLE: the previous path
    asked Tika for `text/plain`, which discards page boundaries, so every passage
    was anonymous — you could find a letter but not say which page of the bundle it
    was on, which is useless when one file holds 712 of them.
    """
    try:
        result = subprocess.run(
            ["pdftotext", "-layout", str(path), "-"],
            capture_output=True, text=True, timeout=1800, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []
    return [(i, page) for i, page in enumerate(result.stdout.split("\f"), start=1) if page.strip()]


def extract_pages(path: Path, ocr_target: Path | None = None) -> tuple[list[tuple[int, str]], bool, str]:
    """[(page_number, text)] plus whether OCR ran and a note.

    Page 0 means "not paginated" — a note, an email, a markdown file. It is kept
    distinct from page 1 so a citation never claims a page that does not exist.
    """
    suffix = path.suffix.lower()
    if suffix in TEXT_MIME_HINTS:
        return [(0, path.read_text(encoding="utf8", errors="replace"))], False, "read as text"

    if suffix == ".pdf":
        pages = pdf_pages(path)
        chars = sum(len(t) for _, t in pages)
        if chars >= MIN_USEFUL_TEXT:
            return pages, False, f"pdftotext, {len(pages)} pages"

        # Almost certainly a scan: a title page's worth of glyphs, or nothing.
        target = ocr_target or Path(DERIVED_DIR) / f"{uuid.uuid4()}.ocr.pdf"
        if ocrmypdf(path, target):
            ocr_pages = pdf_pages(target)
            if sum(len(t) for _, t in ocr_pages) > chars:
                return ocr_pages, True, f"ocr'd, {len(ocr_pages)} pages"
        return pages, False, "no usable text layer and OCR produced nothing"

    text, _ = tika_text(path)
    return [(0, text)], False, "tika"


def extract(path: Path) -> tuple[str, bool, str]:
    """Joined text — kept for callers that do not care about pages."""
    pages, ocr_applied, note = extract_pages(path)
    return "\n\f\n".join(t for _, t in pages), ocr_applied, note


# ── chunking ────────────────────────────────────────────────────────────────
_PARAGRAPH = re.compile(r"\n\s*\n")


def chunk(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Paragraph-first, then a hard split. Overlap keeps a sentence that straddles
    a boundary retrievable from either side."""
    text = text.replace("\r\n", "\n")
    # PostgreSQL text cannot store 0x00 and a real mailbox contains it. Strip it
    # HERE, at the one function every ingest path chunks through, so a dirty
    # message degrades to a slightly shorter one instead of failing the batch.
    text = text.replace("\x00", "").strip()
    if not text:
        return []
    blocks: list[str] = []
    for paragraph in _PARAGRAPH.split(text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= size:
            blocks.append(paragraph)
            continue
        start = 0
        while start < len(paragraph):
            end = min(start + size, len(paragraph))
            blocks.append(paragraph[start:end])
            if end >= len(paragraph):
                break
            start = max(0, end - overlap)
    # merge trivial neighbours so a stray heading does not become its own point
    merged: list[str] = []
    for block in blocks:
        if merged and len(merged[-1]) + len(block) + 2 <= size:
            merged[-1] = f"{merged[-1]}\n\n{block}"
        else:
            merged.append(block)
    return [b for b in merged if b.strip()]


# ── ingest ──────────────────────────────────────────────────────────────────
def _roots() -> list[Path]:
    return [Path(r).resolve() for r in DOCUMENT_ROOTS.split(":") if r.strip()]


def _resolve(path_text: str) -> Path:
    """Resolve a caller-supplied path inside a permitted root, and nowhere else.

    `resolve()` collapses `..`, and the result must still sit under one of the
    configured roots — so `../brain.env` cannot be read. An absolute path is
    accepted only if it is already inside a root.
    """
    resolved = Path(path_text).resolve()
    for root in _roots():
        if resolved == root or root in resolved.parents:
            return resolved
    raise ValueError(
        f"{path_text} is outside the permitted document roots "
        f"({', '.join(str(r) for r in _roots())})"
    )


def ingest(
    path_text: str,
    source_kind: str = "inbox",
    actor: str = "unknown",
    category: str = "",
    keep_original: bool = True,
    force: bool = False,
) -> dict[str, Any]:
    path = _resolve(path_text)
    if not path.is_file():
        raise FileNotFoundError(f"no such file: {path}")
    size = path.stat().st_size
    if size > MAX_INGEST_BYTES:
        raise ValueError(f"{path.name} is {size} bytes, over the {MAX_INGEST_BYTES} cap")

    # An unclassified document lands in the most restrictive category, never a
    # public one. `personal` is the safe default, not a placeholder.
    category = (category or "").strip() or "personal"
    known = _categories()
    if category not in known:
        raise ValueError(
            f"unknown category '{category}'. Known: {', '.join(sorted(known))}"
        )

    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT id, original_path, category, index_state FROM documents WHERE content_hash = %s", (digest,))
        row = cur.fetchone()
    if row and not force:
        if row["category"] != category:
            raise ValueError("These bytes are already indexed under another category; ask an administrator to review the classification.")
        if row["index_state"] != "ready":
            return retry_index(row["id"], actor=actor)
        return {
            "skipped": True,
            "reason": "identical bytes already ingested",
            "document_id": row["id"],
            "original_path": row["original_path"],
        }
    if row and force:
        if row["category"] != category:
            raise ValueError("These bytes are already indexed under another category; ask an administrator to review the classification.")
        return reextract(path, row["id"], category, actor)

    derived_file = Path(DERIVED_DIR) / f"{uuid.uuid4()}.ocr.pdf"
    pages, ocr_applied, note = extract_pages(path, ocr_target=derived_file)
    text = "\n".join(t for _, t in pages)
    # Chunked per page, not over the whole document: a passage that spans a page
    # break would have no single answer to "which page is this on".
    passages: list[tuple[int, str]] = []
    for page_no, page_text in pages:
        for piece in chunk(page_text):
            passages.append((page_no, piece))
    if not passages:
        # Keep the catalogue row anyway: "we saw this and it said nothing" is a
        # fact worth being able to answer questions about, and it stops the inbox
        # watcher retrying it forever.
        passages = []
        note = f"{note}; no usable text"

    vectors = embed([t for _, t in passages]) if passages else []

    # The immutable copy. The inbox is a drop-box: files get moved, renamed and
    # overwritten there, and a citation must outlive that.
    #
    # `keep_original=False` is for ARCHIVES: the Nextcloud Documents tree is
    # already an immutable, backed-up home for these files, so copying 4.3 GB of
    # email and scans onto a laptop with 24 GB free would buy nothing and cost
    # everything. The citation then points at the real file, which is more useful
    # anyway — it is the copy the operator can actually open.
    if keep_original:
        stored = Path(ORIGINALS_DIR) / digest[:12]
        stored.mkdir(parents=True, exist_ok=True)
        stored_file = stored / path.name
        if not stored_file.exists():
            shutil.copy2(path, stored_file)
    else:
        stored_file = path

    point_ids: list[str] = []
    mime = mimetypes.guess_type(path.name)[0]
    with db.conn() as c, c.cursor() as cur:
        cur.execute(
            """INSERT INTO documents
                 (content_hash, original_path, derived_path, filename, mime, bytes,
                  ocr_applied, source_kind, category, embed_model, embed_dims, page_count, meta, index_state)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending')
               RETURNING id""",
            (
                digest,
                str(stored_file),
                str(derived_file) if ocr_applied else None,
                path.name,
                mime,
                size,
                ocr_applied,
                source_kind,
                category,
                MEM0_EMBED_MODEL,
                MEM0_EMBED_DIMS,
                pdf_page_count(path) or None,
                json.dumps({"note": note, "origin": str(path)}),
            ),
        )
        document_id = cur.fetchone()["id"]
        for ordinal, (page_no, passage) in enumerate(passages):
            point_id = str(uuid.uuid4())
            point_ids.append(point_id)
            cur.execute(
                "INSERT INTO chunks (document_id, ordinal, page, text, qdrant_point_id, chars)"
                " VALUES (%s,%s,%s,%s,%s,%s)",
                (document_id, ordinal, page_no, passage, point_id, len(passage)),
            )
        c.commit()

    if passages:
        _upsert(
            [
                {
                    "id": point_ids[i],
                    "vector": vectors[i],
                    "payload": {
                        "document_id": document_id,
                        "ordinal": i,
                        # The page is what makes a 712-page scan usable: a hit can
                        # say WHICH page of the bundle it came from.
                        "page": passages[i][0],
                        "text": passages[i][1],
                        "original_path": str(stored_file),
                        "filename": path.name,
                        "content_hash": digest,
                        "source_kind": source_kind,
                        "category": category,
                    },
                }
                for i in range(len(passages))
            ]
        )

    with db.conn() as c, c.cursor() as cur:
        cur.execute("UPDATE documents SET index_state = 'ready' WHERE id = %s", (document_id,))
        c.commit()

    return {
        "document_id": document_id,
        "original_path": str(stored_file),
        "category": category,
        "chunks": len(passages),
        "ocr_applied": ocr_applied,
        "note": note,
        "chars": len(text),
        "actor": actor,
        "path_in_share": str(path),
    }


def _delete_points(point_ids: list[str]) -> None:
    if not point_ids:
        return
    with httpx.Client(timeout=QDRANT_TIMEOUT) as client:
        response = client.post(_q(f"/collections/{DOCS_COLLECTION}/points/delete?wait=true"),
                               json={"points": point_ids})
        response.raise_for_status()


def reextract(path: Path, document_id: int, category: str, actor: str) -> dict[str, Any]:
    """Stage replacement vectors, then atomically swap the catalogue.

    The catalogue is authoritative at search time, so staged and old vectors
    cannot be returned before or after the swap. The original file is retained.
    """
    derived_file = Path(DERIVED_DIR) / f"{uuid.uuid4()}.ocr.pdf"
    pages, ocr_applied, note = extract_pages(path, ocr_target=derived_file)
    passages = [(page, piece) for page, text in pages for piece in chunk(text)]
    if not passages:
        raise ValueError("Re-extraction returned no usable text; the existing index was preserved.")
    vectors = embed([text for _, text in passages])
    new_ids = [str(uuid.uuid4()) for _ in passages]
    old_ids: list[str] = []
    committed = False
    try:
        with db.conn() as c, c.cursor() as cur:
            cur.execute("SELECT id, category, original_path, filename, content_hash, source_kind, index_state FROM documents WHERE id = %s FOR UPDATE", (document_id,))
            row = cur.fetchone()
            if not row or row["category"] != category or row["index_state"] != "ready":
                raise ValueError("Document changed or is awaiting repair; retry after reviewing it.")
            cur.execute("SELECT qdrant_point_id FROM chunks WHERE document_id = %s", (document_id,))
            old_ids = [item["qdrant_point_id"] for item in cur.fetchall()]
            if passages:
                _upsert([{"id": new_ids[i], "vector": vectors[i], "payload": {
                    "document_id": document_id, "ordinal": i, "page": page,
                    "text": text, "original_path": row["original_path"], "filename": row["filename"],
                    "content_hash": row["content_hash"], "source_kind": row["source_kind"], "category": category,
                }} for i, (page, text) in enumerate(passages)])
            cur.execute("DELETE FROM chunks WHERE document_id = %s", (document_id,))
            for i, (page, text) in enumerate(passages):
                cur.execute("INSERT INTO chunks (document_id, ordinal, page, text, qdrant_point_id, chars) VALUES (%s,%s,%s,%s,%s,%s)",
                            (document_id, i, page, text, new_ids[i], len(text)))
            cur.execute("UPDATE documents SET ocr_applied = %s, derived_path = COALESCE(%s, derived_path), embed_model = %s, embed_dims = %s, page_count = %s, meta = meta || %s::jsonb WHERE id = %s",
                        (ocr_applied, str(derived_file) if ocr_applied else None, MEM0_EMBED_MODEL, MEM0_EMBED_DIMS, pdf_page_count(path) or None, json.dumps({"note": note}), document_id))
            c.commit()
            committed = True
    except Exception:
        if not committed and new_ids:
            try:
                # A lost connection during COMMIT has an ambiguous outcome.
                # Only remove staged vectors after confirming they are not in
                # the authoritative catalogue; if unavailable, retain them.
                with db.conn() as check, check.cursor() as cursor:
                    cursor.execute("SELECT COUNT(*) AS count FROM chunks WHERE qdrant_point_id = ANY(%s)", (new_ids,))
                    referenced = cursor.fetchone()["count"]
                if not referenced:
                    _delete_points(new_ids)
            except Exception as cleanup_error:  # noqa: BLE001
                log.warning("retained staged vectors for later audit: %s", type(cleanup_error).__name__)
        raise
    try:
        _delete_points(old_ids)
    except Exception as cleanup_error:  # noqa: BLE001
        # They cannot be returned by search, and the migration audit can report
        # them for later cleanup; never undo a completed catalogue swap.
        log.warning("could not remove superseded vectors: %s", type(cleanup_error).__name__)
    return {"document_id": document_id, "original_path": row["original_path"], "category": category,
            "chunks": len(passages), "ocr_applied": ocr_applied, "note": note, "actor": actor, "reindexed": True}


def retry_index(document_id: int, actor: str = "unknown") -> dict[str, Any]:
    """Idempotently finish an interrupted catalogue-to-vector write."""
    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT id, original_path, filename, content_hash, source_kind, category, embed_model, embed_dims, index_state FROM documents WHERE id = %s", (document_id,))
        document = cur.fetchone()
        if not document:
            raise ValueError("document not found")
        if document["index_state"] == "ready":
            return {"document_id": document_id, "skipped": True, "reason": "already indexed"}
        if document["embed_model"] != MEM0_EMBED_MODEL or document["embed_dims"] != MEM0_EMBED_DIMS:
            raise ValueError("Document embedding model differs from the configured model; reindex with a matching model.")
        cur.execute("SELECT ordinal, page, text, qdrant_point_id FROM chunks WHERE document_id = %s ORDER BY ordinal", (document_id,))
        chunks = cur.fetchall()
    for start in range(0, len(chunks), 256):
        batch = chunks[start:start + 256]
        vectors = embed([chunk["text"] for chunk in batch])
        _upsert([{"id": chunk["qdrant_point_id"], "vector": vectors[i], "payload": {
            "document_id": document_id, "ordinal": chunk["ordinal"], "page": chunk["page"],
            "text": chunk["text"], "original_path": document["original_path"], "filename": document["filename"],
            "content_hash": document["content_hash"], "source_kind": document["source_kind"],
            "category": document["category"],
        }} for i, chunk in enumerate(batch)])
    with db.conn() as c, c.cursor() as cur:
        cur.execute("UPDATE documents SET index_state = 'ready' WHERE id = %s AND index_state = 'pending'", (document_id,))
        c.commit()
    return {"document_id": document_id, "category": document["category"], "chunks": len(chunks), "repaired": True, "actor": actor}


def search(
    query: str,
    allowed_categories: list[str],
    path_prefix: str | None = None,
    top_k: int = 8,
) -> dict[str, Any]:
    if not allowed_categories:
        # Fail closed. An empty allowance is a caller bug or an attempt to see
        # everything, and neither should return rows.
        raise ValueError("no categories are allowed for this caller")
    vector = embed([query])[0]
    hits = _search_qdrant(vector, top_k, path_prefix, allowed_categories)
    # A vector can outlive its catalogue row after an interrupted write or
    # delete. Treat Postgres as authoritative for both access and content; an
    # old or forged payload must not resurrect a passage or change its text.
    point_ids = [str(hit["id"]) for hit in hits if hit.get("id") is not None]
    authoritative = {}
    if point_ids:
        with db.conn() as c, c.cursor() as cur:
            cur.execute(
                """SELECT ch.qdrant_point_id, ch.document_id, ch.ordinal, ch.page, ch.text,
                          d.category, d.original_path, d.filename
                   FROM chunks ch JOIN documents d ON d.id = ch.document_id
                   WHERE ch.qdrant_point_id = ANY(%s) AND d.category = ANY(%s)
                     AND d.index_state = 'ready'""",
                (point_ids, allowed_categories),
            )
            authoritative = {row["qdrant_point_id"]: row for row in cur.fetchall()}
    results = []
    for hit in hits:
        row = authoritative.get(str(hit.get("id")))
        payload = hit.get("payload") or {}
        if not row or row["document_id"] != payload.get("document_id") or row["category"] != payload.get("category"):
            continue
        results.append(
            {
                "text": row["text"],
                "category": row["category"],
                # 0 means "not a paginated document"; the caller renders nothing.
                "page": row["page"] or None,
                "original_path": row["original_path"],
                "filename": row["filename"],
                "document_id": row["document_id"],
                "ordinal": row["ordinal"],
                "score": hit.get("score"),
            }
        )
    return {
        "ok": True,
        "count": len(results),
        "categories_searched": sorted(allowed_categories),
        "results": results,
    }


# ── the inbox watcher ───────────────────────────────────────────────────────
_started = False


def start_watcher(interval: int = 30) -> None:
    """Scan the drop-box for settled files and ingest them.

    A file is 'settled' when it has not been modified for INBOX_QUIET_SECONDS, so
    a scan being written straight into the share is never read half-finished.
    """
    global _started
    if _started:
        return
    _started = True

    def loop() -> None:
        inbox = Path(INBOX_DIR)
        inbox.mkdir(parents=True, exist_ok=True)
        while True:
            try:
                now = time.time()
                for entry in sorted(inbox.iterdir()):
                    if not entry.is_file() or entry.name.startswith(".") or entry.suffix == ".part":
                        continue
                    if now - entry.stat().st_mtime < INBOX_QUIET_SECONDS:
                        continue
                    try:
                        outcome = ingest(
                            str(entry),
                            source_kind="inbox-watcher",
                            actor="inbox-watcher",
                            category=INBOX_CATEGORY,
                        )
                        log.info("ingested %s: %s", entry.name, outcome.get("chunks", outcome.get("reason")))
                        db.record_event("inbox-watcher", "knowledge.ingest", {"file": entry.name, "outcome": outcome})
                        done = Path(DERIVED_DIR) / "ingested"
                        done.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(entry), str(done / entry.name))
                    except Exception as exc:  # noqa: BLE001
                        log.warning("could not ingest %s: %s", entry.name, exc)
                        db.record_event("inbox-watcher", "knowledge.ingest.error", {"file": entry.name, "error": str(exc)})
                        quarantine = Path(DERIVED_DIR) / "quarantine"
                        quarantine.mkdir(parents=True, exist_ok=True)
                        try:
                            shutil.move(str(entry), str(quarantine / entry.name))
                        except Exception:  # noqa: BLE001
                            pass
            except Exception as exc:  # noqa: BLE001
                log.warning("inbox scan failed: %s", exc)
            time.sleep(interval)

    threading.Thread(target=loop, name="inbox-watcher", daemon=True).start()
    log.info("inbox watcher started on %s (quiet window %ss)", INBOX_DIR, INBOX_QUIET_SECONDS)


def forget(document_id: int) -> dict[str, Any]:
    """Remove one document: its vectors, its catalogue row and its stored files.

    A document that cannot be deleted is a document that can never be un-shared,
    so this is deliberately part of the API rather than a psql recipe. Memory and
    knowledge are separate namespaces and both need a delete.
    """
    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT id, original_path, derived_path, filename, content_hash FROM documents WHERE id = %s FOR UPDATE", (document_id,))
        row = cur.fetchone()
        if not row:
            raise ValueError(f"no document with id {document_id}")

        # Vectors first: a failure here must not leave the catalogue claiming a
        # document is live while its passages are still searchable.
        try:
            with httpx.Client(timeout=QDRANT_TIMEOUT) as client:
                response = client.post(
                    _q(f"/collections/{DOCS_COLLECTION}/points/delete?wait=true"),
                    json={"filter": {"must": [{"key": "document_id", "match": {"value": document_id}}]}},
                )
                response.raise_for_status()
                deleted_points = response.json().get("result", {}).get("operation_id", "ok")
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"could not remove the document's vectors: {exc}") from exc

        cur.execute("DELETE FROM documents WHERE id = %s", (document_id,))  # chunks cascade
        cur.execute("SELECT COUNT(*) AS count FROM documents WHERE original_path IN (%s, %s) OR derived_path IN (%s, %s)", (row["original_path"], row["derived_path"], row["original_path"], row["derived_path"]))
        shared = int(cur.fetchone()["count"])
        c.commit()

    removed_files = []
    if not shared:
        for candidate, base, is_original in ((row["original_path"], ORIGINALS_DIR, True), (row["derived_path"], DERIVED_DIR, False)):
            if not candidate:
                continue
            try:
                target = Path(candidate)
                root = Path(base).resolve()
                resolved = target.resolve()
                # External archives and path/symlink escapes are never removed.
                if root not in resolved.parents or not target.is_file():
                    continue
                if is_original and resolved.parent != root / row["content_hash"][:12]:
                    continue
                target.unlink()
                removed_files.append(str(target))
                if is_original:
                    try:
                        target.parent.rmdir()  # only if empty; never remove siblings
                    except OSError:
                        pass
            except OSError as exc:
                log.warning("could not remove managed document file: %s", type(exc).__name__)

    return {
        "document_id": document_id,
        "filename": row["filename"],
        "vectors_deleted": deleted_points,
        "files_removed": removed_files,
    }


def _store_batch(
    items: list[dict[str, Any]],
    actor: str,
    default_category: str,
) -> dict[str, Any]:
    """Index pre-extracted text: the fast path for bulk archives.

    Email archives are the reason this exists. The one-document-at-a-time route
    costs an HTTP round trip and an embedding call PER MESSAGE, which for ~40,000
    messages is measured in hours. Here the chunking happens first for the whole
    batch, the embeddings go to Ollama in a few large calls, and Qdrant gets one
    upsert per chunk-group — roughly two orders of magnitude fewer round trips.

    The caller supplies the text because MIME parsing belongs with the importer
    that knows the archive's shape; this function owns chunk/embed/index/catalogue.
    """
    known = _categories()
    prepared: list[dict[str, Any]] = []
    skipped = 0

    for item in items:
        path_text = str(item.get("path") or "")
        text = item.get("text") or ""
        category = (item.get("category") or default_category or "personal").strip()
        if category not in known:
            raise ValueError(f"unknown category '{category}' for {path_text}")
        if not text.strip():
            skipped += 1
            continue

        digest = hashlib.sha256(text.encode("utf8", "replace")).hexdigest()
        with db.conn() as c, c.cursor() as cur:
            cur.execute("SELECT id, category, index_state FROM documents WHERE content_hash = %s", (digest,))
            existing = cur.fetchone()
        if existing:
            if existing["category"] != category:
                raise ValueError("These bytes are already indexed under another category; ask an administrator to review the classification.")
            if existing["index_state"] != "ready":
                retry_index(existing["id"], actor=actor)
            skipped += 1
            continue

        passages = chunk(text)
        if not passages:
            skipped += 1
            continue
        prepared.append(
            {
                "path": path_text,
                "category": category,
                "digest": digest,
                "passages": passages,
                "page": int(item.get("page") or 0),
                "meta": item.get("metadata") or {},
                "source_kind": item.get("source_kind") or "archive",
                "filename": item.get("filename") or Path(path_text).name or "message",
                "mime": item.get("mime") or "message/rfc822",
            }
        )

    if not prepared:
        return {"ok": True, "documents": 0, "chunks": 0, "skipped": skipped}

    # One embedding pass over every chunk in the batch, in bounded groups so a
    # single request cannot grow without limit.
    flat: list[str] = []
    for doc in prepared:
        flat.extend(doc["passages"])
    # 256 rather than 64: measured on the TITAN X, embedding throughput goes from
    # 22.5 to 37.3 passages/s between those batch sizes, and a bulk import is
    # entirely bound by this call.
    vectors: list[list[float]] = []
    group = 256
    for start in range(0, len(flat), group):
        vectors.extend(embed(flat[start : start + group]))

    points: list[dict[str, Any]] = []
    cursor = 0
    saved = 0
    saved_ids = []
    for doc in prepared:
        with db.conn() as c, c.cursor() as cur:
            cur.execute(
                """INSERT INTO documents
                     (content_hash, original_path, derived_path, filename, mime, bytes,
                      ocr_applied, source_kind, category, embed_model, embed_dims, page_count, meta, index_state)
                   VALUES (%s,%s,NULL,%s,%s,%s,false,%s,%s,%s,%s,NULL,%s,'pending')
                   ON CONFLICT (content_hash) DO NOTHING
                   RETURNING id""",
                (
                    doc["digest"],
                    doc["path"],
                    doc["filename"],
                    doc["mime"],
                    len(doc["passages"]),
                    doc["source_kind"],
                    doc["category"],
                    MEM0_EMBED_MODEL,
                    MEM0_EMBED_DIMS,
                    json.dumps(_strip_nul({**doc["meta"], "page": doc.get("page") or 0})),
                ),
            )
            row = cur.fetchone()
            if not row:
                # Its classification and index state may differ. A retry will
                # inspect them; never silently declare the concurrent write done.
                raise RuntimeError("Another import is processing this content; retry the batch.")
            document_id = row["id"]
            saved_ids.append(document_id)
            for ordinal, passage in enumerate(doc["passages"]):
                point_id = str(uuid.uuid4())
                points.append(
                    {
                        "id": point_id,
                        "vector": vectors[cursor],
                        "payload": {
                            **{k: v for k, v in doc["meta"].items() if isinstance(v, (str, int, float, bool))},
                            "document_id": document_id,
                            "ordinal": ordinal,
                            "page": doc.get("page") or 0,
                            "text": passage,
                            "original_path": doc["path"],
                            "filename": doc["filename"],
                            "content_hash": doc["digest"],
                            "source_kind": doc["source_kind"],
                            "category": doc["category"],
                        },
                    }
                )
                cur.execute(
                    "INSERT INTO chunks (document_id, ordinal, page, text, qdrant_point_id, chars)"
                    " VALUES (%s,%s,%s,%s,%s,%s)",
                    (document_id, ordinal, doc.get("page") or 0, passage, point_id, len(passage)),
                )
                cursor += 1
            c.commit()
        saved += 1

    for start in range(0, len(points), 256):
        _upsert(points[start : start + 256])

    if saved_ids:
        with db.conn() as c, c.cursor() as cur:
            cur.execute("UPDATE documents SET index_state = 'ready' WHERE id = ANY(%s)", (saved_ids,))
            c.commit()

    return {
        "ok": True,
        "documents": saved,
        "chunks": len(points),
        "skipped": skipped,
        "actor": actor,
    }


def _qdrant_request(method: str, path: str, *, json_body=None, attempts: int = 4):
    """One Qdrant call, retried on transport errors.

    `httpx.Client` is used as a context manager per call, so the pool is closed as
    soon as the call returns. Under concurrent load (a bulk import alongside normal
    agent traffic) an in-flight connection can be closed underneath us and surface
    as "the connection is closed" — a transport symptom, not a data problem, and
    losing a whole batch to it would be silly. Retry with backoff; re-raise only
    when every attempt fails, because that is real.
    """
    delay = 1.0
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            with httpx.Client(timeout=QDRANT_TIMEOUT) as client:
                response = client.request(method, _q(path), json=json_body)
                response.raise_for_status()
                return response
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            last = exc
            # A 4xx is our fault and retrying it is pointless; anything else may
            # be transient.
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code < 500:
                raise
            if attempt < attempts:
                log.warning("qdrant %s %s failed (%s), retrying in %.0fs", method, path, exc, delay)
                time.sleep(delay)
                delay *= 2
    raise last  # type: ignore[misc]


def _strip_nul(value):
    """Remove NUL bytes from anything on its way into Postgres.

    PostgreSQL text columns cannot hold 0x00, and real mailboxes contain it: a
    malformed MIME part, a truncated binary attachment decoded as text, a stray
    control block. Without this a thousand perfectly good messages fail to index
    with "PostgreSQL text fields cannot contain NUL (0x00) bytes" — which reads
    like a database fault and is really dirty input.

    Applied to the text AND to metadata, because `meta` is jsonb, which is text
    underneath, so a NUL in a subject line fails the same way.
    """
    if isinstance(value, str):
        return value.replace("\x00", "")
    if isinstance(value, dict):
        return {k: _strip_nul(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_strip_nul(v) for v in value]
    return value


def document_category(document_id: int) -> str:
    """The category of one document — what `forget` checks before deleting."""
    with db.conn() as c, c.cursor() as cur:
        cur.execute("SELECT category FROM documents WHERE id = %s", (document_id,))
        row = cur.fetchone()
    if not row:
        raise ValueError(f"no document with id {document_id}")
    return row["category"]
