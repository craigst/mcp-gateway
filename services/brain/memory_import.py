"""Idempotent external memory import using the existing Mem0 vector format."""
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
os.environ["MEM0_TELEMETRY"] = "false"  # before any mem0 module is imported

from mem0.memory.main import lemmatize_for_bm25

import db
import knowledge
from settings import MEM0_COLLECTION, QDRANT_TIMEOUT

RESERVED = {'data', 'hash', 'user_id', 'agent_id', 'run_id', 'actor_id', 'role',
            'created_at', 'updated_at', 'text_lemmatized', 'import_signature',
            'import_source', 'import_external_id', 'source_ref'}


def validate_item(item: dict[str, Any], actor: str) -> None:
    text, scope = item['text'], item['scope']
    if not text.strip() or not item['external_id'].strip():
        raise ValueError('Memory text and external identifier must not be blank')
    if not scope or (scope.startswith('agents/') and scope != f'agents/{actor}'):
        raise ValueError('The selected private memory scope does not belong to this agent')
    metadata = item.get('metadata') or {}
    if not isinstance(metadata, dict) or RESERVED.intersection(metadata):
        raise ValueError('Memory metadata contains reserved fields')
    if len(json.dumps(metadata, ensure_ascii=False).encode()) > 16_384:
        raise ValueError('Memory metadata is too large')
    created_at = item.get('created_at')
    if created_at:
        parsed = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('Memory creation time must include a timezone')


def import_one(source: str, item: dict[str, Any], actor: str) -> dict[str, Any]:
    validate_item(item, actor)
    external_id, text, scope = item['external_id'], item['text'], item['scope']
    metadata = item.get('metadata') or {}
    created_at = item.get('created_at')
    canonical = json.dumps({'text': text, 'scope': scope, 'actor': actor,
                            'source_ref': item.get('source_ref'), 'metadata': metadata,
                            'created_at': created_at}, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    signature = hashlib.sha256(canonical.encode()).hexdigest()
    point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(['mcp-gateway-memory-import', source, external_id], ensure_ascii=False)))
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute('''INSERT INTO external_memory_imports(source, external_id, point_id, actor, scope, signature)
                       VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (source, external_id) DO NOTHING''',
                    (source, external_id, point_id, actor, scope, signature))
        cur.execute('SELECT point_id, actor, scope, signature, state, created_at FROM external_memory_imports WHERE source = %s AND external_id = %s', (source, external_id))
        row = cur.fetchone()
        conn.commit()
    if not row or row['signature'] != signature or row['actor'] != actor or row['scope'] != scope or row['point_id'] != point_id:
        raise ValueError('The external memory identifier conflicts with an earlier import')
    existing = httpx.get(knowledge._q(f'/collections/{MEM0_COLLECTION}/points/{point_id}'), timeout=QDRANT_TIMEOUT)
    if existing.status_code == 200:
        payload = (existing.json().get('result') or {}).get('payload') or {}
        if payload.get('import_signature') != signature:
            raise ValueError('The destination memory identifier is already in use')
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute("UPDATE external_memory_imports SET state='ready', updated_at=now() WHERE source=%s AND external_id=%s", (source, external_id))
            conn.commit()
        return {'memory_id': point_id, 'skipped': True}
    if existing.status_code != 404:
        existing.raise_for_status()
    vector = knowledge.embed([text])[0]
    timestamp = created_at or row['created_at'].astimezone(timezone.utc).isoformat()
    payload = {**metadata, 'data': text, 'hash': hashlib.md5(text.encode(), usedforsecurity=False).hexdigest(),
               'user_id': scope, 'agent_id': actor, 'role': 'user', 'created_at': timestamp, 'updated_at': timestamp,
               'text_lemmatized': lemmatize_for_bm25(text), 'source_ref': item.get('source_ref'),
               'import_source': source, 'import_external_id': external_id, 'import_signature': signature}
    knowledge._qdrant_request('PUT', f'/collections/{MEM0_COLLECTION}/points?wait=true',
                              json_body={'points': [{'id': point_id, 'vector': vector, 'payload': payload}]})
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute("UPDATE external_memory_imports SET state='ready', updated_at=now() WHERE source=%s AND external_id=%s", (source, external_id))
        conn.commit()
    return {'memory_id': point_id, 'skipped': False}
