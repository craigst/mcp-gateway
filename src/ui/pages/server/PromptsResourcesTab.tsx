import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { Notice } from '../../components/States.js';
import { Field, GhostButton, PrimaryButton, TextArea } from '../../components/Form.js';
import { RpcResultPanel } from './RpcResultPanel.js';
import type {
  PromptDescriptor,
  ResourceDescriptor,
  ResourceTemplateDescriptor,
} from '../../../core/types.js';

interface Outcome {
  title: string;
  method: string;
  result: unknown;
  latencyMs: number;
}

export interface PromptsResourcesTabProps {
  serverId: string;
  prompts: PromptDescriptor[];
  resources: ResourceDescriptor[];
}

/** Prompts & resources tab: browse, get prompts and read resources through the gateway. */
export function PromptsResourcesTab({ serverId, prompts, resources }: PromptsResourcesTabProps) {
  const templates = useAsyncData(
    () => api.rpc<{ resourceTemplates?: ResourceTemplateDescriptor[] }>('resources/templates/list', { serverId }),
    [serverId],
  );
  const [promptTarget, setPromptTarget] = useState<PromptDescriptor | null>(null);
  const [argsText, setArgsText] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const templateList = templates.status === 'ready' ? templates.data.resourceTemplates ?? [] : [];

  const runPrompt = async (): Promise<void> => {
    if (promptTarget === null) return;
    setError(null);
    let args: unknown;
    try {
      args = argsText.trim() === '' ? {} : (JSON.parse(argsText) as unknown);
    } catch (parseError) {
      setError(`Invalid JSON arguments: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return;
    }
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      setError('Prompt arguments must be a JSON object.');
      return;
    }
    setBusy(true);
    setOutcome(null);
    try {
      const result = await api.rpcDetailed<unknown>('prompts/get', {
        name: promptTarget.name,
        serverId,
        arguments: args,
      });
      setOutcome({
        title: `prompt ${promptTarget.name}`,
        method: 'prompts/get',
        result: result.result,
        latencyMs: result.roundTripMs,
      });
    } catch (callError) {
      setError(formatApiError(callError));
    } finally {
      setBusy(false);
    }
  };

  const readResource = async (resource: ResourceDescriptor): Promise<void> => {
    setError(null);
    setOutcome(null);
    setBusy(true);
    try {
      const result = await api.rpcDetailed<unknown>('resources/read', { uri: resource.uri, serverId });
      setOutcome({
        title: resource.name,
        method: 'resources/read',
        result: result.result,
        latencyMs: result.roundTripMs,
      });
    } catch (callError) {
      setError(formatApiError(callError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error !== null && (
        <Notice tone="error" title="JSON-RPC action failed" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      {outcome !== null && (
        <Card title="Result" subtitle={outcome.title}>
          <RpcResultPanel
            title={outcome.title}
            method={outcome.method}
            result={outcome.result}
            latencyMs={outcome.latencyMs}
            error={null}
          />
        </Card>
      )}

      {promptTarget !== null && (
        <Card
          title={`Get prompt “${promptTarget.name}”`}
          subtitle="Arguments are forwarded to prompts/get; the result is model-ready message content."
          actions={<GhostButton onClick={() => setPromptTarget(null)}>Close</GhostButton>}
        >
          <div className="space-y-3">
            <Field label="Arguments (JSON object)">
              <TextArea
                rows={5}
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                spellCheck={false}
                aria-label="Prompt arguments JSON"
              />
            </Field>
            <PrimaryButton onClick={() => void runPrompt()} disabled={busy}>
              {busy ? 'Fetching…' : 'Fetch prompt'}
            </PrimaryButton>
          </div>
        </Card>
      )}

      <Card title="Prompts" subtitle="Reusable prompt templates advertised by this server" padded={false}>
        {prompts.length === 0 ? (
          <EmptyState
            icon="⌘"
            title="No prompts advertised"
            description="This server does not expose MCP prompts. Tools and resources may still be available."
          />
        ) : (
          <Table<PromptDescriptor>
            rows={prompts}
            getRowKey={(prompt) => prompt.name}
            columns={[
              {
                key: 'name',
                header: 'Prompt',
                render: (prompt) => (
                  <div className="min-w-0 max-w-md">
                    <p className="font-mono text-xs font-medium text-slate-200">{prompt.name}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{prompt.description || 'No description'}</p>
                  </div>
                ),
              },
              {
                key: 'arguments',
                header: 'Arguments',
                render: (prompt) =>
                  prompt.arguments.length === 0 ? (
                    <span className="text-xs text-slate-500">none</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {prompt.arguments.map((argument) => (
                        <Badge
                          key={argument.name}
                          tone={argument.required === true ? 'warning' : 'neutral'}
                        >
                          {argument.name}
                          {argument.required === true ? ' *' : ''}
                        </Badge>
                      ))}
                    </div>
                  ),
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (prompt) => (
                  <PrimaryButton
                    onClick={() => {
                      setPromptTarget(prompt);
                      const initial: Record<string, string> = {};
                      for (const argument of prompt.arguments) initial[argument.name] = '';
                      setArgsText(JSON.stringify(initial, null, 2));
                      setError(null);
                      setOutcome(null);
                    }}
                    className="px-2 py-1 text-[11px]"
                  >
                    Get prompt
                  </PrimaryButton>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card title="Resources" subtitle="Readable resources (files, records, live data)" padded={false}>
        {resources.length === 0 ? (
          <EmptyState
            icon="▤"
            title="No resources advertised"
            description="This server does not expose MCP resources."
          />
        ) : (
          <Table<ResourceDescriptor>
            rows={resources}
            getRowKey={(resource) => resource.uri}
            columns={[
              {
                key: 'resource',
                header: 'Resource',
                render: (resource) => (
                  <div className="min-w-0 max-w-md">
                    <p className="font-mono text-xs font-medium text-slate-200">{resource.name}</p>
                    <p className="mt-0.5 break-all font-mono text-[10px] text-slate-500">{resource.uri}</p>
                    {resource.description !== '' && (
                      <p className="mt-0.5 text-[11px] text-slate-500">{resource.description}</p>
                    )}
                  </div>
                ),
              },
              {
                key: 'mime',
                header: 'MIME type',
                render: (resource) =>
                  resource.mimeType === null ? (
                    <span className="text-xs text-slate-500">—</span>
                  ) : (
                    <Badge tone="neutral">{resource.mimeType}</Badge>
                  ),
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (resource) => (
                  <PrimaryButton
                    onClick={() => void readResource(resource)}
                    disabled={busy}
                    className="px-2 py-1 text-[11px]"
                  >
                    Read
                  </PrimaryButton>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title="Resource templates"
        subtitle="resources/templates/list — parameterised URIs that can be read once filled in"
        actions={<GhostButton onClick={templates.reload}>Refresh</GhostButton>}
        padded={false}
      >
        {templates.status === 'loading' && <p className="px-4 py-5 text-xs text-slate-500">Loading templates…</p>}
        {templates.status === 'error' && (
          <p className="px-4 py-5 text-[11px] text-slate-500">
            This server does not advertise resource templates ({templates.error}).
          </p>
        )}
        {templates.status === 'ready' &&
          (templateList.length === 0 ? (
            <EmptyState
              icon="∅"
              title="No resource templates"
              description="The server returned an empty templates list."
            />
          ) : (
            <Table<ResourceTemplateDescriptor>
              rows={templateList}
              getRowKey={(template) => template.uriTemplate}
              columns={[
                {
                  key: 'template',
                  header: 'Template',
                  render: (template) => (
                    <div>
                      <p className="font-mono text-xs text-slate-200">{template.uriTemplate}</p>
                      <p className="text-[11px] text-slate-500">{template.name}</p>
                    </div>
                  ),
                },
                {
                  key: 'mime',
                  header: 'MIME type',
                  render: (template) =>
                    template.mimeType === null ? (
                      <span className="text-xs text-slate-500">—</span>
                    ) : (
                      <Badge tone="neutral">{template.mimeType}</Badge>
                    ),
                },
              ]}
            />
          ))}
        <p className="px-4 pb-3 pt-1 text-[11px] text-slate-500">
          Templates are metadata only. Fill a concrete URI and use <code className="font-mono">resources/read</code> through the
          Resources table (or an agent call) to fetch content.
        </p>
      </Card>
    </div>
  );
}
