// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getEmailAccess: vi.fn(),
    updateEmailKeyAccess: vi.fn(),
    // Used by the EmailPage integration cases.
    listEmailAccounts: vi.fn(),
    testEmailAccount: vi.fn(),
    listEmailFolders: vi.fn(),
    listEmailMessages: vi.fn(),
  },
}));

vi.mock('../../src/ui/lib/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/lib/api.js')>();
  return { ...actual, api: apiMock };
});

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EmailAccessDialog } from '../../src/ui/pages/email/EmailAccessDialog.js';
import type { EmailAccessDialogProps } from '../../src/ui/pages/email/EmailAccessDialog.js';
import { EmailPage } from '../../src/ui/pages/Email.js';
import type {
  EmailAccessAccount,
  EmailAccessOverview,
  EmailAccessSubject,
  EmailAccount,
} from '../../src/email/types.js';

const ACCOUNTS: EmailAccessAccount[] = [
  { id: 'acc_inbox', name: 'Inbox', email: 'ops@example.com', isDefault: true, enabled: true },
  { id: 'acc_sales', name: 'Sales', email: 'sales@example.com', isDefault: false, enabled: true },
];

const BOT_BASE: EmailAccessSubject = {
  id: 'bot:cleo',
  kind: 'bot',
  name: 'Cleo',
  title: 'Chief of staff',
  slug: 'cleo',
  botId: 'bot-cleo',
  keyId: 'key_cleo',
  keyName: 'omb-cleo',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_cleo',
  emailGranted: true,
  emailPaused: false,
  emailEnabled: true,
  grantedToolCount: 12,
  totalToolCount: 12,
  lastUsedAt: '2026-11-05T10:00:00.000Z',
  revoked: false,
  locked: false,
  accounts: {},
};

const KEY_BASE: EmailAccessSubject = {
  id: 'key:ops',
  kind: 'key',
  name: 'ops-key',
  title: null,
  slug: null,
  botId: null,
  keyId: 'key_ops',
  keyName: 'ops-key',
  keyType: 'agent',
  keyPrefix: 'mcp_ops_',
  emailGranted: true,
  emailPaused: false,
  emailEnabled: true,
  grantedToolCount: 6,
  totalToolCount: 12,
  lastUsedAt: '2026-11-04T09:00:00.000Z',
  revoked: false,
  locked: false,
  accounts: { acc_sales: false },
};

const bot = (overrides: Partial<EmailAccessSubject>): EmailAccessSubject => ({ ...BOT_BASE, ...overrides });
const key = (overrides: Partial<EmailAccessSubject>): EmailAccessSubject => ({ ...KEY_BASE, ...overrides });

const BOTS: EmailAccessSubject[] = [
  BOT_BASE,
  bot({
    id: 'bot:scout',
    name: 'Scout',
    title: null,
    slug: 'scout',
    botId: 'bot-scout',
    keyId: null,
    keyName: null,
    keyType: null,
    keyPrefix: null,
    emailGranted: false,
    emailEnabled: false,
    grantedToolCount: 0,
    lastUsedAt: null,
  }),
  bot({
    id: 'bot:paused',
    name: 'Paused bot',
    title: null,
    slug: 'paused',
    botId: 'bot-paused',
    keyId: 'key_paused',
    keyName: 'omb-paused',
    keyPrefix: 'mcp_ag_paused',
    emailGranted: true,
    emailPaused: true,
    emailEnabled: false,
    grantedToolCount: 0,
  }),
];

const KEYS: EmailAccessSubject[] = [
  KEY_BASE,
  key({
    id: 'key:master',
    name: 'master-key',
    keyId: 'key_master',
    keyName: 'master-key',
    keyType: 'master',
    keyPrefix: 'mcp_master_',
    grantedToolCount: 12,
    accounts: {},
    locked: true,
  }),
  key({
    id: 'key:revoked',
    name: 'retired-key',
    keyId: 'key_revoked',
    keyName: 'retired-key',
    keyPrefix: 'mcp_retired_',
    emailEnabled: false,
    grantedToolCount: 0,
    accounts: {},
    revoked: true,
  }),
];

