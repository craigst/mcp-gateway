#!/usr/bin/env python3
"""Register the HERE HGV navigation MCP server on the gateway and grant it to OMB bots.

Run this ON the gateway host (VPS) as root: it reads the master key from
/opt/mcp-gateway/gateway.env and talks to the loopback admin API, so no secret
ever has to be copied into a shell history, a file in this repo, or an agent's
context.

Pipeline:
  1. Import the public GitHub repo as a managed stdio MCP server (no start yet).
  2. Attach the encrypted config profile holding HERE_API_KEY, restart the server
     and run the gateway's tools/list probe.
  3. Grant the new server to the named OMB bot keys (default: omb-cleo, omb-elara)
     by appending a ServerGrant to each key's existing grant list.
  4. Print the tool list and per-bot access so the result can be verified.

Usage:
  python3 register_here_hgv.py [--repo URL] [--name here-hgv]
                               [--profile here-hgv-api-key]
                               [--keys omb-cleo,omb-elara]
                               [--tools toolA,toolB]   # optional whitelist
                               [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
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


def ensure_profile(api: Api, name: str) -> dict:
    profiles = api.call("GET", "/config-profiles").get("profiles", [])
    for profile in profiles:
        if profile.get("name") == name:
            return profile
    raise SystemExit(
        f"config profile '{name}' not found. Create it first with the HERE_API_KEY value "
        "(see scripts/vps/seed_here_hgv_profile.py or the console: Configurations -> Profiles)."
    )


def grant(api: Api, key_name: str, server_id: str, tools: list[str] | None) -> dict:
    keys = api.call("GET", "/keys").get("keys", [])
    matches = [k for k in keys if k.get("name") == key_name]
    if not matches:
        print(f"  ! key '{key_name}' not found - skipped")
        return {"key": key_name, "status": "missing"}
    results = []
    for key in matches:
        current = api.call("GET", f"/keys/{key['id']}").get("key", {})
        grants = list(current.get("serverGrants") or [])
        grants = [g for g in grants if g.get("serverId") != server_id]
        entry: dict = {"serverId": server_id}
        if tools:
            entry["tools"] = tools
        grants.append(entry)
        if api.dry_run:
            print(f"[dry-run] PATCH /keys/{key['id']} serverGrants+={entry}")
            results.append({"key": key_name, "id": key["id"], "status": "dry-run"})
            continue
        api.call("PATCH", f"/keys/{key['id']}", {"serverGrants": grants})
        results.append({"key": key_name, "id": key["id"], "status": "granted"})
        print(f"  granted {key_name} ({key['id']})")
    return {"key": key_name, "results": results}


def access_summary(api: Api, key_name: str) -> dict:
    """Resolved per-key access: the grant list (with a `granted` flag per tool).

    The access view returns `key.serverGrants` (the raw grants) plus `grants`
    (one row per attached server, each with the server's tools and whether the
    key's whitelist/type grants them). Tool counts must stay under OMB's
    127-tool cap.
    """
    keys = api.call("GET", "/keys").get("keys", [])
    out = {}
    for key in keys:
        if key.get("name") != key_name:
            continue
        view = api.call("GET", f"/keys/{key['id']}/access")
        granted = [t for g in view.get("grants", []) for t in g.get("tools", []) if t.get("granted")]
        out[key["id"]] = {
            "servers": [g.get("serverName") for g in view.get("grants", [])],
            "grantedToolCount": len(granted),
            "headroomTo127": 127 - len(granted),
            "hereTools": [t["name"] for t in granted if t.get("name", "").startswith("here_")],
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default="https://github.com/craigst/here-hgv-mcp")
    parser.add_argument("--name", default="here-hgv")
    parser.add_argument("--profile", default="here-hgv-api-key")
    parser.add_argument("--keys", default="omb-cleo,omb-elara")
    parser.add_argument("--tools", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    api = Api(master_key(), dry_run=args.dry_run)
    tool_whitelist = [t.strip() for t in args.tools.split(",") if t.strip()] or None

    print(f"== import {args.repo} as '{args.name}'")
    existing = find_server(api, args.name)
    if existing:
        print(f"   already registered: {existing['id']} ({existing.get('status')})")
        server_id, server = existing["id"], existing
    else:
        result = api.call(
            "POST",
            "/catalog/import-url",
            {"url": args.repo, "name": args.name, "start": False, "test": False},
        )
        server = result.get("server") or result
        server_id = server.get("id")
        if not server_id:
            raise SystemExit(f"import did not return a server record: {json.dumps(result)[:800]}")
        print(f"   registered: {server_id} status={server.get('status')}")

    print(f"== attach config profile '{args.profile}' and start/test")
    profile = ensure_profile(api, args.profile)
    print(f"   profile {profile['id']} entries={[e['key'] for e in profile.get('entries', [])]}")
    if not api.dry_run:
        applied = api.call(
            "POST",
            f"/config-profiles/{profile['id']}/apply",
            {"serverIds": [server_id], "restart": True, "test": True},
        )
        print("   " + json.dumps(applied)[:1200])

    print("== tool list")
    if not api.dry_run:
        tools = api.call("GET", f"/servers/{server_id}/tools")
        names = [t.get("name") for t in tools.get("tools", [])]
        print(f"   {len(names)} tools: {', '.join(names)}")

    print("== grants")
    for key_name in [k.strip() for k in args.keys.split(",") if k.strip()]:
        print(f" -- {key_name}")
        grant(api, key_name, server_id, tool_whitelist)

    if not api.dry_run:
        print("== per-bot access (tool counts must stay under OMB's 127-tool cap)")
        for key_name in [k.strip() for k in args.keys.split(",") if k.strip()]:
            print(f" -- {key_name}: {json.dumps(access_summary(api, key_name))}")

    print("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
