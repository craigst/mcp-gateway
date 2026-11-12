import http.server
import contextlib
import io
import json
import logging
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from remy_watchers import (
    StateStore,
    WebhookDelivery,
    WhatsAppEvent,
    _quiet_instagram_call,
    build_instagram_contact_catalog,
    event_allowed,
    run_instagram_automation_once,
    process_events,
    read_whatsapp_events,
    latest_whatsapp_cursor,
    run_whatsapp_once,
)


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    received = []

    def do_POST(self):  # noqa: N802
        size = int(self.headers["Content-Length"])
        self.received.append((self.headers["X-Remy-Event-ID"], json.loads(self.rfile.read(size))))
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args):
        pass


class WatcherTests(unittest.TestCase):
    def test_whatsapp_reader_is_incoming_only_and_ordered(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "messages.db"
            db = sqlite3.connect(path)
            db.executescript(
                """
                CREATE TABLE chats(jid TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE messages(timestamp TEXT, chat_jid TEXT, sender TEXT,
                  id TEXT, content TEXT, is_from_me INTEGER, media_type TEXT);
                INSERT INTO chats VALUES ('chat@g.us', 'Test chat');
                INSERT INTO messages VALUES ('2026-10-29T01:00:00+00:00','chat@g.us','42','a','in',0,NULL);
                INSERT INTO messages VALUES ('2026-10-29T01:01:00+00:00','chat@g.us','me','b','out',1,NULL);
                INSERT INTO messages VALUES ('2026-10-29T01:02:00+00:00','chat@g.us','43','c','image',0,'image');
                """
            )
            db.commit()
            db.close()
            events = read_whatsapp_events(path)
            self.assertEqual([e.message_id for e in events], ["a", "c"])
            self.assertEqual(events[1].media_type, "image")
            self.assertEqual(latest_whatsapp_cursor(path), ("2026-10-29T01:02:00+00:00", "c"))

    def test_lid_sender_and_chat_resolve_to_name_and_number(self):
        with tempfile.TemporaryDirectory() as tmp:
            messages = Path(tmp) / "messages.db"
            whatsapp = Path(tmp) / "whatsapp.db"
            db = sqlite3.connect(messages)
            db.executescript(
                """
                CREATE TABLE chats(jid TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE messages(timestamp TEXT, chat_jid TEXT, sender TEXT,
                  id TEXT, content TEXT, is_from_me INTEGER, media_type TEXT);
                INSERT INTO chats VALUES ('261821390962921@lid', '5849879732462');
                INSERT INTO messages VALUES ('2026-11-02T14:30:58+00:00',
                  '261821390962921@lid', '261821390962921', 'm1', 'Batteries are here mate', 0, NULL);
                """
            )
            db.commit()
            db.close()
            wadb = sqlite3.connect(whatsapp)
            wadb.executescript(
                """
                CREATE TABLE whatsmeow_lid_map(lid TEXT, pn TEXT);
                CREATE TABLE whatsmeow_contacts(their_jid TEXT, first_name TEXT,
                  full_name TEXT, push_name TEXT, business_name TEXT);
                INSERT INTO whatsmeow_lid_map VALUES ('261821390962921', '447702088231');
                INSERT INTO whatsmeow_lid_map VALUES ('5849879732462', '447779274274');
                INSERT INTO whatsmeow_contacts VALUES
                  ('447702088231@s.whatsapp.net', 'Matt Frost', 'Matt Frost', 'Matt Frost', NULL);
                INSERT INTO whatsmeow_contacts VALUES
                  ('261821390962921@lid', NULL, NULL, 'Matt Frost', NULL);
                """
            )
            wadb.commit()
            wadb.close()

            event = read_whatsapp_events(messages, whatsapp_db=whatsapp)[0]
            self.assertEqual(event.sender, "261821390962921")
            self.assertEqual(event.sender_number, "447702088231")
            self.assertEqual(event.sender_name, "Matt Frost")
            self.assertEqual(event.sender_kind, "person")
            self.assertEqual(event.sender_label, "Matt Frost (447702088231)")
            self.assertEqual(event.chat_name, "Matt Frost")
            payload = event.payload()
            self.assertEqual(payload["sender"], "Matt Frost (447702088231)")
            self.assertEqual(payload["sender_raw"], "261821390962921")
            self.assertEqual(payload["conversation"]["name"], "Matt Frost")
            self.assertEqual(payload["conversation"]["phone"], "447702088231")

    def test_unresolved_lid_uses_lid_contact_name_but_not_as_phone(self):
        with tempfile.TemporaryDirectory() as tmp:
            messages = Path(tmp) / "messages.db"
            whatsapp = Path(tmp) / "whatsapp.db"
            db = sqlite3.connect(messages)
            db.executescript(
                """
                CREATE TABLE chats(jid TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE messages(timestamp TEXT, chat_jid TEXT, sender TEXT,
                  id TEXT, content TEXT, is_from_me INTEGER, media_type TEXT);
                INSERT INTO chats VALUES ('999999999999999@lid', '999999999999999');
                INSERT INTO messages VALUES ('2026-11-02T14:30:58+00:00',
                  '999999999999999@lid', '999999999999999', 'm2', 'hi', 0, NULL);
                """
            )
            db.commit()
            db.close()
            wadb = sqlite3.connect(whatsapp)
            wadb.executescript(
                """
                CREATE TABLE whatsmeow_lid_map(lid TEXT, pn TEXT);
                CREATE TABLE whatsmeow_contacts(their_jid TEXT, first_name TEXT,
                  full_name TEXT, push_name TEXT, business_name TEXT);
                INSERT INTO whatsmeow_contacts VALUES
                  ('999999999999999@lid', NULL, NULL, 'Jade', NULL);
                """
            )
            wadb.commit()
            wadb.close()

            event = read_whatsapp_events(messages, whatsapp_db=whatsapp)[0]
            self.assertEqual(event.sender_kind, "unresolved_lid")
            self.assertIsNone(event.sender_number)
            self.assertEqual(event.sender_name, "Jade")
            self.assertIn("unresolved LID", event.sender_label)
            self.assertNotIn("999999999999999", event.sender_label.split("unresolved LID")[0])
            self.assertEqual(event.chat_name, "Jade")

    def test_dedup_and_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), CaptureHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            store = StateStore(Path(tmp) / "state.sqlite3")
            delivery = WebhookDelivery(f"http://127.0.0.1:{server.server_port}/hook")
            event = {"event_id": "whatsapp:c:a", "timestamp": "2026-10-29T01:00:00Z", "text": "draft"}
            self.assertEqual(process_events(store, "whatsapp", [event], delivery), 1)
            self.assertEqual(process_events(store, "whatsapp", [event], delivery), 0)
            self.assertEqual(len(CaptureHandler.received), 1)
            self.assertEqual(CaptureHandler.received[0][0], "whatsapp:c:a")
            server.shutdown()
            server.server_close()
            store.close()

    def test_spool_only_does_not_claim_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.sqlite3")
            event = {"event_id": "instagram:t:m", "timestamp": "2026-10-29T01:00:00Z"}
            self.assertEqual(process_events(store, "instagram", [event], WebhookDelivery(None)), 1)
            row = store.conn.execute("SELECT status, attempts FROM outbox").fetchone()
            self.assertEqual(tuple(row), ("pending", 1))
            store.close()

    def test_delivery_does_not_drain_another_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.sqlite3")
            whatsapp = {"event_id": "whatsapp:private", "timestamp": "2026-10-29T01:00:00Z"}
            instagram = {"event_id": "instagram:private", "timestamp": "2026-10-29T01:01:00Z"}
            self.assertTrue(store.enqueue(whatsapp["event_id"], "whatsapp", whatsapp))
            self.assertTrue(store.enqueue(instagram["event_id"], "instagram", instagram))

            process_events(store, "instagram", [], WebhookDelivery(None))

            rows = store.conn.execute(
                "SELECT source, attempts FROM outbox ORDER BY source"
            ).fetchall()
            self.assertEqual([tuple(row) for row in rows], [("instagram", 1), ("whatsapp", 0)])
            store.close()

    def test_event_filter_all_selected_and_paused(self):
        event = WhatsAppEvent(
            event_id="whatsapp:c:m",
            timestamp="2026-11-02T14:30:58+00:00",
            chat_jid="261821390962921@lid",
            chat_name="Matt Frost",
            sender="261821390962921",
            message_id="m",
            text="hi",
            media_type=None,
            sender_label="Matt Frost (447702088231)",
            sender_name="Matt Frost",
            sender_number="447702088231",
            sender_kind="person",
        )
        self.assertTrue(event_allowed(event, {"enabled": True, "mode": "all", "selected": []}))
        self.assertFalse(event_allowed(event, {"enabled": False, "mode": "all", "selected": []}))
        self.assertTrue(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["447702088231"]})
        )
        self.assertTrue(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["lid:261821390962921"]})
        )
        self.assertFalse(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["447000000000"]})
        )
        self.assertFalse(event_allowed(event, {"enabled": True, "mode": "selected", "selected": []}))

    def test_instagram_event_filter_and_contact_catalog(self):
        event = {
            "sender": "mattfrost",
            "sender_username": "mattfrost",
            "sender_id": "12345",
            "conversation": {"id": "thread-1", "name": "Matt Frost"},
        }
        self.assertTrue(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["ig:mattfrost"]})
        )
        self.assertTrue(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["thread:thread-1"]})
        )
        self.assertFalse(
            event_allowed(event, {"enabled": True, "mode": "selected", "selected": ["ig:someoneelse"]})
        )

        class FakeServer:
            @staticmethod
            def ig_list_threads(amount=50):
                return {
                    "ok": True,
                    "threads": [
                        {
                            "thread_id": "thread-1",
                            "title": "Matt Frost",
                            "users": [{"username": "mattfrost", "full_name": "Matt Frost", "pk": "12345"}],
                        },
                        {"thread_id": "thread-2", "title": "Group chat", "users": []},
                    ],
                }

        catalog = build_instagram_contact_catalog(FakeServer())
        self.assertEqual(
            {row["key"] for row in (catalog if isinstance(catalog, list) else [])},
            {"ig:mattfrost", "thread:thread-2"},
        )

    def test_instagram_auto_like_baselines_then_likes_new_items(self):
        class FakeServer:
            def __init__(self):
                self.posts = {"cleo": [{"code": "old", "pk": "1"}]}
                self.activity = [{"kind": "mention", "from": "mate", "at": "2026-11-02T18:00:00",
                                  "comment_id": "c1", "media_pk": "p1", "text": "hey @cra1gst"}]
                self.liked_posts = []
                self.liked_comments = []

            def ig_status(self):
                return {"username": "cra1gst", "writes_enabled": True}

            def ig_user_posts(self, username, amount=3):
                return {"posts": list(self.posts.get(username, []))[:amount]}

            def ig_activity(self, kinds=None, amount=30, resolve=False):
                return {"items": list(self.activity)}

            def ig_like_post(self, code):
                self.liked_posts.append(code)
                return {"liked": True, "pk": code}

            def ig_like_comment(self, comment_id):
                self.liked_comments.append(comment_id)
                return {"liked": True, "comment_id": comment_id}

        settings = {
            "enabled": True,
            "mode": "all",
            "selected": [],
            "autoLike": {
                "cleoPosts": True,
                "mentions": True,
                "cleoPostComments": False,
                "selectedAccounts": False,
                "cleoAccounts": ["cleo"],
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.sqlite3")
            server = FakeServer()
            delivery = WebhookDelivery(None)
            run_instagram_automation_once(store, delivery, settings, server)
            self.assertEqual(server.liked_posts, [])
            self.assertEqual(server.liked_comments, [])

            server.posts["cleo"] = [{"code": "new", "pk": "2"}] + server.posts["cleo"]
            server.activity.append({"kind": "mention", "from": "mate", "at": "2026-11-02T18:10:00",
                                    "comment_id": "c2", "media_pk": "p1", "text": "new @cra1gst"})
            count = run_instagram_automation_once(store, delivery, settings, server)
            self.assertIn("new", server.liked_posts)
            self.assertIn("c2", server.liked_comments)
            self.assertGreaterEqual(count, 1)
            store.close()

    def test_filtered_events_still_advance_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            messages = Path(tmp) / "messages.db"
            db = sqlite3.connect(messages)
            db.executescript(
                """
                CREATE TABLE chats(jid TEXT PRIMARY KEY, name TEXT);
                CREATE TABLE messages(timestamp TEXT, chat_jid TEXT, sender TEXT,
                  id TEXT, content TEXT, is_from_me INTEGER, media_type TEXT);
                INSERT INTO chats VALUES ('261821390962921@lid', 'Matt Frost');
                INSERT INTO messages VALUES ('2026-11-02T14:30:58+00:00',
                  '261821390962921@lid', '261821390962921', 'm1', 'one', 0, NULL);
                INSERT INTO messages VALUES ('2026-11-02T14:31:58+00:00',
                  '261821390962921@lid', '261821390962921', 'm2', 'two', 0, NULL);
                """
            )
            db.commit()
            db.close()
            store = StateStore(Path(tmp) / "state.sqlite3")
            store.set_cursor("whatsapp", "2026-11-02T14:30:58+00:00\tm1")
            count = run_whatsapp_once(
                store,
                WebhookDelivery(None),
                messages,
                settings={"enabled": True, "mode": "selected", "selected": ["other"]},
            )
            self.assertEqual(count, 0)
            self.assertEqual(store.cursor("whatsapp"), "2026-11-02T14:31:58+00:00\tm2")
            store.close()

    def test_instagram_request_logging_is_suppressed(self):
        def noisy_call():
            print("private request", file=sys.stderr)
            logging.getLogger("instagrapi").critical("private request")
            return {"ok": True}

        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = _quiet_instagram_call(noisy_call)

        self.assertEqual(result, {"ok": True})
        self.assertEqual(output.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
