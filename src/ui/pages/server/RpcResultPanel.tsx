import { Badge } from '../../components/Badge.js';
import { JsonViewer } from '../../components/JsonViewer.js';
import { Notice } from '../../components/States.js';
import { formatDuration } from '../../lib/format.js';
import { rpcResultIsError } from './shared.js';

export interface RpcResultPanelProps {
  title: string;
  method: string;
  result: unknown;
  latencyMs: number | null;
  error: string | null;
  emptyHint?: string;
}

/** Shared result viewer for inspector JSON-RPC actions (tools/prompts/resources). */
export function RpcResultPanel({ title, method, result, latencyMs, error, emptyHint }: RpcResultPanelProps) {
  if (error !== null) {
    return (
      <Notice tone="error" title={`${title} failed`}>
        {error}
      </Notice>
    );
  }
  if (result === null || result === undefined) {
    return (
      <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
        {emptyHint ?? 'No result yet — run the request to inspect the response.'}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge tone={rpcResultIsError(result) ? 'danger' : 'success'}>
          {rpcResultIsError(result) ? 'tool error' : 'ok'}
        </Badge>
        <span className="font-mono">{method}</span>
        {latencyMs !== null && <span className="tabular-nums">{formatDuration(latencyMs)} round trip</span>}
        <span className="ml-auto">{title}</span>
      </div>
      <JsonViewer value={result} maxHeight="18rem" />
    </div>
  );
}
