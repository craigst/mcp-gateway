import { useState } from 'react';
import { api, formatApiError } from '../../lib/api.js';
import { Field, PrimaryButton, Select, TextArea, TextInput, CheckboxField } from '../../components/Form.js';
import { Notice } from '../../components/States.js';
import { useToast } from '../../components/Toasts.js';
import { parseEnvJson, splitList } from './shared.js';
import type { RuntimeKind, TransportKind } from '../../../core/types.js';

const RUNTIMES: readonly RuntimeKind[] = ['node', 'python', 'binary', 'remote-agent'];
const TRANSPORTS: readonly TransportKind[] = ['stdio', 'http', 'sse', 'websocket'];

interface RegisterFormState {
  name: string;
  runtime: RuntimeKind;
  transport: TransportKind;
  command: string;
  args: string;
  url: string;
  env: string;
  highPrivilegeTools: string;
  delegationSupported: boolean;
}

const EMPTY_REGISTER: RegisterFormState = {
  name: '',
  runtime: 'node',
  transport: 'stdio',
  command: '',
  args: '',
  url: '',
  env: '',
  highPrivilegeTools: '',
  delegationSupported: false,
};

export interface RegisterServerCardProps {
  onRegistered: () => void;
}

/** Manual, manifest-free sub-server registration (advanced / escape hatch). */
export function RegisterServerCard({ onRegistered }: RegisterServerCardProps) {
  const toast = useToast();
  const [form, setForm] = useState<RegisterFormState>(EMPTY_REGISTER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = <K extends keyof RegisterFormState>(key: K, value: RegisterFormState[K]): void => {
    setForm((previous) => ({ ...previous, [key]: value }));
  };

  const submit = async (): Promise<void> => {
    setError(null);
    const name = form.name.trim();
    if (name === '') {
      setError('Name is required');
      return;
    }
    if (form.transport === 'stdio' && form.command.trim() === '') {
      setError('Command is required for stdio transport');
      return;
    }
    if (form.transport !== 'stdio' && form.url.trim() === '') {
      setError('URL is required for http/sse/websocket transports');
      return;
    }
    let env: Record<string, string>;
    try {
      env = parseEnvJson(form.env);
    } catch (parseError) {
      setError(`Invalid env JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return;
    }
    setBusy(true);
    try {
      await api.registerServer({
        name,
        runtime: form.runtime,
        transport: form.transport,
        command: form.command.trim() === '' ? null : form.command.trim(),
        args: splitList(form.args),
        url: form.url.trim() === '' ? null : form.url.trim(),
        env,
        highPrivilegeTools: splitList(form.highPrivilegeTools),
        delegationSupported: form.delegationSupported,
      });
      setForm(EMPTY_REGISTER);
      toast('success', `Registered sub-server “${name}”.`);
      onRegistered();
    } catch (submitError) {
      setError(formatApiError(submitError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-xl border border-slate-800 bg-slate-900/40">
      <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-300">
        Register a sub-server manually
        <span className="ml-2 font-normal normal-case tracking-normal text-slate-500">
          (no manifest required — for local binaries and remote URLs)
        </span>
      </summary>
      <div className="space-y-3 border-t border-slate-800 px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name">
            <TextInput value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="postgres" />
          </Field>
          <Field label="High-privilege tools" hint="comma or space separated">
            <TextInput
              value={form.highPrivilegeTools}
              onChange={(event) => update('highPrivilegeTools', event.target.value)}
              placeholder="danger_delete drop_table"
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Runtime">
            <Select value={form.runtime} onChange={(event) => update('runtime', event.target.value as RuntimeKind)}>
              {RUNTIMES.map((runtime) => (
                <option key={runtime} value={runtime}>
                  {runtime}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Transport">
            <Select
              value={form.transport}
              onChange={(event) => update('transport', event.target.value as TransportKind)}
            >
              {TRANSPORTS.map((transport) => (
                <option key={transport} value={transport}>
                  {transport}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Command" hint="required for stdio">
            <TextInput value={form.command} onChange={(event) => update('command', event.target.value)} placeholder="node" />
          </Field>
          <Field label="Arguments" hint="space separated">
            <TextInput
              value={form.args}
              onChange={(event) => update('args', event.target.value)}
              placeholder="./server.mjs --port 9000"
            />
          </Field>
        </div>
        <Field label="Remote URL" hint="http / sse / websocket transports">
          <TextInput
            value={form.url}
            onChange={(event) => update('url', event.target.value)}
            placeholder="https://mcp.example.dev/sse"
          />
        </Field>
        <Field label="Environment (JSON object)" hint="values may reference vault secret names">
          <TextArea
            rows={3}
            value={form.env}
            onChange={(event) => update('env', event.target.value)}
            placeholder='{"GITHUB_PAT_TOKEN": "GITHUB_PAT"}'
          />
        </Field>
        <CheckboxField
          label="Delegation supported (expose this sub-server to sub-agent delegation)"
          checked={form.delegationSupported}
          onChange={(checked) => update('delegationSupported', checked)}
        />
        {error !== null && <Notice tone="error" onDismiss={() => setError(null)}>{error}</Notice>}
        <PrimaryButton onClick={() => void submit()} disabled={busy}>
          {busy ? 'Registering…' : 'Register server'}
        </PrimaryButton>
      </div>
    </details>
  );
}