const OVERVIEW: EmailAccessOverview = {
  server: {
    id: 'srv_email',
    name: 'email',
    status: 'running',
    toolCount: 12,
    highPrivilegeTools: ['send_email'],
  },
  accounts: ACCOUNTS,
  bots: BOTS,
  keys: KEYS,
  generatedAt: '2026-11-06T09:30:00.000Z',
};

const UPDATE_RESULT = {
  key: {
    id: 'key_cleo',
    name: 'omb-cleo',
    emailGranted: true,
    emailPaused: false,
    emailEnabled: false,
    accounts: {},
  },
};

const ACCOUNT: EmailAccount = {
  id: 'acc_inbox',
  name: 'Inbox',
  email: 'ops@example.com',
  displayName: 'Ops inbox',
  kind: 'imap',
  enabled: true,
  isDefault: true,
  imapHost: 'imap.example.com',
  imapPort: 993,
  imapSecure: true,
  imapStartTls: false,
  imapUser: 'ops@example.com',
  smtpHost: 'smtp.example.com',
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: 'ops@example.com',
  fromAddress: 'ops@example.com',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  lastTestAt: '2026-11-05T08:00:00.000Z',
  lastTestOk: true,
  lastError: null,
};

beforeEach(() => {
  apiMock.getEmailAccess.mockResolvedValue(OVERVIEW);
  apiMock.updateEmailKeyAccess.mockResolvedValue(UPDATE_RESULT);
  apiMock.listEmailAccounts.mockResolvedValue([ACCOUNT]);
  apiMock.testEmailAccount.mockResolvedValue({
    accountId: 'acc_inbox',
    ok: true,
    folders: 2,
    latencyMs: 12,
    checkedAt: '2026-11-06T09:00:00.000Z',
    error: null,
  });
  apiMock.listEmailFolders.mockResolvedValue([
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', delimiter: '/', subscribed: true },
  ]);
  apiMock.listEmailMessages.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(
  overrides: Partial<EmailAccessDialogProps> = {},
  overview: EmailAccessOverview | null = OVERVIEW,
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <EmailAccessDialog
      open
      onClose={onClose}
      overview={overview}
      loading={false}
      error={null}
      onRefresh={onRefresh}
      focusAccountId={null}
      {...overrides}
    />,
  );
  return { onRefresh, onClose };
}

function switchFor(name: string): HTMLButtonElement {
  return screen.getByRole('switch', { name }) as HTMLButtonElement;
}

describe('Email access dialog', () => {
  it('lists bots and API keys with status badges and server summary', async () => {
    renderDialog();

    expect(screen.getByRole('dialog', { name: 'Email access' })).toBeTruthy();
    expect(screen.getByText(/running · 12 tools/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Bots/ })).toBeTruthy();
    expect(screen.getByText('Cleo')).toBeTruthy();
    expect(screen.getByText('Scout')).toBeTruthy();
    expect(screen.getAllByText('No gateway key').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Full access').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));

    expect(await screen.findByText('ops-key')).toBeTruthy();
    expect(screen.getByText('master-key')).toBeTruthy();
    expect(screen.getByText('retired-key')).toBeTruthy();
    expect(screen.getAllByText('Revoked').length).toBeGreaterThan(0);
    expect(screen.getByText('Master key')).toBeTruthy();
    expect(apiMock.updateEmailKeyAccess).not.toHaveBeenCalled();
  });

  it('toggles the master email switch and refetches the overview', async () => {
    const { onRefresh } = renderDialog();

    const master = switchFor('Email access for Cleo');
    expect(master.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(master);

    await waitFor(() =>
      expect(apiMock.updateEmailKeyAccess).toHaveBeenCalledWith('key_cleo', { enabled: false }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('toggles a mailbox and sends the explicit account decision', async () => {
    const { onRefresh } = renderDialog();

    fireEvent.click(switchFor('Sales mailbox for Cleo'));

    await waitFor(() =>
      expect(apiMock.updateEmailKeyAccess).toHaveBeenCalledWith('key_cleo', {
        accounts: { acc_sales: false },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
  });

  it('re-enables an explicitly denied mailbox for a plain API key', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));

    const sales = await screen.findByRole('switch', { name: 'Sales mailbox for ops-key' });
    expect(sales.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sales);

    await waitFor(() =>
      expect(apiMock.updateEmailKeyAccess).toHaveBeenCalledWith('key_ops', {
        accounts: { acc_sales: true },
      }),
    );
  });

  it('disables controls for unlinked, locked and revoked subjects', async () => {
    renderDialog();

    expect(switchFor('Email access for Cleo').disabled).toBe(false);
    expect(switchFor('Email access for Scout').disabled).toBe(true);
    // The paused bot's per-mailbox switches are disabled while its master switch is off.
    expect(switchFor('Inbox mailbox for Paused bot').disabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));
    expect(await screen.findByText('master-key')).toBeTruthy();
    expect(switchFor('Email access for master-key').disabled).toBe(true);
    expect(switchFor('Email access for retired-key').disabled).toBe(true);
  });

  it('shows an inline error and does not refetch when the update fails', async () => {
    apiMock.updateEmailKeyAccess.mockRejectedValueOnce(new Error('Gateway rejected the change'));
    const { onRefresh } = renderDialog();

    fireEvent.click(switchFor('Email access for Cleo'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Gateway rejected the change');
    expect(onRefresh).not.toHaveBeenCalled();
    expect(switchFor('Email access for Cleo').disabled).toBe(false);
  });

  it('filters by name and slug', () => {
    renderDialog();

    const search = screen.getByRole('searchbox', { name: 'Search bots and API keys' });
    fireEvent.change(search, { target: { value: 'scout' } });

    expect(screen.getByText('Scout')).toBeTruthy();
    expect(screen.queryByText('Cleo')).toBeNull();

    fireEvent.change(search, { target: { value: 'no-such-subject' } });
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('focuses the mailbox it was opened for', () => {
    renderDialog({ focusAccountId: 'acc_sales' });

    expect(screen.getByText(/Focused on/)).toBeTruthy();
    const focused = document.querySelector('[data-email-access-focus="true"]');
    expect(focused).not.toBeNull();
    expect(within(focused as HTMLElement).getByText('Sales')).toBeTruthy();
  });

  it('renders loading and error states', () => {
    renderDialog({ overview: null, loading: true });
    expect(screen.getByRole('status')).toBeTruthy();
    cleanup();

    const onRefresh = vi.fn();
    render(
      <EmailAccessDialog
        open
        onClose={vi.fn()}
        overview={null}
        error="Access API failed"
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText('Access API failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('renders empty states when nothing is registered', () => {
    renderDialog({}, { ...OVERVIEW, bots: [], keys: [], accounts: [] });

    expect(screen.getByText('No bots found')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /API keys/ }));
    expect(screen.getByText('No API keys found')).toBeTruthy();
  });
});

describe('Email page access entry points', () => {
  it('shows per-mailbox access counts and opens the drawer focused on that mailbox', async () => {
    render(<EmailPage />);

    const accessLine = await screen.findByRole('button', { name: 'Manage access to Inbox' });
    await waitFor(() => expect(accessLine.textContent).toMatch(/Access: 1 bot · 2 keys/));

    fireEvent.click(accessLine);

    expect(await screen.findByRole('dialog', { name: 'Email access' })).toBeTruthy();
    expect(screen.getByText(/Focused on/)).toBeTruthy();
  });

  it('opens the drawer from the Access button without a mailbox focus', async () => {
    render(<EmailPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Manage email access' }));

    expect(await screen.findByRole('dialog', { name: 'Email access' })).toBeTruthy();
    expect(screen.queryByText(/Focused on/)).toBeNull();
  });

  it('does not block the mailbox list when the access overview fails', async () => {
    apiMock.getEmailAccess.mockRejectedValueOnce(new Error('access offline'));
    render(<EmailPage />);

    expect(await screen.findByText('Mailboxes')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Manage access to Inbox' })).toBeTruthy();
    expect(await screen.findByText('Access: unavailable')).toBeTruthy();
  });
});
