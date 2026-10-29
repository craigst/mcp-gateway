import { useCallback, useEffect, useState } from 'react';
import { Layout } from './components/Layout.js';
import type { PageKey } from './components/Layout.js';
import { DashboardPage } from './pages/Dashboard.js';
import { CatalogPage } from './pages/Catalog.js';
import { RbacPage } from './pages/Rbac.js';
import { VaultPage } from './pages/Vault.js';
import { AuditPage } from './pages/Audit.js';
import { DelegationPage } from './pages/Delegation.js';
import { PlaygroundPage } from './pages/Playground.js';

const PAGE_KEYS: readonly string[] = [
  'dashboard',
  'catalog',
  'rbac',
  'vault',
  'audit',
  'delegation',
  'playground',
];

function isPageKey(value: string): value is PageKey {
  return PAGE_KEYS.includes(value);
}

function pageFromHash(): PageKey {
  if (typeof window === 'undefined') return 'dashboard';
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  return isPageKey(raw) ? raw : 'dashboard';
}

function renderPage(page: PageKey, navigate: (next: PageKey) => void) {
  switch (page) {
    case 'catalog':
      return <CatalogPage />;
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
      return <DashboardPage onNavigate={navigate} />;
  }
}

/**
 * Console shell. Navigation is state based (no router dependency) and mirrors
 * the SPA routes documented in API.md §5 via the URL hash.
 */
export function App() {
  const [page, setPage] = useState<PageKey>(pageFromHash);

  useEffect(() => {
    const onHashChange = (): void => setPage(pageFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next: PageKey) => {
    setPage(next);
    if (typeof window !== 'undefined') window.location.hash = `#/${next}`;
  }, []);

  return (
    <Layout current={page} onNavigate={navigate}>
      {renderPage(page, navigate)}
    </Layout>
  );
}
