"""Offline checks for the Instagram post auto-like path in remy_watchers.py.

    python3 scripts/test_remy_watchers.py

No network, no Instagram session, no writes: the MCP server object is faked and
the state store is a throwaway SQLite file. It pins the behaviour that made
auto-like silently never like a Cleo post (see docs/SOCIAL-CONNECTORS.md,
"Post auto-like never fired: the poll asked for three"):

* a small `amount` is not a cheap page — the poll must ask for a servable one;
* profile order is not chronological — pinned 2023/2024 posts must never be
  treated as new, and must never be liked;
* an empty poll must be logged, not silently treated as "no new posts";
* the baseline marks seen and likes nothing;
* one like per pass, oldest unseen first, and an already-liked post costs no
  like at all;
* comments on Cleo's posts are scanned on the newest recent posts.
"""

import importlib.util
import io
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__)) + "/.."
os.environ.setdefault("REMY_STATE_DB", os.path.join(tempfile.mkdtemp(), "state.sqlite3"))
os.environ["REMY_INSTAGRAM_MAX_LIKES_PER_PASS"] = "1"
os.environ["REMY_INSTAGRAM_LIKE_MIN_GAP_SECONDS"] = "0"

spec = importlib.util.spec_from_file_location("rw", os.path.join(ROOT, "scripts", "remy_watchers.py"))
rw = importlib.util.module_from_spec(spec)
sys.modules["rw"] = rw
spec.loader.exec_module(rw)


def iso(days_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


class FakeSession:
    def read_state(self):
        return {"last_ok_at": iso(0), "last_error_at": None}


class FakeServer:
    def __init__(self, posts):
        self.posts = posts
        self.liked = []
        self.session = FakeSession()
        self.calls = []

    def ig_user_posts(self, username, amount=None, **kwargs):
        self.calls.append(("ig_user_posts", username, amount))
        return {"username": username, "count": len(self.posts), "posts": list(self.posts)}

    def ig_like_post(self, code):
        self.liked.append(code)
        return {"liked": True, "pk": code}


def post(code, days_ago, liked=False):
    return {"code": code, "pk": str(abs(hash(code))), "taken_at": iso(days_ago), "liked": liked}


failures = []


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f"  {detail}" if detail and not condition else ""))
    if not condition:
        failures.append(name)


# 1. Profile order (pinned 2023 posts first) + a recent burst: newest first, old dropped.
pinned = [post("C21pMLQODdH", 1000), post("CwM0ruwAkqY", 800), post("CwBp0SQNDMB", 800)]
recent = [post("DfhKEPHBoj-", 1.1), post("Dfg7HoICURB", 1.2), post("DfeZ_OwBzFo", 2.1)]
server = FakeServer(pinned + recent)
got = rw._recent_account_posts(server, "livecleo")
check("pinned posts are excluded by age", [p["code"] for p in got] == ["DfhKEPHBoj-", "Dfg7HoICURB", "DfeZ_OwBzFo"], got)
check("poll asks for a servable page, never 3", server.calls[-1][2] >= 4, server.calls[-1])

# 2. An empty page is logged, not silent.
store = rw.StateStore(os.environ["REMY_STATE_DB"])
server_empty = FakeServer([])
stream = io.StringIO()
handler = logging.StreamHandler(stream)
rw.LOG.addHandler(handler)
rw._recent_account_posts(server_empty, "livecleo")
check("empty poll warns", "returned 0 posts" in stream.getvalue(), stream.getvalue())

# 2b. A page of nothing but pinned posts is short, and must say so: a new post
#     behind three pins would otherwise be invisible with no empty page.
pins_only = FakeServer([post("C21pMLQODdH", 1000), post("CwM0ruwAkqY", 800), post("CwBp0SQNDMB", 800)])
stream_short = io.StringIO()
handler_short = logging.StreamHandler(stream_short)
rw.LOG.addHandler(handler_short)
check("pins-only page yields no recent post", rw._recent_account_posts(pins_only, "livecleo") == [])
check("pins-only page warns", "page short" in stream_short.getvalue(), stream_short.getvalue())

# 3. Baseline marks seen and does not like.
baseline_server = FakeServer(pinned + recent)
gate = rw.LikeGate(store, baseline_server)
rw._poll_account_posts(store, baseline_server, "livecleo", state="baseline", writes=True, gate=gate)
check("baseline likes nothing", gate.used == 0 and baseline_server.liked == [], baseline_server.liked)
check(
    "baseline marks every recent post seen",
    all(store.meta_get(f"ig:seen:post:{c}") == "1" for c in ("DfhKEPHBoj-", "Dfg7HoICURB", "DfeZ_OwBzFo")),
)
check("baseline leaves pinned posts unseen", store.meta_get("ig:seen:post:C21pMLQODdH") is None)

# 4. Active: one like per pass, oldest unseen first, and never the pinned ones.
store2 = rw.StateStore(os.path.join(tempfile.mkdtemp(), "s2.sqlite3"))
server2 = FakeServer(pinned + recent)
gate2 = rw.LikeGate(store2, server2)
rw._poll_account_posts(store2, server2, "livecleo", state="active", writes=True, gate=gate2)
check("active pass makes exactly one like", server2.liked == ["DfeZ_OwBzFo"], server2.liked)
check("gate recorded one use", gate2.used == 1)

# 5. A post already liked by hand costs nothing.
store3 = rw.StateStore(os.path.join(tempfile.mkdtemp(), "s3.sqlite3"))
server3 = FakeServer([post("DfhKEPHBoj-", 1.1, liked=True), post("Dfg7HoICURB", 1.2)])
gate3 = rw.LikeGate(store3, server3)
rw._poll_account_posts(store3, server3, "livecleo", state="active", writes=True, gate=gate3)
check("hand-liked post is skipped, not re-liked", server3.liked == ["Dfg7HoICURB"], server3.liked)
check("hand-liked post is marked seen", store3.meta_get("ig:seen:post:DfhKEPHBoj-") == "1")

# 6. An old-but-not-pinned post beyond the window is still ignored.
store4 = rw.StateStore(os.path.join(tempfile.mkdtemp(), "s4.sqlite3"))
server4 = FakeServer([post("OLD", 40), post("NEW", 0.2)])
gate4 = rw.LikeGate(store4, server4)
rw._poll_account_posts(store4, server4, "livecleo", state="active", writes=True, gate=gate4)
check("stale backlog is not liked", server4.liked == ["NEW"], server4.liked)


# 7. Comments on Cleo's posts now scan the NEWEST recent posts, not a blind 2-post window.
class CommentsServer(FakeServer):
    def __init__(self, posts):
        super().__init__(posts)
        self.scanned = []

    def ig_post_comments(self, code, amount=30, mentions_only=False):
        self.scanned.append(code)
        return {"comments": []}


store5 = rw.StateStore(os.path.join(tempfile.mkdtemp(), "s5.sqlite3"))
cs = CommentsServer([post("C21pMLQODdH", 1000), post("NEWEST", 0.1), post("SECOND", 0.2), post("THIRD", 3)])
rw._cleo_comment_events(store5, cs, ["livecleo"], enabled=True, writes=False, my_username="cra1gst", gate=rw.LikeGate(store5, cs))
check("comments scanned for the two newest recent posts", cs.scanned == ["NEWEST", "SECOND"], cs.scanned)

print()
print("FAILURES:", failures if failures else "none")
