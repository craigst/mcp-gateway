"""The memory engine: Mem0 OSS, in-process, on local models.

WHY NOT Mem0's OWN SELF-HOSTED SERVER (the gate result, 2026-10-05):

    server/main.py in mem0ai ships
        BUNDLED_LLM_PROVIDERS     = ("openai", "anthropic", "gemini")
        BUNDLED_EMBEDDER_PROVIDERS = ("openai", "gemini")
    and refuses anything else with a 400. Its default config is
    llm=openai / embedder=openai. There is no Ollama, so that server would have
    sent this household's facts and your documents' text to a cloud API — the
    opposite of the requirement. (It is patchable — the error message says so —
    but that would mean maintaining a fork of a vendored image for a dashboard.)

So Mem0 is used the way its maintainers document for local models: the `mem0ai`
library, in-process, with its first-class `ollama` LLM and `ollama` embedder
providers (mem0/llms/ollama.py, mem0/embeddings/ollama.py) and its core Qdrant
vector store. Nothing leaves the LAN.

What this gives up is Mem0's dashboard. `GET /stats`, `GET /events` and
`brain_forget` are the replacement for "what does this agent know, and delete
it"; Mem0's own history (a SQLite change log) is kept on disk for the same
reason.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any

os.environ["MEM0_TELEMETRY"] = "false"  # before any mem0 module is imported

from mem0 import Memory
from qdrant_client import QdrantClient

from settings import (
    MEM0_COLLECTION,
    MEM0_EMBED_DIMS,
    MEM0_EMBED_MODEL,
    MEM0_HISTORY_DB,
    MEM0_LLM_MAX_TOKENS,
    MEM0_LLM_MODEL,
    MEM0_LLM_TEMPERATURE,
    OLLAMA_URL,
    QDRANT_HOST,
    QDRANT_PORT,
    QDRANT_TIMEOUT,
)

log = logging.getLogger("brain.memory")

# The payload fields Mem0 filters on. It creates these itself, but creating an
# index is the single slowest thing this host does (14-19 s each, measured), so
# they are created once, here, with a client that will actually wait. After the
# first run every later call is a no-op.
FILTER_FIELDS = ("user_id", "agent_id", "run_id", "actor_id")

_lock = threading.Lock()
_memory: Memory | None = None


def qdrant_client() -> QdrantClient:
    """A Qdrant client prepared for this host's storage latency.

    Mem0 constructs its own client with qdrant-client's 5 s default, which is far
    below what a write costs here. Passing our own is supported
    (`QdrantConfig.client`) and is the difference between "Failed to insert any of
    the extracted memories" and a working brain.
    """
    return QdrantClient(
        host=QDRANT_HOST,
        port=QDRANT_PORT,
        timeout=QDRANT_TIMEOUT,
        check_compatibility=False,
    )


def ensure_indexes() -> dict[str, Any]:
    """Create the payload indexes once, and report what exists.

    Called at startup, in the background: it is ~60 s of Qdrant work on this array
    and the service must not refuse to answer /livez while it runs.
    """
    client = qdrant_client()
    report: dict[str, Any] = {"collection": MEM0_COLLECTION, "created": [], "failed": []}
    for field in FILTER_FIELDS:
        try:
            started = time.time()
            client.create_payload_index(
                collection_name=MEM0_COLLECTION,
                field_name=field,
                field_schema="keyword",
                wait=True,
            )
            report["created"].append({"field": field, "seconds": round(time.time() - started, 1)})
        except Exception as exc:  # noqa: BLE001
            report["failed"].append({"field": field, "error": str(exc)})
    log.info("payload indexes ready: %s", report["created"])
    if report["failed"]:
        log.warning("payload index problems: %s", report["failed"])
    return report


def mem0_config() -> dict[str, Any]:
    return {
        "vector_store": {
            "provider": "qdrant",
            "config": {
                # An injected client, not host/port: see qdrant_client() above. It
                # also makes Mem0 treat this as a remote store (is_local=False), so
                # the filter indexes it relies on are created and used.
                "client": qdrant_client(),
                "collection_name": MEM0_COLLECTION,
                "embedding_model_dims": MEM0_EMBED_DIMS,
                "on_disk": True,
            },
        },
        "llm": {
            "provider": "ollama",
            "config": {
                "model": MEM0_LLM_MODEL,
                "ollama_base_url": OLLAMA_URL,
                "temperature": MEM0_LLM_TEMPERATURE,
                "max_tokens": MEM0_LLM_MAX_TOKENS,
            },
        },
        "embedder": {
            "provider": "ollama",
            "config": {
                "model": MEM0_EMBED_MODEL,
                "ollama_base_url": OLLAMA_URL,
                "embedding_dims": MEM0_EMBED_DIMS,
            },
        },
        "history_db_path": MEM0_HISTORY_DB,
    }


def memory() -> Memory:
    """Built once, on first use.

    Built lazily because constructing it talks to Qdrant and Ollama (the Ollama
    embedder probes that its model exists), and a service that refuses to *start*
    when Ollama is rebooting is worse than one that starts and reports the fault
    on the call that needs it.
    """
    global _memory
    with _lock:
        if _memory is None:
            _memory = Memory.from_config(mem0_config())
            log.info(
                "mem0 ready: collection=%s dims=%s llm=%s embedder=%s",
                MEM0_COLLECTION,
                MEM0_EMBED_DIMS,
                MEM0_LLM_MODEL,
                MEM0_EMBED_MODEL,
            )
    return _memory


def reset() -> None:
    """Drop the cached instance (used by tests and after a config change)."""
    global _memory
    with _lock:
        _memory = None


# ── thin, honest wrappers ───────────────────────────────────────────────────
# One namespace per `scope`, which is mem0's `user_id`. The writing agent is
# mem0's `agent_id`. That is the whole scoping model:
#
#     scope="shared"            → shared          (visible to every grant)
#     scope="homelab" | "media" | "work" | "vehicles"
#     scope="agents/<contact>"  → that agent's private notes
#
# A search filters on scope only, so every agent granted `search` sees the shared
# knowledge of that scope, and provenance (`agent_id`) travels with each fact.


def add(
    text: str,
    *,
    scope: str,
    agent_id: str,
    source_ref: str | None = None,
    metadata: dict[str, Any] | None = None,
    infer: bool = True,
    ttl_days: int | None = None,
) -> dict[str, Any]:
    from datetime import date, timedelta

    meta = dict(metadata or {})
    if source_ref:
        meta.setdefault("source_ref", source_ref)
    payload: dict[str, Any] = {
        "messages": [{"role": "user", "content": text}],
        "user_id": scope,
        "agent_id": agent_id,
        "metadata": meta,
        "infer": infer,
    }
    if ttl_days:
        payload["expiration_date"] = (date.today() + timedelta(days=int(ttl_days))).isoformat()
    return memory().add(**payload)


def search(
    query: str,
    *,
    scope: str,
    agent_id: str | None = None,
    top_k: int = 8,
    threshold: float | None = None,
    include_agent_private: bool = False,
) -> dict[str, Any]:
    filters: dict[str, Any] = {"user_id": scope}
    if agent_id:
        filters["agent_id"] = agent_id
    params: dict[str, Any] = {"query": query, "filters": filters, "top_k": top_k}
    if threshold is not None:
        params["threshold"] = threshold
    result = memory().search(**params)
    if include_agent_private and agent_id:
        private = memory().search(query=query, filters={"user_id": f"agents/{agent_id}"}, top_k=top_k)
        merged = list(result.get("results") or []) + list(private.get("results") or [])
        seen: set[str] = set()
        deduped = []
        for row in merged:
            key = row.get("id") or row.get("memory")
            if key in seen:
                continue
            seen.add(key)
            deduped.append(row)
        return {"results": deduped[:top_k]}
    return result


def get_all(scope: str, limit: int = 200) -> dict[str, Any]:
    return memory().get_all(filters={"user_id": scope}, top_k=limit)


def update(memory_id: str, text: str | None = None, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"memory_id": memory_id}
    if text is not None:
        params["data"] = text
    if metadata is not None:
        params["metadata"] = metadata
    return memory().update(**params)


def forget(memory_id: str) -> dict[str, Any]:
    return memory().delete(memory_id=memory_id)


def forget_scope(scope: str) -> dict[str, Any]:
    return memory().delete_all(user_id=scope)
