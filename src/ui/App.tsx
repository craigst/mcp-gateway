import { useCallback, useEffect, useState } from 'react';
import { Layout } from './components/Layout.js';
import type { PageKey } from './components/Layout.js';
import { ToastProvider } from './components/Toasts.js';
import { DashboardPage } from './pages/Dashboard.js';
import { CatalogPage } from './pages/Catalog.js';
import type { CatalogTab } from './pages/Catalog.js';
import { VaultWardenPage } from './pages/VaultWarden.js';
import { RbacPage } from './pages/Rbac.js';
import { VaultPage } from './pages/Vault.js';
import { AuditPage } from './pages/Audit.js';
import { DelegationPage } from './pages/Delegation.js';
import { PlaygroundPage } from './pages/Playground.js';

const PAGE_KEYS: readonly string[] = [
  'dashboard',
  'catalog',
  'vaultwarden',
  'rbac',
  'vault',
  'audit',
  'delegation',
  'playground',
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
}

function locationFromHash(): HashLocation {
  if (typeof window === 'undefined') return { page: 'dashboard', catalogTab: null };
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const page = isPageKey(pathPart) ? pathPart : 'dashboard';
  const tab = new URLSearchParams(queryPart).get('tab');
  return { page, catalogTab: isCatalogTab(tab) ? tab : null };
}

interface RenderContext {
  catalogTab: CatalogTab;
  onCatalogTabChange: (tab: CatalogTab) => void;
  onNavigate: (page: PageKey, options?: { catalogTab?: CatalogTab }) => void;
}

function renderPage(page: PageKey, context: RenderContext) {
  switch (page) {
    case 'catalog':
      return <CatalogPage initialTab={context.catalogTab} onTabChange={context.onCatalogTabChange} />;
    case 'vaultwarden':
      return <VaultWardenPage onNavigate={context.onNavigate} />;
    case 'rbac':
      return <RbacPage />;
    case 'vault':
      return <VaultPage />;
    case 'audit':
      return <AuditPage />;
    case 'delegation':
      return <DelegationPage />;
    case 'playground':
      return <PlaygroundPage />;
    case 'dashboard':
    default:
      return <DashboardPage onNavigate={context.onNavigate} />;
  }
}

/**
 * Console shell. Navigation is state based (no router dependency) and mirrors
 * the SPA routes documented in API.md §5 via the URL hash.
 */
export function App() {
  const initial = locationFromHash();
  const [page, setPage] = useState<PageKey>(initial.page);
  const [catalogTab, setCatalogTab] = useState<CatalogTab>(initial.catalogTab ?? 'installed');

  useEffect(() => {
    const onHashChange = (): void => {
      const next = locationFromHash();
      setPage(next.page);
      if (next.catalogTab !== null) setCatalogTab(next.catalogTab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: PageKey) => {
    setPage(next);
    if (typeof window !== 'undefined') window.location.hash = `#/${next}`;
  }, []);

  const handleNavigate = useCallback((next: PageKey, options?: { catalogTab?: CatalogTab }) => {
    if (options?.catalogTab !== undefined) setCatalogTab(options.catalogTab);
    setPage(next);
    if (typeof window !== 'undefined') {
      window.location.hash = options?.catalogTab
        ? `#/${next}?tab=${options.catalogTab}`
        : `#/${next}`;
    }
  }, []);

  return (
    <ToastProvider>
      <Layout current={page} onNavigate={navigate}>
        {renderPage(page, {
          catalogTab,
          onCatalogTabChange: setCatalogTab,
          onNavigate: handleNavigate,
        })}
      </Layout>
    </ToastProvider>
  );
}
