import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('mcp-gateway-update.sh')

DOCKER = r'''#!/usr/bin/env bash
set -eu
printf '%s\n' "$* MCP_IMAGE_TAG=${MCP_IMAGE_TAG:-}" >> "$CASE_DIR/calls"
if [[ "$1" == inspect ]]; then echo old-image; exit 0; fi
if [[ "$1 $2" == 'image inspect' ]]; then
  if [[ "$*" == *org.opencontainers* ]]; then echo 0.16.0; else echo new-image; fi
  exit 0
fi
if [[ "$1" == tag ]]; then exit 0; fi
if [[ "$1" == logs ]]; then exit 0; fi
if [[ "$1" == compose ]]; then
  case "$4" in
    config) echo ghcr.io/craigst/mcp-gateway:0.16.0 ;;
    pull) : ;;
    stop) echo stopped > "$CASE_DIR/state" ;;
    up)
      if [[ "${MCP_IMAGE_TAG:-}" == rollback ]]; then
        echo rollback > "$CASE_DIR/state"
      else
        echo new > "$CASE_DIR/state"
        echo changed > "$CASE_DIR/data/gateway.db"
        echo changed-wal > "$CASE_DIR/data/gateway.db-wal"
        [[ "${CASE_FAIL_UP:-0}" == 0 ]] || exit 1
      fi ;;
    *) exit 9 ;;
  esac
  exit 0
fi
exit 8
'''

CURL = r'''#!/usr/bin/env bash
if [[ "$(cat "$CASE_DIR/state")" == rollback ]] || [[ "${CASE_HEALTHY:-0}" == 1 ]]; then
  echo '{"ok":true}'
  exit 0
fi
exit 1
'''

CP = r'''#!/usr/bin/env bash
if [[ "${CASE_FAIL_BACKUP:-0}" == 1 && "$*" == *gateway-pre-* ]]; then exit 1; fi
exec /usr/bin/cp "$@"
'''


class UpdaterTest(unittest.TestCase):
    def run_case(self, **options):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = pathlib.Path(temp.name)
        (root / 'bin').mkdir()
        (root / 'data').mkdir()
        (root / 'data/gateway.db').write_text('original database\n')
        (root / 'data/gateway.db-wal').write_text('original wal\n')
        (root / 'state').write_text('old')
        for name, content in [('docker', DOCKER), ('curl', CURL), ('cp', CP)]:
            file = root / 'bin' / name
            file.write_text(content)
            file.chmod(0o755)
        env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'],
                   CASE_DIR=str(root), COMPOSE_DIR=str(root),
                   LOCK_FILE=str(root / 'lock'), HEALTH_TRIES='1', HEALTH_SLEEP='0', **options)
        result = subprocess.run(['bash', str(SCRIPT)], env=env, text=True,
                                capture_output=True, timeout=10)
        return root, result

    def test_success_keeps_new_database_and_backup(self):
        root, result = self.run_case(CASE_HEALTHY='1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((root / 'state').read_text().strip(), 'new')
        backup = next((root / 'backups').glob('*.db'))
        self.assertEqual(backup.read_text(), 'original database\n')
        self.assertEqual(pathlib.Path(str(backup) + '-wal').read_text(), 'original wal\n')

    def test_failed_new_start_restores_database_and_wal(self):
        root, result = self.run_case(CASE_FAIL_UP='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / 'state').read_text().strip(), 'rollback')
        self.assertEqual((root / 'data/gateway.db').read_text(), 'original database\n')
        self.assertEqual((root / 'data/gateway.db-wal').read_text(), 'original wal\n')

    def test_failed_health_restores_database_and_wal(self):
        root, result = self.run_case()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / 'state').read_text().strip(), 'rollback')
        self.assertEqual((root / 'data/gateway.db').read_text(), 'original database\n')
        self.assertEqual((root / 'data/gateway.db-wal').read_text(), 'original wal\n')

    def test_failed_backup_restarts_old_image_without_restore(self):
        root, result = self.run_case(CASE_FAIL_BACKUP='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((root / 'state').read_text().strip(), 'rollback')
        self.assertEqual((root / 'data/gateway.db').read_text(), 'original database\n')
        self.assertEqual((root / 'data/gateway.db-wal').read_text(), 'original wal\n')


if __name__ == '__main__':
    unittest.main()
