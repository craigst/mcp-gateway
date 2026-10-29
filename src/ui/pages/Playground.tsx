import { useMemo, useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import type { RpcDetailedResult } from '../lib/api.js';
import { formatDuration, formatPercent } from '../lib/format.js';
import {
  buildRpcRequest,
  formatLatencyBreakdown,
  PLAYGROUND_METHODS,
} from '../lib/playground.js';
import { Card } from '../components/Card.js';
import { StatTile } from '../components/StatTile.js';
import { JsonViewer } from '../components/JsonViewer.js';
import { Badge } from '../components/Badge.js';
import { InlineNotice } from '../components/States.js';
import {
  Field,
  GhostButton,
  PrimaryButton,
  Select,
  TextArea,
  TextInput,
} from '../components/Form.js';

const DEFAULT_PRESET = PLAYGROUND_METHODS[1];

/** Interactive JSON-RPC sandbox with gateway vs sub-server latency breakdown. */
export function PlaygroundPage() {
  const [method, setMethod] = useState(DEFAULT_PRESET?.method ?? 'tools/list');
  const [params, setParams] = useState(DEFAULT_PRESET?.params ?? '{}');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<RpcDetailedResult<unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => buildRpcRequest(method, params, 'preview'), [method, params]);
  const breakdown = outcome
    ? formatLatencyBreakdown(outcome.roundTripMs, {
        gateway_overhead_ms: outcome.gatewayOverheadMs,
        sub_server_ms: outcome.subServerMs,
      })
    : null;
  const applyPreset = (presetMethod: string): void => {
    const preset = PLAYGROUND_METHODS.find((candidate) => candidate.method === presetMethod);
    if (!preset) return;
    setMethod(preset.method);
    setParams(preset.params);
  };

  const run = async (): Promise<void> => {
    const built = buildRpcRequest(method, params);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    setError(null);
    setRunning(true);
    setOutcome(null);
    try {
      const detailed = await api.rpcDetailed<unknown>(built.request.method, built.request.params);
      setOutcome(detailed);
    } catch (runError) {
      setError(formatApiError(runError));
    } finally {
      setRunning(false);
    }
  };

  const copyResponse = (): void => {
    if (!outcome) return;
    void navigator.clipboard?.writeText(JSON.stringify(outcome.result, null, 2));
  };

  return (
    <div className="space-y-4">
      <InlineNotice>
        Requests are sent through <code>POST /mcp/v1</code> using your signed-in session — the playground simulates
        that operator&apos;s scope. API keys are only for AI / external clients.
      </InlineNotice>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Request"
          subtitle="Single JSON-RPC request, id generated per run"
          actions={<Badge tone="success">session authenticated</Badge>}
        >
          <div className="space-y-3">
            <Field label="Preset">
              <Select
                value={PLAYGROUND_METHODS.some((preset) => preset.method === method) ? method : ''}
                onChange={(event) => applyPreset(event.target.value)}
              >
                <option value="">custom method</option>
                {PLAYGROUND_METHODS.map((preset) => (
                  <option key={preset.method} value={preset.method}>
                    {preset.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Method">
              <TextInput
                value={method}
                onChange={(event) => setMethod(event.target.value)}
                placeholder="tools/call"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
            <Field
              label="Params (JSON)"
              hint="blank = no params; arrays and objects are accepted"
              error={preview.ok ? undefined : preview.error}
            >
              <TextArea
                rows={9}
                value={params}
                onChange={(event) => setParams(event.target.value)}
                spellCheck={false}
                placeholder="{}"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={() => void run()} disabled={running}>
                {running ? 'Running…' : 'Run'}
              </PrimaryButton>
              <GhostButton
                onClick={() => {
                  setOutcome(null);
                  setError(null);
                }}
              >
                Clear
              </GhostButton>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Request preview
              </p>
              {preview.ok ? (
                <JsonViewer value={preview.request} maxHeight="10rem" />
              ) : (
                <p className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-300">
                  {preview.error}
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card
          title="Response"
          subtitle="Raw JSON-RPC result"
          actions={
            outcome !== null ? (
              <GhostButton onClick={copyResponse}>Copy JSON</GhostButton>
            ) : undefined
          }
        >
          <div className="space-y-3">
            {error !== null && (
              <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 px-3 py-2">
                <p className="text-xs font-semibold text-rose-200">Request failed</p>
                <p className="mt-0.5 max-w-full break-words font-mono text-[11px] text-rose-300/90">{error}</p>
              </div>
            )}
            {outcome === null && error === null && (
              <p className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-6 text-center text-xs text-slate-500">
                Run a request to inspect the gateway response and latency breakdown.
              </p>
            )}
            {outcome !== null && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  <Badge tone="success">200 OK</Badge>
                  <span className="font-mono">{outcome.method}</span>
                  <span>id {outcome.id}</span>
                </div>
                <JsonViewer value={outcome.result} maxHeight="24rem" />
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Round trip"
          value={breakdown ? formatDuration(breakdown.roundTripMs) : '—'}
          hint="client → gateway → sub-server"
          tone="info"
        />
        <StatTile
          label="Gateway overhead"
          value={breakdown ? formatDuration(breakdown.gatewayOverheadMs) : '—'}
          hint="/mcp/v1 admin + policy layer"
        />
        <StatTile
          label="Sub-server time"
          value={breakdown ? formatDuration(breakdown.subServerMs) : '—'}
          hint="_meta.sub_server_ms from tools/call"
        />
        <StatTile
          label="Gateway share"
          value={breakdown ? formatPercent(breakdown.gatewayShare) : '—'}
          hint="of total round trip"
        />
      </div>

      <Card title="Latency breakdown" subtitle="Reported by the gateway for tools/call results">
        {breakdown === null ? (
          <p className="text-xs text-slate-500">
            Run a <span className="font-mono text-slate-300">tools/call</span> to populate gateway vs sub-server
            timings.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="font-mono text-xs text-slate-300">{breakdown.summary}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Gateway overhead</p>
                <p className="mt-1 text-lg font-semibold text-sky-300">
                  {formatDuration(breakdown.gatewayOverheadMs)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
                <p className="text-[11px] uppercase tracking-wide text-slate-500">Sub-server</p>
                <p className="mt-1 text-lg font-semibold text-emerald-300">
                  {formatDuration(breakdown.subServerMs)}
                </p>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
