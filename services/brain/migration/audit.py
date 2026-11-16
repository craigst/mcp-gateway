"""Compare a brain catalogue with its vector collections without printing data.

Run against a restored staging copy. The report contains counts only; it never
prints memory contents, document paths, credentials, or individual IDs.
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db  # noqa: E402
import knowledge  # noqa: E402
from settings import DOCS_COLLECTION, MEM0_COLLECTION  # noqa: E402


def audit():
    with db.conn() as conn, conn.cursor() as cur:
        cur.execute('SELECT id, category, index_state FROM documents')
        documents = {row['id']: (row['category'], row['index_state']) for row in cur.fetchall()}
        cur.execute('SELECT qdrant_point_id, document_id FROM chunks')
        rows = cur.fetchall()
    chunks = {}
    duplicate_chunk_ids = 0
    for row in rows:
        point_id = str(row['qdrant_point_id'])
        if point_id in chunks:
            duplicate_chunk_ids += 1
        chunks[point_id] = row['document_id']

    vector_ids = set()
    findings = Counter()
    offset = None
    while True:
        request = {'limit': 1024, 'with_payload': ['document_id', 'category'], 'with_vector': False}
        if offset is not None:
            request['offset'] = offset
        response = knowledge._qdrant_request('POST', f'/collections/{DOCS_COLLECTION}/points/scroll', json_body=request)
        result = response.json()['result']
        for point in result['points']:
            point_id = str(point['id'])
            vector_ids.add(point_id)
            payload = point.get('payload') or {}
            catalog_id = chunks.get(point_id)
            if catalog_id is None:
                findings['vector_not_in_catalogue'] += 1
            else:
                if payload.get('document_id') != catalog_id:
                    findings['vector_document_mismatch'] += 1
                category = documents.get(catalog_id, (None, None))[0]
                if payload.get('category') != category:
                    findings['vector_category_mismatch'] += 1
            if payload.get('document_id') is None:
                findings['vector_without_document_id'] += 1
        offset = result.get('next_page_offset')
        if offset is None:
            break
    findings['catalogue_chunks_without_vector'] = len(set(chunks) - vector_ids)
    findings['duplicate_catalogue_point_ids'] = duplicate_chunk_ids
    findings['documents_not_ready'] = sum(state != 'ready' for _, state in documents.values())
    memory_response = knowledge._qdrant_request('POST', f'/collections/{MEM0_COLLECTION}/points/count', json_body={'exact': True})
    return {
        'documents': len(documents), 'catalogue_chunks': len(rows), 'document_vectors': len(vector_ids),
        'memory_vectors': memory_response.json()['result']['count'],
        'findings': dict(sorted(findings.items())),
        # This checks catalogue/vector consistency only. It does not verify
        # source freshness, files, permissions, search parity, or cutover safety.
        'index_consistent': not any(findings.values()),
    }


if __name__ == '__main__':
    print(json.dumps(audit(), indent=2, sort_keys=True))
