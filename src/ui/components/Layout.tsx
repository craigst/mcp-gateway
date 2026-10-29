import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api.js';
import { cx } from '../lib/cx.js';

export type PageKey =
  | 'dashboard'
  | 'catalog'
  | 'configurations'
  | 'vaultwarden'
  | 'rbac'
  | 'vault'
  | 'audit'
  | 'delegation'
  | 'playground';

export interface NavItem {
  key: PageKey;
  label: string;
  icon: string;
  description: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: '◔', description: 'Live telemetry, request rate and error budget.' },
  {
    key: 'catalog',
    label: 'Catalog',
    icon: '▤',
    description: 'Browse private catalogs, install servers and import local harnesses.',
  },
  {
    key: 'configurations',
    label: 'Configurations',
    icon: '⚙',
    description: 'Reusable encrypted env/headers applied to many MCP servers.',
  },
  {
    key: 'vaultwarden',
    label: 'Vault Warden',
    icon: '◈',
    description: 'Approve agent credential requests and review vault access.',
  },
  { key: 'rbac', label: 'RBAC', icon: '⬡', description: 'Scoped API keys and per-tool access policy.' },
  { key: 'vault', label: 'Vault', icon: '▣', description: 'Encrypted secrets injected into sub-server environments.' },
  { key: 'audit', label: 'Audit', icon: '≡', description: 'Forensic search across JSON-RPC calls and denials.' },
  { key: 'delegation', label: 'Delegation', icon: '⇄', description: 'Sub-agent traces and escalation approval queue.' },
  { key: 'playground', label: 'Playground', icon: '⌘', description: 'Send signed JSON-RPC payloads and inspect latency.' },
];

type ConnectionState = 'checking' | 'online' | 'offline';

function userInitials(username: string): string {
  const trimmed = username.trim();
  if (trimmed === '') return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

export interface LayoutProps {
  current: PageKey;
  onNavigate: (page: PageKey) => void;
  /** Signed-in operator username (session login). */
  user: string;
  onSignOut: () => void;
  signingOut?: boolean;
  children: ReactNode;
}

/** Console shell: sidebar navigation, gateway health, signed-in operator. */
export function Layout({ current, onNavigate, user, onSignOut, signingOut = false, children }: LayoutProps) {
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const active = NAV_ITEMS.find((item) => item.key === current) ?? NAV_ITEMS[0];

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        await api.getHealth();
        if (!cancelled) setConnection('online');
      } catch {
        if (!cancelled) setConnection('offline');
      }
    };
    void check();
    const timer = setInterval(() => {
      void check();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const navButton = (item: NavItem, compact: boolean): ReactNode => (
    <button
      key={item.key}
      type="button"
      onClick={() => onNavigate(item.key)}
      aria-current={item.key === current ? 'page' : undefined}
      className={cx(
        'flex items-center gap-2 rounded-lg text-left text-sm font-medium transition-colors',
        compact ? 'shrink-0 px-3 py-1.5' : 'w-full px-3 py-2',
        item.key === current
          ? 'bg-slate-800 text-sky-300'
          : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
      )}
    >
      <span aria-hidden="true" className="text-xs text-slate-500">
        {item.icon}
      </span>
      {item.label}
    </button>
  );

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-800 bg-slate-950/95 md:flex">
        <div className="flex items-center gap-2.5 border-b border-slate-800 px-4 py-4">
          <span
            aria-hidden="true"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-500/15 text-base font-bold text-sky-300"
          >
            MCP
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-100">Gateway Console</p>
            <p className="text-[11px] text-slate-500">zero-trust control plane</p>
          </div>
        </div>
        <nav aria-label="Primary" className="flex-1 space-y-1 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => navButton(item, false))}
        </nav>
        <div className="space-y-2 border-t border-slate-800 px-4 py-3 text-[11px] text-slate-500">
          <p>v0.4.0 · MCP 2025-06-18</p>
          <div className="rounded-lg border border-slate-800 px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-[10px] font-bold text-sky-300"
              >
                {userInitials(user)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-200">{user}</p>
                <p className="text-[10px] text-slate-500">signed in</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              disabled={signingOut}
              className="mt-2 w-full rounded-md border border-slate-700 px-2 py-1 text-[11px] font-semibold text-slate-300 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-slate-100">{active?.label ?? 'Dashboard'}</h1>
              <p className="hidden text-xs text-slate-400 sm:block">{active?.description ?? ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-300"
                title="Gateway health probe (/mcp/v1/health)"
              >
                <span
                  aria-hidden="true"
                  className={cx(
                    'h-1.5 w-1.5 rounded-full',
                    connection === 'online'
                      ? 'bg-emerald-400'
                      : connection === 'offline'
                        ? 'bg-rose-400'
                        : 'animate-pulse bg-amber-400',
                  )}
                />
                {connection === 'online'
                  ? 'Gateway online'
                  : connection === 'offline'
                    ? 'Gateway offline'
                    : 'Checking gateway'}
              </span>
              <span className="hidden items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-slate-300 sm:inline-flex">
                signed in as <span className="font-semibold text-slate-100">{user}</span>
              </span>
              <button
                type="button"
                onClick={onSignOut}
                disabled={signingOut}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
          <nav aria-label="Primary mobile" className="flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
            {NAV_ITEMS.map((item) => navButton(item, true))}
          </nav>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>

    </div>
  );
}
