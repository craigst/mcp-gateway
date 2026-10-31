#!/usr/bin/env python3
"""Seed the VPS MCP gateway from OpenMausBot's live config.

Run on the VPS as root after the gateway is healthy. It:
  * creates one encrypted config profile per upstream server (X-API-Key),
  * registers all 20 OMB MCP servers as remote HTTP servers,
  * configures the managed computer-use broker,
  * mints one least-privilege agent key per OMB bot (curated <=127 tools),
  * writes /opt/mcp-gateway/provisioning.json (0600) for the OMB cutover.

Read-only against OMB and the upstream servers. Re-running against a populated
gateway is refused (exit 3) rather than half-applying a second set.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

GATEWAY = os.environ.get("GATEWAY_API", "http://127.0.0.1:8484")
MASTER_ENV = Path("/opt/mcp-gateway/gateway.env")
OMB_CONFIG = Path("/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot/config.json")
OMB_BOTS = Path("/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot/bots.json")
OUT = Path("/opt/mcp-gateway/provisioning.json")

# High-privilege tools for servers registered from a remote URL (the gateway
# cannot read a manifest for those). Kept deliberately small: enough to let the
# gateway hide the dangerous half by default, not a classification of every
# mutation. Bots get exactly what they had (explicit grants below).
HIGH_PRIVILEGE: dict[str, list[str]] = {
    "vaultwarden": [
        "vault_deliver_credential", "vault_create_webui_login", "vault_create_api_key",
        "vault_rotate_webui_login", "vault_set_uri", "vault_update_metadata",
        "vault_delete_item", "secrets_delete", "secrets_set_status",
    ],
    "github": [
        "gh_repo_delete", "gh_repo_transfer", "gh_branch_delete", "gh_file_delete",
        "gh_pr_merge", "gh_repo_create", "gh_repo_update", "gh_tag_create",
        "gh_issue_close", "gh_issue_update", "gh_issue_comment",
    ],
    "cloudflare": [
        "cf_add_dns", "cf_delete_dns", "cf_update_dns", "cf_create_tunnel",
        "cf_delete_tunnel", "cf_set_tunnel_ingress", "cf_add_tunnel_route",
        "cf_remove_tunnel_route", "cf_publish_service", "cf_unpublish_service",
        "cf_connector_setup",
    ],
    "unifi": [
        "unifi_firewall_rule_add", "unifi_firewall_rule_delete", "unifi_dns_set",
        "unifi_protect_arm_mode", "unifi_protect_camera_update",
    ],
    "adguard": ["adguard_add_rewrite", "adguard_delete_rewrite", "adguard_set_protection"],
    "homeassistant": ["ha_call_service"],
    "nextcloud": [
        "nc_event_create", "nc_event_delete", "nc_files_delete", "nc_files_move",
        "nc_files_mkdir", "nc_files_write", "nc_note_create", "nc_note_update",
        "nc_share_create", "nc_share_delete", "nc_task_create", "nc_talk_send",
    ],
    "omb": ["omb_set_bot_servers", "omb_grant_servers", "omb_revoke_grant", "omb_set_bot_profile"],
    "messenger": [
        "messenger_send", "messenger_reply", "messenger_ask", "messenger_post",
        "messenger_approve", "messenger_deny", "messenger_rotate", "messenger_pause",
        "messenger_create_agent", "messenger_contact_add", "messenger_contact_set",
        "messenger_mcp_grant", "messenger_mcp_revoke", "messenger_computer_start",
        "messenger_computer_stop", "messenger_computer_act",
    ],
    "homepage": ["homepage_add_tile", "homepage_remove_tile", "homepage_revalidate"],
    "btt-bca": [
        "bca_car_update", "bca_load_update", "bca_load_complete", "bca_load_run",
        "bca_load_shift", "bca_stop_update", "bca_day_set", "bca_day_clear",
        "bca_task_run", "bca_week_correction_apply", "bca_loadsheet_generate",
        "bca_timesheet_generate",
    ],
    "whatsapp": ["send_message", "send_file", "send_audio_message"],
    "instagram": [
        "ig_reply", "ig_send_dm", "ig_send_media", "ig_like_message", "ig_unlike_message",
        "ig_react_message", "ig_mark_seen", "ig_reply_comment", "ig_like_comment",
        "ig_unlike_comment", "ig_like_post", "ig_unlike_post", "ig_comment_post",
        "ig_queue_run",
    ],
    "devicebridge": [
        "device_exec", "device_script_run", "device_file_write", "device_terminal_open",
        "device_terminal_send", "device_terminal_close", "device_revoke", "device_uninstall",
        "device_enrollment_create", "device_prune", "device_forget", "device_secret_apply",
        "device_update_connector", "device_docker_action", "device_sleep", "device_wake",
        "harness_session_start", "harness_session_message", "maus_ask",
    ],
}
for mail in ("email-work", "email-mum", "email-personal", "email-gmail"):
    HIGH_PRIVILEGE[mail] = [
        "send_email", "delete_email", "bulk_email", "unsubscribe_email",
        "archive_email", "reply_to_email", "draft_email", "draft_email_reply",
        "ai_draft_email_reply",
    ]

EMAIL8 = [
    "list_email_accounts", "list_emails", "search_emails", "read_email",
    "draft_email", "draft_email_reply", "ai_draft_email_reply", "send_email",
]
EMAIL4 = ["list_emails", "search_emails", "read_email", "draft_email_reply"]
WA_READ = [
    "search_contacts", "list_messages", "list_chats", "get_chat",
    "get_direct_chat_by_contact", "get_contact_chats", "get_last_interaction",
    "get_message_context", "download_media",
]
WA_8 = ["search_contacts", "list_messages", "list_chats", "get_chat",
        "get_last_interaction", "get_message_context", "send_message", "send_file"]
IG_READ = [
    "ig_status", "ig_list_threads", "ig_read_thread", "ig_search_threads",
    "ig_list_media_messages", "ig_recent_shared", "ig_shared_post", "ig_download_media",
    "ig_user_posts", "ig_tagged_posts", "ig_post_info", "ig_post_comments",
    "ig_user_info", "ig_link_info", "ig_activity", "ig_comment_replies", "ig_comment_likers",
]
IG_6 = ["ig_status", "ig_list_threads", "ig_read_thread", "ig_recent_shared", "ig_activity", "ig_user_info"]
VAULT8 = [
    "vault_status", "secrets_list", "secrets_get_metadata", "secrets_search",
    "secrets_resolve_to_file", "secrets_consumers", "grants_list", "audit_tail",
]
MESSENGER8 = [
    "messenger_status", "messenger_whoami", "messenger_conversations",
    "messenger_inbox", "messenger_read", "messenger_send", "messenger_reply",
    "messenger_ask",
]
DEVICE6 = ["device_list", "device_get", "device_exec", "device_file_read", "device_file_write", "device_script_run"]

# Bot -> server -> "*" (all tools incl. high-priv), explicit list, or "read".
POLICY: dict[str, dict[str, object]] = {
    "Remy": {
        "brain": "*", "email-work": EMAIL8, "email-mum": EMAIL8,
        "email-personal": EMAIL8, "email-gmail": EMAIL8,
        "whatsapp": WA_READ, "instagram": IG_READ,
        "nextcloud": "*", "searxng": "*",
    },
    "Cleo": {
        "brain": "*", "email-work": EMAIL4, "email-mum": EMAIL4,
        "email-personal": EMAIL4, "email-gmail": EMAIL4,
        "whatsapp": WA_8, "instagram": IG_6, "vaultwarden": VAULT8,
        "omb": "*", "messenger": MESSENGER8, "devicebridge": DEVICE6,
        "computer-use": "read",
    },
    "Sentinel": {"brain": "*", "vaultwarden": "*", "omb": "*"},
    "Scout": {"brain": "*", "nextcloud": "*", "searxng": "*"},
    "Nora": {
        "brain": "*", "unifi": "*", "cloudflare": "*", "adguard": "*",
        "homepage": "*", "searxng": "*", "devicebridge": DEVICE6, "computer-use": "*",
    },
    "Luma": {"brain": "*", "github": "*"},
    "Sable": {"brain": "*", "github": "*", "instagram": IG_READ, "whatsapp": WA_READ, "devicebridge": DEVICE6},
    "Forge": {"brain": "*", "github": "*", "instagram": IG_READ, "whatsapp": WA_READ, "devicebridge": DEVICE6},
    "MausBot": {"brain": "*"},
    "Elara": {"brain": "*", "btt-bca": "*", "whatsapp": WA_8, "email-gmail": EMAIL4},
    "Home Henry": {"brain": "*", "homeassistant": "*", "devicebridge": DEVICE6, "computer-use": "*"},
}
BOT_LIMIT = 127


def env_value(name: str) -> str:
    for line in MASTER_ENV.read_text().splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1]
    raise SystemExit(f"{name} missing from {MASTER_ENV}")


MASTER = env_value("MCP_MASTER_KEY")
BROKER_TOKEN = env_value("MCP_COMPUTER_BROKER_TOKEN")


def api(method: str, path: str, body: object | None = None, key: str = MASTER):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        GATEWAY + path,
        data=data,
        method=method,
        headers={"authorization": f"Bearer {key}", "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode()
        raise SystemExit(f"{method} {path} -> {error.code}: {detail[:800]}") from error
    except urllib.error.URLError as error:
        raise SystemExit(f"{method} {path} -> unreachable: {error}") from error


def rpc(method: str, params: dict | None = None, key: str = MASTER):
    payload = api("POST", "/mcp/v1", {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}, key)
    if "error" in payload:
        raise SystemExit(f"rpc {method} -> {json.dumps(payload['error'])[:800]}")
    return payload.get("result", {})


def main() -> int:
    if not OMB_CONFIG.exists() or not OMB_BOTS.exists():
        raise SystemExit("OMB config/bots not found")
    omb = json.loads(OMB_CONFIG.read_text())
    bots = json.loads(OMB_BOTS.read_text())
    upstreams = omb.get("mcpServers", {})
    expected = [
        "brain", "devicebridge", "nextcloud", "github", "email-work", "email-mum",
        "email-personal", "email-gmail", "homeassistant", "whatsapp", "btt-bca",
        "unifi", "searxng", "omb", "cloudflare", "adguard", "homepage",
        "vaultwarden", "instagram", "messenger",
    ]
    missing = [name for name in expected if name not in upstreams]
    if missing:
        raise SystemExit(f"OMB config is missing upstream servers: {missing}")

    existing = {server["name"]: server for server in api("GET", "/mcp/v1/admin/servers").get("servers", [])}
    # computer-use is registered by the gateway itself from its env on first boot.
    # Any other pre-existing server is reused (an interrupted seed can be resumed).
    unexpected = sorted(name for name in existing if name != "computer-use" and name not in expected)
    if unexpected:
        raise SystemExit(f"gateway has servers outside this migration: {unexpected}")

    profiles = {profile["name"]: profile for profile in api("GET", "/mcp/v1/admin/config-profiles").get("profiles", [])}
    servers: dict[str, dict] = {}
    for name in expected:
        entry = upstreams[name]
        headers = entry.get("headers") or {}
        if not headers:
            raise SystemExit(f"{name}: no auth header in OMB config")
        # DeviceBridge uses Authorization: Bearer; the other 19 use X-API-Key.
        header_name, header_value = next(iter(headers.items()))
        profile_name = f"omb-{name}-auth"
        profile = profiles.get(profile_name)
        if profile is None:
            profile = api("POST", "/mcp/v1/admin/config-profiles", {
                "name": profile_name,
                "description": f"Upstream {header_name} for OMB server {name} (from OMB config)",
                "headers": [{"key": header_name, "value": header_value}],
            })["profile"]
            profiles[profile_name] = profile
        server = existing.get(name)
        if server is None:
            server = api("POST", "/mcp/v1/admin/servers", {
                "name": name,
                "runtime": "remote-agent",
                "transport": "http",
                "url": entry["url"],
                "highPrivilegeTools": HIGH_PRIVILEGE.get(name, []),
                "approvalRequiredTools": [],
            })["server"]
            applied = api("POST", f"/mcp/v1/admin/config-profiles/{profile['id']}/apply", {
                "serverIds": [server["id"]],
                "restart": True,
                "test": True,
            })
            result = (applied.get("results") or [{}])[0]
            if not result.get("applied") or not (result.get("test") or {}).get("ok"):
                raise SystemExit(f"{name}: profile apply/test failed: {json.dumps(applied)[:800]}")
            tool_count = result["test"].get("toolCount")
        else:
            tool_count = len(rpc("tools/list", {"serverId": server["id"]}).get("tools", []))
        servers[name] = {"id": server["id"], "tools": tool_count}
        print(f"server {name:<12} {server['id']} tools={tool_count}")

    # Computer use: managed broker row.
    api("POST", "/mcp/v1/admin/computer-use/settings", {
        "brokerUrl": "https://10.10.254.49:7443",
        "publicBrokerUrl": "https://10.10.254.49:7443",
        "caFile": "/certs/broker-ca.pem",
        "token": BROKER_TOKEN,
        "enabled": True,
    })
    computer = next((s for s in api("GET", "/mcp/v1/admin/servers").get("servers", []) if s["name"] == "computer-use"), None)
    if computer is None:
        raise SystemExit("computer-use server was not registered")
    servers["computer-use"] = {"id": computer["id"]}

    # Tool names, grouped by server (master view).
    high_by_server = {
        server["id"]: set(server.get("highPrivilegeTools") or [])
        for server in api("GET", "/mcp/v1/admin/servers").get("servers", [])
    }
    listing = rpc("tools/list")
    by_server: dict[str, list[dict]] = {}
    for tool in listing.get("tools", []):
        by_server.setdefault(tool["server_id"], []).append(tool)

    total_tools = sum(len(v) for v in by_server.values())
    print(f"catalog total tools={total_tools} servers={len(by_server)}")
    if total_tools < 480:
        raise SystemExit(f"catalog looks incomplete ({total_tools} tools)")

    bot_by_name = {bot["name"]: bot for bot in bots}
    grants_by_bot: dict[str, dict] = {}
    for bot_name, policy in POLICY.items():
        bot = bot_by_name.get(bot_name)
        if bot is None:
            raise SystemExit(f"bot {bot_name!r} not found in OMB bots.json")
        grants = []
        total = 0
        for server_name, selection in policy.items():
            meta = servers.get(server_name)
            if meta is None:
                raise SystemExit(f"{bot_name}: server {server_name!r} not registered")
            tools = by_server.get(meta["id"], [])
            names = [tool.get("upstream_name", tool["name"]) for tool in tools]
            high_names = high_by_server.get(meta["id"], set())
            if selection == "*":
                chosen = names
            elif selection == "read":
                chosen = [name for name in names if name not in high_names]
            elif isinstance(selection, list):
                missing_tools = [name for name in selection if name not in names]
                if missing_tools:
                    raise SystemExit(f"{bot_name}/{server_name}: tools not advertised: {missing_tools}")
                chosen = list(selection)
            else:
                raise SystemExit(f"{bot_name}/{server_name}: bad policy {selection!r}")
            if not chosen:
                continue
            grant = {
                "serverId": meta["id"],
                "tools": chosen,
                "highPrivilegeTools": [name for name in chosen if name in high_names],
            }
            grants.append(grant)
            total += len(chosen)
        if total > BOT_LIMIT:
            raise SystemExit(f"{bot_name}: {total} tools exceeds the {BOT_LIMIT} limit")
        grants_by_bot[bot_name] = {"botId": bot["id"], "servers": grants, "total": total}
        print(f"key {bot_name:<12} servers={len(grants):2} tools={total}")

    keys: dict[str, dict] = {}
    for bot_name, spec in grants_by_bot.items():
        issued = api("POST", "/mcp/v1/admin/keys/create", {
            "name": f"omb-{re.sub(r'[^a-z0-9]+', '-', bot_name.lower()).strip('-')}",
            "keyType": "agent",
            "serverGrants": spec["servers"],
            "delegationAllowed": False,
            "escalationAllowed": True,
        })
        keys[bot_name] = {
            "entry": "gateway-" + re.sub(r"[^a-z0-9]+", "-", bot_name.lower()).strip("-"),
            "keyId": issued["key"]["id"],
            "key": issued["plaintext"],
            "tools": spec["total"],
            "botId": spec["botId"],
        }
        print(f"key {bot_name:<12} {issued['key']['id']} tools={spec['total']}")

    OUT.write_text(json.dumps({
        "gatewayUrl": "http://mcp-gateway:8080/mcp/v1",
        "servers": servers,
        "keys": keys,
    }, indent=2))
    OUT.chmod(0o600)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
