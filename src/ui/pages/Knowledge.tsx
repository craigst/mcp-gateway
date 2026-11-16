import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { Badge, badgeToneForStatus } from '../components/Badge.js';
import { Card } from '../components/Card.js';
import { Field, PrimaryButton, Select, TextInput } from '../components/Form.js';
import { ErrorState, Notice } from '../components/States.js';
import { JsonViewer } from '../components/JsonViewer.js';

/** A single place to find and search the existing brain servers. */
export function KnowledgePage({ onOpenServer }: { onOpenServer?: (id: string) => void }) {
  const servers = useAsyncData(() => api.listServers(), []);
  const brains = servers.status === 'ready' ? servers.data.filter((server) => /^brain(?:[-_].*)?$/i.test(server.name)) : [];
  const [serverId, setServerId] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'brain_search' | 'knowledge_search'>('brain_search');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const textContent = typeof result === 'object' && result !== null && 'content' in result && Array.isArray(result.content)
    ? result.content.filter((item: unknown): item is { type: string; text: string } => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text' && 'text' in item && typeof item.text === 'string').map((item) => item.text).join('\n\n')
    : '';
  const toolFailed = typeof result === 'object' && result !== null && 'isError' in result && result.isError === true;
  const selected = brains.find((server) => server.id === serverId) ?? brains.find((server) => server.name === 'brain') ?? brains[0];

  const search = async () => {
    if (!selected || !query.trim() || busy) return;
    setError(null); setResult(null); setBusy(true);
    try {
      const response = await api.rpc<unknown>('tools/call', { serverId: selected.id, name: kind, arguments: { query: query.trim() } });
      setResult(response);
    } catch (cause) { setError(formatApiError(cause)); }
    finally { setBusy(false); }
  };

  return <div className="space-y-5">
    <div><h2 className="text-base font-semibold text-slate-100">Knowledge</h2>
      <p className="mt-1 text-xs text-slate-400">Search connected brain servers and manage their tools in one place. Results depend on the selected server and its access policy.</p></div>
    {servers.status === 'error' && <ErrorState message={servers.error} onRetry={servers.reload} />}
    {servers.status === 'loading' && <p className="text-xs text-slate-400">Loading knowledge servers…</p>}
    {servers.status === 'ready' && brains.length === 0 && <Notice tone="info" title="No brain server found">Add a brain server to search its memories and documents here.</Notice>}
    {brains.length > 0 && <>
      <Card title="Search knowledge" subtitle="Search the selected server's existing memory or document tools.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Knowledge server"><Select disabled={busy} value={selected?.id ?? ''} onChange={(e) => { setServerId(e.target.value); setResult(null); setError(null); }}>
            {brains.map((server) => <option key={server.id} value={server.id}>{server.name} · {server.status}</option>)}
          </Select></Field>
          <Field label="Search in"><Select disabled={busy} value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setResult(null); setError(null); }}><option value="brain_search">Memories</option><option value="knowledge_search">Documents</option></Select></Field>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2"><Field label="Search query" className="min-w-[14rem] flex-1"><TextInput disabled={busy} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} /></Field><PrimaryButton onClick={() => void search()} disabled={busy || !query.trim()}>{busy ? 'Searching…' : 'Search'}</PrimaryButton></div>
        {error && <div className="mt-3"><Notice tone="error" title="Search failed">{error}</Notice></div>}
        {result !== null && <div className="mt-3"><p className={toolFailed ? 'mb-2 text-xs font-semibold text-rose-300' : 'mb-2 text-xs font-semibold text-slate-200'}>{toolFailed ? 'Search returned an error' : 'Search results'}</p><JsonViewer value={textContent || result} maxHeight="24rem" /></div>}
      </Card>
      <Card title="Knowledge servers" subtitle="Open a server to inspect its configuration, tools and access.">
        <div className="space-y-2">{brains.map((server) => <div key={server.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 p-3"><div className="flex items-center gap-2"><span className="font-medium text-slate-200">{server.name}</span><Badge tone={badgeToneForStatus(server.status)}>{server.status}</Badge></div><button type="button" className="text-xs font-semibold text-sky-300" onClick={() => onOpenServer?.(server.id)}>Manage server →</button></div>)}</div>
      </Card>
    </>}
  </div>;
}
