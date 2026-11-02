#!/usr/bin/env python3
"""Self-heal gateway config-profile headers.

Some gateway restarts/server starts have left attached config profiles unapplied,
so facades answer HTTP 404 (missing X-API-Key). This check tests every server with
an attached auth profile and re-applies that profile only when the test fails with
an auth/404 error. Transport failures (tunnel down) are skipped, not restarted.
"""
import json
import sys
import urllib.request

BASE = "http://127.0.0.1:8484"
ENV = "/opt/mcp-gateway/gateway.env"


def master_key() -> str:
    for line in open(ENV, encoding="utf-8"):
        if line.startswith("MCP_MASTER_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no MCP_MASTER_KEY")


def api(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"authorization": "Bearer " + master_key(), "content-type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=60))


def mapping(profiles):
    out = {}
    for name in profiles:
        if name.startswith("cleo-") and name.endswith("-auth"):
            out[name] = name[5:-5]
        elif name.startswith("omb-") and name.endswith("-auth"):
            out[name] = name[4:-5]
    if "cleo-omb-auth" in profiles:
        out.pop("omb-omb-auth", None)
    return out


def main() -> int:
    servers = {s["name"]: s for s in api("GET", "/mcp/v1/admin/servers")["servers"]}
    profiles = {p["name"]: p for p in api("GET", "/mcp/v1/admin/config-profiles")["profiles"]}
    healed = 0
    for pname, sname in sorted(mapping(profiles).items()):
        server = servers.get(sname)
        if not server or server.get("status") != "running":
            continue
        try:
            test = api("POST", f"/mcp/v1/admin/servers/{server['id']}/test", {})
        except Exception as exc:
            print(f"skip {sname}: test transport error {exc}", file=sys.stderr)
            continue
        if test.get("ok"):
            continue
        error = str(test.get("error") or "")
        if not any(token in error for token in ("404", "401", "403", "Missing", "Unauthorized")):
            print(f"skip {sname}: non-auth test error {error}", file=sys.stderr)
            continue
        try:
            res = api(
                "POST", f"/mcp/v1/admin/config-profiles/{profiles[pname]['id']}/apply",
                {"serverIds": [server["id"]], "restart": True, "test": True},
            )
            result = res["results"][0]
            print(f"healed {sname} with {pname}: {result.get('test')}", flush=True)
            healed += 1
        except Exception as exc:
            print(f"heal {sname} failed: {exc}", file=sys.stderr)
    print(f"checked; healed {healed}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
