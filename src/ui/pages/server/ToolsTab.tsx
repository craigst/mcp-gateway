import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import type { RpcDetailedResult } from '../../lib/api.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { JsonViewer } from '../../components/JsonViewer.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Notice } from '../../components/States.js';
import { Field, GhostButton, PrimaryButton, TextArea } from '../../components/Form.js';
import { formatDuration, formatNumber, formatTimestamp } from '../../lib/format.js';
import { RpcResultPanel } from './RpcResultPanel.js';
import { usageForTool } from './shared.js';
import type { ServerUsageStats, ToolDescriptor } from '../../../core/types.js';

export interface ToolsTabProps {
  serverId: string;
  tools: ToolDescriptor[];
  approvalRequiredTools: string[];
  stats: ServerUsageStats;
  /** Refresh inspector data (usage counters) after a successful call. */
  onUsed: () => void;
}

function isApprovalRequired(tool: ToolDescriptor, approvalRequiredTools: string[]): boolean {
  return approvalRequiredTools.includes(tool.name) || approvalRequiredTools.includes(tool.id);
}

/** Tools tab: usage stats, schema inspection and a per-tool JSON-RPC playground. */
export function ToolsTab({ serverId, tools, approvalRequiredTools, stats, onUsed }: ToolsTabProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [tryTool, setTryTool] = useState<ToolDescriptor | null>(null);
  const [argsText, setArgsText] = useState('{}');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RpcDetailedResult<unknown> | null>(null);

  const openTry = (tool: ToolDescriptor): void => {
    setTryTool(tool);
    setArgsText('{}');
    setError(null);
    setOutcome(null);
  };

  const run = async (): Promise<void> => {
    if (tryTool === null) return;
    setError(null);
    let args: unknown;
    try {
      args = argsText.trim() === '' ? {} : (JSON.parse(argsText) as unknown);
    } catch (parseError) {
      setError(`Invalid JSON arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      setError('Arguments must be a JSON object.');
      return;
    }
    setRunning(true);
    setOutcome(null);
    try {
      const result = await api.rpcDetailed<unknown>('tools/call', {
        name: tryTool.name,
        serverId,
        arguments: args,
      });
      setOutcome(result);
      onUsed();
    } catch (callError) {
      setError(formatApiError(callError));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {tryTool !== null && (
        <Card
          title={`Try “${tryTool.name}”`}
          subtitle="Direct tools/call through the gateway; the call is audited and scoped to this server."
          actions={<GhostButton onClick={() => setTryTool(null)}>Close</GhostButton>}
        >
          <div className="space-y-3">
            <Field label="Arguments (JSON object)" error={error ?? undefined}>
              <TextArea
                rows={7}
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                spellCheck={false}
                placeholder="{}"
                aria-label="Tool arguments JSON"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={() => void run()} disabled={running}>
                {running ? 'Running…' : 'Run tool'}
              </PrimaryButton>
              <GhostButton onClick={() => setArgsText('{}')}>Reset arguments</GhostButton>
            </div>
            {(outcome !== null || error !== null) && (
              <RpcResultPanel
                title={tryTool.name}
                method="tools/call"
                result={outcome?.result ?? null}
                latencyMs={outcome?.roundTripMs ?? null}
                error={error}
              />
            )}
          </div>
        </Card>
      )}

      <Card
        title="Tools"
        subtitle={`${tools.length} tool${tools.length === 1 ? '' : 's'} advertised · high-privilege and approval-gated flags shown`}
        padded={false}
      >
        {tools.length === 0 ? (
          <EmptyState
            icon="⚒"
            title="No tools advertised"
            description="This sub-server has not listed any tools yet. Start it and refresh, or check its capabilities in Overview."
          />
        ) : (
          <Table<ToolDescriptor>
            rows={tools}
            getRowKey={(tool) => tool.id}
            expandedKey={expandedKey}
            onRowClick={(tool) => setExpandedKey((current) => (current === tool.id ? null : tool.id))}
            columns={[
              {
                key: 'tool',
                header: 'Tool',
                render: (tool) => (
                  <div className="min-w-0 max-w-md">
                    <p className="font-mono text-xs font-medium text-slate-200">{tool.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{tool.description || 'No description'}</p>
                  </div>
                ),
              },
              {
                key: 'flags',
                header: 'Flags',
                render: (tool) => (
                  <div className="flex flex-wrap gap-1">
                    {tool.highPrivilege && <Badge tone="warning">High-privilege</Badge>}
                    {isApprovalRequired(tool, approvalRequiredTools) && (
                      <Badge tone="danger">Approval required</Badge>
                    )}
                    {!tool.highPrivilege && !isApprovalRequired(tool, approvalRequiredTools) && (
                      <Badge tone="neutral">standard</Badge>
                    )}
                  </div>
                ),
              },
              {
                key: 'usage',
                header: 'Usage',
                render: (tool) => {
                  const usage = usageForTool(stats, tool.id, tool.name);
                  if (usage === null) return <span className="text-xs text-slate-500">never</span>;
                  return (
                    <div className="text-[11px] text-slate-400">
                      <p className="tabular-nums">{formatNumber(usage.count)} calls</p>
                      <p className="text-slate-500">
                        avg {formatDuration(usage.avgLatencyMs)}
                        {usage.lastUsedAt !== null ? ` · ${formatTimestamp(usage.lastUsedAt)}` : ''}
                      </p>
                    </div>
                  );
                },
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (tool) => (
                  <div className="flex flex-wrap items-center gap-1">
                    <PrimaryButton
                      onClick={(event) => {
                        event.stopPropagation();
                        openTry(tool);
                      }}
                      className="px-2 py-1 text-[11px]"
                    >
                      Try
                    </PrimaryButton>
                    <GhostButton
                      onClick={(event) => {
                        event.stopPropagation();
                        setExpandedKey((current) => (current === tool.id ? null : tool.id));
                      }}
                    >
                      Schema
                    </GhostButton>
                  </div>
                ),
              },
            ]}
            renderExpanded={(tool) => (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  inputSchema
                </p>
                <JsonViewer value={tool.inputSchema} maxHeight="16rem" />
              </div>
            )}
          />
        )}
      </Card>

      {tools.length > 0 && !tryTool && (
        <Notice tone="info">
          Pick <span className="font-semibold">Try</span> on a tool to send a real <code className="font-mono">tools/call</code>{' '}
          through the gateway. Requests run with this console&apos;s session and are recorded in Activity.
        </Notice>
      )}
    </div>
  );
}
