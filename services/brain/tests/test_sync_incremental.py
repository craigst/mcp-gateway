import unittest
from migration.sync_incremental import compare


class IncrementalSyncTests(unittest.TestCase):
    def test_detects_new_removed_and_changed_memory_without_exposing_contents(self):
        source = {'new': {'id': 'new', 'payload': {'data': 'new'}, 'vector': [1]},
                  'changed': {'id': 'changed', 'payload': {'data': 'updated'}, 'vector': [1]}}
        target = {'old': {'id': 'old', 'payload': {}, 'vector': [1]},
                  'changed': {'id': 'changed', 'payload': {'data': 'original'}, 'vector': [1]}}
        missing, target_only, changed = compare(source, target, True)
        self.assertEqual([point['id'] for point in missing], ['new'])
        self.assertEqual((target_only, changed), (1, 1))

    def test_document_comparison_does_not_claim_to_compare_existing_vectors(self):
        missing, target_only, changed = compare({'one': {'id': 'one'}}, {'one': {'id': 'one'}}, False)
        self.assertEqual((missing, target_only, changed), ([], 0, None))

    def test_apply_requires_guard_and_refuses_changed_memory(self):
        from unittest.mock import patch
        from migration import sync_incremental as sync
        point = {'id': 'one', 'payload': {'data': 'new'}, 'vector': [1]}
        old = {'id': 'one', 'payload': {'data': 'old'}, 'vector': [1]}
        with patch('sys.argv', ['sync', '--source-url', 'http://source:6333', '--collection', sync.MEM0_COLLECTION, '--apply']), \
             patch.object(sync, 'require_stage') as guard, \
             patch.object(sync, 'scan', side_effect=[{'one': point}, {'one': old}]), \
             patch.object(sync.knowledge, '_qdrant_request') as mutate:
            with self.assertRaisesRegex(RuntimeError, 'diverged'):
                sync.main()
            guard.assert_called_once()
            mutate.assert_not_called()

    def test_apply_copies_only_new_points_after_guard(self):
        import contextlib
        import io
        from unittest.mock import patch
        from migration import sync_incremental as sync
        point = {'id': 'one', 'payload': {'data': 'fact'}, 'vector': [1]}
        with patch('sys.argv', ['sync', '--source-url', 'http://source:6333', '--collection', sync.MEM0_COLLECTION, '--apply']), \
             patch.object(sync, 'require_stage') as guard, \
             patch.object(sync, 'scan', side_effect=[{'one': point}, {}]), \
             patch.object(sync.knowledge, '_qdrant_request') as mutate, \
             contextlib.redirect_stdout(io.StringIO()):
            sync.main()
            guard.assert_called_once()
            self.assertEqual(mutate.call_args.kwargs['json_body']['points'], [point])
