import pathlib, re
path = pathlib.Path("/opt/mcp-gateway/data/repos/instagram-mcp/instagram_mcp/client.py")
src = path.read_text()
old = """def _new_client() -> Client:
    client = Client()
    proxy = os.environ.get("IG_PROXY") or os.environ.get("HTTPS_PROXY")
    if proxy:
        client.set_proxy(proxy)
    try:
        client.request_timeout = 30
        client.delay_range = [config.DELAY_MIN, config.DELAY_MAX]
    except Exception:  # pragma: no cover - attribute set differs across versions
        pass
    return client"""
new = """def _new_client() -> Client:
    client = Client()
    proxy = os.environ.get("IG_PROXY") or os.environ.get("HTTPS_PROXY")
    if proxy:
        client.set_proxy(proxy)
    try:
        client.request_timeout = 30
        client.delay_range = [config.DELAY_MIN, config.DELAY_MAX]
    except Exception:  # pragma: no cover - attribute set differs across versions
        pass
    # instagrapi's password login() reads int(self.country_code); a bare
    # Client() (no saved session/device) leaves it None and login dies with
    # "int() argument must be ... not 'NoneType'" before sending anything.
    # The account egresses through the UK proxy, so default to GB (44).
    try:
        client.set_country_code(int(os.environ.get("IG_COUNTRY_CODE", "44")))
    except Exception:  # pragma: no cover - attribute exists on instagrapi 3.x
        pass
    return client"""
if old not in src:
    raise SystemExit("anchor not found")
path.write_text(src.replace(old, new))
print("patched _new_client")
