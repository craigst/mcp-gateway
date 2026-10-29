import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CheckboxField, Field, TextInput } from '../../components/Form.js';
import { Notice } from '../../components/States.js';
import type { ComputerUseSettingsInfo, ComputerUseSettingsInput } from '../../../core/types.js';

export interface SettingsDialogProps {
  open: boolean;
  /** Current non-secret connection settings; `null` while the overview is loading. */
  info: ComputerUseSettingsInfo | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (input: ComputerUseSettingsInput) => void;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Broker connection form. The bearer token is write-only: it is only included
 * in the payload when the operator types a new one, and "remove stored token"
 * sends an empty string so the gateway clears the vault entry.
 */
export function SettingsDialog({ open, info, busy, error, onCancel, onSubmit }: SettingsDialogProps) {
  const [brokerUrl, setBrokerUrl] = useState('');
  const [publicBrokerUrl, setPublicBrokerUrl] = useState('');
  const [caFile, setCaFile] = useState('');
  const [token, setToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [clearToken, setClearToken] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setBrokerUrl(info?.brokerUrl ?? '');
    setPublicBrokerUrl(info?.publicBrokerUrl ?? '');
    setCaFile(info?.caFile ?? '');
    setToken('');
    setEnabled(info?.enabled ?? true);
    setClearToken(false);
    setValidationError(null);
  }, [open, info]);

  const submit = (): void => {
    const nextBrokerUrl = emptyToNull(brokerUrl);
    const nextPublicUrl = emptyToNull(publicBrokerUrl);
    if (nextBrokerUrl !== null && !isHttpUrl(nextBrokerUrl)) {
      setValidationError('The broker URL must be an http(s) URL, e.g. https://127.0.0.1:7443.');
      return;
    }
    if (nextPublicUrl !== null && !isHttpUrl(nextPublicUrl)) {
      setValidationError('The public broker URL must be an http(s) URL.');
      return;
    }
    setValidationError(null);
    const input: ComputerUseSettingsInput = {
      brokerUrl: nextBrokerUrl,
      publicBrokerUrl: nextPublicUrl,
      caFile: emptyToNull(caFile),
      enabled,
    };
    if (clearToken) input.token = '';
    else if (token.trim() !== '') input.token = token;
    onSubmit(input);
  };

  return (
    <ConfirmDialog
      open={open}
      title="Computer use settings"
      size="lg"
      confirmLabel="Save settings"
      busy={busy}
      onConfirm={submit}
      onCancel={onCancel}
      description="Point the gateway at your self-hosted Computer Broker. Values are stored by the gateway, not in this browser."
    >
      <div className="space-y-4">
        {(validationError ?? error) !== null && (
          <Notice tone="error" title="Could not save settings">
            {validationError ?? error}
          </Notice>
        )}
        <Notice tone="info" title="Token stays server-side">
          The broker token is write-only and stored in the encrypted vault. It is never returned to this console.
        </Notice>
        <Field
          label="Broker URL"
          hint="Server-side base URL the gateway calls, e.g. https://127.0.0.1:7443. Leave empty to disable the integration."
        >
          <TextInput
            type="url"
            value={brokerUrl}
            onChange={(event) => setBrokerUrl(event.target.value)}
            placeholder="https://127.0.0.1:7443"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Public broker URL"
          hint="Browser-facing URL used by Open live desktop links. Defaults to the broker URL."
        >
          <TextInput
            type="url"
            value={publicBrokerUrl}
            onChange={(event) => setPublicBrokerUrl(event.target.value)}
            placeholder="https://broker.example.lan"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label="CA bundle path (optional)"
          hint="Path to a PEM CA bundle on the gateway host when the broker uses a self-signed certificate."
        >
          <TextInput
            type="text"
            value={caFile}
            onChange={(event) => setCaFile(event.target.value)}
            placeholder="/etc/mcp-gateway/computer-broker-ca.pem"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <Field
          label={info?.tokenConfigured === true ? 'Replace broker token (optional)' : 'Broker token (optional)'}
          hint={
            info?.tokenConfigured === true
              ? `A token is already configured${info.tokenSource === null ? '' : ` (${info.tokenSource})`}. Leave empty to keep it.`
              : 'Leave empty when the broker does not require a bearer token.'
          }
        >
          <TextInput
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={info?.tokenConfigured === true ? '••••••••••••' : 'Paste the broker bearer token'}
            autoComplete="new-password"
            disabled={clearToken}
          />
        </Field>
        {info?.tokenConfigured === true && (
          <CheckboxField
            label="Remove the stored broker token"
            checked={clearToken}
            onChange={setClearToken}
          />
        )}
        <CheckboxField
          label="Enable computer use (register the managed computer-use MCP server)"
          checked={enabled}
          onChange={setEnabled}
        />
      </div>
    </ConfirmDialog>
  );
}
