"""Route X and YouTube HTTPS requests through an explicit SOCKS5 proxy.

Other requests, including the local gateway and webhook, keep their existing
route. Social redirects remain proxied even when they land on another domain.
A missing, invalid or unreachable proxy fails the request; it never retries
social traffic directly.
"""
from __future__ import annotations

import http.client
import os
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from collections.abc import Callable

from vendor import socks

_SOCIAL_DOMAINS = ('x.com', 'twitter.com', 'twimg.com', 'youtube.com', 'youtu.be',
                   'ytimg.com', 'googleapis.com', 'google.com', 'gstatic.com')


def _social(request: urllib.request.Request) -> bool:
    host = (urllib.parse.urlsplit(request.full_url).hostname or '').lower().rstrip('.')
    return bool(getattr(request, '_social_proxy_required', False) or
                any(host == domain or host.endswith('.' + domain) for domain in _SOCIAL_DOMAINS))


def read_proxy_file(path: str) -> str:
    if not path:
        raise ValueError('A private social proxy file is required')
    file = Path(path)
    if not file.is_file() or stat.S_IMODE(file.stat().st_mode) & 0o077:
        raise ValueError('The social proxy file must be a private regular file')
    return file.read_text(encoding='utf8').strip()


def read_proxy_env_file(path: str) -> str:
    text = read_proxy_file(path)
    values = [line.split('=', 1)[1] for line in text.splitlines() if line.startswith('IG_PROXY=')]
    if not values or not values[-1].strip():
        raise ValueError('The social proxy setting is missing')
    return values[-1].strip()


def _parse_proxy(proxy_url: str):
    try:
        proxy = urllib.parse.urlsplit(proxy_url)
        port = proxy.port or 1080
        if proxy.scheme.lower() != 'socks5h' or not proxy.hostname or proxy.path not in ('', '/') or proxy.query or proxy.fragment:
            raise ValueError('invalid')
        user = urllib.parse.unquote(proxy.username) if proxy.username else None
        password = urllib.parse.unquote(proxy.password) if proxy.password else None
        return proxy.hostname, port, user, password
    except (ValueError, TypeError) as exc:
        raise ValueError('A valid SOCKS5 proxy with remote DNS is required') from exc


def make_opener(proxy_url: str | Callable[[], str], *, context: ssl.SSLContext | None = None) -> urllib.request.OpenerDirector:
    provider = proxy_url if callable(proxy_url) else lambda: proxy_url
    _parse_proxy(provider())  # fail before starting a worker when configuration is invalid

    class SocksHTTPSConnection(http.client.HTTPSConnection):
        def connect(self) -> None:
            def via_proxy(address, timeout=socket_default_timeout, source_address=None):
                host, port, user, password = _parse_proxy(provider())
                return socks.create_connection(address, timeout=timeout, source_address=source_address,
                    proxy_type=socks.SOCKS5, proxy_addr=host, proxy_port=port,
                    proxy_rdns=True, proxy_username=user, proxy_password=password)
            self._create_connection = via_proxy
            super().connect()

    # HTTPConnection passes this sentinel when no timeout was specified.
    import socket
    socket_default_timeout = socket._GLOBAL_DEFAULT_TIMEOUT

    class SocialHTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, request):
            if _social(request):
                return self.do_open(SocksHTTPSConnection, request, context=self._context)
            return super().https_open(request)

    class SocialHTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, request):
            if _social(request):
                raise urllib.error.URLError('Social traffic requires HTTPS and the configured proxy')
            return super().http_open(request)

    class SocialRedirectHandler(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, fp, code, msg, headers, newurl):
            redirect = super().redirect_request(request, fp, code, msg, headers, newurl)
            if redirect is not None and _social(request):
                redirect._social_proxy_required = True
            return redirect

    # The service chooses the proxy for social domains itself; do not let
    # inherited HTTP_PROXY variables redirect private gateway traffic.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), SocialHTTPHandler(),
                                       SocialHTTPSHandler(context=context), SocialRedirectHandler())


def install_from_file(path: str | None = None) -> None:
    env_path = os.environ.get('SOCIAL_PROXY_ENV_FILE', '')
    if env_path:
        opener = make_opener(lambda: read_proxy_env_file(env_path))
    else:
        file_path = path or os.environ.get('SOCIAL_PROXY_FILE', '')
        opener = make_opener(lambda: read_proxy_file(file_path))
    urllib.request.install_opener(opener)
    sys.stderr.write("social proxy routing enabled\n")
