"""Exercise SOCKS routing with a disposable local TLS and proxy server."""
import http.server
import os
import select
import socket
import socketserver
import ssl
import subprocess
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path

import social_proxy


def receive(sock, count):
    data = b''
    while len(data) < count:
        part = sock.recv(count - len(data))
        if not part:
            raise EOFError('connection closed')
        data += part
    return data


class FakeSocks(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        try:
            version, count = receive(sock, 2)
            methods = receive(sock, count)
            if version != 5 or 2 not in methods:
                return
            sock.sendall(b'\x05\x02')
            version, length = receive(sock, 2)
            user = receive(sock, length).decode()
            password = receive(sock, receive(sock, 1)[0]).decode()
            if version != 1 or user != 'testuser' or password != 'testpass':
                sock.sendall(b'\x01\x01'); return
            sock.sendall(b'\x01\x00')
            version, command, _, kind = receive(sock, 4)
            if version != 5 or command != 1 or kind != 3:
                return
            host = receive(sock, receive(sock, 1)[0]).decode()
            port = int.from_bytes(receive(sock, 2), 'big')
            self.server.destinations.append((host, port))
            upstream = socket.create_connection(('127.0.0.1', self.server.tls_port), timeout=5)
            sock.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
            try:
                while True:
                    ready, _, _ = select.select([sock, upstream], [], [], 5)
                    if not ready: break
                    for source in ready:
                        data = source.recv(65536)
                        if not data: return
                        (upstream if source is sock else sock).sendall(data)
            finally:
                upstream.close()
        except (EOFError, OSError):
            return


class DocumentServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302)
            self.send_header('Location', f'https://redirect.example:{self.server.server_port}/final')
            self.end_headers()
            return
        self.send_response(200); self.end_headers(); self.wfile.write(b'synthetic response')
    def log_message(self, *_args): pass


class ThreadedSocks(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class SocialProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        root = Path(cls.directory.name)
        cls.cert = root / 'cert.pem'; key = root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=x.com', '-addext', 'subjectAltName=DNS:x.com,DNS:redirect.example',
                        '-keyout', str(key), '-out', str(cls.cert)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.web = http.server.ThreadingHTTPServer(('127.0.0.1', 0), DocumentServer)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cls.cert, key)
        cls.web.socket = context.wrap_socket(cls.web.socket, server_side=True)
        cls.web_thread = threading.Thread(target=cls.web.serve_forever, daemon=True); cls.web_thread.start()
        cls.proxy = ThreadedSocks(('127.0.0.1', 0), FakeSocks)
        cls.proxy.tls_port = cls.web.server_port; cls.proxy.destinations = []
        cls.proxy_thread = threading.Thread(target=cls.proxy.serve_forever, daemon=True); cls.proxy_thread.start()
        cls.context = ssl.create_default_context(cafile=str(cls.cert))

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown(); cls.proxy.server_close(); cls.web.shutdown(); cls.web.server_close(); cls.directory.cleanup()

    def setUp(self):
        self.proxy.destinations.clear()
        self.opener = social_proxy.make_opener(f'socks5h://testuser:testpass@127.0.0.1:{self.proxy.server_address[1]}', context=self.context)

    def test_social_requests_use_authenticated_socks_and_remote_dns(self):
        with self.opener.open(f'https://x.com:{self.web.server_port}/hello', timeout=5) as response:
            self.assertEqual(response.read(), b'synthetic response')
        self.assertEqual(self.proxy.destinations, [('x.com', self.web.server_port)])

    def test_social_redirect_remains_proxied(self):
        with self.opener.open(f'https://x.com:{self.web.server_port}/redirect', timeout=5) as response:
            self.assertEqual(response.read(), b'synthetic response')
        self.assertEqual([host for host, _ in self.proxy.destinations], ['x.com', 'redirect.example'])

    def test_insecure_social_http_is_rejected(self):
        with self.assertRaises(urllib.error.URLError): self.opener.open('http://x.com/', timeout=2)
        self.assertEqual(self.proxy.destinations, [])

    def test_local_gateway_http_is_not_proxied(self):
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), DocumentServer)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with self.opener.open(f'http://127.0.0.1:{server.server_port}/local', timeout=5) as response:
                self.assertEqual(response.read(), b'synthetic response')
            self.assertEqual(self.proxy.destinations, [])
        finally:
            server.shutdown(); server.server_close()

    def test_missing_proxy_fails_without_direct_fallback(self):
        with socket.socket() as temp:
            temp.bind(('127.0.0.1', 0)); unused = temp.getsockname()[1]
        opener = social_proxy.make_opener(f'socks5h://127.0.0.1:{unused}', context=self.context)
        with self.assertRaises(urllib.error.URLError): opener.open(f'https://x.com:{self.web.server_port}/', timeout=2)

    def test_proxy_setting_updates_without_restarting_the_process(self):
        second = ThreadedSocks(('127.0.0.1', 0), FakeSocks)
        second.tls_port = self.web.server_port; second.destinations = []
        thread = threading.Thread(target=second.serve_forever, daemon=True); thread.start()
        path = Path(self.directory.name) / 'instagram.env'
        try:
            path.write_text(f'IG_PROXY=socks5h://testuser:testpass@127.0.0.1:{self.proxy.server_address[1]}\n')
            path.chmod(0o600)
            opener = social_proxy.make_opener(lambda: social_proxy.read_proxy_env_file(str(path)), context=self.context)
            with opener.open(f'https://x.com:{self.web.server_port}/first', timeout=5) as response: self.assertEqual(response.status, 200)
            path.write_text(f'IG_PROXY=socks5h://testuser:testpass@127.0.0.1:{second.server_address[1]}\n')
            with opener.open(f'https://x.com:{self.web.server_port}/second', timeout=5) as response: self.assertEqual(response.status, 200)
            self.assertEqual(len(self.proxy.destinations), 1)
            self.assertEqual(len(second.destinations), 1)
            path.write_text('IG_PROXY=\n')
            with self.assertRaises((ValueError, urllib.error.URLError)):
                opener.open(f'https://x.com:{self.web.server_port}/third', timeout=5)
        finally:
            second.shutdown(); second.server_close()

    def test_youtube_startup_fails_closed_without_proxy_configuration(self):
        import sys
        path = Path(self.directory.name) / 'sitecustomize.py'
        path.write_text((Path(__file__).with_name('youtube_sitecustomize.py')).read_text())
        env = {**os.environ, 'PYTHONPATH': self.directory.name,
               'SOCIAL_PROXY_PACKAGE_DIR': str(Path(__file__).parent),
               'SOCIAL_PROXY_ENV_FILE': str(Path(self.directory.name) / 'missing.env')}
        process = subprocess.run([sys.executable, '-c', 'print("must not run")'], env=env, capture_output=True, text=True)
        self.assertEqual(process.returncode, 78)
        self.assertNotIn('must not run', process.stdout)
        self.assertIn('refusing direct traffic', process.stderr)

    def test_proxy_file_is_private_and_remote_dns_required(self):
        path = Path(self.directory.name) / 'proxy'; path.write_text('socks5h://user:password@127.0.0.1:1234')
        path.chmod(0o644)
        with self.assertRaises(ValueError): social_proxy.read_proxy_file(str(path))
        path.chmod(0o600); self.assertTrue(social_proxy.read_proxy_file(str(path)).startswith('socks5h://'))
        with self.assertRaises(ValueError) as error: social_proxy.make_opener('socks5://user:password@127.0.0.1:1234')
        self.assertNotIn('password', str(error.exception))


if __name__ == '__main__': unittest.main()
