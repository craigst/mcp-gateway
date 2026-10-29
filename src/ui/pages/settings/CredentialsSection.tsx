import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { useAsyncData } from '../../lib/hooks.js';
import { Card } from '../../components/Card.js';
import { Badge } from '../../components/Badge.js';
import type { BadgeTone } from '../../components/Badge.js';
import { ErrorState, Notice } from '../../components/States.js';
import { SkeletonCards } from '../../components/Skeleton.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Field, GhostButton, SecondaryButton, Select, TextInput } from '../../components/Form.js';
import { useToast } from '../../components/Toasts.js';
import type {
  CredentialProviderDescriptor,
  CredentialProviderId,
  CredentialProviderState,
  CredentialProviderStatus,
} from '../../../core/types.js';

const STATE_TONE: Record<CredentialProviderState, BadgeTone> = {
  connected: 'success',
  'not-configured': 'neutral',
  error: 'danger',
  unavailable: 'warning',
};

const STATE_LABEL: Record<CredentialProviderState, string> = {
  connected: 'connected',
  'not-configured': 'not configured',
  error: 'error',
  unavailable: 'unavailable',
};

export interface CredentialsSectionProps {
  /** Navigate to the Secrets page (item browser + Vault Warden panels). */
  onNavigateSecrets?: () => void;
}

