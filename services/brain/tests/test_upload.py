import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir='/work')
        self.root = Path(self.tmp.name)
        self.patches = [patch.object(app, 'UPLOAD_DIR', str(self.root / 'uploads')),
                        patch.object(app.know, 'DOCUMENT_ROOTS', str(self.root)),
                        patch.object(app.db, 'record_event')]
        for item in self.patches: item.start()
        self.client = TestClient(app.app)
        self.headers = {'authorization': 'Bearer synthetic-brain-key',
                        'x-brain-allowed-categories': 'homelab',
                        'content-type': 'application/octet-stream'}

    def tearDown(self):
        self.client.close()
        for item in reversed(self.patches): item.stop()
        self.tmp.cleanup()

    def test_upload_is_streamed_and_staging_is_removed(self):
        def ingest(path, source, actor, category):
            self.assertEqual(Path(path).read_bytes(), b'example')
            self.assertEqual((source, category), ('gateway-upload', 'homelab'))
            return {'document_id': 17, 'category': category}
        with patch.object(app.know, 'ingest', side_effect=ingest):
            response = self.client.post('/knowledge/upload?filename=report.txt&category=homelab', headers=self.headers, content=b'example')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['document_id'], 17)
        self.assertEqual(list((self.root / 'uploads').iterdir()), [])

    def test_upload_rejects_wrong_category_unsafe_filename_and_large_body(self):
        response = self.client.post('/knowledge/upload?filename=report.txt&category=financial', headers=self.headers, content=b'x')
        self.assertEqual(response.status_code, 403)
        response = self.client.post('/knowledge/upload?filename=..%2Fsecret&category=homelab', headers=self.headers, content=b'x')
        self.assertEqual(response.status_code, 400)
        with patch.object(app, 'MAX_INGEST_BYTES', 4):
            response = self.client.post('/knowledge/upload?filename=report.txt&category=homelab', headers=self.headers, content=b'12345')
        self.assertEqual(response.status_code, 413)
        self.assertFalse((self.root / 'uploads').exists())

    def test_upload_requires_backend_key(self):
        response = self.client.post('/knowledge/upload?filename=report.txt&category=homelab', headers={'content-type': 'application/octet-stream'}, content=b'x')
        self.assertEqual(response.status_code, 401)

    def test_read_only_stage_rejects_upload_even_with_valid_credentials(self):
        with patch.dict(os.environ, {'BRAIN_READ_ONLY': '1'}), patch.object(app.know, 'ingest') as ingest:
            response = self.client.post('/knowledge/upload?filename=report.txt&category=homelab', headers=self.headers, content=b'example')
        self.assertEqual(response.status_code, 503)
        ingest.assert_not_called()

    def test_upload_rejects_stream_that_exceeds_the_limit_without_content_length(self):
        with patch.object(app, 'MAX_INGEST_BYTES', 4), patch.object(app.know, 'ingest') as ingest:
            response = self.client.post('/knowledge/upload?filename=report.txt&category=homelab', headers=self.headers, content=iter([b'123', b'45']))
        self.assertEqual(response.status_code, 413)
        ingest.assert_not_called()

    def test_private_memory_scope_is_not_accessible_to_another_agent(self):
        headers = {'authorization': 'Bearer synthetic-brain-key', 'x-brain-actor': 'agent-a'}
        cases = [('/memory/search', {'query': 'fact', 'scope': 'agents/agent-b'}),
                 ('/memory/add', {'text': 'fact', 'scope': 'agents/agent-b'}),
                 ('/memory/get_all', {'scope': 'agents/agent-b'}),
                 ('/memory/forget', {'scope': 'agents/agent-b'})]
        for path, body in cases:
            self.assertEqual(self.client.post(path, headers=headers, json=body).status_code, 403, path)
        with patch.object(app.know, '_qdrant_request') as retrieve:
            retrieve.return_value.json.return_value = {'result': [{'payload': {'user_id': 'agents/agent-b'}}]}
            memory_id = '00000000-0000-0000-0000-000000000001'
            self.assertEqual(self.client.post('/memory/update', headers=headers, json={'memory_id': memory_id, 'text': 'changed'}).status_code, 403)
            self.assertEqual(self.client.post('/memory/forget', headers=headers, json={'memory_id': memory_id}).status_code, 403)

    def test_external_memory_import_checks_identity_and_scope_before_writing(self):
        body = {'source': 'external', 'items': [{'external_id': 'id-1', 'text': 'fact', 'scope': 'agents/other'}]}
        headers = {'authorization': 'Bearer synthetic-brain-key', 'x-brain-actor': 'agent-a'}
        with patch.object(app.memory_import, 'import_one') as save:
            response = self.client.post('/memory/import', headers=headers, json=body)
            self.assertEqual(response.status_code, 400)
            save.assert_not_called()
            body['items'][0]['scope'] = 'agents/agent-a'
            save.return_value = {'memory_id': 'synthetic', 'skipped': False}
            response = self.client.post('/memory/import', headers=headers, json=body)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(save.call_args.args[2], 'agent-a')


if __name__ == '__main__':
    unittest.main()
