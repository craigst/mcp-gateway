import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import httpx
import db
import knowledge
from migration import reconcile


class ReconcileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if (os.environ.get('BRAIN_DISPOSABLE_TEST') != '1' or
                os.environ.get('BRAIN_PG_DB') != 'mcp_gateway_test' or
                os.environ.get('DOCS_COLLECTION') != 'mcp_gateway_test_docs'):
            raise unittest.SkipTest('requires disposable services')
        db.ensure_schema()
        knowledge.ensure_collection()

    def test_apply_requires_matching_database_and_vector_markers(self):
        token = uuid.uuid4().hex
        with patch.dict(os.environ, {'BRAIN_MIGRATION_STAGE_TOKEN': token}):
            with self.assertRaises(Exception):
                reconcile.require_stage()
            with db.conn() as conn, conn.cursor() as cur:
                cur.execute('CREATE TABLE IF NOT EXISTS gateway_migration_guard (marker text NOT NULL)')
                cur.execute('DELETE FROM gateway_migration_guard')
                cur.execute('INSERT INTO gateway_migration_guard(marker) VALUES (%s)', (token,))
                conn.commit()
            with self.assertRaises(Exception):
                reconcile.require_stage()
            response = httpx.put(knowledge._q(f'/collections/mcp_migration_{token}'), json={'vectors': {'size': 1, 'distance': 'Cosine'}}, timeout=10)
            response.raise_for_status()
            try:
                reconcile.require_stage()
            finally:
                httpx.delete(knowledge._q(f'/collections/mcp_migration_{token}'), timeout=10)

    def test_missing_vectors_and_legacy_orphans_recover_without_changing_category(self):
        with tempfile.TemporaryDirectory(dir='/work') as temp:
            root = Path(temp)
            originals = root / 'originals'; originals.mkdir()
            doc = root / 'missing.txt'; doc.write_text('unique missing vector')
            fake_vectors = lambda texts: [[1.0] + [0.0] * (knowledge.MEM0_EMBED_DIMS - 1) for _ in texts]
            with patch.object(knowledge, 'DOCUMENT_ROOTS', str(root)), patch.object(knowledge, 'ORIGINALS_DIR', str(originals)), patch.object(knowledge, 'embed', side_effect=fake_vectors), patch.object(knowledge, 'extract_pages', return_value=([(0, 'stored text')], False, 'test')):
                with patch.object(knowledge, '_upsert', side_effect=RuntimeError('offline')):
                    with self.assertRaises(RuntimeError): knowledge.ingest(str(doc), category='homelab')
                with db.conn() as conn, conn.cursor() as cur:
                    cur.execute("UPDATE documents SET index_state = 'ready' WHERE filename = 'missing.txt'")
                    conn.commit()
                rows = reconcile.catalogue()
                missing = [row for key, row in rows.items() if key not in reconcile.vector_ids()]
                self.assertEqual(reconcile.repair_missing(missing), len(missing))
                point_id = str(uuid.uuid4())
                knowledge._upsert([{'id': point_id, 'vector': fake_vectors(['x'])[0], 'payload': {'text': 'legacy passage', 'original_path': '/archive/legacy.txt', 'filename': 'legacy.txt', 'category': 'financial'}}])
                self.assertEqual(reconcile.recover_legacy([point_id]), (1, 0))
                self.assertEqual(reconcile.recover_legacy([point_id]), (1, 0))
                found = knowledge.search('legacy', ['financial'])['results']
                self.assertTrue(any(row['text'] == 'legacy passage' and row['category'] == 'financial' for row in found))
                self.assertFalse(any(row['text'] == 'legacy passage' for row in knowledge.search('legacy', ['homelab'])['results']))


if __name__ == '__main__': unittest.main()
