import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, formatApiError } from '../lib/api.js';
import type { LoginResponse } from '../lib/api.js';
import { useAsyncData } from '../lib/hooks.js';
import { Field, PrimaryButton, TextInput } from '../components/Form.js';
import { Notice } from '../components/States.js';
import { cx } from '../lib/cx.js';

export interface LoginPageProps {
  /** Called with the authenticated session once the gateway sets the cookie. */
  onAuthenticated: (session: LoginResponse) => void;
}

/**
 * Credential login for the console. The gateway responds with an HttpOnly
 * `mcp_session` cookie; no API key is ever stored in the browser.
 */
export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const health = useAsyncData(() => api.getHealth(), []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const name = username.trim();
    if (name === '' || password === '') {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(name, password);
      onAuthenticated(session);
    } catch (loginError) {
      if (loginError instanceof ApiError && loginError.status === 401) {
        setError('Invalid username or password.');
      } else {
        setError(formatApiError(loginError));
      }
    } finally {
      setBusy(false);
    }
  };

  const gatewayLabel =
    health.status === 'ready'
      ? `Gateway online · v${health.data.version}`
      : health.status === 'loading'
        ? 'Checking gateway…'
        : 'Gateway unreachable';

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-sky-500/15 text-base font-bold text-sky-300"
          >
            MCP
          </span>
          <h1 className="mt-4 text-xl font-semibold text-slate-100">Gateway Console</h1>
          <p className="mt-1 text-xs text-slate-400">
            Sign in to manage servers, keys, approvals and vault access.
          </p>
        </div>

        <form
          onSubmit={(event) => void submit(event)}
          aria-label="Sign in"
          className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/30"
        >
          <Field label="Username">
            <TextInput
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="operator"
              autoComplete="username"
              autoFocus
              spellCheck={false}
              disabled={busy}
            />
          </Field>

          <Field label="Password">
            <div className="relative">
              <TextInput
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                disabled={busy}
                className="pr-16"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-1.5 my-auto h-7 rounded-md px-2 text-[11px] font-semibold text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>

          {error !== null && (
            <Notice tone="error" title="Sign-in failed">
              {error}
            </Notice>
          )}

          <PrimaryButton type="submit" disabled={busy} className="w-full justify-center">
            {busy ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </PrimaryButton>

          <p className="text-center text-[11px] leading-relaxed text-slate-500">
            The console signs in with a secure HttpOnly session cookie. API keys are for AI / external clients
            only.
          </p>
        </form>

        <footer
          className="flex items-center justify-center gap-2 text-[11px] text-slate-500"
          title="Gateway health probe (/mcp/v1/health)"
        >
          <span
            aria-hidden="true"
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              health.status === 'ready'
                ? 'bg-emerald-400'
                : health.status === 'loading'
                  ? 'animate-pulse bg-amber-400'
                  : 'bg-rose-400',
            )}
          />
          {gatewayLabel}
        </footer>
      </div>
    </div>
  );
}
