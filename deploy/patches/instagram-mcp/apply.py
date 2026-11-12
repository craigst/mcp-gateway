#!/usr/bin/env python3
"""Apply the gateway's fixes to an instagram-mcp checkout.

Usage: python3 apply.py /data/repos/instagram-mcp

WHY
---
1. instagrapi 3.2.1 fetches the password-encryption keys from ``qe/sync/``,
   which now answers 404 (HTML), so ``int(header)`` raises. 3.2.3 uses
   ``launcher/sync/`` instead. The venv must run instagrapi==3.2.3.
2. A bare ``Client()`` leaves ``country_code``/timezone at defaults, which
   (a) crashes ``login()`` with ``int(None)`` and (b) makes the login
   fingerprint disagree with the UK account/egress.
3. Instagram asks for the 2FA code minutes into a slow CAA login flow, so a
   TOTP generated when the process starts is already expired. The code is
   regenerated at submission time from ``IG_TOTP_SECRET``.
4. ``formats.media_summary`` drops ``has_liked``, so no caller (and in
   particular the auto-like watcher) can tell a post it has already liked from
   one it has not. The gateway's Instagram watcher needs it to skip posts liked
   by hand instead of spending its paced like budget on them.

Idempotent; safe to re-run.
"""

from __future__ import annotations

import pathlib
import sys

TOTP_SOURCE = '''"""Minimal RFC 6238 TOTP for the login 2FA prompt (stdlib only)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import struct
import time

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def normalize(secret: str) -> str:
    return secret.replace(" ", "").replace("-", "").strip().rstrip("=").upper()


def generate(secret: str, digits: int = 6, period: int = 30, at: float | None = None) -> str:
    key_b32 = normalize(secret)
    if not key_b32 or any(character not in ALPHABET for character in key_b32):
        raise ValueError("2FA secret is not valid base32")
    key = base64.b32decode(key_b32 + "=" * ((8 - len(key_b32) % 8) % 8))
    counter = int((at if at is not None else time.time()) // period)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return f"{code:0{digits}d}"
'''

NEW_CLIENT_OLD = '''    try:
        client.request_timeout = 30
        client.delay_range = [config.DELAY_MIN, config.DELAY_MAX]
    except Exception:  # pragma: no cover - attribute set differs across versions
        pass
    return client'''

NEW_CLIENT_NEW = '''    try:
        client.request_timeout = 30
        client.delay_range = [config.DELAY_MIN, config.DELAY_MAX]
    except Exception:  # pragma: no cover - attribute set differs across versions
        pass
    # Login needs a country code (instagrapi does int(self.country_code)) and a
    # device timezone consistent with the UK account/egress.
    try:
        client.set_country_code(int(os.environ.get("IG_COUNTRY_CODE", "44")))
        client.set_timezone_offset(int(os.environ.get("IG_TIMEZONE_OFFSET", "0")))
        client.timezone_name = os.environ.get("IG_TIMEZONE_NAME", "Europe/London")
    except Exception:  # pragma: no cover - attribute exists on instagrapi 3.x
        pass
    return client'''

