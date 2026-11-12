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
import random
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
    "cleoStories": True,
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
        "cleoStories": raw.get("cleoStories") is True,
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
        chat_id = str(getattr(event, "chat_jid", None) or "")
        if chat_id.endswith("@g.us"):
            # A group is a contact in its own right: "selected contacts only"
            # means selected DMs plus selected groups. A message inside an
            # *unselected* group must not pass just because the person who
            # posted it is a selected DM contact — otherwise every selected
            # driver drags their unselected groups ("Daily walk around checks",
            # "Working time", …) in with them and Remy drafts replies there.
            keys.update({chat_id, f"group:{chat_id}"})
        else:
            if getattr(event, "sender_number", None):
                keys.add(str(event.sender_number))
            sender = getattr(event, "sender", None)
            if sender:
                keys.add(f"lid:{sender}")
                keys.add(str(sender))
            if chat_id:
                keys.update({chat_id, f"group:{chat_id}"})
    return bool(keys & selected)


class WatcherSettingsClient:
    """Fetch one source's allowlist/auto-reply settings from the gateway.

    A missing key or an unreachable gateway must not silently change the
    watcher's scope. The caller keeps its last good settings; only the first
    run falls back to enabled/all (the historical behaviour).
    """

    def __init__(self, source: str, key_file: Optional[str] = None, timeout: float = 5.0):
        if source not in ("whatsapp", "instagram"):
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


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _parse_iso(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def _post_taken_at(post: Any) -> Optional[float]:
    if not isinstance(post, dict):
        return None
    return _parse_iso(post.get("taken_at"))


def _post_already_liked(post: Any) -> bool:
    """True only when the feed actually reports our like.

    ``ig_user_posts`` carries ``liked`` when the connector is new enough; an
    older connector leaves it out, so a missing/None value means "unknown" and
    the caller should still try (a repeat like is harmless).
    """
    if not isinstance(post, dict):
        return False
    return post.get("liked") is True


def _recent_account_posts(
    server: Any,
    account: str,
    *,
    amount: Optional[int] = None,
    max_age_days: Optional[int] = None,
) -> list[dict[str, Any]]:
    """One account's recent posts, newest first.

    There are two traps here, and both made auto-like silently do nothing:

    * **A small ``amount`` is not a cheap page.** Instagram's ranked
      ``feed/user`` endpoint answers HTTP 200 with an EMPTY ``items`` list when
      the count is small for some accounts (verified 2026-11-10: ``livecleo``
      returned 0 posts at ``count=3`` and 4 posts at ``count=4``). A three-post
      poll therefore saw nothing on every pass, with no error to log.
    * **Profile order is not chronological.** Pinned posts sit at the top, so a
      three-item window on ``livecleo`` was three posts from 2023/2024 and never
      the reel posted that morning.

    So: ask for a page big enough to be served, then sort by ``taken_at`` and
    drop anything older than ``REMY_INSTAGRAM_POST_MAX_AGE_DAYS`` (default 7).
    An old post is never a "new post", and liking a pinned 2023 reel is exactly
    the bot signal this watcher exists to avoid.
    """
    if amount is None:
        amount = _env_int("REMY_INSTAGRAM_POSTS_AMOUNT", 12)
    amount = max(4, amount)
    if max_age_days is None:
        max_age_days = _env_int("REMY_INSTAGRAM_POST_MAX_AGE_DAYS", 7)
    result = _quiet_instagram_call(server.ig_user_posts, account, amount=amount)
    posts = [
        post
        for post in (result.get("posts") or [])
        if isinstance(post, dict) and str(post.get("code") or "")
    ]
    if not posts:
        # Silence here is what hid the bug for days: an empty poll is a
        # monitoring failure, not "no new posts".
        LOG.warning(
            "instagram posts poll returned 0 posts account=%s amount=%d "
            "(ranked feed throttled or count too small for Instagram to serve)",
            account,
            amount,
        )
        return []
    if len(posts) < 4:
        # A page that short can be nothing but pinned posts, and every pinned
        # post is older than the age window — so a new post would be invisible
        # even though the page was not empty. Say so instead of going quiet.
        LOG.warning(
            "instagram posts page short account=%s returned=%d requested=%d "
            "(pinned posts can fill a short page and hide a new post)",
            account,
            len(posts),
            amount,
        )
    cutoff = time.time() - max_age_days * 86400 if max_age_days > 0 else None
    recent = [
        post
        for post in posts
        if cutoff is None or (_post_taken_at(post) or 0.0) >= cutoff
    ]
    recent.sort(key=lambda post: _post_taken_at(post) or 0.0, reverse=True)
    return recent


class LikeGate:
    """One like per automation pass, with a persisted gap and a hard stop.

    Instagram treats a burst of likes as bot behaviour, and the first write it
    dislikes comes back as ``LoginRequired`` — which then breaks reads too. So:
      * at most ``REMY_INSTAGRAM_MAX_LIKES_PER_PASS`` likes per pass (default 1),
      * at least ``REMY_INSTAGRAM_LIKE_MIN_GAP_SECONDS`` between likes across
        passes (default 300),
      * no writes at all while the connector's state says the session is expired,
      * the first LoginRequired/ChallengeRequired halts every remaining like.
    """

    AUTH_ERRORS = {"LoginRequired", "ChallengeRequired", "PleaseWaitFewMinutes", "SessionError"}

    def __init__(self, store: StateStore, server: Any) -> None:
        self.store = store
        self.server = server
        self.max_per_pass = max(0, _env_int("REMY_INSTAGRAM_MAX_LIKES_PER_PASS", 1))
        self.min_gap_s = max(0, _env_int("REMY_INSTAGRAM_LIKE_MIN_GAP_SECONDS", 300))
        self.used = 0
        self.halted: Optional[str] = None
        self.skip_reason: Optional[str] = None
        self._last_at = _parse_iso(store.meta_get("ig:auto:like:last_at"))

    def remaining(self) -> int:
        return max(0, self.max_per_pass - self.used)

    def halt(self, reason: str) -> None:
        if self.halted is None:
            self.halted = reason
            LOG.warning("instagram auto-like halted: %s", reason)

    def _session_expired(self) -> bool:
        try:
            state = self.server.session.read_state()
        except Exception:  # noqa: BLE001
            return False
        ok_at = _parse_iso(state.get("last_ok_at"))
        error_at = _parse_iso(state.get("last_error_at"))
        return error_at is not None and (ok_at is None or error_at >= ok_at)

    def allow(self, kind: str) -> bool:
        if self.halted is not None:
            return False
        if self.used >= self.max_per_pass:
            self.skip_reason = self.skip_reason or "pass_limit"
            return False
        if self._session_expired():
            self.halt("session_expired")
            return False
        if self._last_at is not None and (time.time() - self._last_at) < self.min_gap_s:
            self.skip_reason = self.skip_reason or "gap"
            return False
        return True

    def record(self, kind: str, target: str) -> None:
        self.used += 1
        self._last_at = time.time()
        self.store.meta_set("ig:auto:like:last_at", now_iso())
        LOG.info(
            "instagram auto-like %s target=%s (pass %d/%d)",
            kind, log_event_id(target), self.used, self.max_per_pass,
        )

    def note_error(self, exc: BaseException) -> None:
        if type(exc).__name__ in self.AUTH_ERRORS:
            self.halt(type(exc).__name__)


def _auto_like_comment(
    store: StateStore, server: Any, comment_id: str, *, writes: bool, gate: LikeGate
) -> bool:
    if not comment_id or _seen(store, "comment", comment_id):
        return False
    if not writes:
        return False
    if not gate.allow("comment"):
        # Leave it unseen: a later pass can like it within the budget/gap.
        return False
    try:
        result = _quiet_instagram_call(server.ig_like_comment, comment_id)
        liked = bool(result.get("liked"))
        _mark_seen(store, "comment", comment_id)
        if liked:
            gate.record("comment", comment_id)
        return liked
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram auto-like comment failed: %s", type(exc).__name__)
        gate.note_error(exc)
        if gate.halted is None:
            _mark_seen(store, "comment", comment_id)
        return False


def _auto_like_post(
    store: StateStore, server: Any, code: str, *, writes: bool, gate: LikeGate
) -> bool:
    if not code or _seen(store, "post", code):
        return False
    if not writes:
        return False
    if not gate.allow("post"):
        return False
    try:
        result = _quiet_instagram_call(server.ig_like_post, code)
        liked = bool(result.get("liked"))
        _mark_seen(store, "post", code)
        if liked:
            gate.record("post", code)
        return liked
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram auto-like post failed: %s", type(exc).__name__)
        gate.note_error(exc)
        if gate.halted is None:
            _mark_seen(store, "post", code)
        return False



def _poll_account_posts(
    store: StateStore,
    server: Any,
    account: str,
    *,
    state: str,
    writes: bool,
    gate: LikeGate,
    amount: Optional[int] = None,
) -> None:
    if state == "off":
        return
    try:
        posts = _recent_account_posts(server, account, amount=amount)
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram posts poll failed: %s", type(exc).__name__)
        return
    if state == "baseline":
        for post in posts:
            _mark_seen(store, "post", str(post["code"]))
        return
    # Oldest first, so a burst of uploads drains in the order they were posted
    # and nothing starves behind the one-like-per-pass gate.
    for post in sorted(posts, key=lambda item: _post_taken_at(item) or 0.0):
        code = str(post.get("code") or "")
        if not code or _seen(store, "post", code):
            continue
        if _post_already_liked(post):
            # Liked by hand (or an earlier pass) — record it without spending a
            # LikeGate slot on a write that would change nothing.
            _mark_seen(store, "post", code)
            continue
        _auto_like_post(store, server, code, writes=writes, gate=gate)


def _activity_comment_events(
    store: StateStore,
    server: Any,
    *,
    enabled: bool,
    writes: bool,
    gate: LikeGate,
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
            _auto_like_comment(store, server, comment_id, writes=writes, gate=gate)
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
    gate: LikeGate,
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
            posts = _recent_account_posts(server, account)[:2]
        except Exception as exc:  # noqa: BLE001
            LOG.warning("instagram cleo posts poll failed: %s", type(exc).__name__)
            continue
        for post in posts:
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
                _auto_like_comment(store, server, comment_pk, writes=writes, gate=gate)
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
    gate: LikeGate,
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
        _poll_account_posts(store, server, username, state=state, writes=writes, gate=gate)




def _auto_like_cleo_stories(
    store: StateStore,
    server: Any,
    accounts: list[str],
    *,
    enabled: bool,
    writes: bool,
    gate: LikeGate,
) -> int:
    """Like at most one unseen story, paced by the LikeGate.

    Stories expire, so they go first, but a burst of story likes is exactly the
    pattern Instagram answers with LoginRequired — so the gate allows one write
    per pass and this stops at the first auth error.
    """
    if not enabled:
        return 0
    if os.environ.get("REMY_INSTAGRAM_LIKE_STORIES", "1").strip().lower() not in {"1", "true", "yes", "on"}:
        return 0
    if not writes or gate.halted is not None or gate.remaining() <= 0:
        if gate.halted is None and writes:
            gate.skip_reason = gate.skip_reason or "pass_limit"
        return 0
    try:
        client = _quiet_instagram_call(server._client)
    except Exception as exc:  # noqa: BLE001
        LOG.warning("instagram story client failed: %s", type(exc).__name__)
        gate.note_error(exc)
        return 0
    try:
        raw = store.meta_get("ig:auto:stories:liked")
        liked = set(json.loads(raw)) if raw else set()
    except (ValueError, TypeError):
        liked = set()
    count = 0
    stop = False
    for account in accounts[:5]:
        if stop or gate.halted is not None or gate.remaining() <= 0:
            break
        try:
            user_id = _quiet_instagram_call(client.user_id_from_username, account)
            stories = _quiet_instagram_call(client.user_stories, user_id)
        except Exception as exc:  # noqa: BLE001
            LOG.warning("instagram stories poll failed account=%s error=%s", account, type(exc).__name__)
            gate.note_error(exc)
            if gate.halted is not None:
                break
            continue
        for story in stories or []:
            pk = str(getattr(story, "pk", "") or "")
            if not pk or pk in liked:
                continue
            if not gate.allow("story"):
                stop = True
                break
            try:
                # Humanise the single write: reads are cheap, likes are not.
                time.sleep(random.uniform(2.0, 6.0))
                _quiet_instagram_call(client.story_like, pk)
                liked.add(pk)
                count += 1
                gate.record("story", pk)
                store.meta_set("ig:auto:stories:liked", json.dumps(sorted(liked)))
            except Exception as exc:  # noqa: BLE001
                LOG.warning("instagram story_like failed account=%s error=%s", account, type(exc).__name__)
                gate.note_error(exc)
                stop = True
            break  # one story per account; the gate caps the pass anyway
    return count


def run_instagram_automation_once(
    store: StateStore,
    delivery: WebhookDelivery,
    settings: dict[str, Any],
    server: Any,
) -> int:
    """Poll Instagram activity/comments and perform enabled auto-likes.

    Replies, comments and mentions are never posted here: matching items become
    draft webhook events for Remy, exactly like DMs.

    Auto-likes are deliberately slow: one like per pass, a persisted minimum gap
    between passes, and an immediate stop on the first auth error. Batch liking
    is what invalidates the saved session.
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
    if not writes:
        reason = "no status"
        if isinstance(status, dict):
            reason = str(status.get("error") or status.get("message") or "writes_enabled missing")
        LOG.warning("instagram writes disabled this pass: %s", reason)

    gate = LikeGate(store, server)
    # Stories first (they expire); the gate still allows only one write per pass.
    _auto_like_cleo_stories(
        store,
        server,
        auto.get("cleoAccounts", []),
        enabled=auto.get("cleoStories", True),
        writes=writes,
        gate=gate,
    )

    cleo_state = _auto_action_state(store, "cleoPosts", auto["cleoPosts"])
    for account in auto.get("cleoAccounts", [])[:5]:
        _poll_account_posts(store, server, account, state=cleo_state, writes=writes, gate=gate)

    _selected_account_post_likes(
        store,
        server,
        settings,
        enabled=auto["selectedAccounts"],
        writes=writes,
        gate=gate,
    )

    events: list[dict[str, Any]] = []
    events.extend(_activity_comment_events(store, server, enabled=auto["mentions"], writes=writes, gate=gate))
    events.extend(
        _cleo_comment_events(
            store,
            server,
            auto.get("cleoAccounts", []),
            enabled=auto["cleoPostComments"],
            writes=writes,
            my_username=my_username,
            gate=gate,
        )
    )

    LOG.info(
        "instagram auto-like pass used=%d/%d halted=%s skipped=%s",
        gate.used, gate.max_per_pass, gate.halted, gate.skip_reason,
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


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=("whatsapp", "instagram"))
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.environ.get("REMY_LOG_LEVEL", "INFO"), format="%(message)s")
    state = os.environ.get(
        "REMY_STATE_DB", "~/.local/state/remy-watchers/state.sqlite3"
    )
    store = StateStore(state)
    try:
        url_key = (
            "REMY_WHATSAPP_WEBHOOK_URL"
            if args.source == "whatsapp"
            else "REMY_INSTAGRAM_WEBHOOK_URL"
        )
        delivery = WebhookDelivery(os.environ.get(url_key))
        if not delivery.enabled:
            LOG.warning("source=%s delivery=disabled reason=missing_private_url", args.source)
        interval = int(
            os.environ.get(
                "REMY_INSTAGRAM_INTERVAL_SECONDS" if args.source == "instagram" else "REMY_WHATSAPP_INTERVAL_SECONDS",
                "1800" if args.source == "instagram" else "15",
            )
        )
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
                fetched = settings_client.fetch()
                if fetched is not None:
                    settings_cache = fetched
                if time.time() - last_contact_sync > 300:
                    if args.source == "whatsapp":
                        catalog = build_contact_catalog(
                            IdentityResolver(whatsapp_db), messages_db
                        )
                    else:
                        catalog = build_instagram_contact_catalog(_instagram_server())
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

                if args.source == "instagram" and last_read and time.time() - last_read < interval:
                    if args.once:
                        return 0
                    time.sleep(tick)
                    continue

                last_read = time.time()
                count = (
                    run_whatsapp_once(
                        store,
                        delivery,
                        messages_db,
                        whatsapp_db,
                        settings=settings_cache,
                    )
                    if args.source == "whatsapp"
                    else run_instagram_once(store, delivery, settings=settings_cache)
                )
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
