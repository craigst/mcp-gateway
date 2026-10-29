import { useEffect, useRef, useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { formatTimestamp } from '../../lib/format.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { EmptyState } from '../../components/EmptyState.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonBlock, SkeletonCards } from '../../components/Skeleton.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { DangerButton, Field, GhostButton, PrimaryButton, Select, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import { REPO_URL_PATTERN, sourceKindLabel, type SourcesState } from './shared.js';
import type { CatalogSource, CatalogSourceKind } from '../../../core/types.js';

interface SourceFormState {
  label: string;
  kind: CatalogSourceKind;
  repoUrl: string;
  ref: string;
  subpath: string;
  token: string;
}

const EMPTY_FORM: SourceFormState = {
  label: '',
  kind: 'dsh-umbrella',
  repoUrl: '',
  ref: 'main',
  subpath: '',
  token: '',
};

const KIND_OPTIONS: readonly { value: CatalogSourceKind; label: string; hint: string }[] = [
  {
    value: 'dsh-umbrella',
    label: 'DSH umbrella repo',
    hint: 'Umbrella repo: .gitmodules + pinned.json mcp[]/bundles[] metadata.',
  },
  {
    value: 'github-repo',
    label: 'Single GitHub repo',
    hint: 'One MCP server repository; the manifest is auto-detected when absent.',
  },
  {
    value: 'catalog-json',
    label: 'Catalog JSON URL',
    hint: 'Raw JSON URL returning { "entries": [ … ] } (no auth).',
  },
];

interface SourceFormErrors {
  label?: string;
  repoUrl?: string;
}

function validateSourceForm(form: SourceFormState): SourceFormErrors {
  const errors: SourceFormErrors = {};
  if (form.label.trim() === '') errors.label = 'Label is required';
  if (form.repoUrl.trim() === '') errors.repoUrl = 'Repository URL is required';
  else if (!REPO_URL_PATTERN.test(form.repoUrl.trim())) {
    errors.repoUrl = 'URL must start with http:// or https://';
  }
  return errors;
}

type CountState = number | 'error';

export interface SourcesTabProps {
  sources: SourcesState;
  onDiscoverSource: (sourceId: string) => void;
}

