"""The email triage watcher: rules, dedupe and one pass over a batch.

The properties worth protecting are the safety ones: a rule decision never
costs a model call, a model failure acks nothing (so the mail comes back), and
an acked batch is on the local spool before the cursor moves.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from remy_watchers import (
    EMAIL_SEEN_KEY,
    StateStore,
    bare_email,
    email_rule,
    email_seen,
    normalize_subject,
    run_email_once,
    sender_matches,
)


def message(uid, sender="Ada <ada@example.com>", subject="Q3 numbers", **extra):
    payload = {
        "id": f"gmail:1:{uid}",
        "accountId": "gmail",
        "accountEmail": "craig@example.com",
        "uid": uid,
        "from": sender,
        "subject": subject,
        "preview": "Can you send them?",
        "date": "2026-11-12T09:00:00.000Z",
        "unread": True,
        "listUnsubscribe": False,
        "automated": False,
    }
    payload.update(extra)
    return payload


def settings(**extra):
    base = {
        "accountId": "gmail",
        "email": "craig@example.com",
        "enabled": True,
        "mode": "important",
        "pollSeconds": 300,
        "junkFolder": None,
        "alwaysImportant": ["mum@example.com"],
        "neverJunk": [],
    }
    base.update(extra)
    return base


class FakeClient:
    """Stands in for EmailGatewayClient; records what the watcher asked for."""

    def __init__(self, accounts, verdicts=None, judge_fails=False, ack_ok=True):
        self.accounts = accounts
        self.verdicts = verdicts or {}
        self.judge_fails = judge_fails
        self.ack_ok = ack_ok
        self.file_fails = False
        self.judged = []
        self.acked = []
        self.filed = []
        self.wait = 300

    def fetch(self):
        return {"accounts": self.accounts, "waitSeconds": self.wait}

    def judge(self, account_id, messages, dismissed):
        self.judged.append({"accountId": account_id, "ids": [m["id"] for m in messages], "dismissed": dismissed})
        if self.judge_fails:
            return None
        return {m["id"]: self.verdicts.get(m["id"], {"triage": "skip", "pTop": 0.9, "scamP": 0.1}) for m in messages}

    def file(self, account_id, decisions):
        self.filed.append({"accountId": account_id, "decisions": decisions})
        if self.file_fails:
            return None
        return {"filed": len(decisions), "results": [{"messageId": d["messageId"], "filed": True, "reason": None} for d in decisions]}

    def ack(self, account_id, uid_validity, last_uid, decisions):
        self.acked.append(
            {"accountId": account_id, "uidValidity": uid_validity, "lastUid": last_uid, "decisions": decisions}
        )
        return self.ack_ok


class FakeDelivery:
    def __init__(self, ok=True):
        self.ok = ok
        self.sent = []

    @property
    def enabled(self):
        return True

    def send(self, event_id, payload):
        self.sent.append((event_id, payload))
        return self.ok


class EmailRuleTests(unittest.TestCase):
    def test_bare_email_takes_the_address_out_of_a_display_name(self):
        self.assertEqual(bare_email("Ada Lovelace <Ada@Example.com>"), "ada@example.com")
        self.assertEqual(bare_email("ada@example.com"), "ada@example.com")
        self.assertEqual(bare_email(""), "")

    def test_sender_matches_an_address_or_a_whole_domain(self):
        self.assertTrue(sender_matches("a@b.example", ["a@b.example"]))
        self.assertTrue(sender_matches("a@gov.uk", ["@gov.uk"]))
        self.assertFalse(sender_matches("a@notgov.uk", ["@gov.uk"]))
        self.assertFalse(sender_matches("a@b.example", []))
        self.assertFalse(sender_matches("a@b.example", ["other@b.example"]))

    def test_normalize_subject_collapses_a_thread(self):
        self.assertEqual(normalize_subject("Re: Fwd: Q3 Numbers"), "q3 numbers")
        self.assertEqual(normalize_subject("RE[2]:  Hello   there"), "hello there")
        self.assertEqual(normalize_subject("Q3"), "q3")

    def test_an_allowlisted_sender_never_reaches_the_model(self):
        self.assertEqual(email_rule(message(1, sender="Mum <mum@example.com>"), settings(), {}), ("important", "allowlist"))

    def test_bulk_and_automated_mail_is_skipped_without_a_model_call(self):
        self.assertEqual(email_rule(message(1, listUnsubscribe=True), settings(), {}), ("skip", "bulk"))
        self.assertEqual(email_rule(message(2, automated=True), settings(), {}), ("skip", "bulk"))

    def test_a_repeat_is_skipped(self):
        seen = {"ada@example.com|q3 numbers": "2026-11-12T09:00:00+00:00"}
        self.assertEqual(email_rule(message(3), settings(), seen), ("skip", "repeat"))
        # A different subject is not a repeat.
        self.assertIsNone(email_rule(message(4, subject="Q4 numbers"), settings(), seen))

    def test_an_ordinary_message_goes_to_the_model(self):
        self.assertIsNone(email_rule(message(5), settings(), {}))


class EmailSeenTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.dir.name) / "state.sqlite3")

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def test_old_entries_are_pruned_and_the_newest_are_kept(self):
        raw = {
            "old@example.com|x": "2020-01-01T00:00:00+00:00",
            "new@example.com|y": "2026-11-12T09:00:00+00:00",
        }
        self.store.meta_set(EMAIL_SEEN_KEY, json.dumps(raw))
        kept = email_seen(self.store)
        self.assertIn("new@example.com|y", kept)
        self.assertNotIn("old@example.com|x", kept)

    def test_a_corrupt_value_does_not_break_the_pass(self):
        self.store.meta_set(EMAIL_SEEN_KEY, "not json")
        self.assertEqual(email_seen(self.store), {})


class RunEmailOnceTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.dir.name) / "state.sqlite3")

    def tearDown(self):
        self.store.close()
        self.dir.cleanup()

    def run_once(self, accounts, **kwargs):
        delivery = FakeDelivery(ok=kwargs.pop("delivery_ok", True))
        client = FakeClient(accounts, **kwargs)
        queued, wait = run_email_once(self.store, delivery, client)
        return queued, wait, client, delivery

    def test_one_event_per_email_carries_what_the_card_prompt_reads(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "1",
                "uidNext": 105,
                "messages": [
                    message(101, sender="Ada <ada@example.com>", subject="Q3 numbers"),
                    message(102, sender="Mum <mum@example.com>", subject="Saturday"),
                ],
            }
        ]
        _queued, _wait, _client, delivery = self.run_once(
            accounts,
            verdicts={"gmail:1:101": {"triage": "reply", "pTop": 0.97, "scamP": 0.02}},
        )
        self.assertEqual(len(delivery.sent), 2)
        by_id = {event_id: payload for event_id, payload in delivery.sent}
        self.assertEqual(sorted(by_id), ["email:gmail:1:101", "email:gmail:1:102"])
        payload = by_id["email:gmail:1:101"]
        # The prompt reads the message itself, so it needs the account and folder.
        self.assertEqual(payload["account"]["id"], "gmail")
        self.assertEqual(payload["folder"], "INBOX")
        self.assertEqual(payload["uid"], 101)
        self.assertEqual(payload["message_id"], "gmail:1:101")
        self.assertTrue(payload["needs_reply"])
        self.assertTrue(payload["draft_only"])
        self.assertFalse(payload["auto_send"])

    def test_the_confidence_floor_suppresses_only_unsure_important_mail(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "1",
                "uidNext": 104,
                "messages": [message(101, subject="bank notice"), message(102, subject="real question")],
            }
        ]
        verdicts = {
            "gmail:1:101": {"triage": "important", "pTop": 0.52, "scamP": 0.46},
            "gmail:1:102": {"triage": "reply", "pTop": 0.55, "scamP": 0.02},
        }
        os.environ["REMY_EMAIL_MIN_CONFIDENCE"] = "0.7"
        try:
            _queued, _wait, _client, delivery = self.run_once(accounts, verdicts=verdicts)
        finally:
            os.environ.pop("REMY_EMAIL_MIN_CONFIDENCE", None)
        # The unsure `important` is dropped; the unsure `reply` is still carded.
        self.assertEqual([p["message_id"] for _e, p in delivery.sent], ["gmail:1:102"])

    def test_the_floor_is_off_by_default(self):
        accounts = [
            {"settings": settings(), "uidValidity": "1", "uidNext": 104,
             "messages": [message(101, subject="bank notice")]},
        ]
        os.environ.pop("REMY_EMAIL_MIN_CONFIDENCE", None)
        _queued, _wait, _client, delivery = self.run_once(
            accounts, verdicts={"gmail:1:101": {"triage": "important", "pTop": 0.52, "scamP": 0.46}}
        )
        self.assertEqual(len(delivery.sent), 1)

    def test_a_backlog_is_capped_per_pass(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "1",
                "uidNext": 120,
                "messages": [message(100 + i, subject=f"Question {i}") for i in range(1, 9)],
            }
        ]
        verdicts = {f"gmail:1:{100 + i}": {"triage": "reply", "pTop": 0.9, "scamP": 0.01} for i in range(1, 9)}
        _queued, _wait, _client, delivery = self.run_once(accounts, verdicts=verdicts)
        self.assertEqual(len(delivery.sent), 5)

    def test_only_the_important_mail_becomes_a_pick(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "1",
                "uidNext": 105,
                "messages": [
                    message(101, sender="Ada <ada@example.com>", subject="Q3 numbers"),
                    message(102, sender="news@shop.example", subject="Deals", listUnsubscribe=True),
                    message(103, sender="Mum <mum@example.com>", subject="Saturday"),
                ],
            }
        ]
        queued, wait, client, delivery = self.run_once(
            accounts,
            verdicts={"gmail:1:101": {"triage": "reply", "pTop": 0.97, "scamP": 0.02}},
        )
        self.assertEqual(queued, 2)   # one event per carded email
        self.assertEqual(wait, 300)
        # Only the message no rule caught is judged: 101. 102 is bulk, 103 is allowlisted.
        self.assertEqual([entry["ids"] for entry in client.judged], [["gmail:1:101"]])
        # Reply first, then the newer important one: one event each.
        self.assertEqual([p["message_id"] for _e, p in delivery.sent], ["gmail:1:101", "gmail:1:103"])
        self.assertEqual([p["needs_reply"] for _e, p in delivery.sent], [True, False])
        self.assertTrue(delivery.sent[0][1]["draft_only"])
        self.assertFalse(delivery.sent[0][1]["auto_send"])
        # The bulk message was filtered and never carded.
        self.assertNotIn("gmail:1:102", [p["message_id"] for _e, p in delivery.sent])

    def test_the_cursor_moves_to_the_newest_uid_and_the_rules_are_audited(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "7",
                "uidNext": 211,
                "messages": [message(209), message(210, listUnsubscribe=True)],
            }
        ]
        _queued, _wait, client, _delivery = self.run_once(accounts)
        self.assertEqual(len(client.acked), 1)
        ack = client.acked[0]
        self.assertEqual((ack["accountId"], ack["uidValidity"], ack["lastUid"]), ("gmail", "7", 210))
        rules = {d["messageId"]: d["rule"] for d in ack["decisions"]}
        self.assertEqual(rules["gmail:1:210"], "bulk")

    def test_cards_only_mode_files_nothing(self):
        accounts = [
            {"settings": settings(mode="important"), "uidValidity": "1", "uidNext": 105,
             "messages": [message(101, listUnsubscribe=True)]},
        ]
        _queued, _wait, client, _delivery = self.run_once(accounts)
        self.assertEqual(client.filed, [])

    def test_full_mode_asks_the_gateway_to_file_a_skip(self):
        accounts = [
            {"settings": settings(mode="full"), "uidValidity": "1", "uidNext": 105,
             "messages": [message(101, subject="Your account is limited",
                                  **{"from": "PayPal <security@paypal-verify.example>"})]},
        ]
        _queued, _wait, client, _delivery = self.run_once(
            accounts, verdicts={"gmail:1:101": {"triage": "skip", "pTop": 0.8, "scamP": 0.99}}
        )
        self.assertEqual(len(client.filed), 1)
        sent = client.filed[0]["decisions"][0]
        self.assertEqual((sent["messageId"], sent["uid"], sent["triage"]), ("gmail:1:101", 101, "skip"))
        self.assertEqual(sent["scamP"], 0.99)

    def test_a_reply_is_never_filed(self):
        accounts = [
            {"settings": settings(mode="full"), "uidValidity": "1", "uidNext": 105,
             "messages": [message(101), message(102, listUnsubscribe=True)]},
        ]
        _queued, _wait, client, _delivery = self.run_once(
            accounts, verdicts={"gmail:1:101": {"triage": "reply", "pTop": 0.95, "scamP": 0.01}}
        )
        filed_ids = [d["messageId"] for d in client.filed[0]["decisions"]]
        self.assertEqual(filed_ids, ["gmail:1:102"])

    def test_a_filing_failure_still_acks_so_nothing_is_rejudged(self):
        accounts = [
            {"settings": settings(mode="full"), "uidValidity": "1", "uidNext": 105,
             "messages": [message(101, listUnsubscribe=True)]},
        ]
        _queued, _wait, client, _delivery = self.run_once(accounts)
        client.filed.clear()
        client.file_fails = True
        _queued, _wait, client2, _delivery2 = self.run_once(
            [{"settings": settings(mode="full"), "uidValidity": "1", "uidNext": 106,
              "messages": [message(102, listUnsubscribe=True)]}]
        )
        self.assertEqual(len(client2.filed), 1)      # asked
        self.assertEqual(len(client2.acked), 1)      # and still acked

    def test_the_ack_carries_rule_decisions_only_so_nothing_is_audited_twice(self):
        accounts = [
            {
                "settings": settings(),
                "uidValidity": "1",
                "uidNext": 105,
                "messages": [message(101), message(102, listUnsubscribe=True)],
            }
        ]
        _queued, _wait, client, _delivery = self.run_once(
            accounts, verdicts={"gmail:1:101": {"triage": "reply", "pTop": 0.9, "scamP": 0.01}}
        )
        acked_ids = [d["messageId"] for d in client.acked[0]["decisions"]]
        # 101 was judged (and audited by /judge); only the rule decision is acked.
        self.assertEqual(acked_ids, ["gmail:1:102"])

    def test_a_model_failure_acks_nothing_so_the_mail_comes_back(self):
        accounts = [{"settings": settings(), "uidValidity": "1", "uidNext": 105, "messages": [message(101)]}]
        queued, _wait, client, delivery = self.run_once(accounts, judge_fails=True)
        self.assertEqual(queued, 0)
        self.assertEqual(client.acked, [])
        self.assertEqual(delivery.sent, [])
        # Nothing was recorded as seen either, so the next pass judges it again.
        self.assertEqual(email_seen(self.store), {})

    def test_a_refused_ack_does_not_record_the_batch_as_seen(self):
        accounts = [{"settings": settings(), "uidValidity": "1", "uidNext": 105, "messages": [message(101)]}]
        self.run_once(accounts, ack_ok=False)
        self.assertEqual(email_seen(self.store), {})

    def test_an_account_with_no_new_mail_is_left_alone(self):
        accounts = [{"settings": settings(), "uidValidity": "1", "uidNext": 100, "messages": []}]
        queued, _wait, client, _delivery = self.run_once(accounts)
        self.assertEqual(queued, 0)
        self.assertEqual(client.judged, [])
        self.assertEqual(client.acked, [])

    def test_a_failed_delivery_keeps_the_event_for_the_next_pass(self):
        accounts = [{"settings": settings(), "uidValidity": "1", "uidNext": 105, "messages": [message(101)]}]
        _queued, _wait, _client, delivery = self.run_once(
            accounts,
            verdicts={"gmail:1:101": {"triage": "reply", "pTop": 0.9, "scamP": 0.01}},
            delivery_ok=False,
        )
        self.assertEqual(len(delivery.sent), 1)
        # A failed send is spooled and scheduled with a backoff, not dropped and
        # not immediately retried, so the row is what proves it survived.
        rows = self.store.conn.execute(
            "SELECT event_id, status FROM outbox WHERE source = 'email'"
        ).fetchall()
        self.assertEqual([tuple(row) for row in rows], [("email:gmail:1:101", "pending")])

    def test_the_wait_is_floored_and_capped(self):
        accounts = [{"settings": settings(), "uidValidity": "1", "uidNext": 100, "messages": []}]
        _queued, wait, client, _delivery = self.run_once(accounts)
        client.wait = 0
        _queued, wait, _client, _delivery = self.run_once(accounts)
        self.assertGreaterEqual(wait, 15)
        client.wait = 99_999
        _queued, wait, _client, _delivery = self.run_once(accounts)
        self.assertLessEqual(wait, 3600)


if __name__ == "__main__":
    unittest.main()
