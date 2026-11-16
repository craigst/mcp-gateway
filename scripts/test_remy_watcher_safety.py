import importlib.util
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchers_candidate', Path(__file__).with_name('remy_watchers.py'))
watchers = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = watchers
spec.loader.exec_module(watchers)


class Delivery:
    def __init__(self): self.sent = []
    def send(self, event_id, payload): self.sent.append(event_id); return True


class SafetyTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = watchers.StateStore(Path(self.directory.name) / 'state.sqlite3')
        self.delivery = Delivery()

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def test_social_worker_will_not_start_without_its_required_proxy(self):
        with patch.dict(os.environ, {'SOCIAL_PROXY_REQUIRED': '1'}, clear=True),              patch.object(watchers, 'StateStore') as store:
            self.assertEqual(watchers.main(['x', '--once']), 1)
            self.assertEqual(watchers.main(['youtube', '--once']), 1)
            store.assert_not_called()

    def test_startup_waits_without_fetching_messages_if_policy_unavailable(self):
        with patch.dict(os.environ, {'REMY_STATE_DB': str(Path(self.directory.name) / 'startup.sqlite3')}, clear=True), \
             patch.object(watchers.WatcherSettingsClient, 'fetch', return_value=None), \
             patch.object(watchers, 'run_whatsapp_once') as poll:
            self.assertEqual(watchers.main(['whatsapp', '--once']), 0)
            poll.assert_not_called()

    def test_pending_whatsapp_events_obey_current_contact_filter(self):
        event = {'source': 'whatsapp', 'event_id': '1', 'timestamp': '2026-01-01', 'sender_raw': 'lid123', 'sender_number': '+123', 'conversation': {'id': 'group123'}}
        self.store.enqueue('1', 'whatsapp', event)
        watchers.process_events(self.store, 'whatsapp', [], self.delivery, settings={'enabled': False, 'mode': 'all'})
        watchers.process_events(self.store, 'whatsapp', [], self.delivery, settings={'enabled': True, 'mode': 'selected', 'selected': ['group:other']})
        self.assertEqual(self.delivery.sent, [])
        watchers.process_events(self.store, 'whatsapp', [], self.delivery, settings={'enabled': True, 'mode': 'selected', 'selected': ['group:group123']})
        self.assertEqual(self.delivery.sent, ['1'])

    def test_blocked_pending_events_do_not_starve_an_allowed_event(self):
        for index in range(55):
            event = {'source': 'whatsapp', 'event_id': str(index), 'timestamp': '2026-01-01', 'sender_number': '+999', 'conversation': {}}
            self.store.enqueue(str(index), 'whatsapp', event)
        allowed = {'source': 'whatsapp', 'event_id': 'allowed', 'timestamp': '2026-01-01', 'sender_number': '+123', 'conversation': {}}
        self.store.enqueue('allowed', 'whatsapp', allowed)
        watchers.process_events(self.store, 'whatsapp', [], self.delivery, settings={'enabled': True, 'mode': 'selected', 'selected': ['+123']})
        self.assertEqual(self.delivery.sent, ['allowed'])
        self.assertEqual(len(self.store.pending('whatsapp', limit=100)), 55)

    def test_youtube_comments_match_watched_channel_not_only_the_author(self):
        event = watchers._youtube_event({'comment_id': 'c1', 'author': 'someone', 'published_at': '2026-01-02'}, {'channel': 'Example', 'channel_id': 'channel1', 'channel_ref': 'wanted'}, 'v1', 'comment')
        self.assertTrue(watchers.event_allowed(event, {'enabled': True, 'mode': 'selected', 'selected': ['yt:wanted']}))
        self.assertFalse(watchers.event_allowed(event, {'enabled': True, 'mode': 'selected', 'selected': ['yt:other']}))

    def test_channel_catalogs_derive_from_configured_values_and_filter_invalid_keys(self):
        self.assertEqual(watchers.build_channel_catalog('youtube', ['@ChannelOne', 'bad/path', 'ChannelOne']), [
            {'key': 'yt:ChannelOne', 'name': '@ChannelOne', 'phone': None, 'kind': 'person'}])
        self.assertEqual(watchers.build_channel_catalog('x', ['@person'])[0]['key'], 'x:person')

    def test_x_selected_accounts_filter_posts_and_replies(self):
        event = watchers._x_event({'id': 'x1', 'author': 'commenter', 'created_at': '2026-01-02'}, 'reply', watched_account='target')
        self.assertTrue(watchers.event_allowed(event, {'enabled': True, 'mode': 'selected', 'selected': ['x:target']}))
        self.assertFalse(watchers.event_allowed(event, {'enabled': True, 'mode': 'selected', 'selected': ['x:someoneelse']}))

    def test_x_deduplicates_a_post_that_is_also_a_mention(self):
        row = {'id': 'p1', 'author': 'person', 'created_at': '2026-01-02', 'text': '@me hello'}
        client = SimpleNamespace(user_posts=lambda *a, **kw: {'rows': [row.copy()]},
                                 replies_of=lambda *a, **kw: {'rows': []},
                                 mentions=lambda *a, **kw: {'rows': [row.copy()]})
        config = SimpleNamespace(CHANNELS=['person'], MENTION_HANDLES=['me'])
        formats = SimpleNamespace(rows=lambda payload: payload['rows'], mentions_handle=lambda *a: True)
        with patch.object(watchers, '_x_modules', return_value=(client, config, formats, None)):
            events = watchers.read_x_activity()['events']
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['kind'], 'mention')

    def test_x_first_scan_keeps_alerts_but_does_not_like_backlog(self):
        event = watchers._x_event({'id': 'p1', 'author': 'person', 'created_at': '2026-01-02'}, 'mention')
        self.store.set_cursor('x', '2026-01-01\told')
        with patch.object(watchers, 'read_x_activity', return_value={'events': [event], 'posts': []}), patch.object(watchers, 'autolike_x', return_value={}) as likes:
            watchers.run_x_once(self.store, self.delivery, {'enabled': True, 'mode': 'all'}, suppress_initial_likes=True)
            self.assertTrue(likes.call_args.args[1])
            self.assertEqual(self.delivery.sent, ['x:mention:p1'])

    def test_x_waits_for_a_successful_scan_before_automatic_likes(self):
        state = {'complete': False}
        self.store.set_cursor('x', '2026-01-01\told')
        with patch.object(watchers, 'read_x_activity', side_effect=[{'events': [], 'posts': [], 'read_ok': False}, {'events': [], 'posts': [], 'read_ok': True}, {'events': [], 'posts': [], 'read_ok': True}]), patch.object(watchers, 'autolike_x', return_value={}) as likes:
            for _ in range(3):
                watchers.run_x_once(self.store, self.delivery, {'enabled': True, 'mode': 'all'}, startup_state=state)
            self.assertEqual([call.args[1] for call in likes.call_args_list], [True, True, False])

    def test_youtube_new_video_respects_disabled_and_selected_modes(self):
        video = {'video_id': 'v1', 'published_at': '2026-01-02', 'channel': 'wanted', 'channel_id': 'channel1', 'kind': 'video', 'title': 'Example'}
        self.store.set_cursor('youtube', '2026-01-01\told')
        self.store.set_cursor('youtube:videos', '2026-01-01\told')
        with patch.object(watchers, 'read_youtube_activity', return_value={'events': [], 'videos': [video]}), patch.object(watchers, 'autolike_youtube', return_value={}):
            watchers.run_youtube_once(self.store, self.delivery, {'enabled': False, 'mode': 'all'})
            watchers.run_youtube_once(self.store, self.delivery, {'enabled': True, 'mode': 'selected', 'selected': ['yt:other']})
            self.assertEqual(self.delivery.sent, [])
            watchers.run_youtube_once(self.store, self.delivery, {'enabled': True, 'mode': 'selected', 'selected': ['yt:channel1']})
            self.assertEqual(self.delivery.sent, ['youtube:video:v1'])


if __name__ == '__main__': unittest.main()
