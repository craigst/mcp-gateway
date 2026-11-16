import type { PageKey } from '../lib/routes.js';

const SETTINGS_LINKS: readonly { page: PageKey; label: string }[] = [
  { page: 'settings', label: 'Account & system' },
  { page: 'configurations', label: 'Server profiles' },
  { page: 'secrets', label: 'Password managers' },
  { page: 'vault', label: 'Vault secrets' },
  { page: 'rbac', label: 'API keys & access' },
  { page: 'playground', label: 'Playground' },
];
const ACTIVITY_LINKS: readonly { page: PageKey; label: string }[] = [
  { page: 'audit', label: 'Activity log' },
  { page: 'delegation', label: 'Approvals' },
];

/** Related tools share one clearly labelled navigation, while old links remain valid. */
export function SectionNav({ current, section, onNavigate }: {
  current: PageKey; section: 'settings' | 'activity'; onNavigate: (page: PageKey) => void;
}) {
  const links = section === 'settings' ? SETTINGS_LINKS : ACTIVITY_LINKS;
  return <nav aria-label={section === 'settings' ? 'Settings sections' : 'Activity sections'} className="section-nav">
    {links.map(({ page, label }) => <button key={page} type="button" aria-current={current === page ? 'page' : undefined} onClick={() => onNavigate(page)}>{label}</button>)}
  </nav>;
}
