#!/usr/bin/env python3
"""Prove each OMB bot uses its own key and sees only its assigned servers.

Read-only against OMB and the gateway: it probes each `gateway-<bot>` entry,
lists tools/servers with the bot key, and attempts ONE denied read-only tool per
bot to prove the scope is enforced before any upstream call. It never sends a
message or email.
"""
from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = "http://127.0.0.1:8484"
PROVISIONING = Path("/opt/mcp-gateway/provisioning.json")
MASTER_ENV = Path("/opt/mcp-gateway/gateway.env")
OMB_CONFIG = Path("/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot/config.json")
OMB_BOTS = Path("/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot/bots.json")
CONTAINER = "openmausbot-omb-1"

# A read-only tool that each bot must NOT be able to reach.
DENIED_PROBE = {
    "Remy": "unifi_status",
    "Cleo": "unifi_status",
    "Sentinel": "email_work__send_email",
    "Scout": "gh_repo_get",
    "Nora": "email_work__send_email",
    "Luma": "list_messages",
    "Sable": "unifi_status",
    "Forge": "unifi_status",
    "MausBot": "gh_repo_get",
    "Elara": "gh_repo_get",
    "Home Henry": "gh_repo_get",
}
LIMIT = 127


def env_value(name: str) -> str:
    for line in MASTER_ENV.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1]
    raise SystemExit(f"{name} missing")


MASTER = env_value("MCP_MASTER_KEY")


def rpc(method: str, params: dict, key: str):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        GATEWAY + "/mcp/v1",
        data=body,
        method="POST",
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.loads(response.read().decode())
    return payload


def admin(path: str):
    request = urllib.request.Request(
        GATEWAY + path, headers={"authorization": f"Bearer {MASTER}", "content-type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode())


def omb_probe(entry: str):
    result = subprocess.run(
        [
            "docker", "exec", CONTAINER, "curl", "-s", "--max-time", "45",
            "-X", "POST", f"http://127.0.0.1:8799/api/mcp/servers/{entry}/test",
            "-H", "content-type: application/json", "-d", "{}",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None, result.stdout[:200]
    try:
        return json.loads(result.stdout), None
    except json.JSONDecodeError:
        return None, result.stdout[:200]


def main() -> int:
    provisioning = json.loads(PROVISIONING.read_text())
    omb = json.loads(OMB_CONFIG.read_text())
    bots = json.loads(OMB_BOTS.read_text())
    entries = omb.get("mcpServers", {})
    keys = provisioning["keys"]
    key_names = {record["key"]: bot for bot, record in keys.items()}
    failures: list[str] = []

    expected_entries = {record["entry"] for record in keys.values()}
    if set(entries) != expected_entries:
        failures.append(f"OMB entries {sorted(entries)} != expected {sorted(expected_entries)}")

    print(f"OMB entries: {len(entries)} (all per-bot gateway entries: {set(entries) == expected_entries})")
    print(f"{'bot':<12} {'entry':<20} {'key?':<5} {'servers':<38} {'tools':>5} {'omb probe':<10} {'denied':<8}")
    for bot in bots:
        name = bot["name"]
        record = keys.get(name)
        if record is None:
            failures.append(f"{name}: no provisioning key")
            continue
        entry_name = record["entry"]
        entry = entries.get(entry_name)
        if entry is None:
            failures.append(f"{name}: OMB entry {entry_name!r} missing")
            continue
        if bot.get("mcpServers") != [entry_name]:
            failures.append(f"{name}: allowlist {bot.get('mcpServers')} != [{entry_name!r}]")
        header = (entry.get("headers") or {}).get("Authorization", "")
        key_matches = header == f"Bearer {record['key']}"
        if not key_matches:
            failures.append(f"{name}: OMB entry does not carry this bot's key")

        listing = rpc("tools/list", {}, record["key"]).get("result", {})
        tools = listing.get("tools", [])
        names = {tool["name"] for tool in tools}
        permitted = {
            server["name"]
            for server in rpc("servers/list_permitted", {}, record["key"]).get("result", {}).get("servers", [])
        }
        probe, probe_error = omb_probe(entry_name)
        probe_ok = bool(probe and probe.get("ok"))
        if not probe_ok:
            failures.append(f"{name}: OMB probe failed: {probe_error or (probe or {}).get('error')}")
        if len(tools) > LIMIT:
            failures.append(f"{name}: {len(tools)} tools > {LIMIT}")

        denied_tool = DENIED_PROBE[name]
        denied_code = None
        try:
            denied = rpc("tools/call", {"name": denied_tool, "arguments": {}}, record["key"])
            if "error" in denied:
                denied_code = denied["error"].get("code")
            else:
                failures.append(f"{name}: denied probe {denied_tool!r} unexpectedly succeeded")
        except urllib.error.HTTPError as error:
            body = json.loads(error.read().decode())
            denied_code = (body.get("error") or {}).get("code")
        if denied_code not in (-32002, -32001):
            failures.append(f"{name}: denied probe {denied_tool!r} returned {denied_code}")

        if len(permitted) == 0:
            failures.append(f"{name}: sees no servers")
        print(
            f"{name:<12} {entry_name:<20} {str(key_matches):<5} "
            f"{','.join(sorted(permitted))[:36]:<38} {len(tools):>5} "
            f"{str(probe_ok):<10} {str(denied_code):<8}"
        )

    # Old direct entries must be gone.
    for old in ("brain", "devicebridge", "nextcloud", "github", "email-work", "email-mum",
                "email-personal", "email-gmail", "homeassistant", "whatsapp", "btt-bca",
                "unifi", "searxng", "omb", "cloudflare", "adguard", "homepage",
                "vaultwarden", "instagram", "messenger"):
        if old in entries:
            failures.append(f"old direct entry still present: {old}")

    # Attribution: every bot key must have audit rows from the probes above.
    audit_keys = {key["id"]: key["name"] for key in admin("/mcp/v1/admin/keys")["keys"]}
    for bot, record in keys.items():
        rows = admin(f"/mcp/v1/admin/audit?keyId={record['keyId']}&limit=1").get("entries", [])
        if not rows:
            failures.append(f"{bot}: no audit rows for its key")
        elif audit_keys.get(rows[0].get("keyId")) != f"omb-{bot.lower().replace(' ', '-')}":
            failures.append(f"{bot}: audit key name mismatch")

    if failures:
        print("\nFAILURES")
        for failure in failures:
            print(" -", failure)
        return 1
    print("\nall per-bot key and scope checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
