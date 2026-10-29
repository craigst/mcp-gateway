import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { Table } from '../../components/Table.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonCards, SkeletonTable } from '../../components/Skeleton.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Field, GhostButton, PrimaryButton, SecondaryButton, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { envRowsFromKeys, parseEnvRows, splitList } from './shared.js';
import type { EnvRow } from './shared.js';
import type { HarnessEntry, HarnessScanResult, ServerRecord } from '../../../core/types.js';

interface ImportOverrides {
  env: Record<string, string>;
  envFile: string | null;
  highPrivilegeTools: string[];
  approvalRequiredTools: string[];
}

interface HarnessImportDialogProps {
  entry: HarnessEntry;
  busy: boolean;
  onSubmit: (overrides: ImportOverrides) => void;
  onClose: () => void;
}

function HarnessImportDialog({ entry, busy, onSubmit, onClose }: HarnessImportDialogProps) {
  const [envRows, setEnvRows] = useState<EnvRow[]>(() => envRowsFromKeys(entry.envKeys));
  const [envFile, setEnvFile] = useState(entry.envFile ?? '');
  const [highPrivilegeTools, setHighPrivilegeTools] = useState('');
  const [approvalRequiredTools, setApprovalRequiredTools] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    const parsed = parseEnvRows(envRows);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }
    const missing = entry.envKeys.filter((key) => parsed.env[key] === undefined);
    if (missing.length > 0) {
      setError(`Missing values for: ${missing.join(', ')}. Leave them blank and use an env file instead if you prefer.`);
      return;
    }
    onSubmit({
      env: parsed.env,
      envFile: envFile.trim() === '' ? null : envFile.trim(),
      highPrivilegeTools: splitList(highPrivilegeTools),
      approvalRequiredTools: splitList(approvalRequiredTools),
    });
  };

  return (
    <ConfirmDialog
      open
      title={`Import “${entry.name}”`}
      description={`From ${entry.harness} · ${entry.transport}. Values you enter here are passed to the gateway once and injected at start.`}
      size="lg"
      confirmLabel="Import server"
      busy={busy}
      onConfirm={submit}
      onCancel={onClose}
    >
      <div className="space-y-4">
        {entry.envKeys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
            This harness entry declares no environment variables. You can still import it and register env values
            later from the server policy drawer.
          </p>
        ) : (
          <div>
            <p className="mb-1.5 text-xs font-medium text-slate-300">Environment values</p>
            <p className="mb-2 text-[11px] text-slate-500">
              Discovery only returns variable names — choose values or keep using the env file below.
            </p>
            <ul className="space-y-2">
              {envRows.map((row) => (
                <li key={row.id} className="grid gap-2 sm:grid-cols-[1fr_1fr]">
                  <TextInput
                    aria-label={`${row.key} variable name`}
                    value={row.key}
                    onChange={(event) =>
                      setEnvRows((rows) =>
                        rows.map((candidate) =>
                          candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate,
                        ),
                      )
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <TextInput
                    aria-label={`${row.key} value`}
                    type="password"
                    value={row.value}
                    onChange={(event) =>
                      setEnvRows((rows) =>
                        rows.map((candidate) =>
                          candidate.id === row.id ? { ...candidate, value: event.target.value } : candidate,
                        ),
                      )
                    }
                    placeholder="value"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field label="Env file path" hint="optional — values stay on disk and are never persisted by the gateway.">
          <TextInput
            value={envFile}
            onChange={(event) => setEnvFile(event.target.value)}
            placeholder="~/.config/example/mcp.env"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="High-privilege tools" hint="comma separated tool names">
            <TextInput
              value={highPrivilegeTools}
              onChange={(event) => setHighPrivilegeTools(event.target.value)}
              placeholder="delete_repo"
            />
          </Field>
          <Field label="Approval-required tools" hint="human-approved before execution">
            <TextInput
              value={approvalRequiredTools}
              onChange={(event) => setApprovalRequiredTools(event.target.value)}
              placeholder="deliver_credential"
            />
          </Field>
        </div>
        {error !== null && <Notice tone="error">{error}</Notice>}
      </div>
    </ConfirmDialog>
  );
}

export interface ImportTabProps {
  onViewServer: (serverId: string) => void;
  onServersChanged: () => void;
}

/** Import tab: scan local agent harnesses (Claude, opencode, OpenMausBot, generic). */
export function ImportTab({ onViewServer, onServersChanged }: ImportTabProps) {
  const toast = useToast();
  const sources = useAsyncData(() => api.listDiscoverySources(), []);
  const [scanResult, setScanResult] = useState<HarnessScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [createdServer, setCreatedServer] = useState<ServerRecord | null>(null);
  const [optionsEntry, setOptionsEntry] = useState<HarnessEntry | null>(null);

  const harnessSources = scanResult?.sources ?? (sources.status === 'ready' ? sources.data : []);
  const entries = scanResult?.entries ?? [];

  const scan = async (): Promise<void> => {
    setScanning(true);
    setScanError(null);
    setImportError(null);
    try {
      setScanResult(await api.scanDiscovery());
      toast('success', 'Harness scan complete.');
    } catch (error) {
      setScanError(formatApiError(error));
    } finally {
      setScanning(false);
    }
  };

  const handleImport = async (entry: HarnessEntry, overrides?: ImportOverrides): Promise<void> => {
    setImportingId(entry.id);
    setImportError(null);
    try {
      const server = await api.importDiscoveryEntry({
        harness: entry.harness,
        name: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.args,
        url: entry.url,
        env: overrides?.env ?? {},
        envFile: overrides?.envFile ?? entry.envFile,
        highPrivilegeTools: overrides?.highPrivilegeTools ?? [],
        approvalRequiredTools: overrides?.approvalRequiredTools ?? [],
      });
      setCreatedServer(server);
      setOptionsEntry(null);
      toast('success', `Imported “${server.name}” from ${entry.harness}.`);
      onServersChanged();
    } catch (error) {
      setImportError(formatApiError(error));
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="space-y-5">
      {scanError !== null && (
        <Notice tone="error" title="Harness scan failed" onDismiss={() => setScanError(null)}>
          {scanError}
        </Notice>
      )}
      {importError !== null && (
        <Notice tone="error" title="Import failed" onDismiss={() => setImportError(null)}>
          {importError}
        </Notice>
      )}

      {createdServer !== null && (
        <Notice tone="success" title={`Imported “${createdServer.name}”`}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={badgeToneForStatus(createdServer.status)}>{createdServer.status}</Badge>
            <span className="font-mono text-[11px]">{createdServer.id}</span>
            <span className="text-[11px]">
              {createdServer.runtime} · {createdServer.transport}
            </span>
            <GhostButton onClick={() => onViewServer(createdServer.id)}>View server</GhostButton>
            <GhostButton onClick={() => setCreatedServer(null)}>Dismiss</GhostButton>
          </div>
        </Notice>
      )}

      <Card
        title="Local harness discovery"
        subtitle="Read-only scan of MCP servers already configured in Claude Code, opencode, OpenMausBot or a generic JSON config."
        actions={
          <>
            <GhostButton
              onClick={() => {
                setScanResult(null);
                sources.reload();
              }}
            >
              Re-detect
            </GhostButton>
            <PrimaryButton onClick={() => void scan()} disabled={scanning} className="px-3 py-1.5 text-xs">
              {scanning ? 'Scanning…' : 'Scan harnesses'}
            </PrimaryButton>
          </>
        }
      >
        {sources.status === 'loading' && <SkeletonCards count={3} />}
        {sources.status === 'error' && <ErrorState message={sources.error} onRetry={sources.reload} />}
        {sources.status === 'ready' &&
          (harnessSources.length === 0 ? (
            <EmptyState
              icon="⌂"
              title="No harness adapters detected"
              description="Discovery looks for ~/.claude.json, ~/.config/opencode/opencode.json, ~/.openmausbot/config.json and MCP_DISCOVERY_CONFIG. Override a path with MCP_DISCOVERY_<ID>_CONFIG."
            />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {harnessSources.map((harness) => (
                <article
                  key={harness.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 shadow-lg shadow-black/10"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-100">{harness.label}</p>
                    <Badge tone={harness.exists ? 'success' : 'neutral'}>
                      {harness.exists ? 'detected' : 'not found'}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-slate-500" title={harness.configPath}>
                    {harness.configPath}
                  </p>
                  <p className="mt-2 text-[11px] text-slate-400">
                    {harness.serverCount} configured server{harness.serverCount === 1 ? '' : 's'}
                  </p>
                </article>
              ))}
            </div>
          ))}
      </Card>

      <Card
        title="Discovered MCP servers"
        subtitle={scanResult === null ? 'Run a scan to list importable servers' : `${entries.length} servers found${scanResult.errors.length > 0 ? ` · ${scanResult.errors.length} harness error${scanResult.errors.length === 1 ? '' : 's'}` : ''}`}
        padded={false}
      >
        {scanResult !== null && scanResult.errors.length > 0 && (
          <div className="space-y-2 border-b border-slate-800 p-4">
            {scanResult.errors.map((harnessError) => (
              <Notice key={harnessError.harness} tone="warning" title={`${harnessError.harness} could not be read`}>
                {harnessError.error}
              </Notice>
            ))}
          </div>
        )}

        {scanning && <SkeletonTable rows={3} columns={5} label="Scanning local harnesses…" />}

        {!scanning && scanResult === null && (
          <EmptyState
            icon="⇣"
            title="Scan your local harnesses"
            description="Discovery is read-only and local-only: it lists server entries and environment variable names, never their values."
            action={
              <PrimaryButton onClick={() => void scan()} className="px-3 py-1.5 text-xs">
                Scan harnesses
              </PrimaryButton>
            }
          />
        )}

        {!scanning && scanResult !== null && entries.length === 0 && (
          <EmptyState
            icon="∅"
            title="No MCP servers found"
            description="The detected harness configs do not contain any mcpServers entries yet. Configure a server in your agent, then scan again."
          />
        )}

        {!scanning && scanResult !== null && entries.length > 0 && (
          <Table<HarnessEntry>
            rows={entries}
            getRowKey={(entry) => entry.id}
            columns={[
              {
                key: 'name',
                header: 'Server',
                render: (entry) => (
                  <div className="min-w-0">
                    <p className="font-medium text-slate-200">{entry.name}</p>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {entry.enabled ? null : <Badge tone="warning">disabled in harness</Badge>}
                      {entry.headerKeys.length > 0 && (
                        <Badge tone="neutral">
                          {entry.headerKeys.length} header{entry.headerKeys.length === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                key: 'harness',
                header: 'Harness',
                render: (entry) => <Badge tone="info">{entry.harness}</Badge>,
              },
              {
                key: 'transport',
                header: 'Transport',
                render: (entry) => <Badge tone="neutral">{entry.transport}</Badge>,
              },
              {
                key: 'command',
                header: 'Command / URL',
                render: (entry) => (
                  <span
                    className="block max-w-[18rem] truncate font-mono text-[11px] text-slate-400"
                    title={entry.command ? `${entry.command} ${entry.args.join(' ')}`.trim() : entry.url ?? ''}
                  >
                    {entry.command ? `${entry.command} ${entry.args.join(' ')}`.trim() : entry.url ?? '—'}
                  </span>
                ),
              },
              {
                key: 'env',
                header: 'Env',
                render: (entry) => (
                  <div className="max-w-[12rem] space-y-1">
                    {entry.envKeys.length === 0 ? (
                      <span className="text-xs text-slate-500">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {entry.envKeys.slice(0, 4).map((key) => (
                          <Badge key={key} tone="accent">
                            {key}
                          </Badge>
                        ))}
                        {entry.envKeys.length > 4 && <Badge tone="neutral">+{entry.envKeys.length - 4}</Badge>}
                      </div>
                    )}
                    {entry.envFile !== null && (
                      <p className="truncate font-mono text-[10px] text-slate-500" title={entry.envFile}>
                        {entry.envFile}
                      </p>
                    )}
                  </div>
                ),
              },
              {
                key: 'actions',
                header: 'Actions',
                render: (entry) => (
                  <div className="flex flex-wrap items-center gap-1">
                    <PrimaryButton
                      onClick={() => void handleImport(entry)}
                      disabled={importingId !== null}
                      className="px-2 py-1 text-[11px]"
                    >
                      {importingId === entry.id ? 'Importing…' : 'Import'}
                    </PrimaryButton>
                    <SecondaryButton
                      onClick={() => setOptionsEntry(entry)}
                      disabled={importingId !== null}
                      className="px-2 py-1 text-[11px]"
                    >
                      Options
                    </SecondaryButton>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      {optionsEntry !== null && (
        <HarnessImportDialog
          entry={optionsEntry}
          busy={importingId !== null}
          onSubmit={(overrides) => void handleImport(optionsEntry, overrides)}
          onClose={() => setOptionsEntry(null)}
        />
      )}

      <p className="px-1 text-[11px] text-slate-500">
        Discovery never modifies harness configs and never returns secret values — only environment variable names.
        Imported servers are registered with the gateway; after import you can review policy and logs in Installed.
      </p>
    </div>
  );
}
