# Instagram connector patches

The gateway's automatic Instagram re-login needs three things that upstream
`instagram-mcp` does not yet provide. `apply.py` adds them idempotently to a
checkout (default `/data/repos/instagram-mcp`):

```bash
python3 deploy/patches/instagram-mcp/apply.py /data/repos/instagram-mcp
uv pip install --python /data/repos/instagram-mcp/.venv/bin/python 'instagrapi==3.2.3'
```

## Why

| Fix | Reason |
|---|---|
| `instagrapi==3.2.3` (requirements pin) | 3.2.1 fetches the password-encryption keys from `qe/sync/`, which now answers 404 (an HTML page), so `int(header)` raises `int() argument must be ... not 'NoneType'`. 3.2.3 uses `launcher/sync/`, which returns the keys. |
| `_new_client()`: `country_code=44`, `timezone_offset=0`, `timezone_name=Europe/London` | A bare `Client()` leaves `country_code=None`; `login()` then dies at `int(self.country_code)`. The timezone also matches the UK account/egress instead of instagrapi's default US-Eastern. |
| `login_with_password()`: `IG_TOTP_SECRET` + `_install_totp_patch()` | Instagram asks for the 2FA code minutes into the CAA login flow (each request takes ~30 s through the proxy), so a code generated at process start is expired. The patch regenerates the TOTP in `_login_with_bloks_two_factor` / `bloks_caa_resolve_two_step_verification` at submission time. |
| `last-login.log` | INFO log of request URLs for the last login; no credentials. Useful when a login stall needs diagnosing. |

## Gateway side (this repo)

- `src/social/totp.ts` generates the code the UI shows and validates the seed;
  the CLI generates the submitted code on demand from `IG_TOTP_SECRET`.
- `src/social/instagram-api.ts` spawns `login` with the password on stdin and
  the seed in the environment, deletes the CLI's plaintext `credentials.json`,
  runs a live verify so the session flips to valid immediately, restarts the
  Instagram + watcher servers, and enforces the attempt floor.
- Login timeout is 10 minutes; the console's **Test login now** waits up to 11.
