#!/usr/bin/env python3
"""Read-only acceptance checks for the VPS MCP gateway.

Uses only tools/list, servers/list_permitted and one read-only brain call. It
never sends a message, email, DNS change or device action.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = "http://127.0.0.1:8484"
PROVISIONING = Path("/opt/mcp-gateway/provisioning.json")
MASTER_ENV = Path("/opt/mcp-gateway/gateway.env")
LIMIT = 127


def env_value(name: str) -> str:
    for line in MASTER_ENV.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1]
    raise SystemExit(f"{name} missing")


MASTER = env_value("MCP_MASTER_KEY")


def call(method: str, params: dict | None = None, key: str = MASTER):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    request = urllib.request.Request(
        GATEWAY + "/mcp/v1",
        data=payload,
        method="POST",
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.loads(response.read().decode())
    if "error" in body:
        raise RuntimeError(json.dumps(body["error"])[:500])
    return body.get("result", {})


def admin(path: str):
    request = urllib.request.Request(
        GATEWAY + path,
        headers={"authorization": f"Bearer {MASTER}", "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode())


def main() -> int:
    provisioning = json.loads(PROVISIONING.read_text())
    keys = provisioning["keys"]
    failures: list[str] = []

    master_tools = call("tools/list")["tools"]
    servers = admin("/mcp/v1/admin/servers")["servers"]
    print(f"master tools={len(master_tools)} servers={len(servers)}")
    if len(servers) != 21:
        failures.append(f"expected 21 servers (20 upstream + computer-use), got {len(servers)}")

    email_names = sorted({tool["name"] for tool in master_tools if tool.get("upstream_name") in ("send_email", "read_email")})
    print("email exposed names sample:", email_names[:4])
    if "email_work__send_email" not in email_names or "email_mum__send_email" not in email_names:
        failures.append("email tools are not namespaced as email_<account>__<tool>")

    report = {}
    for bot, record in keys.items():
        key = record["key"]
        tools = call("tools/list", key=key)["tools"]
        names = {tool["name"] for tool in tools}
        permitted = {server["name"] for server in call("servers/list_permitted", key=key)["servers"]}
        report[bot] = {"tools": len(tools), "servers": sorted(permitted)}
        print(f"{bot:<12} tools={len(tools):3} servers={sorted(permitted)}")
        if len(tools) > LIMIT:
            failures.append(f"{bot}: {len(tools)} tools > {LIMIT}")
        if len(tools) != record["tools"]:
            failures.append(f"{bot}: provisioning said {record['tools']} tools, key sees {len(tools)}")

        if bot == "Remy":
            if "unifi" in permitted:
                failures.append("Remy can see unifi")
            for forbidden in ("send_message", "ig_send_dm", "ig_comment_post", "device_exec"):
                if any(name == forbidden or name.endswith("__" + forbidden) for name in names):
                    failures.append(f"Remy can see write tool {forbidden}")
        if bot == "Cleo" and "messenger" not in permitted:
            failures.append("Cleo lost the messenger server")

    # Attribution: a read-only call must land in the audit trail under the bot's key.
    remy_key = keys["Remy"]["key"]
    try:
        call("tools/call", {"name": "health", "arguments": {}}, remy_key)
    except Exception as error:  # noqa: BLE001 - a read-only probe may be denied upstream
        print(f"searxng health probe: {error}")
    key_names = {key["id"]: key["name"] for key in admin("/mcp/v1/admin/keys")["keys"]}
    audit = admin(f"/mcp/v1/admin/audit?keyId={keys['Remy']['keyId']}&limit=5")
    names = [key_names.get(entry.get("keyId", ""), entry.get("keyId")) for entry in audit.get("entries", [])]
    print("Remy audit key names:", names[:5])
    if not names or not any(name == "omb-remy" for name in names):
        failures.append("Remy's call was not attributed to key omb-remy")

    # Computer use is visible to the device-using bots, not to Remy.
    nora_names = {tool["name"] for tool in call("tools/list", key=keys["Nora"]["key"])["tools"]}
    remy_names = {tool["name"] for tool in call("tools/list", key=keys["Remy"]["key"])["tools"]}
    if not ({"device_exec", "computer_use__device_exec", "devicebridge__device_exec"} & nora_names):
        failures.append("Nora cannot see a device_exec tool")
    if any(name == "device_exec" or name.endswith("__device_exec") for name in remy_names):
        failures.append("Remy can see device_exec")

    print(json.dumps({"report": report, "failures": failures}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