TOTP_BLOCK = '''# --- TOTP-aware two-factor handling ---------------------------------------

_TOTP_PLACEHOLDER = "000000"


def _generate_totp_or_none() -> Optional[str]:
    secret = os.environ.get("IG_TOTP_SECRET", "").strip()
    if not secret:
        return None
    from .totp import generate

    return generate(secret)


def _install_totp_patch() -> None:
    """Regenerate the TOTP at verification time, not at process start."""
    try:
        from instagrapi.mixins import auth as ig_auth
        from instagrapi.mixins import bloks as ig_bloks

        login_mixin = ig_auth.LoginMixin
        bloks_mixin = ig_bloks.BloksMixin
    except (ImportError, AttributeError) as exc:  # pragma: no cover - version guard
        raise RuntimeError(f"cannot install the TOTP patch against this instagrapi: {exc}") from exc

    if not getattr(login_mixin, "_igmcp_totp_patched", False):
        original_two_factor = login_mixin._login_with_bloks_two_factor

        def _login_with_bloks_two_factor(self, verification_code, login_json, exc):
            fresh = _generate_totp_or_none()
            if fresh:
                verification_code = fresh
            return original_two_factor(self, verification_code, login_json, exc)

        login_mixin._login_with_bloks_two_factor = _login_with_bloks_two_factor
        login_mixin._igmcp_totp_patched = True

    if not getattr(bloks_mixin, "_igmcp_totp_patched", False):
        original_resolve = bloks_mixin.bloks_caa_resolve_two_step_verification

        def _resolve(self, send_result, verification_code="", domain=None):
            if verification_code:
                fresh = _generate_totp_or_none()
                if fresh:
                    verification_code = fresh
            return original_resolve(self, send_result, verification_code=verification_code, domain=domain)

        bloks_mixin.bloks_caa_resolve_two_step_verification = _resolve
        bloks_mixin._igmcp_totp_patched = True


'''


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/data/repos/instagram-mcp")
    pkg = root / "instagram_mcp"
    if not (pkg / "client.py").exists():
        print(f"not an instagram-mcp checkout: {root}", file=sys.stderr)
        return 2

    (pkg / "totp.py").write_text(TOTP_SOURCE, encoding="utf-8")
    print("wrote instagram_mcp/totp.py")

    client = pkg / "client.py"
    src = client.read_text(encoding="utf-8")

    if "IG_COUNTRY_CODE" not in src:
        if NEW_CLIENT_OLD not in src:
            print("WARN: _new_client anchor not found; country/timezone not applied", file=sys.stderr)
        else:
            src = src.replace(NEW_CLIENT_OLD, NEW_CLIENT_NEW, 1)
            print("patched _new_client (country_code + UK timezone)")

    if "TOTP-aware two-factor handling" not in src:
        anchor = "def load_saved(client: Client) -> bool:"
        if anchor not in src:
            print("WARN: load_saved anchor not found; TOTP block not applied", file=sys.stderr)
        else:
            src = src.replace(anchor, TOTP_BLOCK + anchor, 1)
            print("added TOTP helper block")

    login_old = '''    client = _new_client()
    totp_secret = os.environ.get("IG_TOTP_SECRET", "").strip()
'''
    login_new = '''    client = _new_client()
    try:
        import logging

        _log_path = "/data/secrets/instagram/last-login.log"
        _fh = logging.FileHandler(_log_path, mode="w", encoding="utf-8")
        try:
            os.chmod(_log_path, 0o600)
        except OSError:
            pass
        _fh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        client.logger.setLevel(logging.INFO)
        client.logger.addHandler(_fh)
    except Exception:  # noqa: BLE001 - diagnostics must never block login
        pass
    totp_secret = os.environ.get("IG_TOTP_SECRET", "").strip()
    if totp_secret:
        _install_totp_patch()
        if not verification_code:
            verification_code = _TOTP_PLACEHOLDER
'''
    if "_install_totp_patch()" not in src and login_old in src:
        src = src.replace(login_old, login_new, 1)
        print("patched login_with_password (on-demand TOTP + request log)")

    client.write_text(src, encoding="utf-8")

    formats = pkg / "formats.py"
    if formats.exists():
        src = formats.read_text(encoding="utf-8")
        anchor = '        "carousel_items": len(resources) or None,\n    }'
        patched = (
            '        "carousel_items": len(resources) or None,\n'
            '        # Whether THIS account already liked it: the auto-like watcher\n'
            '        # must not spend a paced like on a post liked by hand.\n'
            '        "liked": bool(getattr(media, "has_liked", False)),\n'
            '    }'
        )
        if 'getattr(media, "has_liked"' in src:
            print("formats.media_summary already carries liked")
        elif anchor not in src:
            print("WARN: media_summary anchor not found; liked not exposed", file=sys.stderr)
        else:
            formats.write_text(src.replace(anchor, patched, 1), encoding="utf-8")
            print("patched media_summary (liked)")

    requirements = root / "requirements.txt"
    if requirements.exists():
        text = requirements.read_text(encoding="utf-8")
        if "instagrapi==3.2.1" in text:
            requirements.write_text(text.replace("instagrapi==3.2.1", "instagrapi==3.2.3"), encoding="utf-8")
            print("pinned requirements to instagrapi==3.2.3")

    print("done. install instagrapi==3.2.3 in the venv, e.g.:")
    print("  uv pip install --python .venv/bin/python 'instagrapi==3.2.3'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
