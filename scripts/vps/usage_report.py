#!/usr/bin/env python3
"""Per-key MCP gateway usage from the audit table and the tool-call log."""
import argparse
import collections
import json
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone

DB = "/opt/mcp-gateway/data/gateway.db"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--since", default="24h", help="docker logs --since value (default 24h)")
    args = p.parse_args()

    unit = args.since[-1].lower()
    amount = int(args.since[:-1])
    delta = {"h": timedelta(hours=amount), "d": timedelta(days=amount), "m": timedelta(minutes=amount)}[unit]
    cutoff = (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    keys = {r["id"]: r["name"] for r in con.execute("select id,name from api_keys")}
    print(f"Audit rows (last {args.since}):")
    for r in con.execute(
        "select key_id, count(*) n, max(ts) last from audit_log "
        "where ts >= ? group by key_id order by n desc",
        (cutoff,),
    ):
        print(f"  {keys.get(r['key_id'], r['key_id']):<22} {r['n']:>5}  last {r['last']}")

    out = subprocess.run(["docker", "logs", "--since", args.since, "mcp-gateway"], capture_output=True, text=True).stdout
    calls = []
    for line in out.splitlines():
        if '"msg":"tool call"' not in line:
            continue
        try:
            calls.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    by = collections.Counter()
    err = collections.Counter()
    last = {}
    es = collections.Counter()
    for d in calls:
        k = d.get("key", "?")
        by[k] += 1
        if d.get("status") != "ok":
            err[k] += 1
            es[(d.get("server"), d.get("status"))] += 1
        last[k] = d.get("ts")
    print(f"\nTool calls in gateway log ({len(calls)}):")
    print(f"  {'key':<22} {'calls':>5} {'errors':>6}  last")
    for k, n in by.most_common():
        print(f"  {k:<22} {n:>5} {err[k]:>6}  {last.get(k, '')}")
    if es:
        print("\nErrors by upstream server:")
        for (server, status), n in es.most_common(15):
            print(f"  {str(server):<18} {status:<10} {n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
