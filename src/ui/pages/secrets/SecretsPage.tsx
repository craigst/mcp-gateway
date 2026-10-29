import { useState } from 'react';
import { VaultWardenPage } from '../VaultWarden.js';
import { CredentialBrowser } from './CredentialBrowser.js';
import type { PageKey } from '../../components/Layout.js';
import type { CredentialProviderId } from '../../../core/types.js';

export interface SecretsPageProps {
  onNavigate?: (page: PageKey) => void;
}

/**
 * Secrets page: password-manager item browser (Vaultwarden default, 1Password
 * alternative, built-in gateway vault) plus the Vault Warden approval panels.
 */
export function SecretsPage({ onNavigate }: SecretsPageProps) {
  const [activeProvider, setActiveProvider] = useState<CredentialProviderId | null>(null);

  return (
    <div className="space-y-5">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-slate-100">Secrets</h2>
        <p className="mt-0.5 max-w-3xl text-xs leading-relaxed text-slate-400">
          Browse and reveal items from the configured password manager (Vaultwarden by default, 1Password optional)
          or the built-in gateway vault. Reveals are audited. Vault Warden approvals and access history stay below
          the browser.
        </p>
      </div>

      <CredentialBrowser
        activeProvider={activeProvider}
        onActiveProviderChange={setActiveProvider}
        onNavigateSettings={() => onNavigate?.('settings')}
      />

      {activeProvider === 'vaultwarden' && (
        <section aria-label="Vault Warden protections">
          <VaultWardenPage onNavigate={onNavigate} />
        </section>
      )}
    </div>
  );
}
