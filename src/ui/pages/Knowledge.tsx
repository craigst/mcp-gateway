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
  const managed = useAsyncData(() => api.getManagedKnowledge(), []);
  const brains = servers.status === 'ready' ? servers.data.filter((server) => /^brain(?:[-_].*)?$/i.test(server.name)) : [];
  const [serverId, setServerId] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'brain_search' | 'knowledge_search'>('brain_search');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
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

  const upload = async () => {
    if (!file || !category || uploading || managed.status !== 'ready' || !managed.data.configured) return;
    if (managed.data.maxUploadBytes && file.size > managed.data.maxUploadBytes) { setUploadError('The file is larger than the upload limit.'); return; }
    setUploading(true); setUploadError(null); setUploadMessage(null);
    try {
      const outcome = await api.uploadKnowledgeDocument(file, category);
      setUploadMessage(outcome.repaired ? 'The interrupted document index was repaired.' : outcome.skipped ? 'This document is already indexed in that category.' : 'The document was uploaded and indexed.');
      setFile(null);
      setFileInputVersion((value) => value + 1);
    } catch (cause) { setUploadError(formatApiError(cause)); }
    finally { setUploading(false); }
  };

  return <div className="space-y-5">
    <div><h2 className="text-base font-semibold text-slate-100">Knowledge</h2>
      <p className="mt-1 text-xs text-slate-400">Search connected brain servers and manage their tools in one place. Results depend on the selected server and its access policy.</p></div>
    <Card title="Add a document" subtitle="Upload a document to the managed knowledge service and choose who can access it by category.">
      {managed.status === 'loading' && <p className="text-xs text-slate-400">Checking the knowledge service…</p>}
      {managed.status === 'error' && <ErrorState message={managed.error} onRetry={managed.reload} />}
      {managed.status === 'ready' && !managed.data.configured && <Notice title="Managed knowledge is not configured">Search remains available through your existing brain servers. Uploads appear here when the managed service is connected.</Notice>}
      {managed.status === 'ready' && managed.data.configured && <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Document"><div className="rounded-lg border border-dashed border-slate-700 p-3" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!uploading) { setFile(event.dataTransfer.files[0] ?? null); setUploadMessage(null); setUploadError(null); } }}><p className="mb-2 text-xs text-slate-400">Drop a file here or choose one.</p><input key={fileInputVersion} aria-label="Document" type="file" disabled={uploading} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploadMessage(null); setUploadError(null); }} className="block w-full text-xs text-slate-300" />{file && <p className="mt-2 text-xs text-slate-200">Selected: {file.name}</p>}</div></Field>
          <Field label="Category"><Select value={category} disabled={uploading} onChange={(event) => setCategory(event.target.value)}><option value="">Choose a category…</option>{managed.data.categories.map((item) => <option key={item.name} value={item.name}>{item.name}{item.sensitive ? ' · restricted' : ''}</option>)}</Select></Field>
        </div>
        <p className="text-xs text-slate-400">Agents can search only categories granted to them. Indexing can take several minutes.</p>
        {uploadError && <Notice tone="error" title="Upload failed">{uploadError}</Notice>}
        {uploadMessage && <Notice tone="success">{uploadMessage}</Notice>}
        <PrimaryButton onClick={() => void upload()} disabled={!file || !category || uploading}>{uploading ? 'Uploading and indexing…' : 'Upload document'}</PrimaryButton>
      </div>}
    </Card>
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
