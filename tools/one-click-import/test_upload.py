"""Exercise the real scripts against synthetic caches and a loopback-only HTTP stub."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[2]
BASH = os.environ.get('KIRO_TEST_BASH') or shutil.which('bash')
POWERSHELL = os.environ.get('KIRO_TEST_POWERSHELL') or shutil.which('pwsh') or shutil.which('powershell')


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='kiro-upload-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cache = self.root / '.aws/sso/cache'
        self.cache.mkdir(parents=True)
        self.token = {'refreshToken': 'synthetic-private-refresh', 'authMethod': 'social', 'region': 'us-east-1'}
        for folder in ['Library/Application Support/Kiro', 'AppData/Roaming/Kiro']:
            path = self.root / folder / 'machineid'
            path.parent.mkdir(parents=True)
            path.write_text('a' * 64, encoding='utf-8')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name, content in {
            'uname': '#!/usr/bin/env bash\nprintf Darwin\n',
            'python3': '#!/usr/bin/env bash\nexec ' + shlex.quote(Path(sys.executable).as_posix()) + ' "$@"\n',
            'pbcopy': '#!/usr/bin/env bash\necho unexpected-clipboard >&2; exit 1\n',
        }.items():
            path = self.bin / name
            path.write_text(content, encoding='utf-8', newline='\n')
            path.chmod(0o755)
        self.posts = []
        self.gets = 0
        self.status = 'success'
        self.lose_post_response = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def respond(self, code, status):
                body = json.dumps({'status': status}).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def authorized(self):
                return self.path == '/api/admin/fork/import-session' and self.headers.get('x-kiro-import-token') == 'a' * 64

            def do_POST(self):
                if not self.authorized():
                    return self.respond(401, 'unavailable')
                owner.posts.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.respond(503 if owner.lose_post_response else 202, 'running')

            def do_GET(self):
                owner.gets += 1
                self.respond(200 if self.authorized() else 401, owner.status)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.origin = f'http://127.0.0.1:{self.server.server_port}'

    def run_script(self, platform, email='test@example.invalid'):
        (self.cache / 'kiro-auth-token.json').write_text(json.dumps(self.token), encoding='utf-8')
        env = {**os.environ, 'KIRO_EXPORT_ROOT': self.root.as_posix(), 'KIRO_TEST_BIN': self.bin.as_posix(), 'NO_PROXY': '127.0.0.1'}
        if platform == 'macos':
            wrapper = ('if command -v cygpath >/dev/null 2>&1; then KIRO_TEST_BIN="$(cygpath -u "$KIRO_TEST_BIN")"; fi; '
                       'export PATH="$KIRO_TEST_BIN:$PATH"; exec bash "$@"')
            args = [BASH, '--noprofile', '--norc', '-c', wrapper, 'test-upload', (ROOT / 'scripts/fork/get-kiro-info.sh').as_posix(),
                    'get', '--server-origin', self.origin, '--import-token', 'a' * 64, '--email', email]
        else:
            args = [POWERSHELL, '-NoProfile', '-NonInteractive', '-File', str(ROOT / 'scripts/fork/get-kiro-info.ps1'),
                    '-ServerOrigin', self.origin, '-ImportToken', 'a' * 64, '-Email', email]
        result = subprocess.run(args, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=25)
        output = result.stdout + result.stderr
        for private in ['synthetic-private-refresh', 'synthetic-private-secret', 'unexpected-clipboard']:
            self.assertNotIn(private, output)
        return result

    def test_social_upload_without_profile_arn_and_poll(self):
        for platform in PLATFORMS:
            with self.subTest(platform=platform):
                self.posts.clear()
                result = self.run_script(platform)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.posts), 1)
                data = self.posts[0]
                data = data[0] if isinstance(data, list) else data
                self.assertEqual(data['email'], 'test@example.invalid')
                self.assertEqual(data['refreshToken'], self.token['refreshToken'])
                self.assertEqual(data['machineId'], 'a' * 64)
                self.assertNotIn('clientSecret', data)
                self.assertGreater(self.gets, 0)

    def test_idc_uses_only_matching_registration(self):
        self.token.update(authMethod='IdC', clientIdHash='matching')
        (self.cache / 'matching.json').write_text(json.dumps({'clientId': 'test-client', 'clientSecret': 'synthetic-private-secret'}), encoding='utf-8')
        for platform in PLATFORMS:
            with self.subTest(platform=platform):
                result = self.run_script(platform)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = self.posts[-1]
                data = data[0] if isinstance(data, list) else data
                self.assertEqual(data['clientSecret'], 'synthetic-private-secret')
        self.token['clientIdHash'] = 'missing'
        self.posts.clear()
        for platform in PLATFORMS:
            self.assertNotEqual(self.run_script(platform).returncode, 0)
        self.assertEqual(self.posts, [])

    def test_requires_email_and_rejects_unsupported_auth_before_upload(self):
        for platform in PLATFORMS:
            self.assertNotEqual(self.run_script(platform, 'invalid').returncode, 0)
        self.token['authMethod'] = 'external_idp'
        for platform in PLATFORMS:
            self.assertNotEqual(self.run_script(platform).returncode, 0)
        self.assertEqual(self.posts, [])

    def test_lost_post_response_queries_result_without_reposting(self):
        self.lose_post_response = True
        self.status = 'duplicate'
        for platform in PLATFORMS:
            with self.subTest(platform=platform):
                self.posts.clear()
                self.assertEqual(self.run_script(platform).returncode, 0)
                self.assertEqual(len(self.posts), 1)

    def test_partial_import_failures_are_not_reported_as_success(self):
        for status in ['failed', 'unverified', 'activationUnknown']:
            self.status = status
            for platform in PLATFORMS:
                with self.subTest(platform=platform, status=status):
                    self.assertNotEqual(self.run_script(platform).returncode, 0)


if __name__ == '__main__':
    selected = os.environ.get('KIRO_TEST_PLATFORM', 'both')
    PLATFORMS = [selected] if selected in ['macos', 'windows'] else ['macos', 'windows']
    if ('macos' in PLATFORMS and not BASH) or ('windows' in PLATFORMS and not POWERSHELL):
        raise SystemExit('Set KIRO_TEST_BASH / KIRO_TEST_POWERSHELL, or KIRO_TEST_PLATFORM for platform-specific CI.')
    unittest.main()