/** Sources tab: connect private GitHub catalogs, inspect and remove them. */
export function SourcesTab({ sources, onDiscoverSource }: SourcesTabProps) {
  const toast = useToast();
  const [form, setForm] = useState<SourceFormState>(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState<SourceFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<CatalogSource | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [counts, setCounts] = useState<Record<string, CountState | null>>({});
  const [countVersion, setCountVersion] = useState(0);
  const requestedRef = useRef<Set<string>>(new Set());

  const selectedKind = KIND_OPTIONS.find((option) => option.value === form.kind) ?? KIND_OPTIONS[0];

  useEffect(() => {
    if (sources.status !== 'ready') return;
    for (const source of sources.data) {
      if (requestedRef.current.has(source.id)) continue;
      requestedRef.current.add(source.id);
      setCounts((previous) => ({ ...previous, [source.id]: null }));
      api
        .listCatalogEntries(source.id)
        .then((result) => setCounts((previous) => ({ ...previous, [source.id]: result.entries.length })))
        .catch(() => setCounts((previous) => ({ ...previous, [source.id]: 'error' })));
    }
  }, [sources.status, sources.data, countVersion]);

  const reload = (): void => {
    requestedRef.current.clear();
    setCounts({});
    setCountVersion((current) => current + 1);
    sources.reload();
  };

  const update = <K extends keyof SourceFormState>(key: K, value: SourceFormState[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    const errors = validateSourceForm(form);
    setFormErrors(errors);
    setSubmitError(null);
    setNotice(null);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const token = form.token.trim();
      const source = await api.addCatalogSource({
        label: form.label.trim(),
        kind: form.kind,
        repoUrl: form.repoUrl.trim(),
        ref: form.ref.trim() === '' ? null : form.ref.trim(),
        subpath: form.subpath.trim() === '' ? null : form.subpath.trim(),
        ...(token === '' ? {} : { token }),
      });
      setForm(EMPTY_FORM);
      setNotice(
        token === ''
          ? `Connected “${source.label}”.`
          : `Connected “${source.label}” — the clone token is stored encrypted in the vault and is never returned by the API.`,
      );
      toast('success', `Catalog source “${source.label}” connected.`);
      reload();
    } catch (error) {
      setSubmitError(formatApiError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setSubmitError(null);
    try {
      await api.deleteCatalogSource(deleteTarget.id);
      toast('success', `Removed catalog source “${deleteTarget.label}”.`);
      requestedRef.current.delete(deleteTarget.id);
      setCounts((previous) => {
        const next = { ...previous };
        delete next[deleteTarget.id];
        return next;
      });
      setDeleteTarget(null);
      sources.reload();
    } catch (error) {
      setSubmitError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  const sourceList = sources.status === 'ready' ? sources.data : [];

  return (
    <div className="space-y-5">
      {submitError !== null && (
        <Notice tone="error" title="Catalog source request failed" onDismiss={() => setSubmitError(null)}>
          {submitError}
        </Notice>
      )}
      {notice !== null && (
        <Notice tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Notice>
      )}

      <Card title="Connect a catalog source" subtitle="Point the gateway at a private GitHub catalog repository.">
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Label" error={formErrors.label}>
              <TextInput
                value={form.label}
                onChange={(event) => update('label', event.target.value)}
                placeholder="Internal MCP catalog"
              />
            </Field>
            <Field label="Source kind" hint={selectedKind?.hint}>
              <Select
                value={form.kind}
                onChange={(event) => update('kind', event.target.value as CatalogSourceKind)}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Repository / catalog URL" error={formErrors.repoUrl}>
            <TextInput
              value={form.repoUrl}
              onChange={(event) => update('repoUrl', event.target.value)}
              placeholder="https://github.com/example/private-mcp-catalog"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ref / tag" hint="optional — branch, tag or commit">
              <TextInput value={form.ref} onChange={(event) => update('ref', event.target.value)} placeholder="main" />
            </Field>
            <Field label="Subpath" hint="optional — catalog location inside a monorepo">
              <TextInput
                value={form.subpath}
                onChange={(event) => update('subpath', event.target.value)}
                placeholder="catalog/"
              />
            </Field>
          </div>
          <Field
            label="Private token"
            hint="Optional for private repositories. Stored encrypted in the AES-256 vault; never returned by the API or written to logs."
          >
            <TextInput
              type="password"
              value={form.token}
              onChange={(event) => update('token', event.target.value)}
              placeholder="ghp_…"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="max-w-xl text-[11px] text-slate-500">
              Private repos are cloned with the vault-backed token; public repos work without one. Changes are cached
              until you refresh the source in Discover.
            </p>
            <PrimaryButton onClick={() => void submit()} disabled={busy}>
              {busy ? 'Saving…' : 'Add source'}
            </PrimaryButton>
          </div>
        </div>
      </Card>

      <Card
        title="Catalog sources"
        subtitle={`${sourceList.length} connected`}
        actions={<GhostButton onClick={reload}>Refresh</GhostButton>}
        padded={sourceList.length === 0}
      >
        {sources.status === 'loading' && (
          <div className="p-4">
            <SkeletonCards count={2} />
          </div>
        )}
        {sources.status === 'error' && (
          <div className="p-4">
            <ErrorState message={sources.error} onRetry={sources.reload} />
          </div>
        )}
        {sources.status === 'ready' &&
          (sourceList.length === 0 ? (
            <EmptyState
              icon="⬡"
              title="No catalog sources yet"
              description="Connect a private GitHub catalog to browse MCP servers and bundles. Use an umbrella repo for a DSH plugin catalog, a single server repo, or a raw catalog JSON URL. Private tokens are stored encrypted in the AES-256 vault."
            />
          ) : (
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
              {sourceList.map((source) => {
                const count = counts[source.id];
                return (
                  <article
                    key={source.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-4 shadow-lg shadow-black/10"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-100">{source.label}</p>
                          <p className="font-mono text-[10px] text-slate-500">{source.id}</p>
                        </div>
                        <Badge tone="info">{sourceKindLabel(source.kind)}</Badge>
                      </div>
                      <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-slate-400">
                        {source.repoUrl}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{source.ref ?? 'default ref'}</Badge>
                        {source.subpath !== null && <Badge tone="neutral">subpath {source.subpath}</Badge>}
                        <Badge tone={source.tokenSecretName ? 'accent' : 'neutral'}>
                          {source.tokenSecretName ? 'token in vault' : 'public'}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2.5">
                      <span className="text-[11px] text-slate-500">
                        {count === undefined || count === null ? (
                          <SkeletonBlock className="inline-block h-3 w-16 align-middle" />
                        ) : count === 'error' ? (
                          'entry count unavailable'
                        ) : (
                          `${count} entr${count === 1 ? 'y' : 'ies'}`
                        )}
                        {' · '}
                        {formatTimestamp(source.createdAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        <GhostButton onClick={() => onDiscoverSource(source.id)}>Browse</GhostButton>
                        <DangerButton
                          onClick={() => setDeleteTarget(source)}
                          className="px-2 py-1 text-[11px]"
                          disabled={deleteBusy}
                        >
                          Delete
                        </DangerButton>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ))}
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Remove catalog source"
        description={
          deleteTarget !== null
            ? `Remove “${deleteTarget.label}” (${deleteTarget.id})? Already-installed servers stay registered; the cached catalog entries are dropped.`
            : undefined
        }
        tone="danger"
        confirmLabel="Remove source"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
