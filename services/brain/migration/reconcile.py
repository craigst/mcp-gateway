"""Repair a restored, explicitly marked staging copy of a brain index.

Default is a dry run. Applying requires the same randomly generated stage marker
in Postgres and Qdrant, and never deletes source data or existing vectors.
"""
import argparse
import hashlib
import hmac
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db  # noqa: E402
import knowledge  # noqa: E402
from settings import DOCS_COLLECTION, MEM0_EMBED_DIMS, MEM0_EMBED_MODEL  # noqa: E402


def require_stage():
    token = os.environ.get('BRAIN_MIGRATION_STAGE_TOKEN', '')
    if not re.fullmatch(r'[a-f0-9]{32}', token):
        raise RuntimeError('A valid staging marker is required')
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute('SELECT marker FROM gateway_migration_guard LIMIT 1')
        row = cur.fetchone()
    if not row or not hmac.compare_digest(row['marker'], token):
        raise RuntimeError('Postgres staging marker does not match')
    response = knowledge._qdrant_request('GET', f'/collections/mcp_migration_{token}')
    if not response.json().get('result'):
        raise RuntimeError('Qdrant staging marker is missing')


def vector_ids():
    ids = set()
    offset = None
    while True:
        data = {'limit': 1024, 'with_payload': False, 'with_vector': False}
        if offset is not None: data['offset'] = offset
        result = knowledge._qdrant_request('POST', f'/collections/{DOCS_COLLECTION}/points/scroll', json_body=data).json()['result']
        ids.update(str(point['id']) for point in result['points'])
        offset = result.get('next_page_offset')
        if offset is None: return ids


def catalogue():
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute('''SELECT c.qdrant_point_id, c.ordinal, c.page, c.text, d.id, d.original_path,
                              d.filename, d.content_hash, d.source_kind, d.category, d.embed_model, d.embed_dims, d.meta
                       FROM chunks c JOIN documents d ON d.id = c.document_id''')
        rows = cur.fetchall()
    return {str(row['qdrant_point_id']): row for row in rows}


def repair_missing(rows):
    repaired = 0
    # Small batches and a short pause give the live model service time to serve
    # existing bots while the isolated staging copy is being repaired.
    batch_size = 16
    for start in range(0, len(rows), batch_size):
        batch = rows[start:start + batch_size]
        for row in batch:
            if row['embed_model'] != MEM0_EMBED_MODEL or row['embed_dims'] != MEM0_EMBED_DIMS:
                raise RuntimeError('Cannot repair a chunk with a different embedding model or dimensions')
        vectors = knowledge.embed([row['text'] for row in batch])
        points = []
        for row, vector in zip(batch, vectors):
            metadata = row['meta'] if isinstance(row['meta'], dict) else {}
            extra = {k: v for k, v in metadata.items() if isinstance(v, (str, int, float, bool))}
            points.append({'id': row['qdrant_point_id'], 'vector': vector, 'payload': {
                **extra, 'document_id': row['id'], 'ordinal': row['ordinal'], 'page': row['page'],
                'text': row['text'], 'original_path': row['original_path'], 'filename': row['filename'],
                'content_hash': row['content_hash'], 'source_kind': row['source_kind'], 'category': row['category'],
            }})
        knowledge._upsert(points)
        repaired += len(points)
        if start + batch_size < len(rows):
            time.sleep(1)
    return repaired


def recover_legacy(point_ids):
    recovered = 0
    unresolved = 0
    for start in range(0, len(point_ids), 128):
        ids = point_ids[start:start + 128]
        response = knowledge._qdrant_request('POST', f'/collections/{DOCS_COLLECTION}/points', json_body={'ids': ids, 'with_payload': True, 'with_vector': False})
        for point in response.json()['result']:
            payload = point.get('payload') or {}
            text, path, category = payload.get('text'), payload.get('original_path'), payload.get('category')
            if (not isinstance(text, str) or not text or not isinstance(path, str) or
                    not path or category not in knowledge.CATEGORIES):
                unresolved += 1
                continue
            point_id = str(point['id'])
            digest = hashlib.sha256(('legacy-qdrant-point:' + point_id).encode()).hexdigest()
            with db.conn() as conn, conn.cursor() as cur:
                cur.execute('SELECT c.document_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.qdrant_point_id = %s AND d.source_kind = %s', (point_id, 'legacy-vector'))
                existing = cur.fetchone()
                if existing:
                    document_id = existing['document_id']
                    if payload.get('document_id') not in (None, document_id):
                        unresolved += 1
                        continue
                else:
                    if payload.get('document_id') is not None:
                        unresolved += 1
                        continue
                    name = str(payload.get('filename') or Path(path).name or 'legacy-document')
                    metadata = json.dumps({'migration': 'legacy-vector', 'content_hash_is_synthetic': True, 'original_point_id': point_id})
                    cur.execute('''INSERT INTO documents (content_hash, original_path, filename, bytes, source_kind, category, embed_model, embed_dims, meta, index_state)
                                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'pending') RETURNING id''',
                                (digest, path, name, len(text.encode('utf8')), 'legacy-vector', category, MEM0_EMBED_MODEL, MEM0_EMBED_DIMS, metadata))
                    document_id = cur.fetchone()['id']
                    page = payload.get('page') if isinstance(payload.get('page'), int) and payload['page'] >= 0 else 0
                    cur.execute('INSERT INTO chunks (document_id, ordinal, page, text, qdrant_point_id, chars) VALUES (%s,0,%s,%s,%s,%s)',
                                (document_id, page, text, point_id, len(text)))
                    conn.commit()
            knowledge._qdrant_request('POST', f'/collections/{DOCS_COLLECTION}/points/payload?wait=true',
                                      json_body={'points': [point['id']], 'payload': {'document_id': document_id, 'ordinal': 0}})
            with db.conn() as conn, conn.cursor() as cur:
                cur.execute("UPDATE documents SET index_state = 'ready' WHERE id = %s", (document_id,))
                conn.commit()
            recovered += 1
    return recovered, unresolved


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply: require_stage()
    vectors = vector_ids()
    rows = catalogue()
    missing = sorted(set(rows) - vectors)
    orphans = sorted(vectors - set(rows))
    report = {'missing_vectors': len(missing), 'orphan_vectors': len(orphans), 'applied': args.apply}
    if args.apply:
        report['vectors_rebuilt'] = repair_missing([rows[key] for key in missing])
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT c.qdrant_point_id FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.source_kind = 'legacy-vector' AND d.index_state = 'pending'")
            pending = [str(row['qdrant_point_id']) for row in cur.fetchall()]
        report['legacy_vectors_recovered'], report['unresolved_orphans'] = recover_legacy(sorted(set(orphans) | set(pending)))
    print(json.dumps(report, sort_keys=True))


if __name__ == '__main__':
    main()
