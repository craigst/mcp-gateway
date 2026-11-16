"""Run only against disposable Postgres and Qdrant containers."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

import db
import knowledge


def vector(texts):
    return [[1.0] + [0.0] * (knowledge.MEM0_EMBED_DIMS - 1) for _ in texts]


class KnowledgeIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if (os.environ.get('BRAIN_DISPOSABLE_TEST') != '1' or
                os.environ.get('BRAIN_PG_DB') != 'mcp_gateway_test' or
                os.environ.get('DOCS_COLLECTION') != 'mcp_gateway_test_docs'):
            raise unittest.SkipTest('requires an explicitly disposable brain database')
        db.ensure_schema()
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute('TRUNCATE documents CASCADE')
            conn.commit()
        httpx.delete(knowledge._q('/collections/mcp_gateway_test_docs'), timeout=10)
        knowledge.ensure_collection()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/work')
        self.root = Path(self.tmp.name)
        self.originals = self.root / 'originals'
        self.derived = self.root / 'derived'
        self.originals.mkdir()
        self.derived.mkdir()
        self.patches = [patch.object(knowledge, 'DOCUMENT_ROOTS', str(self.root)),
                        patch.object(knowledge, 'ORIGINALS_DIR', str(self.originals)),
                        patch.object(knowledge, 'DERIVED_DIR', str(self.derived)),
                        patch.object(knowledge, 'embed', side_effect=vector),
                        patch.object(knowledge, 'extract_pages', return_value=([(0, 'A meaningful sample passage')], False, 'test'))]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.tmp.cleanup()

    def test_failed_upsert_is_pending_and_retry_restores_search(self):
        file = self.root / 'report.txt'
        file.write_text('content to index')
        with patch.object(knowledge, '_upsert', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                knowledge.ingest(str(file), category='homelab')
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute("SELECT id, index_state FROM documents WHERE filename = %s", ('report.txt',))
            pending = cur.fetchone()
            self.assertEqual(pending['index_state'], 'pending')
        self.assertFalse(any(hit['document_id'] == pending['id'] for hit in knowledge.search('sample', ['homelab'])['results']))
        result = knowledge.ingest(str(file), category='homelab')
        self.assertTrue(result['repaired'])
        self.assertTrue(any(hit['document_id'] == result['document_id'] for hit in knowledge.search('sample', ['homelab'])['results']))
        with self.assertRaisesRegex(ValueError, 'another category'):
            knowledge.ingest(str(file), category='financial')

    def test_metadata_cannot_change_the_authoritative_category(self):
        result = knowledge._store_batch([{'path': '/archive/synthetic', 'text': 'private text for category testing',
                                          'category': 'financial', 'metadata': {'category': 'homelab'}}],
                                        actor='test', default_category='personal')
        self.assertEqual(result['documents'], 1)
        hits = knowledge.search('private', ['homelab'])['results']
        self.assertFalse(any(hit['text'] == 'private text for category testing' for hit in hits))
        self.assertTrue(any(hit['text'] == 'private text for category testing' for hit in knowledge.search('private', ['financial'])['results']))

    def test_document_catalogue_respects_categories_and_paginates(self):
        from fastapi.testclient import TestClient
        import app
        knowledge._store_batch([{'path': '/archive/a', 'text': 'catalogue public content', 'category': 'homelab'},
                                {'path': '/archive/b', 'text': 'catalogue restricted content', 'category': 'financial'},
                                {'path': '/archive/c', 'text': 'catalogue second public document', 'category': 'homelab'}],
                               actor='test', default_category='personal')
        client = TestClient(app.app)
        headers = {'authorization': 'Bearer synthetic-brain-key', 'x-brain-allowed-categories': 'homelab'}
        response = client.get('/knowledge/documents?limit=1', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['documents']), 1)
        self.assertEqual(response.json()['documents'][0]['category'], 'homelab')
        self.assertTrue(response.json()['has_more'])
        next_page = client.get('/knowledge/documents?limit=1&offset=1', headers=headers).json()
        self.assertNotEqual(response.json()['documents'][0]['id'], next_page['documents'][0]['id'])
        self.assertEqual(client.get('/knowledge/documents?category=financial', headers=headers).status_code, 403)
        self.assertEqual(client.get('/knowledge/documents', headers={'authorization': 'Bearer synthetic-brain-key'}).status_code, 403)
        client.close()

    def test_search_rejects_stale_vectors_and_uses_catalogue_text(self):
        file = self.root / 'trusted.txt'
        file.write_text('unique search guard bytes')
        result = knowledge.ingest(str(file), category='homelab')
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute('SELECT qdrant_point_id FROM chunks WHERE document_id = %s', (result['document_id'],))
            point = cur.fetchone()['qdrant_point_id']
        forged = {'id': point, 'score': 1.0, 'payload': {'document_id': result['document_id'],
                  'category': 'homelab', 'text': 'forged vector text'}}
        orphan = {'id': '00000000-0000-0000-0000-000000000000', 'score': 0.9,
                  'payload': {'document_id': result['document_id'], 'category': 'homelab', 'text': 'stale'}}
        with patch.object(knowledge, '_search_qdrant', return_value=[forged, orphan]):
            hits = knowledge.search('sample', ['homelab'])['results']
        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]['text'], 'A meaningful sample passage')

    def test_reextract_preserves_original_and_swaps_only_after_success(self):
        file = self.root / 'reindex.txt'
        file.write_text('unique bytes for re-extraction')
        result = knowledge.ingest(str(file), category='homelab')
        stored = Path(result['original_path'])
        with patch.object(knowledge, '_upsert', side_effect=RuntimeError('offline')):
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                knowledge.ingest(str(file), category='homelab', force=True)
        self.assertTrue(stored.exists())
        self.assertTrue(any(hit['document_id'] == result['document_id'] for hit in knowledge.search('sample', ['homelab'])['results']))
        with patch.object(knowledge, 'extract_pages', return_value=([], False, 'empty')):
            with self.assertRaisesRegex(ValueError, 'no usable text'):
                knowledge.ingest(str(file), category='homelab', force=True)
        with patch.object(knowledge, 'extract_pages', return_value=([(1, 'Replacement passage')], False, 'updated')):
            updated = knowledge.ingest(str(file), category='homelab', force=True)
        self.assertTrue(updated['reindexed'])
        self.assertEqual(updated['document_id'], result['document_id'])
        self.assertTrue(stored.exists())
        matches = [hit for hit in knowledge.search('sample', ['homelab'])['results'] if hit['document_id'] == result['document_id']]
        self.assertEqual([hit['text'] for hit in matches], ['Replacement passage'])
        with self.assertRaisesRegex(ValueError, 'another category'):
            knowledge.ingest(str(file), category='financial', force=True)

    def test_forget_does_not_remove_siblings_or_external_archive(self):
        file = self.root / 'owned.txt'
        file.write_text('unique owned bytes')
        result = knowledge.ingest(str(file), category='homelab')
        stored = Path(result['original_path'])
        sibling = stored.parent / 'sibling.txt'
        sibling.write_text('must remain')
        knowledge.forget(result['document_id'])
        self.assertTrue(sibling.exists())
        self.assertTrue(file.exists())
        archive = self.root / 'archive'
        archive.mkdir()
        external = archive / 'external.txt'
        external.write_text('external archive bytes')
        indexed = knowledge.ingest(str(external), category='homelab', keep_original=False)
        knowledge.forget(indexed['document_id'])
        self.assertTrue(external.exists())
        self.assertTrue(archive.exists())


if __name__ == '__main__':
    unittest.main()
