#!/usr/bin/env python3
"""Register a REMOTE (streamable-http) MCP server on the gateway and grant it to bot keys.

Run this ON the gateway host (VPS) as root: it reads the master key from
/opt/mcp-gateway/gateway.env and talks to the loopback admin API, so no secret
ever has to be copied into a shell history, a file in this repo, or an agent's
context. The server's own API token is read from a file (--token-file) or the
environment (--token-env) and is written straight into an ENCRYPTED configuration
profile — it never lands in the SQLite server row and is never returned by the API.

Pipeline:
  1. Create (or reuse) a config profile holding the Authorization header.
  2. Register the remote server (transport=http) unless the name already exists.
  3. Attach the profile, restart and run the gateway's tools/list probe.
  4. Grant the server to the named bot keys (appending a ServerGrant to each key's
     existing grant list). --tools takes an optional comma-separated whitelist.
  5. Print the per-key tool counts, because OpenMausBot silently drops tools past
     its 128-tool cap: a bot already near the cap must get a whitelist, not
     everything.

Usage:
  python3 register_remote_mcp.py --name scrypted \
      --url http://10.10.254.13:11080/endpoint/scrypted-mcp/public/mcp \
      --profile scrypted-mcp --token-env SCRYPTED_TOKEN \
      --keys omb-cleo --tools list_plugins,get_logs [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY_ENV = Path("/opt/mcp-gateway/gateway.env")
BASE = "http://127.0.0.1:8484/mcp/v1/admin"


def master_key() -> str:
    text = GATEWAY_ENV.read_text(encoding="utf-8")
    match = re.search(r"^MCP_MASTER_KEY=(.*)$", text, re.MULTILINE)
    if not match or not match.group(1).strip():
        raise SystemExit(f"no MCP_MASTER_KEY in {GATEWAY_ENV}")
    return match.group(1).strip()


class Api:
    def __init__(self, key: str, dry_run: bool = False) -> None:
        self.key = key
        self.dry_run = dry_run

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        if self.dry_run and method != "GET":
            print(f"[dry-run] {method} {path} {json.dumps(body)[:200] if body else ''}")
            return {}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            BASE + path,
            data=data,
            method=method,
            headers={"Authorization": f"Bearer {self.key}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise SystemExit(f"{method} {path} -> HTTP {exc.code}: {detail[:800]}") from exc


def find_server(api: Api, name: str) -> dict | None:
    for server in api.call("GET", "/servers").get("servers", []):
        if server.get("name") == name:
            return server
    return None


def ensure_profile(api: Api, name: str, token: str, description: str,
                   header_name: str = "Authorization") -> dict:
    """Create the encrypted profile (one auth header) or leave an existing one alone.

    `header_name` matters: mcp-proxy (used by the social MCP servers) validates
    `X-API-Key` and returns 401 for `Authorization: Bearer <same token>`. A
    hardcoded Authorization header silently registered a server with 0 tools.
    """
    for profile in api.call("GET", "/config-profiles").get("profiles", []):
        if profile.get("name") == name:
            keys = [h.get("key") for h in profile.get("headers", [])]
            print(f"   profile exists: {profile['id']} headers={keys}")
            if header_name not in keys:
                raise SystemExit(
                    f"profile '{name}' exists but has no {header_name} header; "
                    "fix it in the console rather than overwriting it blindly"
                )
            return profile
    value = f"Bearer {token}" if header_name == "Authorization" else token
    body = {
        "name": name,
        "description": description,
        "entries": [],
        "headers": [{"key": header_name, "value": value}],
    }
    created = api.call("POST", "/config-profiles", body)
    profile = created.get("profile") or created
    print(f"   profile created: {profile.get('id')} (header value encrypted, never returned)")
    return profile


def grant(api: Api, key_name: str, server_id: str, tools: list[str] | None) -> None:
    keys = api.call("GET", "/keys").get("keys", [])
    matches = [k for k in keys if k.get("name") == key_name and not k.get("revokedAt")]
    if not matches:
        print(f"  ! key '{key_name}' not found (or revoked) - skipped")
        return
    for key in matches:
        current = api.call("GET", f"/keys/{key['id']}").get("key", {})
        grants = [g for g in (current.get("serverGrants") or []) if g.get("serverId") != server_id]
        entry: dict = {"serverId": server_id}
        if tools:
            entry["tools"] = tools
        grants.append(entry)
        if api.dry_run:
            print(f"[dry-run] PATCH /keys/{key['id']} serverGrants+={json.dumps(entry)[:160]}")
            continue
        api.call("PATCH", f"/keys/{key['id']}", {"serverGrants": grants})
        print(f"  granted {key_name} ({key['id']}) tools={'all' if not tools else len(tools)}")


def access_summary(api: Api, key_name: str) -> list[dict]:
    """Resolved per-key access: tool count against OMB's 128-tool cap."""
    out = []
    for key in api.call("GET", "/keys").get("keys", []):
        if key.get("name") != key_name or key.get("revokedAt"):
            continue
        view = api.call("GET", f"/keys/{key['id']}/access")
        granted = [t for g in view.get("grants", []) for t in g.get("tools", []) if t.get("granted")]
        out.append(
            {
                "keyId": key["id"],
                "servers": sorted({g.get("serverName") or "" for g in view.get("grants", [])}),
                "grantedToolCount": len(granted),
                "headroomTo128": 128 - len(granted),
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True, help="gateway server name, e.g. scrypted")
    parser.add_argument("--url", required=True, help="remote streamable-http MCP endpoint")
    parser.add_argument("--profile", required=True, help="config profile name to create/attach")
    parser.add_argument("--token-env", default="", help="env var holding the server API token")
    parser.add_argument("--token-file", default="", help="file holding the server API token")
    parser.add_argument("--keys", default="", help="comma-separated bot key names to grant")
    parser.add_argument("--tools", default="", help="optional comma-separated tool whitelist")
    parser.add_argument("--header-name", default="Authorization",
                        help="auth header name; mcp-proxy servers need X-API-Key")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    token = ""
    if args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    elif args.token_env:
        token = os.environ.get(args.token_env, "").strip()
    if not token:
        raise SystemExit("no token: pass --token-env or --token-file")
    if token.startswith("Bearer "):
        token = token[len("Bearer ") :].strip()

    api = Api(master_key(), dry_run=args.dry_run)
    whitelist = [t.strip() for t in args.tools.split(",") if t.strip()] or None

    print(f"== config profile '{args.profile}'")
    profile = ensure_profile(api, args.profile, token,
                            f"Credential for the {args.name} MCP server at {args.url}",
                            header_name=args.header_name)

    print(f"== server '{args.name}' -> {args.url}")
    existing = find_server(api, args.name)
    if existing:
        print(f"   already registered: {existing['id']} ({existing.get('status')})")
        server_id = existing["id"]
    else:
        created = api.call(
            "POST",
            "/servers",
            {
                "name": args.name,
                "runtime": "remote-agent",
                "transport": "http",
                "url": args.url,
                "headers": {},
            },
        )
        server = created.get("server") or created
        server_id = server.get("id")
        if not server_id:
            if api.dry_run:
                print("   [dry-run] would register (no id yet)")
                server_id = "srv_DRYRUN"
            else:
                raise SystemExit(f"registration did not return a server record: {json.dumps(created)[:800]}")
        else:
            print(f"   registered: {server_id}")

    if not api.dry_run:
        # The profile is attached via the policy endpoint so a re-run is idempotent.
        api.call("PATCH", f"/servers/{server_id}/policy", {"configProfileIds": [profile["id"]]})
        applied = api.call(
            "POST",
            f"/config-profiles/{profile['id']}/apply",
            {"serverIds": [server_id], "restart": True, "test": True},
        )
        print("   apply: " + json.dumps(applied)[:800])
        tools = api.call("GET", f"/servers/{server_id}/tools")
        names = [t.get("name") for t in tools.get("tools", [])]
        print(f"   {len(names)} tools: {', '.join(names)}")

    for key_name in [k.strip() for k in args.keys.split(",") if k.strip()]:
        print(f"== grant {key_name}")
        grant(api, key_name, server_id, whitelist)

    if not api.dry_run and args.keys:
        print("== per-key access (must stay under OMB's 128-tool cap)")
        for key_name in [k.strip() for k in args.keys.split(",") if k.strip()]:
            print(f" -- {key_name}: {json.dumps(access_summary(api, key_name))}")
    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
