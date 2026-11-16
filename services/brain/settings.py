"""Environment-based configuration for the managed brain service.

Keep service keys and database passwords outside version control, in private
files or a secrets manager. The backend trusts the identity and category headers
of authorized adapters, so its API key must never be given directly to agents.
"""

from __future__ import annotations

import os


def _env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        if default is None:
            raise RuntimeError(f"{name} is required")
        return default
    return value


# ── identity ────────────────────────────────────────────────────────────────
# Shared backend credential. Gateway MCP adapters use local per-process grants;
# it does not establish a different identity for each gateway caller.
BRAIN_API_KEY = _env("BRAIN_API_KEY")

# ── the two local engines on archive-host ───────────────────────────────────────────
OLLAMA_URL = _env("OLLAMA_URL", "http://ollama:11434").rstrip("/")
QDRANT_HOST = _env("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(_env("QDRANT_PORT", "6333"))

# Qdrant's write path on this host is slow: a single payload-index creation on an
# EMPTY collection measured 14-19 s, and the array's read-modify-write parity
# behaviour is the reason. qdrant-client's default timeout is 5 s, so Mem0's own
# index and insert calls fail with "timed out" while Qdrant goes on to succeed —
# the work happens, the client just stops waiting for it. 180 s is not a fudge;
# it is the honest budget for this storage. Fixing the storage (see the project
# README) is what would let this come back down.
QDRANT_TIMEOUT = float(_env("QDRANT_TIMEOUT", "180"))

# Mem0's fact-extraction LLM. Deliberately NOT a "thinking" model: qwen3:latest was
# measured returning an EMPTY response with a small token budget (the whole budget
# went into the reasoning trace) and taking 53 s cold, which is exactly what Mem0's
# JSON extraction cannot tolerate. qwen2.5:7b answers in JSON, cold-loads in 53 s and
# warm-answers in seconds — and brain-api pre-warms it at startup for that reason.
MEM0_LLM_MODEL = _env("MEM0_LLM_MODEL", "qwen2.5:7b")
MEM0_LLM_TEMPERATURE = float(_env("MEM0_LLM_TEMPERATURE", "0.1"))
MEM0_LLM_MAX_TOKENS = int(_env("MEM0_LLM_MAX_TOKENS", "2000"))

# Mem0's embedder. nomic-embed-text is 768-dim; that number is also the Qdrant
# collection size, so changing the model means a full reindex. It is recorded in
# the catalogue for exactly that reason.
MEM0_EMBED_MODEL = _env("MEM0_EMBED_MODEL", "nomic-embed-text:latest")
MEM0_EMBED_DIMS = int(_env("MEM0_EMBED_DIMS", "768"))

# ── storage ─────────────────────────────────────────────────────────────────
MEM0_COLLECTION = _env("MEM0_COLLECTION", "brain_memories")
DOCS_COLLECTION = _env("DOCS_COLLECTION", "brain_docs")
MEM0_HISTORY_DB = _env("MEM0_HISTORY_DB", "/data/mem0-history/history.db")

BRAIN_PG_HOST = _env("BRAIN_PG_HOST", "postgres")
BRAIN_PG_PORT = int(_env("BRAIN_PG_PORT", "5432"))
BRAIN_PG_DB = _env("BRAIN_PG_DB", "brain")
BRAIN_PG_USER = _env("BRAIN_PG_USER", "brain")
BRAIN_PG_PASSWORD = _env("BRAIN_PG_PASSWORD")

# ── documents (phase 2) ─────────────────────────────────────────────────────
TIKA_URL = _env("TIKA_URL", "http://tika:9998").rstrip("/")
INBOX_DIR = _env("INBOX_DIR", "/data/inbox")
UPLOAD_DIR = _env("BRAIN_UPLOAD_DIR", "/secondbrain/gateway-uploads")
# Every root a caller may name a file under. The drop-box is writable and small;
# /archive is the read-only mount of the existing Nextcloud Documents tree, where
# the historical email exports and scanned letters already live. A path outside
# these roots is refused, so a caller cannot walk the filesystem.
DOCUMENT_ROOTS = _env("DOCUMENT_ROOTS", "/secondbrain:/archive")
ORIGINALS_DIR = _env("ORIGINALS_DIR", "/data/originals")
DERIVED_DIR = _env("DERIVED_DIR", "/data/derived")
# A file must be untouched for this long before it is ingested, so a partially
# written scan is never read. Scanners write straight into the drop-box.
INBOX_QUIET_SECONDS = int(_env("INBOX_QUIET_SECONDS", "60"))
# Anything dropped in the inbox has no classification, so it lands in the most
# restrictive category. Change this per drop-box only if the box itself is
# unambiguous (e.g. a scanner that only ever produces utility bills).
INBOX_CATEGORY = _env("INBOX_CATEGORY", "personal")
MAX_INGEST_BYTES = int(_env("MAX_INGEST_BYTES", str(200 * 1024 * 1024)))
CHUNK_CHARS = int(_env("CHUNK_CHARS", "1600"))
CHUNK_OVERLAP = int(_env("CHUNK_OVERLAP", "200"))

VERSION = "1.0.0"


# ── categories: the access boundary for documents ───────────────────────────
#
# WHY THIS EXISTS: the archive is not all one thing. Bank statements, payslips and
# a driving licence must not be searchable by every agent, while homelab notes
# should be. A category is therefore BOTH a label and an access boundary —
# brain-mcp derives the caller's allowed set from its configured local grant and
# brain-api enforces it server-side. An agent cannot widen its own view by
# omitting a filter, because the filter is not supplied by the agent.
#
# `sensitive` marks the categories a grant must name explicitly (the `knowledge`
# action alone covers only the non-sensitive ones).
_CATEGORY_SPEC = _env(
    "BRAIN_CATEGORIES",
    # name:sensitive,...
    "homelab:0,projects:0,email:1,financial:1,property:1,identity:1,vehicle:1,personal:1,sessions:1",
)


def categories() -> dict[str, bool]:
    """{category: sensitive} as configured."""
    out: dict[str, bool] = {}
    for item in _CATEGORY_SPEC.split(","):
        item = item.strip()
        if not item:
            continue
        name, _, flag = item.partition(":")
        out[name.strip()] = flag.strip() in ("1", "true", "yes")
    return out


def public_categories() -> list[str]:
    return [name for name, sensitive in categories().items() if not sensitive]


def all_categories() -> list[str]:
    return list(categories())
