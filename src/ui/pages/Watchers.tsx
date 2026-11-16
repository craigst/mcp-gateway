import { useEffect, useState } from 'react';
import { Tabs } from '../components/Tabs.js';
import { WatcherCard } from './configurations/WatcherCard.js';
import { InstagramSessionCard } from './configurations/InstagramSessionCard.js';
import { api } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { Notice } from '../components/States.js';
import type { WatcherSource } from '../../core/types.js';

const SOURCES: readonly { key: WatcherSource; label: string }[] = [
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'x', label: 'X' },
];

function sourceFromHash(): WatcherSource {
  const query = typeof window === 'undefined' ? '' : window.location.hash.split('?')[1] ?? '';
  const value = new URLSearchParams(query).get('source');
  return SOURCES.find((source) => source.key === value)?.key ?? 'whatsapp';
}

export function WatchersPage() {
  const [source, setSource] = useState<WatcherSource>(sourceFromHash);
  const workers = useAsyncData(async () => {
    const manager = (await api.listServers()).find((server) => server.name === 'social-watchers');
    if (!manager) throw new Error('Watcher manager not found');
    const result = await api.rpc<unknown>('tools/call', { serverId: manager.id, name: 'watchers_status', arguments: {} });
    if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content) || ('isError' in result && result.isError === true)) throw new Error('Worker status unavailable');
    const item = result.content.find((entry: unknown) => typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'text' && 'text' in entry && typeof entry.text === 'string');
    if (!item) throw new Error('Worker status unavailable');
    const status: unknown = JSON.parse(item.text);
    if (!status || typeof status !== 'object' || !('sources' in status) || !Array.isArray(status.sources)) throw new Error('Worker status unavailable');
    return status.sources.filter((entry: unknown): entry is { source: string; pid: number | null } => typeof entry === 'object' && entry !== null && 'source' in entry && typeof entry.source === 'string' && 'pid' in entry && (typeof entry.pid === 'number' || entry.pid === null));
  }, []);
  useEffect(() => {
    const sync = () => setSource(sourceFromHash());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const select = (next: WatcherSource) => {
    setSource(next);
    window.location.hash = `#/watchers?source=${next}`;
  };
  return (
    <div className="space-y-5">
      <div><h2 className="text-base font-semibold text-slate-100">Social watchers</h2>
        <p className="mt-1 text-xs text-slate-400">Choose a channel to manage what its existing watcher sends to Remy. Reply drafts still require confirmation.</p>
      </div>
      <Tabs items={SOURCES} active={source} onChange={select} label="Watcher channels" />
      <Notice tone={workers.status === 'ready' && !workers.data.some((worker) => worker.source === source && worker.pid !== null) ? 'warning' : 'info'} title="Watcher process">
        {workers.status === 'loading' ? 'Checking the watcher manager…' : workers.status === 'error' ? 'Worker status is unavailable. Saved settings do not confirm a worker is running.' : workers.data.some((worker) => worker.source === source && worker.pid !== null) ? 'The manager reports a running process. This does not confirm account access or delivery.' : workers.data.some((worker) => worker.source === source) ? 'The manager reports this worker is stopped.' : 'The manager does not report a worker for this channel.'}{' '}
        <button type="button" onClick={workers.reload} className="font-semibold underline">Refresh process status</button>
      </Notice>
      {SOURCES.map((item) => <div key={item.key} role="tabpanel" id={`tabpanel-${item.key}`} aria-labelledby={`tab-${item.key}`} hidden={source !== item.key} className="space-y-4">
        <WatcherCard source={item.key} />
        {item.key === 'instagram' && <InstagramSessionCard />}
      </div>)}
    </div>
  );
}
