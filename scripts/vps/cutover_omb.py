#!/usr/bin/env python3
"""Point OpenMausBot at the VPS MCP gateway (config-only; no OMB fork).

Every bot gets its own gateway entry (`gateway-<bot>`) carrying its own agent
key, because OMB's per-bot MCP config is a name allowlist with no per-bot header
override. The 20 direct upstream entries are removed; the backup is the rollback.

Usage:
  cutover_omb.py --dry-run
  cutover_omb.py --apply
  cutover_omb.py --rollback <backup-dir>
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DATA = Path("/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot")
CONFIG = DATA / "config.json"
BOTS = DATA / "bots.json"
PROVISIONING = Path("/opt/mcp-gateway/provisioning.json")
BACKUP_ROOT = Path("/opt/mcp-gateway/backups")
COMPOSE = "/opt/openmausbot/docker-compose.yml"
UID = 1001
GID = 1001


def compose(*args: str) -> None:
    subprocess.run(["docker", "compose", "-f", COMPOSE, *args], check=True)


def write_json(path: Path, payload: object) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.chmod(tmp, 0o600)
    os.chown(tmp, UID, GID)
    os.replace(tmp, path)


def read_json(path: Path) -> object:
    return json.loads(path.read_text())


def build_entries(provisioning: dict, bots: list[dict]) -> dict[str, dict]:
    entries: dict[str, dict] = {}
    for bot in bots:
        name = bot["name"]
        record = provisioning["keys"].get(name)
        if record is None:
            raise SystemExit(f"no gateway key for bot {name!r}")
        entries[record["entry"]] = {
            "type": "http",
            "url": provisioning["gatewayUrl"],
            "headers": {"Authorization": f"Bearer {record['key']}"},
            "enabled": True,
        }
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true")
    group.add_argument("--apply", action="store_true")
    group.add_argument("--rollback")
    args = parser.parse_args()

    if args.rollback:
        backup = Path(args.rollback)
        if not (backup / "config.json").exists() or not (backup / "bots.json").exists():
            raise SystemExit(f"{backup} does not look like a cutover backup")
        compose("stop")
        shutil.copy2(backup / "config.json", CONFIG)
        shutil.copy2(backup / "bots.json", BOTS)
        os.chown(CONFIG, UID, GID)
        os.chown(BOTS, UID, GID)
        compose("up", "-d")
        print(f"rolled back from {backup}")
        return 0

    provisioning = read_json(PROVISIONING)
    config = read_json(CONFIG)
    bots = read_json(BOTS)
    entries = build_entries(provisioning, bots)
    if len(entries) > 20:
        raise SystemExit(f"{len(entries)} gateway entries exceeds OMB's 20-server limit")

    old_entries = config.get("mcpServers", {})
    config["mcpServers"] = entries
    for bot in bots:
        record = provisioning["keys"][bot["name"]]
        bot["mcpServers"] = [record["entry"]]

    print(f"removing {len(old_entries)} direct entries")
    for name in sorted(old_entries):
        print(f"  - {name}")
    print(f"adding {len(entries)} per-bot gateway entries")
    for name in sorted(entries):
        print(f"  + {name}")
    print("bot allowlists:")
    for bot in bots:
        print(f"  {bot['name']:<12} -> {bot['mcpServers']}")

    if args.dry_run:
        print("dry run: no files or containers changed")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = BACKUP_ROOT / f"omb-{stamp}"
    backup.mkdir(parents=True, exist_ok=True)
    shutil.copy2(CONFIG, backup / "config.json")
    shutil.copy2(BOTS, backup / "bots.json")
    print(f"backup {backup}")

    compose("stop")
    try:
        write_json(CONFIG, config)
        write_json(BOTS, bots)
        compose("up", "-d")
        for _ in range(45):
            time.sleep(2)
            check = subprocess.run(
                ["docker", "exec", "openmausbot-omb-1", "curl", "-sf", "http://127.0.0.1:8799/api/health"],
                capture_output=True,
                text=True,
            )
            if check.returncode == 0:
                print("OMB healthy")
                break
        else:
            raise SystemExit("OMB did not become healthy; run --rollback " + str(backup))
    except Exception:
        print("cutover failed, restoring backup", file=sys.stderr)
        shutil.copy2(backup / "config.json", CONFIG)
        shutil.copy2(backup / "bots.json", BOTS)
        compose("up", "-d")
        raise

    servers = subprocess.run(
        ["docker", "exec", "openmausbot-omb-1", "curl", "-sf", "http://127.0.0.1:8799/api/mcp/servers"],
        capture_output=True,
        text=True,
    )
    if servers.returncode != 0:
        raise SystemExit("OMB is up but /api/mcp/servers did not answer")
    listing = json.loads(servers.stdout)
    names = sorted(server["name"] for server in listing.get("servers", []))
    print(f"OMB MCP servers now: {names}")
    if names != sorted(entries):
        raise SystemExit("OMB does not show exactly the per-bot gateway entries; roll back")
    print(f"cutover complete; backup at {backup}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
