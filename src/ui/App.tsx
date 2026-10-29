import { useCallback, useEffect, useState } from 'react';
import { api } from './lib/api.js';
import type { LoginResponse, SessionUser } from './lib/api.js';
import { Layout } from './components/Layout.js';
import type { PageKey } from './components/Layout.js';
import { ToastProvider } from './components/Toasts.js';
import { LoginPage } from './pages/Login.js';
import { DashboardPage } from './pages/Dashboard.js';
import { CatalogPage } from './pages/Catalog.js';
import { ComputerUsePage } from './pages/computer-use/ComputerUsePage.js';
import { ConfigurationsPage } from './pages/Configurations.js';
import type { CatalogTab } from './pages/Catalog.js';
import { SecretsPage } from './pages/secrets/SecretsPage.js';
import { RbacPage } from './pages/Rbac.js';
import { VaultPage } from './pages/Vault.js';
import { AuditPage } from './pages/Audit.js';
import { DelegationPage } from './pages/Delegation.js';
import { PlaygroundPage } from './pages/Playground.js';
import { ServerInspectorPage } from './pages/ServerInspector.js';
import { SetupWizard } from './pages/Setup.js';
import { SettingsPage } from './pages/Settings.js';

const PAGE_KEYS: readonly string[] = [
  'dashboard',
  'catalog',
  'computer-use',
  'configurations',
  'secrets',
  'rbac',
  'vault',
  'audit',
  'delegation',
  'playground',
  'settings',
];

function isPageKey(value: string): value is PageKey {
  return PAGE_KEYS.includes(value);
}

function isCatalogTab(value: string | null): value is CatalogTab {
  return value === 'installed' || value === 'discover' || value === 'sources' || value === 'import';
}

interface HashLocation {
  page: PageKey;
  catalogTab: CatalogTab | null;
  /** Set when the hash is `#/server/<id>`. */
  serverId: string | null;
  /** Set when the hash is `#/rbac/<keyId>`. */
  keyId: string | null;
}

function locationFromHash(): HashLocation {
  if (typeof window === 'undefined') return { page: 'dashboard', catalogTab: null, serverId: null, keyId: null };
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segments = pathPart.split('/').filter((segment) => segment.length > 0);
  const tab = new URLSearchParams(queryPart).get('tab');
  if (segments[0] === 'server' && segments[1] !== undefined) {
    return {
      page: 'server',
      catalogTab: null,
      serverId: decodeURIComponent(segments[1]),
      keyId: null,
    };
  }
  // Backwards-compatible alias: the Vault Warden page is now Secrets.
  if (segments[0] === 'vaultwarden') {
    return { page: 'secrets', catalogTab: null, serverId: null, keyId: null };
  }
  if (segments[0] === 'rbac' && segments[1] !== undefined) {
    return {
      page: 'rbac',
      catalogTab: null,
      serverId: null,
      keyId: decodeURIComponent(segments[1]),
    };
  }
  const page = isPageKey(segments[0] ?? '') ? (segments[0] as PageKey) : 'dashboard';
  return { page, catalogTab: isCatalogTab(tab) ? tab : null, serverId: null, keyId: null };
}

type SessionState =
  | { status: 'loading' }
  | { status: 'setup'; restoreSupported: boolean }
  | { status: 'anonymous' }
  | { status: 'authenticated'; user: SessionUser };

interface RenderContext {
  catalogTab: CatalogTab;
  serverId: string | null;
  keyId: string | null;
  username: string;
  onCatalogTabChange: (tab: CatalogTab) => void;
  onNavigate: (page: PageKey, options?: { catalogTab?: CatalogTab }) => void;
  onOpenServer: (serverId: string) => void;
  onOpenKey: (keyId: string | null) => void;
  onReturnToLogin: () => void;
}

function renderPage(page: PageKey, context: RenderContext) {
  switch (page) {
    case 'catalog':
      return (
        <CatalogPage
          initialTab={context.catalogTab}
          onTabChange={context.onCatalogTabChange}
          onOpenServer={context.onOpenServer}
        />
      );
    case 'server':
      return context.serverId === null ? (
        <CatalogPage initialTab="installed" onTabChange={context.onCatalogTabChange} onOpenServer={context.onOpenServer} />
      ) : (
        <ServerInspectorPage
          serverId={context.serverId}
          onBack={() => context.onNavigate('catalog')}
        />
      );
    case 'configurations':
      return <ConfigurationsPage onNavigate={context.onNavigate} />;
    case 'computer-use':
      return <ComputerUsePage />;
    case 'secrets':
      return <SecretsPage onNavigate={context.onNavigate} />;
    case 'rbac':
      return <RbacPage initialKeyId={context.keyId} onKeyOpenChange={context.onOpenKey} />;
    case 'vault':
      return <VaultPage />;
    case 'audit':
      return <AuditPage onOpenServer={context.onOpenServer} />;
    case 'settings':
      return (
        <SettingsPage
          username={context.username}
          onNavigate={context.onNavigate}
          onReturnToLogin={context.onReturnToLogin}
        />
      );
    case 'delegation':
      return <DelegationPage />;
    case 'playground':
      return <PlaygroundPage />;
    case 'dashboard':
    default:
      return <DashboardPage onNavigate={context.onNavigate} />;
  }
}

function SessionSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-950 text-slate-100">
      <span
        aria-hidden="true"
        className="h-6 w-6 animate-spin rounded-full border-2 border-slate-700 border-t-sky-400"
      />
      <p role="status" className="text-sm text-slate-400">
        Checking your session…
      </p>
    </div>
  );
}

/**
 * Console shell. Authenticates against `GET /auth/me` on mount: a loading
 * splash, then the login page (anonymous) or the management shell
 * (authenticated). Any HTTP 401 from a later request returns to login.
 * Navigation is state based (no router dependency) and mirrored in the URL hash.
 */
export function App() {
  const initial = locationFromHash();
  const [session, setSession] = useState<SessionState>({ status: 'loading' });
  const [signingOut, setSigningOut] = useState(false);
  const [page, setPage] = useState<PageKey>(initial.page);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>(initial.catalogTab ?? 'installed');
  const [serverId, setServerId] = useState<string | null>(initial.serverId);
  const [keyId, setKeyId] = useState<string | null>(initial.keyId);

  useEffect(() => {
    let cancelled = false;
    api.getSession().then(
      (status) => {
        if (cancelled) return;
        setSession(
          status.authenticated && status.user !== undefined
            ? { status: 'authenticated', user: status.user }
            : status.setupRequired === true
              ? { status: 'setup', restoreSupported: status.restoreSupported === true }
              : { status: 'anonymous' },
        );
      },
      () => {
        if (!cancelled) setSession({ status: 'anonymous' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Any 401 from any request (initial load, navigation or a page fetch) drops
  // the console back to the login screen.
  useEffect(() => {
    return api.onUnauthorized(() => setSession({ status: 'anonymous' }));
  }, []);

  useEffect(() => {
    const onHashChange = (): void => {
      const next = locationFromHash();
      setPage(next.page);
      setServerId(next.serverId);
      setKeyId(next.keyId);
      if (next.catalogTab !== null) setCatalogTab(next.catalogTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: PageKey) => {
    setPage(next);
    setServerId(null);
    setKeyId(null);
    if (typeof window !== 'undefined') window.location.hash = `#/${next}`;
  }, []);

  const openServer = useCallback((id: string) => {
    setServerId(id);
    setPage('server');
    setKeyId(null);
    if (typeof window !== 'undefined') {
      window.location.hash = `#/server/${encodeURIComponent(id)}`;
    }
  }, []);

  const openKey = useCallback((id: string | null) => {
    setKeyId(id);
    setPage('rbac');
    if (typeof window !== 'undefined') {
      window.location.hash = id === null ? '#/rbac' : `#/rbac/${encodeURIComponent(id)}`;
    }
  }, []);

  const handleNavigate = useCallback((next: PageKey, options?: { catalogTab?: CatalogTab }) => {
    if (options?.catalogTab !== undefined) setCatalogTab(options.catalogTab);
    setPage(next);
    setServerId(null);
    setKeyId(null);
    if (typeof window !== 'undefined') {
      window.location.hash = options?.catalogTab
        ? `#/${next}?tab=${options.catalogTab}`
        : `#/${next}`;
    }
  }, []);

  const handleAuthenticated = useCallback((result: LoginResponse) => {
    setSession({ status: 'authenticated', user: result.user });
  }, []);

  const handleSetupComplete = useCallback((user: SessionUser) => {
    setSession({ status: 'authenticated', user });
    setPage('dashboard');
    setServerId(null);
    if (typeof window !== 'undefined') window.location.hash = '#/';
  }, []);

  const handleRestoreComplete = useCallback(() => {
    setSession({ status: 'anonymous' });
  }, []);

  const returnToLogin = useCallback(() => {
    setSession({ status: 'anonymous' });
  }, []);

  const handleSignOut = useCallback(async (): Promise<void> => {
    setSigningOut(true);
    try {
      await api.logout();
    } catch {
      // Best effort: even if the server session is already gone, drop the UI session.
    } finally {
      setSigningOut(false);
      setSession({ status: 'anonymous' });
    }
  }, []);

  if (session.status === 'loading') return <SessionSplash />;

  if (session.status === 'setup') {
    return (
      <ToastProvider>
        <SetupWizard
          restoreSupported={session.restoreSupported}
          onComplete={handleSetupComplete}
          onRestoreComplete={handleRestoreComplete}
        />
      </ToastProvider>
    );
  }

  if (session.status === 'anonymous') {
    return (
      <ToastProvider>
        <LoginPage onAuthenticated={handleAuthenticated} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <Layout
        current={page}
        onNavigate={navigate}
        user={session.user.username}
        onSignOut={() => void handleSignOut()}
        signingOut={signingOut}
      >
        {renderPage(page, {
          catalogTab,
          serverId,
          keyId,
          username: session.user.username,
          onCatalogTabChange: setCatalogTab,
          onNavigate: handleNavigate,
          onOpenServer: openServer,
          onOpenKey: openKey,
          onReturnToLogin: returnToLogin,
        })}
      </Layout>
    </ToastProvider>
  );
}
