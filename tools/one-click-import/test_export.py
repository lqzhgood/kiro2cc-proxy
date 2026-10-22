"""Run only against synthetic fixtures; never use the user's Kiro cache or clipboard."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts/fork/get-kiro-info.sh'
BASH = os.environ.get('KIRO_TEST_BASH') or shutil.which('bash')


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kiro-export-test-')
        self.addCleanup(self.temp.cleanup)
        self.fixture = Path(self.temp.name)
        self.cache = self.fixture / '.aws/sso/cache'
        self.cache.mkdir(parents=True)
        machine = self.fixture / 'Library/Application Support/kiro/machineid'
        machine.parent.mkdir(parents=True)
        machine.write_text('a' * 64, encoding='utf-8')
        self.bin = self.fixture / 'bin'
        self.bin.mkdir()
        self.command('uname', '#!/usr/bin/env bash\nprintf Darwin\n')
        self.command('pbcopy', '#!/usr/bin/env bash\ncat > "$KIRO_TEST_CLIPBOARD"\n')
        self.command('python3', '#!/usr/bin/env bash\nexec ' + shlex.quote(Path(sys.executable).as_posix()) + ' "$@"\n')
        self.clipboard = self.fixture / 'clipboard.txt'
        self.env = {**os.environ, 'KIRO_EXPORT_ROOT': self.fixture.as_posix(),
                    'KIRO_TEST_CLIPBOARD': self.clipboard.as_posix(),
                    'KIRO_TEST_BIN': self.bin.as_posix()}

    def command(self, name, content):
        path = self.bin / name
        path.write_text(content, encoding='utf-8', newline='\n')
        path.chmod(0o755)

    def token(self, **fields):
        value = {'refreshToken': 'synthetic-refresh-token', 'authMethod': 'social',
                 'profileArn': 'arn:aws:test:profile', 'region': 'us-east-1', **fields}
        (self.cache / 'kiro-auth-token.json').write_text(json.dumps(value), encoding='utf-8')

    def run_bash(self, *args):
        # Git Bash adds its own tools to PATH at startup. Prepend mocks inside Bash,
        # after converting a Windows drive path, so tests never reach real pbcopy.
        wrapper = ('if command -v cygpath >/dev/null 2>&1; then '
                   'KIRO_TEST_BIN="$(cygpath -u "$KIRO_TEST_BIN")"; fi; '
                   'export PATH="$KIRO_TEST_BIN:$PATH"; exec bash "$@"')
        return subprocess.run([BASH, '--noprofile', '--norc', '-c', wrapper, 'test-export', SCRIPT.as_posix(), *args],
                              env=self.env, capture_output=True, text=True, encoding='utf-8', timeout=15)

    def run_export(self, *args):
        result = self.run_bash('get', '--email', 'test@example.invalid', *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        marker = '账户 JSON（可手动复制下方内容）\n'
        self.assertIn(marker, result.stdout)
        payload, _ = json.JSONDecoder().raw_decode(result.stdout.split(marker, 1)[1])
        return result, payload

    def test_social_prints_complete_json_and_final_copy_success(self):
        self.token()
        result, payload = self.run_export()
        self.assertEqual(json.loads(self.clipboard.read_text(encoding='utf-8')), payload)
        self.assertEqual(payload[0]['refreshToken'], 'synthetic-refresh-token')
        self.assertNotIn('clientSecret', payload[0])
        self.assertEqual(payload[0]['machineId'], 'a' * 64)
        self.assertIn('已复制到剪贴板', result.stdout.splitlines()[-2])
        self.assertGreater(result.stdout.index('已复制到剪贴板'), result.stdout.index('账户 JSON'))

    def test_copy_failure_still_prints_json_and_never_claims_success(self):
        self.token()
        self.command('pbcopy', '#!/usr/bin/env bash\nexit 1\n')
        result, payload = self.run_export('--stdout')
        self.assertEqual(payload[0]['email'], 'test@example.invalid')
        self.assertIn('未能复制到剪贴板', result.stdout.splitlines()[-2])
        self.assertNotIn('已复制到剪贴板', result.stdout)

    def test_idc_registration_and_output_file(self):
        self.token(authMethod='IdC', clientIdHash='test-client')
        (self.cache / 'test-client.json').write_text(json.dumps({'clientId': 'fake-client', 'clientSecret': 'fake-secret'}), encoding='utf-8')
        output = self.fixture / 'export.json'
        _, payload = self.run_export('--out', output.as_posix())
        self.assertEqual(payload[0]['authMethod'], 'idc')
        self.assertEqual(payload[0]['clientSecret'], 'fake-secret')
        self.assertEqual(json.loads(output.read_text(encoding='utf-8')), payload)

    def test_non_mac_is_rejected_before_reading_credentials(self):
        self.command('uname', '#!/usr/bin/env bash\nprintf Linux\n')
        result = self.run_bash('get', '--email', 'test@example.invalid')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('仅支持 macOS', result.stderr)
        self.assertFalse(self.clipboard.exists())


if __name__ == '__main__':
    if not BASH:
        raise SystemExit('Bash is required; set KIRO_TEST_BASH to its executable path.')
    unittest.main()
