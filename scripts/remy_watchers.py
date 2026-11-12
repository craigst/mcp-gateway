"""Durable, draft-only social activity watchers for Remy's automations.

The process never sends a WhatsApp or Instagram reply.  It reads WhatsApp's
SQLite message store read-only and calls the existing Instagram MCP Python
surface for inbox reads.  New events are persisted before delivery so a
restart cannot lose an event or create a duplicate webhook action.

Webhook URLs are supplied only through environment variables.  They are never
written to the state database or included in logs.  If a URL is absent, the
watcher remains in safe spool-only mode; this is intentional until the
automation owner supplies the private delivery addresses.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import logging
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional


LOG = logging.getLogger("remy-watchers")
SCHEMA = """
CREATE TABLE IF NOT EXISTS cursor (
    source TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at REAL NOT NULL DEFAULT 0,
    created_at REAL NOT NULL,
    sent_at REAL
);
CREATE INDEX IF NOT EXISTS outbox_pending
    ON outbox(status, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_event_id(event_id: str) -> str:
    """Stable short handle that cannot disclose a chat or message identifier."""
    return hashlib.sha256(event_id.encode("utf-8")).hexdigest()[:16]


MAX_PN_DIGITS = 13
GROUP_ID_MIN_DIGITS = 16


def _bare(identifier) -> str:
    """Strip any @domain and a leading + from a JID or number."""
    if not identifier:
        return ""
    return str(identifier).split("@")[0].lstrip("+")


class IdentityResolver:
    """Resolve WhatsApp LIDs to phone numbers and saved/profile names.

    The bridge stores the bare LID in messages.sender and can cache a stale
    chats.name (sometimes the account's own LID). whatsmeow's own store has the
    authoritative mapping and contact names; read it read-only so the webhook
    carries a human identity instead of an opaque number.
    """

    def __init__(self, whatsapp_db: str | Path | None):
        self.lid_to_pn: dict[str, str] = {}
        self.contacts: dict[str, tuple[str, str, str, str]] = {}
        if not whatsapp_db:
            return
        path = Path(whatsapp_db).expanduser()
        if not path.exists():
            return
        try:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                for lid, pn in conn.execute("SELECT lid, pn FROM whatsmeow_lid_map"):
                    if lid and pn:
                        self.lid_to_pn[str(lid)] = str(pn)
                for jid, first, full, push, business in conn.execute(
                    "SELECT their_jid, first_name, full_name, push_name, business_name "
                    "FROM whatsmeow_contacts"
                ):
                    if jid:
                        self.contacts[str(jid)] = (
                            str(first or ""), str(full or ""), str(push or ""), str(business or "")
                        )
            finally:
                conn.close()
        except sqlite3.Error:
            # A missing/locked whatsapp.db must never stop event delivery; it
            # only means the event falls back to an unresolved-LID label.
            self.lid_to_pn = {}
            self.contacts = {}

    @staticmethod
    def _best_name(*values: Optional[str]) -> Optional[str]:
        for value in values:
            text = str(value or "").strip()
            if text:
                return text
        return None

    def _contact_name(self, jid: str) -> Optional[str]:
        first, full, push, business = self.contacts.get(jid, ("", "", "", ""))
        return self._best_name(full, first, push, business)

    def contact_for_pn(self, pn: str) -> Optional[str]:
        return self._contact_name(f"{_bare(pn)}@s.whatsapp.net")

    def contact_for_lid(self, lid: str) -> Optional[str]:
        return self._contact_name(f"{_bare(lid)}@lid")

    def resolve_sender(self, raw, alt=None) -> tuple[str, Optional[str], Optional[str]]:
        """Return (kind, name, phone_number) for a stored sender value.

        kind: person | unresolved_lid | group | unknown
        """
        alt_bare = _bare(alt)
        if alt_bare.isdigit():
            name = self.contact_for_pn(alt_bare)
            return ("person", name, alt_bare)
        bare = _bare(raw)
        if not bare.isdigit():
            return ("unknown", None, None)
        pn = self.lid_to_pn.get(bare)
        if pn:
            name = self.contact_for_pn(pn) or self.contact_for_lid(bare)
            return ("person", name, pn)
        if len(bare) >= GROUP_ID_MIN_DIGITS:
            return ("group", None, None)
        if len(bare) > MAX_PN_DIGITS:
            return ("unresolved_lid", self.contact_for_lid(bare), None)
        return ("person", self.contact_for_pn(bare), bare)

    def sender_label(self, raw, alt=None) -> str:
        kind, name, number = self.resolve_sender(raw, alt)
        bare = _bare(raw)
        if kind == "person":
            if name and number:
                return f"{name} ({number})"
            return number or name or str(raw)
        if kind == "unresolved_lid":
            if name:
                return f"{name} (unresolved LID {bare}, not a phone number)"
            return f"unresolved LID {bare} (not a phone number)"
        if kind == "group":
            return f"sender not recorded (group post; id {bare} is a WhatsApp group id, not a phone number)"
        return str(raw)

    def resolve_chat(self, chat_jid: str, stored_name: Optional[str]) -> tuple[Optional[str], Optional[str]]:
        """Return (display name, phone number) for a chat, never a raw LID as a name."""
        jid = str(chat_jid or "")
        bare = _bare(jid)
        if jid.endswith("@g.us"):
            return (stored_name or "WhatsApp group", None)
        if jid.endswith("@s.whatsapp.net"):
            name = self.contact_for_pn(bare)
            return (name or bare, bare if not name else bare)
        if jid.endswith("@lid"):
            pn = self.lid_to_pn.get(bare)
            name = self.contact_for_pn(pn) if pn else None
            name = name or self.contact_for_lid(bare)
            if name:
                return (name, pn)
            if pn:
                return (pn, pn)
            return ("Unresolved WhatsApp contact", None)
        return (stored_name, None)


def _safe_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


class StateStore:
    """Small durable store; only event payloads and opaque IDs are persisted."""

    def __init__(self, path: str | Path):
        self.path = _safe_path(str(path))
        self.conn = sqlite3.connect(self.path)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=15000")
        self.conn.executescript(SCHEMA)
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    def close(self) -> None:
        self.conn.close()

    def cursor(self, source: str) -> Optional[str]:
        row = self.conn.execute(
            "SELECT value FROM cursor WHERE source = ?", (source,)
        ).fetchone()
        return str(row[0]) if row else None

    def set_cursor(self, source: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO cursor(source, value) VALUES(?, ?) "
            "ON CONFLICT(source) DO UPDATE SET value = excluded.value",
            (source, value),
        )
        self.conn.commit()

    def meta_get(self, key: str) -> Optional[str]:
        row = self.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row else None

    def meta_set(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    def enqueue(self, event_id: str, source: str, payload: dict[str, Any]) -> bool:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        try:
            self.conn.execute(
                "INSERT INTO outbox(event_id, source, payload, created_at) "
                "VALUES(?, ?, ?, ?)",
                (event_id, source, encoded, time.time()),
            )
        except sqlite3.IntegrityError:
            return False
        self.conn.commit()
        return True

    def pending(
        self, source: Optional[str] = None, limit: int = 50
    ) -> list[tuple[str, str, dict[str, Any], int]]:
        clauses = ["status = 'pending'", "next_attempt_at <= ?"]
        params: list[Any] = [time.time()]
        if source:
            clauses.append("source = ?")
            params.append(source)
        params.append(limit)
        rows = self.conn.execute(
            "SELECT event_id, source, payload, attempts FROM outbox WHERE "
            + " AND ".join(clauses)
            + " ORDER BY created_at LIMIT ?",
            params,
        ).fetchall()
        return [(r[0], r[1], json.loads(r[2]), int(r[3])) for r in rows]

    def mark_sent(self, event_id: str) -> None:
        self.conn.execute(
            "UPDATE outbox SET status = 'sent', sent_at = ? WHERE event_id = ?",
            (time.time(), event_id),
        )
        self.conn.commit()

    def mark_retry(self, event_id: str, attempts: int) -> None:
        delay = min(3600, max(15, 2 ** min(attempts, 10)))
        self.conn.execute(
            "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE event_id = ?",
            (attempts, time.time() + delay, event_id),
        )
        self.conn.commit()


class WebhookDelivery:
    """POSTs only to an explicitly configured private automation address."""

    def __init__(self, url: Optional[str], timeout: float = 10):
        self.url = url.strip() if url else None
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def send(self, event_id: str, payload: dict[str, Any]) -> bool:
        if not self.url:
            LOG.info("event_hash=%s delivery=spooled_only", log_event_id(event_id))
            return False
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "X-Remy-Event-ID": event_id,
                # OMB dedupes on Idempotency-Key and filters on X-Webhook-Event.
                "Idempotency-Key": event_id,
                "X-Webhook-Event": f"{payload.get('source', 'remy')}_message",
                # Cloudflare fronts the OMB host and rejects urllib's default
                # User-Agent with 403 error 1010 (OMB's own harness client sets
                # one for the same reason).
                "User-Agent": "remy-watchers/1.0",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                ok = 200 <= response.status < 300
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            LOG.warning("event_hash=%s delivery=failed error=%s", log_event_id(event_id), type(exc).__name__)
            return False
        if not ok:
            LOG.warning("event_hash=%s delivery=failed status=%s", log_event_id(event_id), response.status)
        return ok


DEFAULT_AUTO_LIKE: dict[str, Any] = {
    "cleoPosts": True,
    "mentions": True,
    "cleoPostComments": False,
    "selectedAccounts": False,
    "cleoAccounts": ["livecleo", "livecleotv"],
}
DEFAULT_WATCHER_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "mode": "all",
    "selected": [],
    "autoReply": False,
    "draftOnly": True,
    "autoLike": dict(DEFAULT_AUTO_LIKE),
}


def normalize_auto_like(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return dict(DEFAULT_AUTO_LIKE)
    accounts = raw.get("cleoAccounts")
    if not isinstance(accounts, list):
        accounts = DEFAULT_AUTO_LIKE["cleoAccounts"]
    cleaned = []
    for handle in accounts:
        if not isinstance(handle, str):
            continue
        handle = handle.strip().lstrip("@")
        if handle and handle not in cleaned:
            cleaned.append(handle)
    return {
        "cleoPosts": raw.get("cleoPosts") is True,
        "mentions": raw.get("mentions") is True,
        "cleoPostComments": raw.get("cleoPostComments") is True,
        "selectedAccounts": raw.get("selectedAccounts") is True,
        "cleoAccounts": cleaned or list(DEFAULT_AUTO_LIKE["cleoAccounts"]),
    }
WATCHER_BASE_URL = os.environ.get(
    "WATCHER_BASE_URL",
    "http://mcp-gateway.lan:8484/mcp/v1/watcher",
).rstrip("/")
WATCHER_KEY_FILE = os.environ.get(
    "WATCHER_KEY_FILE",
    os.environ.get("WHATSAPP_WATCHER_KEY_FILE", "~/.config/remy-watchers/watcher.key"),
)


def event_allowed(event, settings: Optional[dict[str, Any]]) -> bool:
    """Whether this WhatsAppEvent or Instagram event dict should be pushed."""
    if not settings or settings.get("enabled") is not True:
        return False
    if settings.get("mode") != "selected":
        return True
    selected = {str(key) for key in (settings.get("selected") or [])}
    if not selected:
        return False

    keys: set[str] = set()
    if isinstance(event, dict):
        sender = str(event.get("sender") or "")
        username = str(event.get("sender_username") or sender).lstrip("@")
        sender_id = str(event.get("sender_id") or "")
        conversation = event.get("conversation") or {}
        chat_id = str(conversation.get("id") or event.get("thread_id") or "")
        if username:
            keys.update({username, f"ig:{username}"})
        if sender_id:
            keys.update({sender_id, f"ig:{sender_id}"})
        if sender:
            keys.update({sender, f"ig:{sender.lstrip('@')}"})
        if chat_id:
            keys.update({chat_id, f"thread:{chat_id}", f"ig-thread:{chat_id}"})
    else:
        if getattr(event, "sender_number", None):
            keys.add(str(event.sender_number))
        sender = getattr(event, "sender", None)
        if sender:
            keys.add(f"lid:{sender}")
            keys.add(str(sender))
        chat_id = getattr(event, "chat_jid", None)
        if chat_id:
            keys.add(str(chat_id))
            keys.add(f"group:{chat_id}")
    return bool(keys & selected)


class WatcherSettingsClient:
    """Fetch one source's allowlist/auto-reply settings from the gateway.

    A missing key or an unreachable gateway must not silently change the
    watcher's scope. The caller keeps its last good settings; only the first
    run falls back to enabled/all (the historical behaviour).
    """

    def __init__(self, source: str, key_file: Optional[str] = None, timeout: float = 5.0):
        if source not in ("whatsapp", "instagram", "youtube", "x"):
            raise ValueError(f"unknown watcher source {source!r}")
        self.source = source
        self.settings_url = f"{WATCHER_BASE_URL}/{source}/settings"
        self.contacts_url = f"{WATCHER_BASE_URL}/{source}/contacts"
        self.key_file = Path(key_file or WATCHER_KEY_FILE).expanduser()
        self.timeout = timeout
        self._warned = False
        self._last_error_log = 0.0

    def _key(self) -> Optional[str]:
        try:
            key = self.key_file.read_text(encoding="utf-8").strip()
        except OSError:
            if not self._warned:
                LOG.warning("watcher settings key is missing at %s; using last/default settings", self.key_file)
                self._warned = True
            return None
        return key or None

    def _call(self, method: str, url: str, body: Optional[dict[str, Any]] = None) -> Optional[dict[str, Any]]:
        key = self._key()
        if not key:
            return None
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "User-Agent": "remy-watchers/1.0",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            if time.time() - self._last_error_log > 60:
                LOG.warning("watcher settings request failed: %s", type(exc).__name__)
                self._last_error_log = time.time()
            return None

    def fetch(self) -> Optional[dict[str, Any]]:
        payload = self._call("GET", self.settings_url)
        settings = payload.get("settings") if isinstance(payload, dict) else None
        if not isinstance(settings, dict):
            return None
        if settings.get("mode") not in ("all", "selected"):
            return None
        if not isinstance(settings.get("selected"), list):
            return None
        if self.source == "x":
            raw_auto = settings.get("autoLike")
            auto: dict[str, Any] = dict(DEFAULT_X_SETTINGS["autoLike"])
            if isinstance(raw_auto, dict):
                for key in ("posts", "replies", "quotes", "mentions"):
                    if isinstance(raw_auto.get(key), bool):
                        auto[key] = raw_auto[key]
                accounts = raw_auto.get("cleoAccounts")
                if isinstance(accounts, list) and accounts:
                    auto["cleoAccounts"] = [
                        str(h).strip().lstrip("@") for h in accounts if str(h).strip()
                    ]
            return {
                "enabled": settings.get("enabled") is True,
                "mode": settings.get("mode"),
                "selected": [str(key) for key in settings.get("selected")],
                "autoReply": False,
                "draftOnly": True,
                "autoLike": auto,
            }
        if self.source == "youtube":
            raw_auto = settings.get("autoLike")
            auto: dict[str, Any] = dict(DEFAULT_YOUTUBE_SETTINGS["autoLike"])
            if isinstance(raw_auto, dict):
                for key in ("videos", "shorts", "comments", "replies", "mentions"):
                    if isinstance(raw_auto.get(key), bool):
                        auto[key] = raw_auto[key]
                accounts = raw_auto.get("cleoAccounts")
                if isinstance(accounts, list) and accounts:
                    auto["cleoAccounts"] = [
                        str(h).strip().lstrip("@") for h in accounts if str(h).strip()
                    ]
            return {
                "enabled": settings.get("enabled") is True,
                "mode": settings.get("mode"),
                "selected": [str(key) for key in settings.get("selected")],
                "autoReply": False,
                "draftOnly": True,
                "autoLike": auto,
            }
        return {
            "enabled": settings.get("enabled") is True,
            "mode": settings.get("mode"),
            "selected": [str(key) for key in settings.get("selected")],
            "autoReply": False,
            "draftOnly": True,
            "autoLike": normalize_auto_like(settings.get("autoLike")),
        }

    def sync_contacts(self, contacts: list[dict[str, Any]]) -> bool:
        payload = self._call("POST", self.contacts_url, {"contacts": contacts})
        return bool(isinstance(payload, dict) and payload.get("ok"))


def build_contact_catalog(
    identity: IdentityResolver,
    messages_db: str | Path,
) -> list[dict[str, Any]]:
    """Build the UI's selectable contact catalog from whatsmeow + chat names."""
    rows: dict[str, dict[str, Any]] = {}

    def add(key: str, name: str, phone: Optional[str], kind: str) -> None:
        if not key or not name:
            return
        current = rows.get(key)
        if current is None or (not current["name"].strip() and name.strip()):
            rows[key] = {"key": key, "name": name, "phone": phone, "kind": kind}

    for their_jid, values in identity.contacts.items():
        first, full, push, business = values
        name = next((str(value).strip() for value in (full, first, push, business) if str(value or "").strip()), "")
        if not name:
            continue
        if their_jid.endswith("@s.whatsapp.net"):
            number = their_jid.split("@")[0]
            if number.isdigit():
                add(number, name, number, "person")
        elif their_jid.endswith("@lid"):
            lid = their_jid.split("@")[0]
            pn = identity.lid_to_pn.get(lid)
            add(pn or f"lid:{lid}", name, pn, "person")

    try:
        conn = sqlite3.connect(f"file:{Path(messages_db).expanduser()}?mode=ro", uri=True)
        try:
            for jid, stored_name in conn.execute(
                "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us'"
            ):
                name = str(stored_name or "").strip() or f"Group {str(jid).split('@')[0]}"
                add(f"group:{jid}", name, None, "group")
        finally:
            conn.close()
    except sqlite3.Error:
        pass

    return sorted(rows.values(), key=lambda row: (row["kind"], row["name"].casefold()))[:2000]


def build_instagram_contact_catalog(server: Any) -> list[dict[str, Any]]:
    """Build the console's Instagram contact/thread catalog from recent DMs."""
    result = _quiet_instagram_call(server.ig_list_threads, amount=50)
    if not result.get("ok", True):
        return []
    rows: dict[str, dict[str, Any]] = {}
    for thread in result.get("threads", []):
        thread_id = str(thread.get("thread_id") or thread.get("id") or "")
        title = str(thread.get("title") or "").strip()
        users = thread.get("users") or []
        for user in users:
            username = str(user.get("username") or "").strip().lstrip("@")
            if not username:
                continue
            name = str(user.get("full_name") or user.get("name") or username).strip()
            rows[f"ig:{username}"] = {
                "key": f"ig:{username}",
                "name": name,
                "phone": None,
                "kind": "person",
            }
        if not users and thread_id:
            rows[f"thread:{thread_id}"] = {
                "key": f"thread:{thread_id}",
                "name": title or f"Instagram thread {thread_id}",
                "phone": None,
                "kind": "group",
            }
    return sorted(rows.values(), key=lambda row: row["name"].casefold())[:2000]


@dataclass(frozen=True)
class WhatsAppEvent:
    event_id: str
    timestamp: str
    chat_jid: str
    chat_name: Optional[str]
    sender: str
    message_id: str
    text: str
    media_type: Optional[str]
    sender_label: str = ""
    sender_name: Optional[str] = None
    sender_number: Optional[str] = None
    sender_kind: str = "unknown"
    chat_phone: Optional[str] = None

    def payload(self) -> dict[str, Any]:
        return {
            "source": "whatsapp",
            "event_id": self.event_id,
            "received_at": now_iso(),
            "conversation": {
                "id": self.chat_jid,
                "name": self.chat_name,
                "phone": self.chat_phone,
            },
            # `sender` is the human label the agent should read; `sender_raw`
            # keeps the bridge value for traceability and dedup/debugging.
            "sender": self.sender_label or self.sender,
            "sender_raw": self.sender,
            "sender_name": self.sender_name,
            "sender_number": self.sender_number,
            "sender_kind": self.sender_kind,
            "message_id": self.message_id,
            "timestamp": self.timestamp,
            "text": self.text,
            "media_type": self.media_type,
            "draft_only": True,
            "auto_send": False,
        }


def read_whatsapp_events(
    db_path: str | Path,
    after: Optional[tuple[str, str]] = None,
    limit: int = 100,
    whatsapp_db: Optional[str | Path] = None,
) -> list[WhatsAppEvent]:
    """Read incoming messages without taking a write lock on the bridge DB."""
    uri = f"file:{Path(db_path).expanduser()}?mode=ro"
    resolver = IdentityResolver(
        whatsapp_db or Path(db_path).expanduser().parent / "whatsapp.db"
    )
    conn = sqlite3.connect(uri, uri=True)
    try:
        clauses = [
            "messages.is_from_me = 0",
            "messages.chat_jid NOT LIKE '%@broadcast'",
            "messages.chat_jid NOT LIKE '%@newsletter'",
        ]
        params: list[Any] = []
        if after:
            clauses.append(
                "(messages.timestamp > ? OR "
                "(messages.timestamp = ? AND messages.id > ?))"
            )
            params.extend([after[0], after[0], after[1]])
        query = (
            "SELECT messages.timestamp, messages.chat_jid, chats.name, "
            "messages.sender, messages.id, messages.content, messages.media_type "
            "FROM messages JOIN chats ON chats.jid = messages.chat_jid "
            f"WHERE {' AND '.join(clauses)} "
            "ORDER BY messages.timestamp, messages.id LIMIT ?"
        )
        params.append(limit)
        rows = conn.execute(query, params).fetchall()
    finally:
        conn.close()

    events: list[WhatsAppEvent] = []
    for row in rows:
        chat_jid = str(row[1])
        raw_sender = str(row[3])
        chat_name, chat_phone = resolver.resolve_chat(chat_jid, row[2])
        kind, name, number = resolver.resolve_sender(raw_sender)
        events.append(
            WhatsAppEvent(
                event_id=f"whatsapp:{chat_jid}:{row[4]}",
                timestamp=str(row[0]),
                chat_jid=chat_jid,
                chat_name=chat_name,
                sender=raw_sender,
                message_id=str(row[4]),
                text=str(row[5] or ""),
                media_type=row[6],
                sender_label=resolver.sender_label(raw_sender),
                sender_name=name,
                sender_number=number,
                sender_kind=kind,
                chat_phone=chat_phone,
            )
        )
    return events


def latest_whatsapp_cursor(db_path: str | Path) -> Optional[tuple[str, str]]:
    """Return the newest bridge row for a no-replay first-run baseline."""
    uri = f"file:{Path(db_path).expanduser()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        row = conn.execute(
            "SELECT timestamp, id FROM messages ORDER BY timestamp DESC, id DESC LIMIT 1"
        ).fetchone()
    finally:
        conn.close()
    return (str(row[0]), str(row[1])) if row else None


def _instagram_server():
    root = os.environ.get("INSTAGRAM_MCP_ROOT", "/home/craigst/.local/share/instagram-mcp")
    if root not in sys.path:
        sys.path.insert(0, root)
    from instagram_mcp import server  # type: ignore

    return server


def _quiet_instagram_call(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Call the MCP adapter without leaking instagrapi request logging."""
    previous = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return fn(*args, **kwargs)
    finally:
        logging.disable(previous)


def read_instagram_events(
    server: Any,
    after: Optional[tuple[str, str]] = None,
    thread_amount: int = 20,
    message_amount: int = 20,
) -> list[dict[str, Any]]:
    """Read recent DM threads through the existing Instagram MCP functions."""
    # instagrapi's debug logger writes request details to stdout.  The watcher
    # must not copy private thread/request data into journald, so capture and
    # discard that chatter while retaining the structured MCP result.
    result = _quiet_instagram_call(server.ig_list_threads, amount=thread_amount)
    if not result.get("ok", True):
        raise RuntimeError(result.get("error", "Instagram thread read failed"))
    events: list[dict[str, Any]] = []
    for thread in result.get("threads", []):
        thread_id = str(thread.get("thread_id") or thread.get("id") or "")
        if not thread_id:
            continue
        detail = _quiet_instagram_call(
            server.ig_read_thread, thread_id=thread_id, amount=message_amount
        )
        if not detail.get("ok", True):
            raise RuntimeError(detail.get("error", "Instagram thread read failed"))
        users = detail.get("users") or []
        users_by_username = {
            str(user.get("username") or "").lstrip("@"): user
            for user in users
            if user.get("username")
        }
        title = thread.get("title") or next(
            (u.get("username") for u in users if u.get("username")), None
        )
        for message in detail.get("messages", []):
            message_id = str(message.get("message_id") or message.get("id") or "")
            timestamp = str(message.get("timestamp") or message.get("at") or "")
            if not message_id or not timestamp or message.get("from") in {"me", None}:
                continue
            if after and (timestamp, message_id) <= after:
                continue
            sender_username = str(message.get("from") or "").lstrip("@")
            user = users_by_username.get(sender_username, {})
            sender_name = str(user.get("full_name") or user.get("name") or sender_username)
            sender_id = str(user.get("pk") or user.get("user_id") or "")
            event_id = f"instagram:{thread_id}:{message_id}"
            events.append(
                {
                    "source": "instagram",
                    "event_id": event_id,
                    "received_at": now_iso(),
                    "conversation": {
                        "id": thread_id,
                        "name": title,
                        "group": bool(thread.get("group")),
                    },
                    "thread_id": thread_id,
                    "sender": sender_username,
                    "sender_username": sender_username,
                    "sender_name": sender_name,
                    "sender_id": sender_id,
                    "sender_raw": message.get("from"),
                    "message_id": message_id,
                    "timestamp": timestamp,
                    "text": message.get("text") or "",
                    "media": message.get("media"),
                    "shared": message.get("shared"),
                    "draft_only": True,
                    "auto_send": False,
                }
            )
    events.sort(key=lambda event: (event["timestamp"], event["event_id"]))
    return events



# ── YouTube ─────────────────────────────────────────────────────────────────
# YouTube has no mention feed and no notification API, so a "comment at me" is
# found by sweeping: recent uploads of the watched channels -> their comment
# threads -> keep the ones containing @<handle>. Same work yt_mentions does in
# youtube-mcp, reusing its client so there is one implementation, not two.
#
# Cost is ~1 quota unit per video scanned. REMY_YOUTUBE_SCAN_VIDEOS (default 10)
# is the knob: keep it small, this runs every 30 minutes.

YOUTUBE_MCP_ROOT = os.environ.get("YOUTUBE_MCP_ROOT", "~/.local/share/youtube-mcp")


def _youtube_modules():
    root = str(Path(YOUTUBE_MCP_ROOT).expanduser())
    if root not in sys.path:
        sys.path.insert(0, root)
    from youtube_mcp import client as yt_client  # noqa: PLC0415
    from youtube_mcp import config as yt_config  # noqa: PLC0415
    from youtube_mcp import formats as yt_formats  # noqa: PLC0415

    return yt_client, yt_config, yt_formats


def read_youtube_events(
    after: Optional[tuple[str, str]] = None,
    scan_videos: Optional[int] = None,
) -> list[dict[str, Any]]:
    """Mention-only view of read_youtube_activity - one event schema, no duplicate."""
    activity = read_youtube_activity(after=after, scan_videos=scan_videos)
    return [event for event in activity["events"] if event.get("mentions_me")]


def _auto_action_state(store: StateStore, action: str, enabled: bool) -> str:
    """off | baseline (first enabled poll) | active."""
    key = f"ig:auto:{action}:enabled"
    previous = store.meta_get(key) == "1"
    store.meta_set(key, "1" if enabled else "0")
    if not enabled:
        return "off"
    return "active" if previous else "baseline"


def _seen(store: StateStore, kind: str, target: str) -> bool:
    return store.meta_get(f"ig:seen:{kind}:{target}") == "1"


def _mark_seen(store: StateStore, kind: str, target: str) -> None:
    store.meta_set(f"ig:seen:{kind}:{target}", "1")


def _auto_like_comment(store: StateStore, server: Any, comment_id: str, *, writes: bool) -> bool:
    if not comment_id or _seen(store, "comment", comment_id):
        return False
    if not writes:
        _mark_seen(store, "comment", comment_id)
        return False
    try:
        result = _quiet_instagram_call(server.ig_like_comment, comment_id)
        liked = bool(result.get("liked"))
        _mark_seen(store, "comment", comment_id)
        if liked:
            LOG.info("instagram auto-like comment_hash=%s", log_event_id(comment_id))
        return liked
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram auto-like comment failed: %s", type(exc).__name__)
        _mark_seen(store, "comment", comment_id)
        return False


def _auto_like_post(store: StateStore, server: Any, code: str, *, writes: bool) -> bool:
    if not code or _seen(store, "post", code):
        return False
    if not writes:
        _mark_seen(store, "post", code)
        return False
    try:
        result = _quiet_instagram_call(server.ig_like_post, code)
        liked = bool(result.get("liked"))
        _mark_seen(store, "post", code)
        if liked:
            LOG.info("instagram auto-like post_hash=%s", log_event_id(code))
        return liked
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram auto-like post failed: %s", type(exc).__name__)
        _mark_seen(store, "post", code)
        return False


def _poll_account_posts(
    store: StateStore,
    server: Any,
    account: str,
    *,
    state: str,
    writes: bool,
    amount: int = 3,
) -> None:
    if state == "off":
        return
    try:
        result = _quiet_instagram_call(server.ig_user_posts, account, amount=amount)
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram posts poll failed: %s", type(exc).__name__)
        return
    posts = result.get("posts") or []
    for post in posts[:amount]:
        code = str(post.get("code") or "")
        if not code:
            continue
        if state == "baseline":
            _mark_seen(store, "post", code)
        else:
            _auto_like_post(store, server, code, writes=writes)


def _activity_comment_events(
    store: StateStore,
    server: Any,
    *,
    enabled: bool,
    writes: bool,
) -> list[dict[str, Any]]:
    state = _auto_action_state(store, "mentions", enabled)
    try:
        result = _quiet_instagram_call(
            server.ig_activity,
            kinds=["mention", "reply_to_comment", "usertag"],
            amount=30,
            resolve=False,
        )
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram activity poll failed: %s", type(exc).__name__)
        return []

    events: list[dict[str, Any]] = []
    for item in result.get("items", []):
        at = str(item.get("at") or "")
        if not at:
            continue
        comment_id = str(item.get("comment_id") or "")
        media_pk = str(item.get("media_pk") or "")
        sender = str(item.get("from") or "").lstrip("@")
        if not sender:
            continue
        if state == "baseline":
            if comment_id:
                _mark_seen(store, "comment", comment_id)
        elif state == "active" and comment_id:
            _auto_like_comment(store, server, comment_id, writes=writes)
        token = comment_id or f"{at}:{media_pk}:{sender}"
        events.append(
            {
                "source": "instagram",
                "event_id": f"instagram:mention:{token}",
                "received_at": now_iso(),
                "conversation": {
                    "id": f"ig-media:{media_pk}" if media_pk else "instagram:activity",
                    "name": "Instagram activity",
                    "type": "instagram",
                },
                "sender": sender,
                "sender_username": sender,
                "sender_name": sender,
                "message_id": comment_id or token,
                "timestamp": at,
                "text": item.get("text") or "",
                "media": {"pk": media_pk} if media_pk else None,
                "comment_id": comment_id or None,
                "post_pk": media_pk or None,
                "activity_kind": item.get("kind"),
                "draft_only": True,
                "auto_send": False,
            }
        )
    return events


def _cleo_comment_events(
    store: StateStore,
    server: Any,
    cleo_accounts: list[str],
    *,
    enabled: bool,
    writes: bool,
    my_username: str,
) -> list[dict[str, Any]]:
    state = _auto_action_state(store, "cleoPostComments", enabled)
    if state == "off":
        return []
    excluded = {name.casefold() for name in cleo_accounts}
    if my_username:
        excluded.add(my_username.casefold())
    events: list[dict[str, Any]] = []
    for account in cleo_accounts[:5]:
        try:
            posts_result = _quiet_instagram_call(server.ig_user_posts, account, amount=2)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("instagram cleo posts poll failed: %s", type(exc).__name__)
            continue
        for post in (posts_result.get("posts") or [])[:2]:
            code = str(post.get("code") or "")
            post_pk = str(post.get("pk") or "")
            if not code:
                continue
            try:
                comments_result = _quiet_instagram_call(
                    server.ig_post_comments, code, amount=30, mentions_only=False
                )
            except Exception as exc:  # noqa: BLE001
                LOG.warning("instagram cleo comments poll failed: %s", type(exc).__name__)
                continue
            for comment in comments_result.get("comments") or []:
                author = str(comment.get("author") or "").lstrip("@")
                comment_pk = str(comment.get("pk") or "")
                at = str(comment.get("at") or "")
                if not comment_pk or not at or not author:
                    continue
                if author.casefold() in excluded:
                    continue
                if state == "baseline":
                    _mark_seen(store, "comment", comment_pk)
                    continue
                _auto_like_comment(store, server, comment_pk, writes=writes)
                events.append(
                    {
                        "source": "instagram",
                        "event_id": f"instagram:comment:{comment_pk}",
                        "received_at": now_iso(),
                        "conversation": {
                            "id": f"ig-media:{post_pk}" if post_pk else "instagram:comment",
                            "name": f"Cleo post ({account})",
                            "type": "instagram",
                            "url": post.get("url"),
                        },
                        "sender": author,
                        "sender_username": author,
                        "sender_name": author,
                        "message_id": comment_pk,
                        "timestamp": at,
                        "text": comment.get("text") or "",
                        "media": {"pk": post_pk} if post_pk else None,
                        "post_pk": post_pk or None,
                        "comment_id": comment_pk,
                        "post_code": code,
                        "draft_only": True,
                        "auto_send": False,
                    }
                )
    return events


def _selected_account_post_likes(
    store: StateStore,
    server: Any,
    settings: dict[str, Any],
    *,
    enabled: bool,
    writes: bool,
) -> None:
    state = _auto_action_state(store, "selectedAccounts", enabled)
    if state == "off":
        return
    usernames = []
    for key in settings.get("selected") or []:
        key = str(key)
        if key.startswith("ig:"):
            usernames.append(key[3:])
    for username in usernames[:10]:
        _poll_account_posts(store, server, username, state=state, writes=writes, amount=3)


def run_instagram_automation_once(
    store: StateStore,
    delivery: WebhookDelivery,
    settings: dict[str, Any],
    server: Any,
) -> int:
    """Poll Instagram activity/comments and perform enabled auto-likes.

    Replies, comments and mentions are never posted here: matching items become
    draft webhook events for Remy, exactly like DMs.
    """
    if settings.get("enabled") is not True:
        return 0
    auto = normalize_auto_like(settings.get("autoLike"))
    try:
        status = _quiet_instagram_call(server.ig_status)
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram status poll failed: %s", type(exc).__name__)
        return 0
    writes = bool(status.get("writes_enabled")) if isinstance(status, dict) else False
    my_username = str(status.get("username") or "") if isinstance(status, dict) else ""

    cleo_state = _auto_action_state(store, "cleoPosts", auto["cleoPosts"])
    for account in auto.get("cleoAccounts", [])[:5]:
        _poll_account_posts(store, server, account, state=cleo_state, writes=writes, amount=3)

    _selected_account_post_likes(
        store,
        server,
        settings,
        enabled=auto["selectedAccounts"],
        writes=writes,
    )

    events: list[dict[str, Any]] = []
    events.extend(_activity_comment_events(store, server, enabled=auto["mentions"], writes=writes))
    events.extend(
        _cleo_comment_events(
            store,
            server,
            auto.get("cleoAccounts", []),
            enabled=auto["cleoPostComments"],
            writes=writes,
            my_username=my_username,
        )
    )

    raw = store.cursor("instagram-activity")
    after = _cursor_pair(raw)
    effective = settings
    new_events = [
        event
        for event in events
        if event_allowed(event, effective)
        and (after is None or (str(event["timestamp"]), str(event["message_id"])) > after)
    ]
    initialize_only = raw is None
    count = process_events(store, "instagram-activity", new_events, delivery, initialize_only)
    if raw is None and not new_events:
        store.set_cursor("instagram-activity", _cursor_value(now_iso(), "init"))
    return count


def _cursor_pair(raw: Optional[str]) -> Optional[tuple[str, str]]:
    if not raw:
        return None
    timestamp, separator, message_id = raw.partition("\t")
    return (timestamp, message_id) if separator else None


def _cursor_value(timestamp: str, event_id: str) -> str:
    return f"{timestamp}\t{event_id}"


def process_events(
    store: StateStore,
    source: str,
    events: Iterable[dict[str, Any]],
    delivery: WebhookDelivery,
    initialize_only: bool = False,
) -> int:
    count = 0
    newest: Optional[tuple[str, str]] = None
    for event in events:
        event_id = str(event["event_id"])
        timestamp = str(event["timestamp"])
        newest = (timestamp, str(event.get("message_id") or event_id))
        if initialize_only:
            continue
        if store.enqueue(event_id, source, event):
            count += 1
            LOG.info("event_hash=%s queued=1", log_event_id(event_id))
    if newest:
        store.set_cursor(source, _cursor_value(*newest))
    if not initialize_only:
        for event_id, _source, payload, attempts in store.pending(source=source):
            if delivery.send(event_id, payload):
                store.mark_sent(event_id)
            else:
                store.mark_retry(event_id, attempts + 1)
    return count


def run_whatsapp_once(
    store: StateStore,
    delivery: WebhookDelivery,
    db_path: str,
    whatsapp_db: Optional[str] = None,
    settings: Optional[dict[str, Any]] = None,
) -> int:
    raw = store.cursor("whatsapp")
    if raw is None and os.environ.get("REMY_REPLAY_EXISTING") != "1":
        newest = latest_whatsapp_cursor(db_path)
        if newest:
            store.set_cursor("whatsapp", _cursor_value(*newest))
        return 0
    events = read_whatsapp_events(db_path, _cursor_pair(raw), whatsapp_db=whatsapp_db)
    newest = max(((event.timestamp, event.message_id) for event in events), default=None)
    effective = settings or DEFAULT_WATCHER_SETTINGS
    allowed = [event.payload() for event in events if event_allowed(event, effective)]
    count = process_events(store, "whatsapp", allowed, delivery)
    # Advance past filtered events too, otherwise the next poll re-reads them.
    if newest is not None:
        store.set_cursor("whatsapp", _cursor_value(*newest))
    return count


def run_instagram_once(
    store: StateStore,
    delivery: WebhookDelivery,
    settings: Optional[dict[str, Any]] = None,
) -> int:
    raw = store.cursor("instagram")
    events = read_instagram_events(_instagram_server(), _cursor_pair(raw))
    newest = max(((str(event["timestamp"]), str(event["event_id"])) for event in events), default=None)
    effective = settings or DEFAULT_WATCHER_SETTINGS
    allowed = [event for event in events if event_allowed(event, effective)]
    initialize_only = raw is None and os.environ.get("REMY_REPLAY_EXISTING") != "1"
    count = process_events(store, "instagram", allowed, delivery, initialize_only)
    # Advance past filtered events too, otherwise the next poll re-reads them.
    if newest is not None:
        store.set_cursor("instagram", _cursor_value(*newest))
    return count




# ── YouTube: what to watch, and what may be liked without asking ────────────
# Scoped to the accounts named here, so "auto-like" can never wander onto
# someone else's channel.
DEFAULT_YOUTUBE_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "autoReply": False,      # draft only - the whole point
    "draftOnly": True,
    "autoLike": {
        "cleoAccounts": ["livecleo"],
        "videos": True,      # like a newly published video
        "shorts": True,      # like a newly published Short
        "comments": True,    # like comments on her videos
        "replies": True,     # like replies under those comments
        "mentions": True,    # like the comment that tags the operator
    },
}


def _yt_flag(name: str, default: bool = True) -> bool:
    return os.environ.get(name, "1" if default else "0").strip().lower() in {
        "1", "true", "yes", "on"
    }


def youtube_settings(gateway: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Defaults, overridable per-flag from the environment.

    Auto-reply is not a flag: it is False, always. A YouTube reply is a public
    comment in the operator's name, so it takes a deliberate `confirm=true`.
    """
    settings = {**DEFAULT_YOUTUBE_SETTINGS,
                "autoLike": dict(DEFAULT_YOUTUBE_SETTINGS["autoLike"])}
    settings["autoLike"]["cleoAccounts"] = [
        h.strip().lstrip("@")
        for h in os.environ.get("REMY_YOUTUBE_CHANNELS", "livecleo").split(",")
        if h.strip()
    ]
    for key in ("videos", "shorts", "comments", "replies", "mentions"):
        env = f"REMY_YOUTUBE_AUTOLIKE_{key.upper()}"
        if env in os.environ:
            settings["autoLike"][key] = _yt_flag(env)
    if "REMY_YOUTUBE_AUTOLIKE" in os.environ:
        master = _yt_flag("REMY_YOUTUBE_AUTOLIKE")
        for key in ("videos", "shorts", "comments", "replies", "mentions"):
            settings["autoLike"][key] = settings["autoLike"][key] and master
    # Settings from the gateway web UI are authoritative - that is the surface the
    # operator actually tunes, so they must beat env defaults.
    if isinstance(gateway, dict):
        if gateway.get("enabled") is False:
            settings["enabled"] = False
        auto = gateway.get("autoLike")
        if isinstance(auto, dict):
            for key in ("videos", "shorts", "comments", "replies", "mentions"):
                if isinstance(auto.get(key), bool):
                    settings["autoLike"][key] = auto[key]
            accounts = auto.get("cleoAccounts")
            if isinstance(accounts, list) and accounts:
                settings["autoLike"]["cleoAccounts"] = [
                    str(h).strip().lstrip("@") for h in accounts if str(h).strip()
                ]
    return settings


def read_youtube_activity(
    after: Optional[tuple[str, str]] = None,
    after_videos: Optional[tuple[str, str]] = None,
    scan_videos: Optional[int] = None,
    channels: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Everything worth telling Remy about, on the watched channels only.

    Three kinds, because they need three different drafts:

      video   a new upload or Short      -> Remy drafts a comment for it
      comment a new top-level comment    -> Remy drafts a reply
      reply   a new reply to a comment   -> Remy drafts a reply

    YouTube has no activity feed, so this is a sweep of recent uploads (about one
    quota unit per video). Replies come from the thread payload, which carries
    the first few inline; deeper threads need comments.list(parentId=...).
    """
    yt_client, yt_config, yt_formats = _youtube_modules()
    limit = int(scan_videos or os.environ.get("REMY_YOUTUBE_SCAN_VIDEOS", "10"))
    handles = list(yt_config.MENTION_HANDLES)
    targets = channels or list(yt_config.CHANNELS or [])
    events: list[dict[str, Any]] = []
    videos: list[dict[str, Any]] = []

    for ref in targets:
        try:
            found = yt_client.videos_for_channel(ref, limit=limit)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("source=youtube channel=%s read_failed=%s", ref, type(exc).__name__)
            continue
        for video in found:
            video_id = video.get("id")
            if not video_id:
                continue
            meta = yt_formats.video_row(video)
            if meta.get("published_at") and (
                not after_videos or (str(meta["published_at"]), video_id) > after_videos
            ):
                videos.append({**meta, "channel_ref": ref})
            try:
                threads = yt_client.comment_threads(video_id, limit=100, order="time")
            except Exception as exc:  # noqa: BLE001 - disabled comments are normal
                LOG.info("source=youtube video=%s comments_unreadable=%s",
                         video_id, type(exc).__name__)
                continue
            for thread in threads:
                row = yt_formats.comment_row(thread, handles)
                if not row.get("comment_id"):
                    continue
                base = _youtube_event(row, meta, video_id, "comment")
                if not after or (base["timestamp"], base["event_id"]) > after:
                    events.append(base)
                for reply in row.get("replies") or []:
                    if not reply.get("comment_id"):
                        continue
                    child = _youtube_event(reply, meta, video_id, "reply",
                                           parent_id=row["comment_id"])
                    if not after or (child["timestamp"], child["event_id"]) > after:
                        events.append(child)
    events.sort(key=lambda event: (event["timestamp"], event["event_id"]))
    return {"events": events, "videos": videos}


def _youtube_event(row: dict[str, Any], meta: dict[str, Any], video_id: str,
                   kind: str, parent_id: Optional[str] = None) -> dict[str, Any]:
    """One Remy-facing event. `kind` decides what Remy is being asked to draft."""
    comment_id = str(row.get("comment_id") or "")
    author = str(row.get("author") or "")
    return {
        "source": "youtube",
        "event_id": f"youtube:{kind}:{comment_id}",
        "kind": kind,
        "received_at": now_iso(),
        "conversation": {"id": video_id, "name": meta.get("title"), "group": False},
        "thread_id": video_id,
        "sender": author.lstrip("@"),
        "sender_username": author.lstrip("@"),
        "sender_name": author,
        "sender_id": row.get("author_channel_id") or "",
        "sender_raw": author,
        "message_id": comment_id,
        "timestamp": str(row.get("published_at") or ""),
        "text": row.get("text") or "",
        "media": None,
        "shared": {"video": {"video_id": video_id, "title": meta.get("title"),
                             "url": f"https://youtu.be/{video_id}",
                             "kind": meta.get("kind"), "channel": meta.get("channel")}},
        "platform": "youtube",
        "video_id": video_id,
        "video_url": f"https://youtu.be/{video_id}",
        "comment_id": comment_id,
        "comment_url": row.get("url"),
        "parent_comment_id": parent_id,
        "reply_to": {"comment_id": comment_id, "video_id": video_id},
        "mentions_me": bool(row.get("mentions_me")),
        "mentions": row.get("mentioned_handles") or [],
        "draft_only": True,
        "auto_send": False,
    }


def _youtube_video_event(meta: dict[str, Any]) -> dict[str, Any]:
    """A newly published video/Short - Remy's cue to draft a comment."""
    video_id = str(meta.get("video_id") or "")
    return {
        "source": "youtube",
        "event_id": f"youtube:video:{video_id}",
        "kind": "video",
        "received_at": now_iso(),
        "conversation": {"id": video_id, "name": meta.get("title"), "group": False},
        "thread_id": video_id,
        "sender": meta.get("channel") or "",
        "sender_username": str(meta.get("channel") or "").lstrip("@"),
        "sender_name": meta.get("channel"),
        "sender_id": meta.get("channel_id") or "",
        "message_id": video_id,
        "timestamp": str(meta.get("published_at") or ""),
        "text": f"New {meta.get('kind')} published: {meta.get('title')}",
        "media": None,
        "shared": {"video": {"video_id": video_id, "title": meta.get("title"),
                             "url": f"https://youtu.be/{video_id}",
                             "kind": meta.get("kind"), "channel": meta.get("channel")}},
        "platform": "youtube",
        "video_id": video_id,
        "video_url": f"https://youtu.be/{video_id}",
        "comment_id": None,
        "duration_s": meta.get("duration_s"),
        "mentions_me": False,
        "mentions": [],
        "draft_only": True,
        "auto_send": False,
    }


def _youtube_autolike_modules():
    root = str(Path(YOUTUBE_MCP_ROOT).expanduser())
    if root not in sys.path:
        sys.path.insert(0, root)
    from youtube_mcp import innertube as yt_innertube  # noqa: PLC0415
    from youtube_mcp import queue as yt_queue  # noqa: PLC0415

    return yt_innertube, yt_queue


def autolike_youtube(
    events: list[dict[str, Any]],
    videos: list[dict[str, Any]],
    initialise_only: bool = False,
    settings: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Like what the settings allow, and say exactly what could not be liked.

    Two different credentials, deliberately:
      videos + Shorts  -> OAuth (videos.rate). Needs youtube.force-ssl.
      comments+replies -> browser cookies (no official method exists).

    Nothing here can post. Liking is the only write.
    """
    settings = settings or youtube_settings()
    flags = settings.get("autoLike") or {}
    out: dict[str, Any] = {"video_likes": 0, "comment_likes": 0, "reply_likes": 0,
                           "failed": 0, "skipped": [], "reasons": []}
    if initialise_only:
        out["reasons"].append("baseline_run: nothing liked on the first sweep")
        return out
    if not settings.get("enabled", True):
        out["reasons"].append("disabled_in_settings")
        return out

    def note(reason: str) -> None:
        if reason not in out["reasons"]:
            out["reasons"].append(reason)

    try:
        yt_client, _cfg, _fmt = _youtube_modules()
        yt_innertube, yt_queue = _youtube_autolike_modules()
    except Exception as exc:  # noqa: BLE001
        note(f"import_failed:{type(exc).__name__}")
        return out

    # --- videos and Shorts (OAuth) ----------------------------------------
    for video in videos:
        video_id = video.get("video_id")
        if not video_id:
            continue
        is_short = video.get("kind") == "short"
        if not flags.get("shorts" if is_short else "videos", False):
            out["skipped"].append({"video_id": video_id, "kind": video.get("kind"),
                                   "reason": "disabled_in_settings"})
            continue
        try:
            yt_queue.pace("remy_yt_like_video")
            yt_client.rate_video(video_id, "like")
            out["video_likes"] += 1
        except Exception as exc:  # noqa: BLE001
            err = getattr(exc, "error", type(exc).__name__)
            out["failed"] += 1
            note(f"video_like:{err}")
            if err in {"quota_exceeded", "auth_required", "insufficient_scope"}:
                break  # the same wall would stop every remaining one

    # --- comments and replies (cookies) -----------------------------------
    comment_events = [e for e in events if e.get("kind") in {"comment", "reply"}]
    if comment_events and (flags.get("comments") or flags.get("replies")):
        available, why = yt_innertube.available()
        if not available:
            note(f"comment_like_unavailable: {why}")
        else:
            for event in comment_events:
                kind = event.get("kind")
                if kind == "comment" and not flags.get("comments"):
                    continue
                if kind == "reply" and not flags.get("replies"):
                    continue
                if event.get("mentions_me") and not flags.get("mentions", True):
                    continue
                target = event.get("comment_id")
                if not target:
                    continue
                try:
                    yt_queue.pace("remy_yt_like_comment")
                    yt_innertube.act(target, event.get("video_id") or "", "like")
                    if kind == "reply":
                        out["reply_likes"] += 1
                    else:
                        out["comment_likes"] += 1
                except Exception as exc:  # noqa: BLE001
                    err = getattr(exc, "error", type(exc).__name__)
                    out["failed"] += 1
                    note(f"comment_like:{err}")
                    if err == "cookies_rejected":
                        break
    return out


def run_youtube_once(
    store: StateStore,
    delivery: WebhookDelivery,
    settings: Optional[dict[str, Any]] = None,
) -> int:
    """Queue what Remy should draft, and like what the settings allow."""
    raw = store.cursor("youtube")
    raw_videos = store.cursor("youtube:videos")
    replay = os.environ.get("REMY_REPLAY_EXISTING") == "1"
    activity = read_youtube_activity(_cursor_pair(raw), _cursor_pair(raw_videos))
    events = activity["events"]
    videos = activity["videos"]

    effective = settings or DEFAULT_WATCHER_SETTINGS
    baseline_comments = raw is None and not replay
    baseline_videos = raw_videos is None and not replay

    # A first sweep is a BASELINE: record where we are, push nothing. Otherwise
    # enabling the watcher would dump a year of comments into Remy at once.
    allowed = ([] if baseline_comments
               else [event for event in events if event_allowed(event, effective)])
    if not baseline_videos:
        allowed += [_youtube_video_event(video) for video in videos]

    newest = max(((str(e["timestamp"]), str(e["event_id"])) for e in events), default=None)
    newest_video = max(
        ((str(v["published_at"]), str(v["video_id"])) for v in videos if v.get("published_at")),
        default=None,
    )

    count = process_events(store, "youtube", allowed, delivery, False)

    likes = autolike_youtube(events, videos, baseline_comments or baseline_videos,
                             youtube_settings(effective))
    LOG.info("source=youtube autolike videos=%s comments=%s replies=%s failed=%s reasons=%s",
             likes.get("video_likes"), likes.get("comment_likes"),
             likes.get("reply_likes"), likes.get("failed"),
             "; ".join(likes.get("reasons") or []) or "none")

    # Advance past filtered events too, so the next sweep is quiet.
    if newest is not None:
        store.set_cursor("youtube", _cursor_value(*newest))
    if newest_video is not None:
        store.set_cursor("youtube:videos", _cursor_value(*newest_video))
    return count



# ── X (Twitter): what to watch, and what may be liked without asking ────────
# X has no separate "comment" object: a reply IS a post. So the likeable classes
# are posts, replies, quotes and mentions, and each is independently switchable.
# Liking on X goes through OAuth (`like.write`) - there is no cookie involved.
X_MCP_ROOT = os.environ.get("X_MCP_ROOT", "~/.local/share/x-mcp")

DEFAULT_X_SETTINGS: dict[str, Any] = {
    "enabled": True,
    "autoReply": False,      # draft only - the whole point
    "draftOnly": True,
    "autoLike": {
        # Her YouTube/Instagram handle is "livecleo"; on X it is "LiveCleoPatra".
        "cleoAccounts": ["LiveCleoPatra"],
        # Mentions only by default: the operator does not want every post of hers
        # liked, just the posts that tag him. Each class stays switchable.
        "posts": False,      # like a new post from the watched account
        "replies": False,    # like replies others leave on her posts
        "quotes": False,     # like a quote post of one of hers
        "mentions": True,    # like a post that @-mentions the operator
    },
}


def x_settings(gateway: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """Defaults, overridable per-flag from the environment, gateway wins.

    Auto-reply is not a flag: it is False, always. An X reply is public and in
    the operator's name, so it takes a deliberate `confirm=true`.
    """
    settings = {**DEFAULT_X_SETTINGS, "autoLike": dict(DEFAULT_X_SETTINGS["autoLike"])}
    settings["autoLike"]["cleoAccounts"] = [
        h.strip().lstrip("@")
        for h in os.environ.get("REMY_X_CHANNELS", "LiveCleoPatra").split(",")
        if h.strip()
    ]
    for key in ("posts", "replies", "quotes", "mentions"):
        env = f"REMY_X_AUTOLIKE_{key.upper()}"
        if env in os.environ:
            settings["autoLike"][key] = _yt_flag(env, True)
    if "REMY_X_AUTOLIKE" in os.environ:
        master = _yt_flag("REMY_X_AUTOLIKE", True)
        for key in ("posts", "replies", "quotes", "mentions"):
            settings["autoLike"][key] = settings["autoLike"][key] and master
    if isinstance(gateway, dict):
        if gateway.get("enabled") is False:
            settings["enabled"] = False
        auto = gateway.get("autoLike")
        if isinstance(auto, dict):
            for key in ("posts", "replies", "quotes", "mentions"):
                if isinstance(auto.get(key), bool):
                    settings["autoLike"][key] = auto[key]
            accounts = auto.get("cleoAccounts")
            if isinstance(accounts, list) and accounts:
                settings["autoLike"]["cleoAccounts"] = [
                    str(h).strip().lstrip("@") for h in accounts if str(h).strip()
                ]
    return settings


def _x_modules():
    root = str(Path(X_MCP_ROOT).expanduser())
    if root not in sys.path:
        sys.path.insert(0, root)
    from x_mcp import backend as x_client  # noqa: PLC0415
    from x_mcp import config as x_config  # noqa: PLC0415
    from x_mcp import formats as x_formats  # noqa: PLC0415
    from x_mcp import queue as x_queue  # noqa: PLC0415

    return x_client, x_config, x_formats, x_queue


def read_x_activity(
    after: Optional[tuple[str, str]] = None,
    scan_posts: Optional[int] = None,
    reply_posts: Optional[int] = None,
    channels: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Everything worth telling Remy about, on the watched accounts and my mentions.

    Three kinds, because they need three different drafts:

      post    a new post from a watched account -> Remy drafts a reply
      reply   a reply to one of her posts      -> Remy drafts a reply
      mention a post that @-mentions me        -> Remy drafts a reply

    Reading replies uses recent search, which is a third-party read ($0.005 each),
    so only the newest few posts are scanned for them. REMY_X_REPLY_POSTS bounds
    that and REMY_X_SCAN_POSTS bounds the posts fetched per account.
    """
    x_client, x_config, x_formats, _queue = _x_modules()
    limit = int(scan_posts or os.environ.get("REMY_X_SCAN_POSTS", "5"))
    reply_limit = int(reply_posts or os.environ.get("REMY_X_REPLY_POSTS", "3"))
    targets = channels or list(x_config.CHANNELS or [])
    events: list[dict[str, Any]] = []
    posts: list[dict[str, Any]] = []

    def fresh(event: dict[str, Any]) -> bool:
        return after is None or (event["timestamp"], event["event_id"]) > after

    for handle in targets:
        try:
            payload = x_client.user_posts(handle, limit, include_replies=True,
                                         include_reposts=False)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("source=x account=%s read_failed=%s", handle, type(exc).__name__)
            continue
        rows = x_formats.rows(payload)
        for row in rows:
            row["mentions_me"] = x_formats.mentions_handle(
                row.get("text") or "", x_config.MENTION_HANDLES)
        for index, row in enumerate(rows):
            if not row.get("id"):
                continue
            event = _x_event(row, "quote" if row.get("kind") == "quote" else "post")
            posts.append(row)
            if fresh(event):
                events.append(event)
            if index >= reply_limit:
                continue
            try:
                replies = x_client.replies_of(row["id"], 25)
            except Exception as exc:  # noqa: BLE001
                LOG.info("source=x post=%s replies_unreadable=%s", row["id"],
                         type(exc).__name__)
                continue
            for reply in x_formats.rows(replies):
                if not reply.get("id") or reply.get("id") == row.get("id"):
                    continue
                reply["mentions_me"] = x_formats.mentions_handle(
                    reply.get("text") or "", x_config.MENTION_HANDLES)
                child = _x_event(reply, "reply", parent_id=row["id"])
                if fresh(child):
                    events.append(child)

    try:
        for row in x_formats.rows(x_client.mentions(25)):
            if not row.get("id"):
                continue
            row["mentions_me"] = x_formats.mentions_handle(
                row.get("text") or "", x_config.MENTION_HANDLES)
            event = _x_event(row, "mention")
            if fresh(event):
                events.append(event)
    except Exception as exc:  # noqa: BLE001
        LOG.warning("source=x mentions_read_failed=%s", type(exc).__name__)

    events.sort(key=lambda event: (event["timestamp"], event["event_id"]))
    return {"events": events, "posts": posts}


def _x_event(row: dict[str, Any], kind: str,
             parent_id: Optional[str] = None) -> dict[str, Any]:
    """One Remy-facing event. `kind` decides what Remy is being asked to draft."""
    post_id = str(row.get("id") or "")
    author = str(row.get("author") or "")
    conversation = str(row.get("conversation_id") or post_id)
    return {
        "source": "x",
        "event_id": f"x:{kind}:{post_id}",
        "kind": kind,
        "received_at": now_iso(),
        "conversation": {"id": conversation, "name": f"@{author}", "group": False},
        "thread_id": conversation,
        "sender": author,
        "sender_username": author,
        "sender_name": row.get("author_name") or author,
        "sender_id": row.get("author_id") or "",
        "sender_raw": author,
        "message_id": post_id,
        "timestamp": str(row.get("created_at") or ""),
        "text": row.get("text") or "",
        "media": None,
        "shared": {"post": {"post_id": post_id, "url": row.get("url"),
                            "kind": row.get("kind"), "author": author}},
        "platform": "x",
        "post_id": post_id,
        "post_url": row.get("url"),
        "parent_post_id": parent_id or row.get("replied_to"),
        "mentions_me": bool(row.get("mentions_me")),
        "mentions": row.get("mentioned_handles") or [],
        "metrics": row.get("metrics") or {},
        "draft_only": True,
        "auto_send": False,
    }


def autolike_x(
    events: list[dict[str, Any]],
    initialise_only: bool = False,
    settings: Optional[dict[str, Any]] = None,
    posts: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    """Like what the settings allow, and say exactly what could not be liked.

    Liking on X is a single OAuth call (`like.write`); there is no cookie path and
    no second credential. Nothing here can post: liking is the only write.
    """
    settings = settings or x_settings()
    flags = settings.get("autoLike") or {}
    out: dict[str, Any] = {"likes": 0, "failed": 0, "skipped": [],
                           "reasons": []}
    if initialise_only:
        out["reasons"].append("baseline_run: nothing liked on the first sweep")
        return out
    if not settings.get("enabled", True):
        out["reasons"].append("disabled_in_settings")
        return out

    def note(reason: str) -> None:
        if reason not in out["reasons"]:
            out["reasons"].append(reason)

    try:
        x_client, x_config, _fmt, x_queue = _x_modules()
    except Exception as exc:  # noqa: BLE001
        note(f"import_failed:{type(exc).__name__}")
        return out

    # A channel post is also reported as an event, so de-duplicate by id while
    # keeping the kind that decides which flag applies.
    wanted: dict[str, str] = {}
    for event in events:
        post_id = str(event.get("post_id") or "")
        if not post_id:
            continue
        kind = event.get("kind") or "post"
        wanted.setdefault(post_id, "post" if kind == "post" else kind)

    if not wanted:
        return out

    already: set[str] = set()
    try:
        already = {str(p.get("id")) for p in (x_client.liked_posts(100).get("data") or [])}
    except Exception as exc:  # noqa: BLE001 - the check is a convenience, not a gate
        note(f"liked_lookup_failed:{type(exc).__name__}")

    for post_id, kind in wanted.items():
        flag = {"post": "posts", "reply": "replies", "quote": "quotes",
                "mention": "mentions"}.get(kind, "posts")
        if not flags.get(flag, False):
            out["skipped"].append({"post_id": post_id, "kind": kind,
                                   "reason": "disabled_in_settings"})
            continue
        if post_id in already:
            out["skipped"].append({"post_id": post_id, "kind": kind,
                                   "reason": "already_liked"})
            continue
        try:
            x_queue.pace("remy_x_like")
            x_client.like(post_id)
            out["likes"] += 1
        except Exception as exc:  # noqa: BLE001
            err = getattr(exc, "status", None) or type(exc).__name__
            out["failed"] += 1
            note(f"like:{err}")
            if str(err) in {"401", "403"}:
                break  # the credential is the wall; every remaining like would fail
    return out


def run_x_once(
    store: StateStore,
    delivery: WebhookDelivery,
    settings: Optional[dict[str, Any]] = None,
) -> int:
    """Queue what Remy should draft, and like what the settings allow."""
    raw = store.cursor("x")
    replay = os.environ.get("REMY_REPLAY_EXISTING") == "1"
    activity = read_x_activity(_cursor_pair(raw))
    events = activity["events"]

    effective = settings or DEFAULT_WATCHER_SETTINGS
    baseline = raw is None and not replay

    # A first sweep is a BASELINE: record where we are, push nothing. Otherwise
    # enabling the watcher would dump months of posts into Remy at once.
    allowed = [] if baseline else [e for e in events if event_allowed(e, effective)]

    newest = max(((str(e["timestamp"]), str(e["event_id"])) for e in events), default=None)

    count = process_events(store, "x", allowed, delivery, False)

    likes = autolike_x(events, baseline, x_settings(effective), activity.get("posts"))
    LOG.info("source=x autolike likes=%s failed=%s reasons=%s",
             likes.get("likes"), likes.get("failed"),
             "; ".join(likes.get("reasons") or []) or "none")

    if newest is not None:
        store.set_cursor("x", _cursor_value(*newest))
    return count


# ---------------------------------------------------------------------------
# Email triage -> Remy
#
# The gateway owns the mailboxes, the switches and the decision model. This
# process is deliberately dumb and credential-free: it asks the gateway which
# mailboxes are due, applies the cheap deterministic rules, asks the gateway to
# judge only what is left, then acks the batch with every decision it made.
#
# It can read and it can queue a draft. It cannot send: the gateway's watcher
# key has no send tool, and the event carries draft_only/auto_send=false.
# ---------------------------------------------------------------------------
EMAIL_SEEN_KEY = "email:seen"
EMAIL_DISMISSED_KEY = "email:dismissed"
EMAIL_SEEN_DAYS = 14
EMAIL_SEEN_MAX = 2000
EMAIL_DISMISSED_MAX = 20
EMAIL_JUDGE_BATCH = 20
# Picks carded per mailbox per pass: a first run on a backlog must not open 20 turns.
EMAIL_PICKS_PER_PASS = 5
EMAIL_WAIT_FLOOR = 15
EMAIL_WAIT_CEILING = 3600


def bare_email(value: str) -> str:
    """The lower-case address out of `Name <addr>`, else the whole cleaned value."""
    text = (value or "").strip()
    match = re.search(r"<([^>]+)>", text)
    return (match.group(1) if match else text).strip().lower()


def sender_matches(sender: str, entries: Any) -> bool:
    """An entry is an address, or `@domain` for a whole domain."""
    if not isinstance(entries, list):
        return False
    for entry in entries:
        clean = str(entry).strip().lower()
        if not clean:
            continue
        if clean.startswith("@"):
            if sender.endswith(clean):
                return True
        elif sender == clean:
            return True
    return False


def normalize_subject(value: str) -> str:
    """Strip reply/forward prefixes so a thread counts as one repeat."""
    text = re.sub(r"\s+", " ", (value or "").strip().lower())
    while True:
        stripped = re.sub(r"^(?:re|fw|fwd|aw|sv)\s*(?:\[\d+\])?\s*:\s*", "", text)
        if stripped == text:
            return text
        text = stripped


def _email_json_get(store: StateStore, key: str, fallback: Any) -> Any:
    raw = store.meta_get(key)
    if not raw:
        return fallback
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return fallback
    return value if isinstance(value, type(fallback)) else fallback


def email_seen(store: StateStore) -> dict[str, str]:
    """Recent `sender|subject` keys, pruned to the window and the cap."""
    raw = _email_json_get(store, EMAIL_SEEN_KEY, {})
    cutoff = time.time() - EMAIL_SEEN_DAYS * 86400
    kept: dict[str, str] = {}
    for key, stamp in raw.items():
        try:
            when = datetime.fromisoformat(str(stamp)).timestamp()
        except (TypeError, ValueError):
            continue
        if when >= cutoff:
            kept[str(key)] = str(stamp)
    if len(kept) > EMAIL_SEEN_MAX:
        newest = sorted(kept.items(), key=lambda pair: pair[1], reverse=True)[:EMAIL_SEEN_MAX]
        kept = dict(newest)
    return kept


def email_dismissed_from(store: StateStore) -> list[str]:
    raw = _email_json_get(store, EMAIL_DISMISSED_KEY, [])
    return [str(entry.get("from")) for entry in raw if isinstance(entry, dict) and entry.get("from")][:EMAIL_DISMISSED_MAX]


def email_rule(message: dict[str, Any], settings: dict[str, Any], seen: dict[str, str]) -> Optional[tuple[str, str]]:
    """The deterministic decisions, cheapest first. None means "ask the model"."""
    sender = bare_email(str(message.get("from") or ""))
    if sender_matches(sender, settings.get("alwaysImportant")):
        return ("important", "allowlist")
    if message.get("listUnsubscribe") or message.get("automated"):
        return ("skip", "bulk")
    key = f"{sender}|{normalize_subject(str(message.get('subject') or ''))}"
    if key in seen:
        return ("skip", "repeat")
    return None


class EmailGatewayClient:
    """The gateway's scoped email triage surface (watcher key, no MCP grants)."""

    def __init__(self, key_file: Optional[str] = None, timeout: float = 40.0):
        self.base = WATCHER_BASE_URL
        self.key_file = Path(key_file or WATCHER_KEY_FILE).expanduser()
        self.timeout = timeout
        self._warned = False

    def _key(self) -> Optional[str]:
        try:
            key = self.key_file.read_text(encoding="utf-8").strip()
        except OSError:
            if not self._warned:
                LOG.warning("watcher key is missing at %s; email triage cannot run", self.key_file)
                self._warned = True
            return None
        return key or None

    def _call(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> tuple[int, Any]:
        key = self._key()
        if not key:
            return 0, None
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base}/email/{path}",
            data=data,
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "User-Agent": "remy-watchers/1.0",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8"))
            except (ValueError, OSError):
                payload = None
            return exc.code, payload
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            LOG.warning("source=email gateway_request_failed path=%s error=%s", path, type(exc).__name__)
            return 0, None

    def fetch(self) -> Optional[dict[str, Any]]:
        status, payload = self._call("GET", "new")
        return payload if status == 200 and isinstance(payload, dict) else None

    def judge(self, account_id: str, messages: list[dict[str, Any]], dismissed: list[str]) -> Optional[dict[str, dict[str, Any]]]:
        """Verdicts by message id, or None when the model could not answer for all of them."""
        verdicts: dict[str, dict[str, Any]] = {}
        for start in range(0, len(messages), EMAIL_JUDGE_BATCH):
            chunk = messages[start:start + EMAIL_JUDGE_BATCH]
            status, payload = self._call(
                "POST",
                "judge",
                {
                    "accountId": account_id,
                    "dismissedFrom": dismissed,
                    "messages": [
                        {
                            "id": m["id"],
                            "from": m.get("from") or "",
                            "subject": m.get("subject") or "",
                            "preview": m.get("preview") or "",
                        }
                        for m in chunk
                    ],
                },
            )
            if status != 200 or not isinstance(payload, dict):
                LOG.warning("source=email judge_unavailable status=%s", status)
                return None
            for verdict in payload.get("verdicts") or []:
                if isinstance(verdict, dict) and verdict.get("id"):
                    verdicts[str(verdict["id"])] = verdict
        return verdicts

    def ack(self, account_id: str, uid_validity: str, last_uid: int, decisions: list[dict[str, Any]]) -> bool:
        status, payload = self._call(
            "POST",
            "ack",
            {
                "accountId": account_id,
                "uidValidity": uid_validity,
                "lastUid": last_uid,
                "decisions": decisions[:EMAIL_JUDGE_BATCH],
            },
        )
        return status == 200 and isinstance(payload, dict) and payload.get("ok") is True


def run_email_once(
    store: StateStore,
    delivery: WebhookDelivery,
    client: Optional[EmailGatewayClient] = None,
) -> tuple[int, int]:
    """One pass over the due mailboxes. Returns (events queued, seconds to wait)."""
    client = client or EmailGatewayClient()
    batch = client.fetch()
    if batch is None:
        return 0, 60

    try:
        wait = int(batch.get("waitSeconds") or 60)
    except (TypeError, ValueError):
        wait = 60
    wait = max(EMAIL_WAIT_FLOOR, min(wait, EMAIL_WAIT_CEILING))

    seen = email_seen(store)
    dismissed = email_dismissed_from(store)
    queued = 0

    for account in batch.get("accounts") or []:
        if not isinstance(account, dict):
            continue
        settings = account.get("settings") or {}
        account_id = str(settings.get("accountId") or "")
        uid_validity = str(account.get("uidValidity") or "")
        messages = [m for m in (account.get("messages") or []) if isinstance(m, dict) and m.get("id")]
        if not account_id or not uid_validity or not messages:
            continue

        decisions: list[dict[str, Any]] = []
        to_judge: list[dict[str, Any]] = []
        for message in messages:
            ruled = email_rule(message, settings, seen)
            if ruled is None:
                to_judge.append(message)
            else:
                triage, rule = ruled
                decisions.append({"messageId": message["id"], "from": message.get("from"),
                                  "subject": message.get("subject"), "triage": triage, "rule": rule})

        verdicts: dict[str, dict[str, Any]] = {}
        if to_judge:
            judged = client.judge(account_id, to_judge, dismissed)
            if judged is None:
                # Their mail waits: nothing is acked, so the batch comes back.
                LOG.warning("source=email account=%s deferred=%d", account_id, len(messages))
                continue
            verdicts = judged
            for message in to_judge:
                verdict = verdicts.get(message["id"])
                if not verdict:
                    continue
                decisions.append({"messageId": message["id"], "from": message.get("from"),
                                  "subject": message.get("subject"), "triage": verdict.get("triage"),
                                  "rule": verdict.get("rule") or "jev", "source": "jev"})

        picks: list[dict[str, Any]] = []
        for decision in decisions:
            triage = decision.get("triage")
            if triage not in ("reply", "important"):
                continue
            source = next((m for m in messages if m["id"] == decision["messageId"]), None)
            verdict = verdicts.get(decision["messageId"]) or {}
            picks.append({
                "message_id": decision["messageId"],
                "account_id": account_id,
                "account_email": settings.get("email"),
                "from": decision.get("from"),
                "subject": decision.get("subject"),
                "preview": (source or {}).get("preview", ""),
                "needs_reply": triage == "reply",
                "triage": triage,
                "p": verdict.get("pTop"),
                "scam_p": verdict.get("scamP"),
                "why": "",
                "rule": decision.get("rule"),
            })

        # A card is read top to bottom: things waiting on a reply first, then the
        # newest, so the most actionable email is the one seen first.
        picks.sort(key=lambda pick: (not pick["needs_reply"], -int((pick.get("message_id") or "0:0:0").rsplit(":", 1)[-1] or 0)))

        last_uid = max(int(m.get("uid") or 0) for m in messages)

        # One event per email, because Remy's card prompt is written for one
        # message ("A new email arrived"): it reads that message itself and
        # writes the card and the draft chips. Sending a digest would make it
        # summarise instead of reading.
        capped = picks[:EMAIL_PICKS_PER_PASS]
        if len(picks) > len(capped):
            LOG.warning("source=email account=%s picks_dropped=%d cap=%d",
                        settings.get("email"), len(picks) - len(capped), EMAIL_PICKS_PER_PASS)
        for pick in capped:
            source = next((m for m in messages if m["id"] == pick["message_id"]), {})
            uid = int(source.get("uid") or 0)
            event_id = f"email:{account_id}:{uid_validity}:{uid}"
            event = {
                "source": "email",
                "event_id": event_id,
                "received_at": now_iso(),
                "account": {"id": account_id, "email": settings.get("email")},
                "folder": "INBOX",
                "uid": uid,
                "message_id": pick["message_id"],
                "from": pick.get("from"),
                "subject": pick.get("subject"),
                "date": source.get("date"),
                "triage": pick.get("triage"),
                "needs_reply": pick.get("needs_reply"),
                "p": pick.get("p"),
                "scam_p": pick.get("scam_p"),
                "rule": pick.get("rule"),
                "draft_only": True,
                "auto_send": False,
            }
            if store.enqueue(event_id, "email", event):
                queued += 1
        LOG.info("source=email account=%s picks=%d filtered=%d",
                 settings.get("email"), len(capped), len(decisions) - len(picks))

        # The spool is durable, so acking now cannot lose a pick: an undelivered
        # event is retried from `pending` on the next pass once a URL is set.
        # The judge endpoint already audited every model decision, so the ack
        # carries only the rule ones: one row per message in the trail.
        ack_decisions = [d for d in decisions if d.get("source") != "jev"]
        if client.ack(account_id, uid_validity, last_uid, ack_decisions):
            for message in messages:
                sender = bare_email(str(message.get("from") or ""))
                seen[f"{sender}|{normalize_subject(str(message.get('subject') or ''))}"] = now_iso()

    store.meta_set(EMAIL_SEEN_KEY, json.dumps(seen, ensure_ascii=False))
    for event_id, _source, payload, attempts in store.pending(source="email"):
        if delivery.send(event_id, payload):
            store.mark_sent(event_id)
        else:
            store.mark_retry(event_id, attempts + 1)
    return queued, wait


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=("whatsapp", "instagram", "youtube", "x", "email"))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("REMY_LOG_LEVEL", "INFO"), format="%(message)s")
    state = os.environ.get(
        "REMY_STATE_DB", "~/.local/state/remy-watchers/state.sqlite3"
    )
    store = StateStore(state)
    try:
        url_key = {
            "whatsapp": "REMY_WHATSAPP_WEBHOOK_URL",
            "instagram": "REMY_INSTAGRAM_WEBHOOK_URL",
            "youtube": "REMY_YOUTUBE_WEBHOOK_URL",
            "x": "REMY_X_WEBHOOK_URL",
            "email": "REMY_EMAIL_WEBHOOK_URL",
        }[args.source]
        delivery = WebhookDelivery(os.environ.get(url_key))
        if not delivery.enabled:
            LOG.warning("source=%s delivery=disabled reason=missing_private_url", args.source)

        if args.source == "email":
            # Email is not a social source: the gateway decides which mailboxes are
            # due, so this is one call, one sleep, and no contact catalog.
            email_client = EmailGatewayClient()
            while True:
                wait = 60
                try:
                    count, wait = run_email_once(store, delivery, email_client)
                    if count:
                        LOG.info("source=email queued=%d", count)
                except Exception as exc:  # noqa: BLE001 - never spin on one bad batch
                    LOG.error("source=email read_failed=%s", type(exc).__name__)
                if args.once:
                    return 0
                time.sleep(wait)
        interval_key = {
            "whatsapp": "REMY_WHATSAPP_INTERVAL_SECONDS",
            "instagram": "REMY_INSTAGRAM_INTERVAL_SECONDS",
            "youtube": "REMY_YOUTUBE_INTERVAL_SECONDS",
            "x": "REMY_X_INTERVAL_SECONDS",
        }[args.source]
        interval_default = {"whatsapp": "15", "instagram": "1800", "youtube": "1800", "x": "1800"}[args.source]
        interval = int(os.environ.get(interval_key, interval_default))
        settings_client = WatcherSettingsClient(args.source)
        settings_cache: dict[str, Any] = dict(DEFAULT_WATCHER_SETTINGS)
        messages_db = os.environ.get(
            "WHATSAPP_MESSAGES_DB", "~/whatsapp-mcp/whatsapp-bridge/store/messages.db"
        )
        whatsapp_db = (
            os.environ.get("WHATSAPP_DB")
            or "~/whatsapp-mcp/whatsapp-bridge/store/whatsapp.db"
        )
        automation_interval = int(
            os.environ.get("REMY_INSTAGRAM_AUTOMATION_INTERVAL_SECONDS", "900")
        )
        last_contact_sync = 0.0
        last_read = 0.0
        last_automation = 0.0
        tick = 15
        while True:
            try:
                fetched = settings_client.fetch() if settings_client else None
                if fetched is not None:
                    settings_cache = fetched
                if time.time() - last_contact_sync > 300:
                    if args.source == "whatsapp":
                        catalog = build_contact_catalog(
                            IdentityResolver(whatsapp_db), messages_db
                        )
                    elif args.source == "instagram":
                        catalog = build_instagram_contact_catalog(_instagram_server())
                    else:
                        # No contact catalog for YouTube: the senders are
                        # commenters, not a directory we can enumerate.
                        catalog = []
                    if catalog and settings_client:
                        settings_client.sync_contacts(catalog)
                    last_contact_sync = time.time()

                if args.source == "instagram" and time.time() - last_automation >= automation_interval:
                    last_automation = time.time()
                    try:
                        auto_count = run_instagram_automation_once(
                            store, delivery, settings_cache, _instagram_server()
                        )
                        LOG.info("source=instagram auto_likes_queued=%d", auto_count)
                    except Exception as exc:  # noqa: BLE001
                        LOG.error("source=instagram automation_failed=%s", type(exc).__name__)

                if args.source in ("instagram", "youtube", "x") and last_read and time.time() - last_read < interval:
                    if args.once:
                        return 0
                    time.sleep(tick)
                    continue

                last_read = time.time()
                if args.source == "whatsapp":
                    count = run_whatsapp_once(
                        store,
                        delivery,
                        messages_db,
                        whatsapp_db,
                        settings=settings_cache,
                    )
                elif args.source == "instagram":
                    count = run_instagram_once(store, delivery, settings=settings_cache)
                elif args.source == "youtube":
                    count = run_youtube_once(store, delivery, settings=settings_cache)
                else:
                    count = run_x_once(store, delivery, settings=settings_cache)
                LOG.info("source=%s queued=%d", args.source, count)
            except Exception as exc:  # do not spin on auth/challenge/throttle failures
                LOG.error("source=%s read_failed=%s", args.source, type(exc).__name__)
                if args.source == "instagram" and any(
                    marker in str(exc).lower()
                    for marker in ("challenge", "thrott", "rate", "login", "blocked")
                ):
                    return 2
            if args.once:
                return 0
            time.sleep(tick)
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
