import os
import unittest
from unittest.mock import patch

import httpx
import db
import knowledge
import memory_import


class MemoryImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if (os.environ.get('BRAIN_DISPOSABLE_TEST') != '1' or
                os.environ.get('BRAIN_PG_DB') != 'mcp_gateway_test' or
                os.environ.get('MEM0_COLLECTION') != 'mcp_gateway_test_memories'):
            raise unittest.SkipTest('requires disposable memory services')
        db.ensure_schema()
        with db.conn() as conn, conn.cursor() as cur:
            cur.execute('TRUNCATE external_memory_imports')
            conn.commit()
        httpx.delete(knowledge._q('/collections/mcp_gateway_test_memories'), timeout=10)
        result = httpx.put(knowledge._q('/collections/mcp_gateway_test_memories'), json={'vectors': {'size': knowledge.MEM0_EMBED_DIMS, 'distance': 'Cosine'}}, timeout=10)
        result.raise_for_status()

    def setUp(self):
        self.patcher = patch.object(knowledge, 'embed', side_effect=lambda texts: [[1.0] + [0.0] * (knowledge.MEM0_EMBED_DIMS - 1) for _ in texts])
        self.patcher.start()

    def tearDown(self): self.patcher.stop()

    def test_import_is_idempotent_and_rejects_conflicting_content(self):
        item = {'external_id': 'source-1', 'text': 'A durable fact', 'scope': 'shared', 'source_ref': 'external:1', 'metadata': {}}
        first = memory_import.import_one('example', item, 'agent-a')
        again = memory_import.import_one('example', item, 'agent-a')
        self.assertFalse(first['skipped'])
        self.assertTrue(again['skipped'])
        self.assertEqual(first['memory_id'], again['memory_id'])
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            memory_import.import_one('example', {**item, 'text': 'Different fact'}, 'agent-a')
        with self.assertRaisesRegex(ValueError, 'conflicts'):
            memory_import.import_one('example', item, 'agent-b')

    def test_failed_vector_write_can_be_retried_without_duplicate(self):
        item = {'external_id': 'source-2', 'text': 'Retry this fact', 'scope': 'shared', 'metadata': {}}
        with patch.object(knowledge, '_qdrant_request', side_effect=RuntimeError('offline')):
            with self.assertRaises(RuntimeError): memory_import.import_one('example', item, 'agent-a')
        result = memory_import.import_one('example', item, 'agent-a')
        self.assertFalse(result['skipped'])
        self.assertTrue(memory_import.import_one('example', item, 'agent-a')['skipped'])

    def test_import_cannot_override_actor_or_private_scope(self):
        item = {'external_id': 'source-3', 'text': 'fact', 'scope': 'agents/other', 'metadata': {}}
        with self.assertRaisesRegex(ValueError, 'private'):
            memory_import.import_one('example', item, 'agent-a')
        with self.assertRaisesRegex(ValueError, 'reserved'):
            memory_import.import_one('example', {**item, 'scope': 'shared', 'metadata': {'agent_id': 'other'}}, 'agent-a')


if __name__ == '__main__': unittest.main()
