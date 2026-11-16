import { useEffect, useState } from 'react';
import { Tabs } from '../components/Tabs.js';
import { WatcherCard } from './configurations/WatcherCard.js';
import { InstagramSessionCard } from './configurations/InstagramSessionCard.js';
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
      {SOURCES.map((item) => <div key={item.key} role="tabpanel" id={`tabpanel-${item.key}`} aria-labelledby={`tab-${item.key}`} hidden={source !== item.key} className="space-y-4">
        <WatcherCard source={item.key} />
        {item.key === 'instagram' && <InstagramSessionCard />}
      </div>)}
    </div>
  );
}
