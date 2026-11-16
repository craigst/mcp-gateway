import json
import os
import select
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

MANAGER = Path(__file__).with_name('social-watchers-manager.mjs')


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / 'remy_watchers.py').write_text(
            'import os,sys,time\n'
            'with open(os.environ["STARTS"], "a") as f: f.write(sys.argv[1]+"\\n")\n'
            'time.sleep(60)\n'
        )
        self.starts = root / 'starts'
        self.env = {**os.environ, 'WATCHER_ROOT': str(root), 'WATCHER_LOG': str(root / 'log'),
                    'WATCHER_PYTHON': sys.executable, 'WATCHER_RESTART_DELAY_MS': '50',
                    'STARTS': str(self.starts)}
        self.env.pop('WATCHER_ENABLE_X', None)
        self.proc = None

    def tearDown(self):
        if self.proc is not None:
            self.proc.terminate()
            self.proc.wait(timeout=5)
            self.proc.stdin.close()
            self.proc.stdout.close()
            self.proc.stderr.close()
        self.temp.cleanup()

    def start(self):
        self.proc = subprocess.Popen(['node', str(MANAGER)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, env=self.env, bufsize=1)

    def call(self, name):
        self.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name}}) + '\n')
        self.proc.stdin.flush()
        ready, _, _ = select.select([self.proc.stdout], [], [], 5)
        self.assertTrue(ready, 'manager did not reply')
        return json.loads(self.proc.stdout.readline())

    def status(self):
        return json.loads(self.call('watchers_status')['result']['content'][0]['text'])

    def test_restart_creates_only_one_replacement_per_worker(self):
        self.start()
        first = self.status()
        self.assertEqual({s['source'] for s in first['sources']}, {'whatsapp', 'instagram', 'youtube'})
        self.call('watchers_restart')
        time.sleep(0.35)
        replacement = self.status()
        self.assertTrue(all(s['pid'] for s in replacement['sources']))
        replacement_pids = {s['source']: s['pid'] for s in replacement['sources']}
        time.sleep(0.2)
        self.assertEqual(replacement_pids, {s['source']: s['pid'] for s in self.status()['sources']})
        # Each source may be killed before its first child starts Python, so
        # the log has at most the initial and one replacement invocation.
        counts = self.starts.read_text().splitlines()
        self.assertTrue(all(counts.count(source) <= 2 for source in replacement_pids))

    def test_x_worker_is_explicitly_enabled(self):
        self.env['WATCHER_ENABLE_X'] = '1'
        self.start()
        self.assertIn('x', {s['source'] for s in self.status()['sources']})

    def test_missing_worker_executable_does_not_crash_manager(self):
        self.env['WATCHER_PYTHON'] = '/nonexistent/watcher-python'
        self.start()
        time.sleep(0.15)
        self.assertIsNone(self.proc.poll())
        self.assertTrue(all(s['pid'] is None for s in self.status()['sources']))


if __name__ == '__main__':
    unittest.main()
