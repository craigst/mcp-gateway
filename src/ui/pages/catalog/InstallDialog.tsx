import { useEffect, useRef, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Badge, badgeToneForStatus } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { GhostButton, CheckboxField, Field, PrimaryButton, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { REPO_URL_PATTERN, formatLatency, newEnvRow, parseEnvRows } from './shared.js';
import type { EnvRow } from './shared.js';
import type { CatalogEntry, CatalogInstallResult } from '../../../core/types.js';

export type InstallAction =
  | { type: 'entry'; sourceId: string; entry: CatalogEntry }
  | { type: 'url' };

export interface InstallDialogProps {
  action: InstallAction;
  onClose: () => void;
  onInstalled: (result: CatalogInstallResult) => void;
  onViewServer: (serverId: string) => void;
}

type Phase = 'form' | 'running' | 'done';

const STAGES: readonly string[] = [
  'Clone repository',
  'Detect manifest',
  'Install dependencies & build',
  'Register sub-server',
  'Start & probe tools',
];

function InstallProgress({ stageIndex }: { stageIndex: number }) {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <Notice tone="info" title="Installing…">
        The gateway is cloning the repository, building it and registering the sub-server. This can take a
        couple of minutes — keep this dialog open.
      </Notice>
      <ol className="space-y-2">
        {STAGES.map((stage, index) => {
          const done = index < stageIndex;
          const active = index === stageIndex;
          return (
            <li key={stage} className="flex items-center gap-2.5 text-xs">
              <span
                aria-hidden="true"
                className={
                  done
                    ? 'flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] text-emerald-300'
                    : active
                      ? 'h-5 w-5 animate-spin rounded-full border-2 border-slate-700 border-t-sky-400'
                      : 'h-5 w-5 rounded-full border border-slate-700'
                }
              >
                {done ? '✓' : ''}
              </span>
              <span className={done ? 'text-slate-400' : active ? 'font-medium text-slate-200' : 'text-slate-500'}>
                {stage}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-slate-500">Progress is approximate; the build log tail is shown when it finishes.</p>
    </div>
  );
}

function InstallResultView({
  result,
  onViewServer,
  onInstallAnother,
}: {
  result: CatalogInstallResult;
  onViewServer: (serverId: string) => void;
  onInstallAnother: () => void;
}) {
  const test = result.test;
  const tone = test === null ? 'info' : test.ok ? 'success' : 'warning';
  return (
    <div className="space-y-4">
      <Notice
        tone={tone}
        title={test === null ? 'Server installed' : test.ok ? 'Installed and tested' : 'Installed — probe failed'}
      >
        {test === null
          ? 'The sub-server was registered without a test run.'
          : test.ok
            ? `${test.toolCount} tool${test.toolCount === 1 ? '' : 's'} discovered in ${formatLatency(test.latencyMs)}.`
            : test.error ?? 'The activation probe failed.'}
      </Notice>

      <dl className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-2">
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Server</dt>
          <dd className="mt-0.5 text-sm font-medium text-slate-200">{result.server.name}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</dt>
          <dd className="mt-0.5">
            <Badge tone={badgeToneForStatus(result.server.status)}>{result.server.status}</Badge>
          </dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Server id</dt>
          <dd className="mt-0.5 font-mono text-[11px] text-slate-400">{result.server.id}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Runtime</dt>
          <dd className="mt-0.5 text-xs text-slate-300">
            {result.server.runtime} · {result.server.transport}
          </dd>
        </div>
      </dl>

      {test !== null && test.tools.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Discovered tools
          </h3>
          <div className="flex flex-wrap gap-1">
            {test.tools.slice(0, 24).map((tool) => (
              <Badge key={tool} tone="neutral">
                {tool}
              </Badge>
            ))}
            {test.tools.length > 24 && <Badge tone="info">+{test.tools.length - 24} more</Badge>}
          </div>
        </div>
      )}

      {result.buildLogTail.length > 0 && (
        <details className="rounded-xl border border-slate-800 bg-slate-900/40">
          <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-semibold text-slate-300">
            Build log tail ({result.buildLogTail.length} lines)
          </summary>
          <pre className="terminal-scroll max-h-56 overflow-auto border-t border-slate-800 p-3 font-mono text-[11px] leading-relaxed text-slate-400">
            {result.buildLogTail.join('\n')}
          </pre>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={() => onViewServer(result.server.id)} className="px-3 py-1.5 text-xs">
          View server
        </PrimaryButton>
        <GhostButton onClick={onInstallAnother}>Install another</GhostButton>
      </div>
    </div>
  );
}

/**
 * Shared install/import dialog for catalog entries and raw Git URLs.
 * Handles env rows, env file, start-after-build and run-test toggles, shows
 * progress while the gateway clones/builds, then a result card.
 */
export function InstallDialog({ action, onClose, onInstalled, onViewServer }: InstallDialogProps) {
  const toast = useToast();
  const entry = action.type === 'entry' ? action.entry : null;

  const [phase, setPhase] = useState<Phase>('form');
  const [stageIndex, setStageIndex] = useState(0);
  const [result, setResult] = useState<CatalogInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(entry?.serverName ?? '');
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState(entry?.ref ?? '');
  const [subpath, setSubpath] = useState('');
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [envFile, setEnvFile] = useState('');
  const [start, setStart] = useState(true);
  const [test, setTest] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (phase !== 'running') return;
    const timer = setInterval(() => {
      setStageIndex((current) => Math.min(current + 1, STAGES.length - 1));
    }, 1200);
    return () => clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const close = (): void => {
    abortRef.current?.abort();
    onClose();
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (action.type === 'url') {
      const trimmed = url.trim();
      if (trimmed === '') {
        setError('Repository URL is required.');
        return;
      }
      if (!REPO_URL_PATTERN.test(trimmed)) {
        setError('Repository URL must start with http:// or https://');
        return;
      }
    }
    const parsed = parseEnvRows(envRows);
    if (parsed.error !== null) {
      setError(parsed.error);
      return;
    }

    const common = {
      ...(name.trim() === '' ? {} : { name: name.trim() }),
      env: parsed.env,
      envFile: envFile.trim() === '' ? null : envFile.trim(),
      start,
      test,
    };
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setStageIndex(0);
    try {
      const installed =
        action.type === 'entry'
          ? await api.installCatalogEntry(
              { sourceId: action.sourceId, entryId: action.entry.id, ...common },
              { signal: controller.signal },
            )
          : await api.importCatalogUrl(
              {
                url: url.trim(),
                ...(ref.trim() === '' ? {} : { ref: ref.trim() }),
                ...(subpath.trim() === '' ? {} : { subpath: subpath.trim() }),
                ...common,
              },
              { signal: controller.signal },
            );
      setResult(installed);
      setPhase('done');
      onInstalled(installed);
      toast(
        'success',
        `Installed “${installed.server.name}”${installed.test ? ` · ${installed.test.toolCount} tools` : ''}.`,
      );
    } catch (submitError) {
      if (controller.signal.aborted) return;
      setError(formatApiError(submitError));
      setPhase('form');
    }
  };

  const title = action.type === 'entry' ? `Install ${action.entry.name}` : 'Import from Git URL';
  const description =
    action.type === 'entry'
      ? `Clone ${action.entry.repoUrl}${action.entry.ref ? ` @ ${action.entry.ref}` : ''} and register it as a sub-server.`
      : 'Clone any allowlisted MCP repository, auto-detect its manifest and register it as a sub-server.';

  const confirmLabel =
    phase === 'done' ? 'Close' : action.type === 'entry' ? 'Install server' : 'Import server';

  return (
    <ConfirmDialog
      open
      title={title}
      description={description}
      size="lg"
      confirmLabel={confirmLabel}
      cancelLabel={phase === 'running' ? 'Cancel install' : 'Cancel'}
      busy={phase === 'running'}
      onConfirm={() => {
        if (phase === 'done') close();
        else void submit();
      }}
      onCancel={close}
    >
      {phase === 'running' && <InstallProgress stageIndex={stageIndex} />}

      {phase !== 'running' && result !== null && (
        <InstallResultView
          result={result}
          onViewServer={(serverId) => {
            onViewServer(serverId);
            close();
          }}
          onInstallAnother={() => {
            setResult(null);
            setPhase('form');
            setError(null);
          }}
        />
      )}

      {phase === 'form' && result === null && (
        <div className="space-y-4">
          {action.type === 'url' && (
            <>
              <Field label="Repository URL" hint="Must match the gateway clone allowlist.">
                <TextInput
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://github.com/example/mcp-server"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Ref / tag" hint="optional — branch, tag or commit">
                  <TextInput value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" />
                </Field>
                <Field label="Subpath" hint="optional — manifest location inside a monorepo">
                  <TextInput
                    value={subpath}
                    onChange={(event) => setSubpath(event.target.value)}
                    placeholder="packages/server"
                  />
                </Field>
              </div>
            </>
          )}

          <Field label="Server name" hint="optional — defaults to the manifest or catalog name">
            <TextInput
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={entry?.serverName ?? entry?.name ?? 'custom-name'}
            />
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">Environment variables</span>
              <GhostButton onClick={() => setEnvRows((rows) => [...rows, newEnvRow()])}>Add variable</GhostButton>
            </div>
            {envRows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-800 px-3 py-2.5 text-[11px] text-slate-500">
                No variables yet. Add them here if the server needs credentials; use an env file to keep values on
                disk instead.
              </p>
            ) : (
              <ul className="space-y-2">
                {envRows.map((row) => (
                  <li key={row.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <TextInput
                      aria-label="Environment variable name"
                      value={row.key}
                      onChange={(event) =>
                        setEnvRows((rows) =>
                          rows.map((candidate) =>
                            candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate,
                          ),
                        )
                      }
                      placeholder="BRAIN_API_KEY"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <TextInput
                      aria-label="Environment variable value"
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
                    <GhostButton
                      onClick={() => setEnvRows((rows) => rows.filter((candidate) => candidate.id !== row.id))}
                      aria-label={`Remove ${row.key || 'environment variable'}`}
                    >
                      Remove
                    </GhostButton>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Field
            label="Env file path"
            hint="optional — KEY=VALUE file read at start; values stay on disk and are never persisted."
          >
            <TextInput
              value={envFile}
              onChange={(event) => setEnvFile(event.target.value)}
              placeholder="~/.config/example/mcp.env"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="space-y-1.5">
            <CheckboxField
              label="Start the sub-server after a successful build"
              checked={start}
              onChange={setStart}
            />
            <CheckboxField
              label="Run an activation test and list tools (adds a few seconds)"
              checked={test}
              onChange={setTest}
            />
          </div>

          {error !== null && (
            <Notice tone="error" title="Could not install" onDismiss={() => setError(null)}>
              {error}
            </Notice>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
