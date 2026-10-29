import { useState } from 'react';
import type { ReactNode } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import { Notice } from '../../components/States.js';
import { GhostButton } from '../../components/Form.js';
import { CopyButton } from '../../components/CopyButton.js';
import { useToast } from '../../components/Toasts.js';
import type {
  InspectorEnvEntry,
  InspectorProfile,
  ServerInspectorOverview,
  ServerRecord,
} from '../../../core/types.js';

export interface ConfigurationTabProps {
  serverId: string;
  server: ServerRecord;
  config: ServerInspectorOverview['config'];
  /** Refresh inspector data after a migration. */
  onChanged: () => void;
}

type RevealKind = 'env' | 'header' | 'profile';

/** Configuration tab: masked env/headers + attached profiles, audited reveal. */
export function ConfigurationTab({ serverId, server, config, onChanged }: ConfigurationTabProps) {
  const toast = useToast();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrating, setMigrating] = useState(false);

  const cacheKey = (kind: RevealKind, key: string, profileId?: string): string =>
    `${kind}:${profileId ?? '-'}:${key}`;

  const reveal = async (kind: RevealKind, key: string, profileId?: string): Promise<void> => {
    const id = cacheKey(kind, key, profileId);
    setRevealing(id);
    setError(null);
    try {
      const secret = await api.revealSecret(serverId, {
        kind,
        key,
        ...(profileId === undefined ? {} : { profileId }),
      });
      setRevealed((previous) => ({ ...previous, [id]: secret.value }));
      toast('success', `Revealed ${key} — this access was audited.`);
    } catch (revealError) {
      setError(formatApiError(revealError));
    } finally {
      setRevealing(null);
    }
  };

  const migrate = async (): Promise<void> => {
    setMigrating(true);
    setError(null);
    try {
      const profile = await api.migrateEnvFile(serverId);
      toast('success', `Migrated the legacy env file into encrypted profile “${profile.name}”.`);
      onChanged();
    } catch (migrateError) {
      setError(formatApiError(migrateError));
    } finally {
      setMigrating(false);
    }
  };

  const renderServerEntry = (entry: InspectorEnvEntry, kind: 'env' | 'header'): ReactNode => {
    const id = cacheKey(kind, entry.key);
    const value = revealed[id] ?? (entry.masked ? undefined : entry.value ?? undefined);
    return (
      <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="font-mono text-xs text-slate-200">{entry.key}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <Badge tone="neutral">{entry.source}</Badge>
            {entry.masked && value === undefined && <Badge tone="warning">masked</Badge>}
          </div>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-1.5">
          {value !== undefined ? (
            <>
              <code className="max-w-[22rem] truncate rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-emerald-300">
                {value}
              </code>
              <CopyButton value={value} label="Copy" copiedLabel="Copied" variant="ghost" />
            </>
          ) : (
            <>
              <span aria-label="masked value" className="font-mono text-xs tracking-widest text-slate-500">
                ••••••••
              </span>
              <GhostButton onClick={() => void reveal(kind, entry.key)} disabled={revealing !== null}>
                {revealing === id ? 'Revealing…' : 'Reveal'}
              </GhostButton>
            </>
          )}
        </div>
      </li>
    );
  };

  const renderProfile = (profile: InspectorProfile): ReactNode => (
    <article key={profile.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-100">{profile.name}</p>
          <p className="font-mono text-[10px] text-slate-500">{profile.id}</p>
          {profile.description !== null && (
            <p className="mt-1 text-[11px] text-slate-400">{profile.description}</p>
          )}
        </div>
        <Badge tone="accent">{profile.entries.length + profile.headers.length} values</Badge>
      </div>
      {profile.entries.length + profile.headers.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">This profile has no configuration entries.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-800/70 rounded-lg border border-slate-800/70">
          {[...profile.entries, ...profile.headers].map((entry, index) => {
            const id = cacheKey('profile', entry.key, profile.id);
            const value = revealed[id];
            return (
              <li
                key={`${profile.id}-${entry.key}-${index}`}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs text-slate-200">{entry.key}</p>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {entry.source === 'encrypted' ? (
                      <Badge tone="warning">encrypted</Badge>
                    ) : (
                      <Badge tone="accent">vault: {entry.ref ?? '—'}</Badge>
                    )}
                  </div>
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-1.5">
                  {value !== undefined ? (
                    <>
                      <code className="max-w-[20rem] truncate rounded border border-slate-800 bg-slate-950 px-2 py-1 font-mono text-[11px] text-emerald-300">
                        {value}
                      </code>
                      <CopyButton value={value} label="Copy" copiedLabel="Copied" variant="ghost" />
                    </>
                  ) : (
                    <>
                      <span aria-label="masked value" className="font-mono text-xs tracking-widest text-slate-500">
                        ••••••••
                      </span>
                      <GhostButton
                        onClick={() => void reveal('profile', entry.key, profile.id)}
                        disabled={revealing !== null}
                      >
                        {revealing === id ? 'Revealing…' : 'Reveal'}
                      </GhostButton>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );

  return (
    <div className="space-y-4">
      <Notice tone="info" title="Credential reveal is audited">
        Values are stored encrypted in the gateway vault and never returned by the inspector. Revealing a value is
        a one-shot, audited action recorded in this server&apos;s Activity log.
      </Notice>

      {error !== null && (
        <Notice tone="error" title="Configuration action failed" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}

      {server.envFile !== null && server.envFile !== undefined && (
        <Notice tone="warning" title="Legacy env file detected">
          <p>
            This server still reads <code className="font-mono">{server.envFile}</code>. Migrate it into an
            encrypted configuration profile so values live in the vault and can be reused.
          </p>
          <button
            type="button"
            onClick={() => void migrate()}
            disabled={migrating}
            className="mt-2 rounded-lg border border-amber-700 px-2.5 py-1 text-[11px] font-semibold text-amber-100 transition-colors hover:bg-amber-900/40 disabled:opacity-50"
          >
            {migrating ? 'Migrating…' : 'Migrate to encrypted profile'}
          </button>
        </Notice>
      )}

      <Card
        title="Server environment"
        subtitle={`${config.env.length} variable${config.env.length === 1 ? '' : 's'} · masked values are revealable`}
        padded={false}
      >
        {config.env.length === 0 ? (
          <p className="px-4 py-5 text-xs text-slate-500">No server-level environment variables.</p>
        ) : (
          <ul className="divide-y divide-slate-800/70">{config.env.map((entry) => renderServerEntry(entry, 'env'))}</ul>
        )}
      </Card>

      <Card
        title="Server headers"
        subtitle={`${config.headers.length} header${config.headers.length === 1 ? '' : 's'} for remote transports`}
        padded={false}
      >
        {config.headers.length === 0 ? (
          <p className="px-4 py-5 text-xs text-slate-500">No server-level HTTP headers.</p>
        ) : (
          <ul className="divide-y divide-slate-800/70">
            {config.headers.map((entry) => renderServerEntry(entry, 'header'))}
          </ul>
        )}
      </Card>

      <Card
        title="Attached configuration profiles"
        subtitle={`${config.profiles.length} profile${config.profiles.length === 1 ? '' : 's'} merged into this server at start`}
        padded
      >
        {config.profiles.length === 0 ? (
          <p className="text-xs text-slate-500">
            No encrypted configuration profiles are attached. Attach one from the Configurations page.
          </p>
        ) : (
          <div className="space-y-3">{config.profiles.map((profile) => renderProfile(profile))}</div>
        )}
      </Card>

      <Card title="Vault secret references" subtitle="Named secrets a profile can reference (values stay in the Vault page)">
        {config.vaultRefs.length === 0 ? (
          <p className="text-xs text-slate-500">No vault references are used by this server&apos;s profiles.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {config.vaultRefs.map((name) => (
              <Badge key={name} tone="accent">
                {name}
              </Badge>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
