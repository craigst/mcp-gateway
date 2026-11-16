import { useState } from 'react';
import { api, formatApiError } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { formatTimestamp } from '../lib/format.js';
import { Card } from '../components/Card.js';
import { Badge } from '../components/Badge.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState, Notice } from '../components/States.js';
import { SkeletonCards } from '../components/Skeleton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { DangerButton, GhostButton, PrimaryButton, SecondaryButton } from '../components/Form.js';
import { useToast } from '../components/Toasts.js';
import { ConfigProfileDialog } from '../pages/configurations/ConfigProfileDialog.js';
import { ApplyProfileDialog } from '../pages/configurations/ApplyProfileDialog.js';
import { countCredentialRefs, countEncrypted, countVaultRefs } from '../pages/configurations/shared.js';
import type { PageKey } from '../components/Layout.js';
import type { ConfigProfileSummary, ServerRecord } from '../../core/types.js';

interface VaultInfo {
  available: boolean;
  names: string[];
}

export interface ConfigurationsPageProps {
  onNavigate?: (page: PageKey) => void;
}

/**
 * Configurations page: reusable, gateway-managed encrypted profiles that can be
 * attached to many MCP servers. No env files — values live in the AES vault.
 */
export function ConfigurationsPage({ onNavigate }: ConfigurationsPageProps) {
  const toast = useToast();
  const profiles = useAsyncData(() => api.listConfigProfiles(), []);
  const servers = useAsyncData(() => api.listServers(), []);
  const vault = useAsyncData<VaultInfo>(async () => {
    try {
      const response = await api.listVaultSecrets();
      return {
        available: response.enabled,
        names: response.secrets.map((secret) => secret.name).sort((a, b) => a.localeCompare(b)),
      };
    } catch {
      // Vault disabled (503) or endpoint unavailable: profiles with encrypted
      // values cannot be saved, but existing vault-ref profiles still list.
      return { available: false, names: [] };
    }
  }, []);

  const [editor, setEditor] = useState<{ profile: ConfigProfileSummary | null } | null>(null);
  const [applyTarget, setApplyTarget] = useState<ConfigProfileSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConfigProfileSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const profileList = profiles.status === 'ready' ? profiles.data : [];
  const serverList: ServerRecord[] = servers.status === 'ready' ? servers.data : [];
  const secretNames = vault.status === 'ready' ? vault.data.names : [];
  const vaultAvailable = vault.status === 'ready' ? vault.data.available : false;

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setActionError(null);
    try {
      await api.deleteConfigProfile(deleteTarget.id);
      toast('success', `Deleted configuration profile “${deleteTarget.name}”.`);
      setDeleteTarget(null);
      profiles.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-100">Configuration profiles</h2>
          <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
            Save API keys, database strings and IP/port settings once — encrypted in the gateway vault — then apply
            one profile to many MCP servers. Credentials never live in plaintext files or reach the model context.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SecondaryButton onClick={() => onNavigate?.('vault')} className="px-2 py-1 text-xs">
            Vault secrets
          </SecondaryButton>
          <PrimaryButton onClick={() => setEditor({ profile: null })} className="px-3 py-1.5 text-xs">
            New profile
          </PrimaryButton>
        </div>
      </div>

      {actionError !== null && (
        <Notice tone="error" title="Configuration request failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Notice>
      )}
      {!vaultAvailable && vault.status === 'ready' && (
        <Notice tone="warning" title="Vault is not configured">
          Encrypted profile values require <code className="font-mono">MCP_VAULT_SECRET</code>. Existing vault-ref
          entries still work, but saving new encrypted values will fail until the vault is enabled.
        </Notice>
      )}

      <Card
        title="Profiles"
        subtitle={`${profileList.length} encrypted configuration profile${profileList.length === 1 ? '' : 's'}`}
        actions={<GhostButton onClick={profiles.reload}>Refresh</GhostButton>}
        padded={profileList.length === 0}
      >
        {profiles.status === 'loading' && (
          <div className="p-4">
            <SkeletonCards count={3} />
          </div>
        )}
        {profiles.status === 'error' && (
          <div className="p-4">
            <ErrorState message={profiles.error} onRetry={profiles.reload} />
          </div>
        )}
        {profiles.status === 'ready' &&
          (profileList.length === 0 ? (
            <EmptyState
              icon="⚙"
              title="No configuration profiles yet"
              description="Create a profile to store shared configuration once — an n8n URL, an API key, a database URL or an IP/port pair — encrypted in the gateway vault. Attach it to any number of MCP servers; values are injected at start and never shown again."
              action={
                <PrimaryButton onClick={() => setEditor({ profile: null })} className="px-3 py-1.5 text-xs">
                  Create profile
                </PrimaryButton>
              }
            />
          ) : (
            <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
              {profileList.map((profile) => {
                const encrypted = countEncrypted(profile.entries);
                const vaultRefs = countVaultRefs(profile.entries);
                const credentialRefs = countCredentialRefs(profile.entries);
                const headerVaultRefs = countVaultRefs(profile.headers);
                return (
                  <article
                    key={profile.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-4 shadow-lg shadow-black/10"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="truncate text-sm font-semibold text-slate-100">{profile.name}</p>
                        <Badge tone={profile.attachedServerIds.length > 0 ? 'success' : 'neutral'}>
                          {profile.attachedServerIds.length} attached
                        </Badge>
                      </div>
                      <p className="mt-0.5 font-mono text-[10px] text-slate-500">{profile.id}</p>
                      {profile.description !== null && (
                        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">{profile.description}</p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Badge tone="neutral">{profile.entries.length} env</Badge>
                        {encrypted > 0 && <Badge tone="warning">{encrypted} encrypted</Badge>}
                        {vaultRefs > 0 && <Badge tone="accent">{vaultRefs} vault ref</Badge>}
                        {credentialRefs > 0 && <Badge tone="info">{credentialRefs} password-manager</Badge>}
                        {profile.headers.length > 0 && (
                          <Badge tone="info">
                            {profile.headers.length} header{profile.headers.length === 1 ? '' : 's'}
                            {headerVaultRefs > 0 ? ` · ${headerVaultRefs} vault` : ''}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-2.5">
                      <span className="text-[11px] text-slate-500">
                        updated {formatTimestamp(profile.updatedAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        <GhostButton onClick={() => setEditor({ profile })}>Edit</GhostButton>
                        <GhostButton onClick={() => setApplyTarget(profile)}>Apply</GhostButton>
                        <DangerButton
                          onClick={() => setDeleteTarget(profile)}
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

      {editor !== null && (
        <ConfigProfileDialog
          profile={editor.profile}
          vaultSecrets={secretNames}
          vaultAvailable={vaultAvailable}
          onClose={() => setEditor(null)}
          onSaved={() => profiles.reload()}
        />
      )}

      {applyTarget !== null && (
        <ApplyProfileDialog
          profile={applyTarget}
          servers={serverList}
          onClose={() => setApplyTarget(null)}
          onApplied={() => {
            profiles.reload();
            servers.reload();
          }}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete configuration profile"
        description={
          deleteTarget !== null
            ? `Delete “${deleteTarget.name}”? Servers keep their own env/headers, but this profile's encrypted values are removed and it is detached from ${deleteTarget.attachedServerIds.length} server${deleteTarget.attachedServerIds.length === 1 ? '' : 's'}.`
            : undefined
        }
        tone="danger"
        confirmLabel="Delete profile"
        busy={deleteBusy}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
