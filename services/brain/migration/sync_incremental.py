"""Copy source-only vectors to a marked staging target without overwriting data.

This is not a final cutover. The source may change while it is scanned, source
items removed after a snapshot are never deleted, and document IDs already on
the target are not compared. Coordinate every source writer and repeat all
integrity checks before switching clients.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import knowledge  # noqa: E402
from migration.reconcile import require_stage  # noqa: E402
from settings import DOCS_COLLECTION, MEM0_COLLECTION, QDRANT_TIMEOUT  # noqa: E402


def fingerprint(point):
    return hashlib.sha256(json.dumps({'payload': point.get('payload'), 'vector': point.get('vector')},
                                     sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def compare(source, target, compare_existing):
    missing = [source[key] for key in source.keys() - target.keys()]
    target_only = len(target.keys() - source.keys())
    changed = sum(fingerprint(source[key]) != fingerprint(target[key]) for key in source.keys() & target.keys()) if compare_existing else None
    return missing, target_only, changed


def scan(base, collection, include_data, key=None):
    parsed = urlsplit(base)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Invalid Qdrant source URL')
    headers = {'api-key': key} if key else {}
    points = {}
    offset = None
    with httpx.Client(timeout=QDRANT_TIMEOUT, headers=headers, follow_redirects=False) as client:
        while True:
            body = {'limit': 256 if include_data else 1024, 'with_payload': include_data, 'with_vector': include_data}
            if offset is not None:
                body['offset'] = offset
            response = client.post(f'{base.rstrip("/")}/collections/{collection}/points/scroll', json=body)
            response.raise_for_status()
            result = response.json()['result']
            for point in result['points']:
                points[str(point['id'])] = point
            offset = result.get('next_page_offset')
            if offset is None:
                return points


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-url', required=True, help='Read-only source Qdrant URL; credentials belong in SOURCE_QDRANT_API_KEY')
    parser.add_argument('--collection', required=True, choices=[MEM0_COLLECTION, DOCS_COLLECTION, 'agent-context', 'queen-memory'])
    parser.add_argument('--apply', action='store_true', help='Copy only missing points to an explicitly marked staging target')
    args = parser.parse_args()
    if args.apply:
        require_stage()
    is_documents = args.collection == DOCS_COLLECTION
    target_url = knowledge._q('')
    # Documents can number in the hundreds of thousands; compare IDs first and
    # request full payloads and vectors only for missing source points.
    source = scan(args.source_url, args.collection, not is_documents, os.environ.get('SOURCE_QDRANT_API_KEY'))
    target = scan(target_url, args.collection, not is_documents)
    missing, target_only, changed = compare(source, target, not is_documents)
    result = {'collection': args.collection, 'source_only': len(missing), 'target_only': target_only,
              'changed_existing': changed, 'document_existing_points_compared': not is_documents,
              'applied': False, 'cutover_ready': False}
    if args.apply:
        # Memory snapshots should be identical except for newly created records.
        # Never overwrite a changed point or silently resurrect a deleted one.
        if not is_documents and (target_only or changed):
            raise RuntimeError('Memory records diverged; review changes before synchronizing')
        if is_documents and missing:
            ids = [point['id'] for point in missing]
            missing = []
            with httpx.Client(timeout=QDRANT_TIMEOUT, headers={'api-key': os.environ['SOURCE_QDRANT_API_KEY']} if os.environ.get('SOURCE_QDRANT_API_KEY') else {}, follow_redirects=False) as client:
                for start in range(0, len(ids), 128):
                    response = client.post(f'{args.source_url.rstrip("/")}/collections/{args.collection}/points', json={'ids': ids[start:start+128], 'with_payload': True, 'with_vector': True})
                    response.raise_for_status()
                    missing.extend(response.json()['result'])
            if len(missing) != len(ids):
                raise RuntimeError('Source changed during scan; repeat the audit')
        for start in range(0, len(missing), 64):
            knowledge._qdrant_request('PUT', f'/collections/{args.collection}/points?wait=true', json_body={'points': missing[start:start+64]})
        result['applied'] = True
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