/** Credential-provider configuration (Vaultwarden default, 1Password option). */
export function CredentialsSection({ onNavigateSecrets }: CredentialsSectionProps) {
  const toast = useToast();
  const providersState = useAsyncData(() => api.getCredentialProviders(), []);

  const [configureTarget, setConfigureTarget] = useState<CredentialProviderDescriptor | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [configureError, setConfigureError] = useState<string | null>(null);
  const [configureBusy, setConfigureBusy] = useState(false);
  const [clearTarget, setClearTarget] = useState<CredentialProviderStatus | null>(null);
  const [clearBusy, setClearBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const providers = providersState.status === 'ready' ? providersState.data.providers : [];
  const descriptors = providersState.status === 'ready' ? providersState.data.descriptors : [];
  const defaultProvider: CredentialProviderId | null =
    providersState.status === 'ready' ? providersState.data.defaultProvider : null;

  const descriptorFor = (id: CredentialProviderId): CredentialProviderDescriptor | null =>
    descriptors.find((descriptor) => descriptor.id === id) ?? null;

  const setDefault = async (id: CredentialProviderId): Promise<void> => {
    setDefaultBusy(true);
    setActionError(null);
    try {
      await api.setDefaultCredentialProvider(id);
      toast('success', `Default credential provider set to ${id}.`);
      providersState.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setDefaultBusy(false);
    }
  };

  const testProvider = async (provider: CredentialProviderStatus): Promise<void> => {
    setTestingId(provider.id);
    setActionError(null);
    try {
      const result = await api.testCredentialProvider(provider.id);
      toast(
        result.state === 'connected' ? 'success' : 'error',
        `${result.name}: ${result.message || result.state}`,
      );
      providersState.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setTestingId(null);
    }
  };

  const openConfigure = (descriptor: CredentialProviderDescriptor): void => {
    setFormValues({});
    setConfigureError(null);
    setConfigureTarget(descriptor);
  };

  const submitConfigure = async (): Promise<void> => {
    if (configureTarget === null) return;
    setConfigureError(null);
    const missing = configureTarget.fields.filter(
      (field) => field.required && (formValues[field.key] ?? '').trim() === '',
    );
    if (missing.length > 0) {
      setConfigureError(`Required: ${missing.map((field) => field.label).join(', ')}.`);
      return;
    }
    setConfigureBusy(true);
    try {
      await api.configureCredentialProvider(configureTarget.id, formValues);
      toast('success', `${configureTarget.name} configured.`);
      setConfigureTarget(null);
      providersState.reload();
    } catch (error) {
      setConfigureError(formatApiError(error));
    } finally {
      setConfigureBusy(false);
    }
  };

  const confirmClear = async (): Promise<void> => {
    if (clearTarget === null) return;
    setClearBusy(true);
    setActionError(null);
    try {
      await api.clearCredentialProvider(clearTarget.id);
      toast('success', `${clearTarget.name} configuration cleared.`);
      setClearTarget(null);
      providersState.reload();
    } catch (error) {
      setActionError(formatApiError(error));
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <Card
      title="Credentials"
      subtitle="Choose where the gateway resolves credentials from. Vaultwarden is the default password/API manager; 1Password is an alternative."
      actions={<GhostButton onClick={providersState.reload}>Refresh</GhostButton>}
    >
      <div className="space-y-4">
        {providersState.status === 'loading' && <SkeletonCards count={3} />}
        {providersState.status === 'error' && (
          <ErrorState message={providersState.error} onRetry={providersState.reload} />
        )}
        {actionError !== null && (
          <Notice tone="error" title="Credential provider action failed" onDismiss={() => setActionError(null)}>
            {actionError}
          </Notice>
        )}

        {providersState.status === 'ready' && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field
                label="Default provider"
                hint="Used by the Secrets page and by configuration profiles that do not name a provider."
                className="w-full sm:w-72"
              >
                <Select
                  value={defaultProvider ?? ''}
                  onChange={(event) => {
                    if (event.target.value !== '') void setDefault(event.target.value as CredentialProviderId);
                  }}
                  disabled={defaultBusy}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                      {provider.isDefault ? ' (default)' : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              {onNavigateSecrets !== undefined && (
                <SecondaryButton onClick={onNavigateSecrets} className="px-3 py-1.5 text-xs">
                  Open Secrets →
                </SecondaryButton>
              )}
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              {providers.map((provider) => {
                const descriptor = descriptorFor(provider.id);
                const builtin = provider.kind === 'builtin';
                return (
                  <article
                    key={provider.id}
                    className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-4"
                  >
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-100">{provider.name}</p>
                          <p className="font-mono text-[10px] text-slate-500">{provider.id}</p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {builtin && <Badge tone="info">built-in</Badge>}
                          {provider.isDefault && <Badge tone="accent">default</Badge>}
                          <Badge tone={STATE_TONE[provider.state]}>{STATE_LABEL[provider.state]}</Badge>
                        </div>
                      </div>

                      {provider.id === 'vaultwarden' && (
                        <p className="text-[11px] leading-relaxed text-slate-400">
                          Default password/API manager. Stores item aliases used by Vault Warden credential delivery;
                          configure its host URL and API token here, then browse items in Secrets.
                        </p>
                      )}
                      {provider.id === 'onepassword' && (
                        <p className="text-[11px] leading-relaxed text-slate-400">
                          Optional 1Password provider. Connect through a 1Password Connect host plus a
                          service-account token or API key; items become available as credential references.
                        </p>
                      )}
                      {provider.id === 'gateway' && (
                        <p className="text-[11px] leading-relaxed text-slate-400">
                          Built-in AES-256-GCM vault. Always available locally; manage the underlying secrets from the
                          Vault page.
                        </p>
                      )}

                      {provider.message !== '' && (
                        <p className="text-[11px] text-slate-500">{provider.message}</p>
                      )}
                      {descriptor !== null && (
                        <p className="text-[10px] text-slate-600">{descriptor.docsHint}</p>
                      )}
                      {provider.id === 'vaultwarden' && onNavigateSecrets !== undefined && (
                        <GhostButton onClick={onNavigateSecrets}>Open Secrets →</GhostButton>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-slate-800 pt-2.5">
                      {descriptor !== null && descriptor.fields.length > 0 && (
                        <GhostButton onClick={() => openConfigure(descriptor)}>Configure</GhostButton>
                      )}
                      <GhostButton
                        onClick={() => void testProvider(provider)}
                        disabled={testingId !== null || !provider.configured}
                      >
                        {testingId === provider.id ? 'Testing…' : 'Test'}
                      </GhostButton>
                      {provider.configured && (
                        <GhostButton
                          onClick={() => setClearTarget(provider)}
                          disabled={clearBusy || provider.isDefault}
                          title={provider.isDefault ? 'Choose another default before clearing' : undefined}
                        >
                          Clear
                        </GhostButton>
                      )}
                      {!provider.isDefault && (
                        <GhostButton onClick={() => void setDefault(provider.id)} disabled={defaultBusy}>
                          Set as default
                        </GhostButton>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>

      {configureTarget !== null && (
        <ConfirmDialog
          open
          title={`Configure ${configureTarget.name}`}
          description={`${configureTarget.description} Values are encrypted into the gateway vault and never displayed again.`}
          confirmLabel="Save provider"
          busy={configureBusy}
          onConfirm={() => void submitConfigure()}
          onCancel={() => setConfigureTarget(null)}
        >
          <div className="space-y-3">
            {configureTarget.fields.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint ?? (field.secret ? 'write-only' : undefined)}>
                <TextInput
                  type={field.secret ? 'password' : 'text'}
                  value={formValues[field.key] ?? ''}
                  onChange={(event) =>
                    setFormValues((previous) => ({ ...previous, [field.key]: event.target.value }))
                  }
                  placeholder={field.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            ))}
            <p className="text-[11px] text-slate-500">
              Secrets are stored encrypted; only non-secret values may be echoed back in provider status.
            </p>
            {configureError !== null && (
              <Notice tone="error" title="Could not save provider" onDismiss={() => setConfigureError(null)}>
                {configureError}
              </Notice>
            )}
          </div>
        </ConfirmDialog>
      )}

      <ConfirmDialog
        open={clearTarget !== null}
        title="Clear provider configuration"
        tone="danger"
        confirmLabel="Clear configuration"
        busy={clearBusy}
        onConfirm={() => void confirmClear()}
        onCancel={() => setClearTarget(null)}
        description={
          clearTarget !== null
            ? `Remove the stored configuration for ${clearTarget.name}? Credential references that depend on it stop resolving until it is configured again.`
            : undefined
        }
      />
    </Card>
  );
}
