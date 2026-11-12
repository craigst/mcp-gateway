/**
 * The email half of the watcher API: what a watcher-scoped key may read, and
 * when its cursor moves.
 *
 * The rules under test are the ones that make triage safe:
 *   1. only a watcher key may call it at all;
 *   2. a mailbox that is not explicitly enabled is never read;
 *   3. the cursor advances only on an explicit ack, so a crash re-delivers;
 *   4. one unreachable mailbox does not stop the others, and does not advance.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../src/core/db.js';
import { createLogger } from '../../src/core/logger.js';
import type { AuthenticatedKey } from '../../src/core/types.js';
import type { EmailService } from '../../src/email/service.js';
import { EmailTriageStore } from '../../src/email/triage-store.js';
import type { EmailAccount, EmailNewMessages } from '../../src/email/types.js';
import { WatcherApi } from '../../src/gateway/watcher-api.js';
import { WatcherService } from '../../src/watchers/service.js';

const silent = createLogger('test', 'silent');

function account(id: string, email = `${id}@example.com`): EmailAccount {
  return {
    id,
    name: id,
    email,
    displayName: '',
    kind: 'imap',
    enabled: true,
    isDefault: false,
    imapHost: '127.0.0.1',
    imapPort: 143,
    imapSecure: false,
    imapStartTls: true,
    imapUser: email,
    smtpHost: '127.0.0.1',
    smtpPort: 25,
    smtpSecure: false,
    smtpUser: email,
    fromAddress: email,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastTestAt: null,
    lastTestOk: null,
    lastError: null,
  };
}

const batch = (accountId: string, uids: number[]): EmailNewMessages => ({
  accountId,
  accountEmail: `${accountId}@example.com`,
  uidValidity: '777',
  uidNext: 100,
  messages: uids.map((uid) => ({
    id: `${accountId}:777:${uid}`,
    accountId,
    accountEmail: `${accountId}@example.com`,
    uid,
    from: 'Ada <ada@example.com>',
    subject: `Subject ${uid}`,
    preview: 'Can you send them?',
    date: '2026-11-12T09:00:00.000Z',
    unread: true,
    listUnsubscribe: false,
    automated: false,
  })),
});

interface CallOptions {
  body?: unknown;
  role?: string;
  name?: string;
}

function makeRequest(method: string, options: CallOptions = {}): IncomingMessage {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')];
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  const mutable = req as unknown as { method: string; url: string; headers: Record<string, string> };
  mutable.method = method;
  mutable.url = '/mcp/v1/watcher/email';
  mutable.headers = { authorization: 'Bearer watcher-key' };
  return req;
}

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

function makeResponse(): { res: ServerResponse; done: Promise<ApiResponse> } {
  let status = 0;
  let resolveDone: (value: ApiResponse) => void = () => {};
  const done = new Promise<ApiResponse>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    setHeader: () => undefined,
    end: (chunk?: string) => {
      resolveDone({ status, body: chunk ? (JSON.parse(chunk) as Record<string, unknown>) : {} });
    },
    set statusCode(code: number) {
      status = code;
    },
    get statusCode() {
      return status;
    },
  } as unknown as ServerResponse;
  return { res, done };
}

describe('WatcherApi email triage', () => {
  let db: DatabaseSync;
  let triage: EmailTriageStore;
  let listNewMessages: ReturnType<typeof vi.fn>;
  let accounts: EmailAccount[];
  let role: string;
  let keyName: string;

  const api = (): WatcherApi =>
    new WatcherApi({
      service: new WatcherService(db, silent),
      email: { listAccounts: () => accounts, listNewMessages } as unknown as EmailService,
      triage,
      authenticate: () =>
        ({ id: 'key_watcher', name: keyName, keyType: 'agent', metadata: { role } }) as unknown as AuthenticatedKey,
      logger: silent,
    });

  const call = async (method: string, path: string, options: CallOptions = {}): Promise<ApiResponse> => {
    role = options.role ?? 'watcher';
    keyName = options.name ?? 'watcher-email';
    const req = makeRequest(method, options);
    const { res, done } = makeResponse();
    await api().handle(req, res, new URL(`http://localhost${path}`));
    return done;
  };

  beforeEach(() => {
    db = openDatabase(':memory:');
    triage = new EmailTriageStore(db);
    listNewMessages = vi.fn(async (selector: string) => batch(selector, [11, 12]));
    accounts = [account('gmail'), account('proton')];
  });

  it('refuses a key that is not watcher-scoped', async () => {
    await expect(call('GET', '/mcp/v1/watcher/email/new', { role: 'agent', name: 'omb-remy' })).resolves.toMatchObject({
      status: 403,
    });
    expect(listNewMessages).not.toHaveBeenCalled();
  });

  it('reads nothing while every mailbox is off', async () => {
    const response = await call('GET', '/mcp/v1/watcher/email/new');
    expect(response.status).toBe(200);
    expect(response.body.accounts).toEqual([]);
    expect(Number(response.body.waitSeconds)).toBeGreaterThan(0);
    expect(listNewMessages).not.toHaveBeenCalled();
  });

  it('reads only the mailboxes that were switched on', async () => {
    triage.save('gmail', { enabled: true }, 'key_admin');
    const response = await call('GET', '/mcp/v1/watcher/email/new');
    expect(listNewMessages).toHaveBeenCalledTimes(1);
    expect(listNewMessages).toHaveBeenCalledWith('gmail', expect.objectContaining({ afterUid: 0 }));
    const rows = response.body.accounts as Array<{ settings: { accountId: string }; messages: unknown[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.settings.accountId).toBe('gmail');
    expect(rows[0]?.messages).toHaveLength(2);
  });

  it('waits out the poll interval before reading the same mailbox again', async () => {
    triage.save('gmail', { enabled: true, pollSeconds: 300 }, 'key_admin');
    triage.setCursor('gmail', '777', 12, new Date().toISOString());
    const response = await call('GET', '/mcp/v1/watcher/email/new');
    expect(listNewMessages).not.toHaveBeenCalled();
    expect(response.body.accounts).toEqual([]);
    expect(Number(response.body.waitSeconds)).toBeLessThanOrEqual(300);
  });

  it('advances the cursor only on an ack, and resumes after it', async () => {
    triage.save('gmail', { enabled: true, pollSeconds: 60 }, 'key_admin');
    const ack = await call('POST', '/mcp/v1/watcher/email/ack', {
      body: { accountId: 'gmail', uidValidity: '777', lastUid: 12 },
    });
    expect(ack.status).toBe(200);
    expect(triage.get('gmail')).toMatchObject({ lastUid: 12, uidValidity: '777' });

    // Not due yet, so no read.
    expect(listNewMessages).not.toHaveBeenCalled();
    // Once due, the next read starts from the cursor rather than from zero.
    triage.setCursor('gmail', '777', 12, new Date(Date.now() - 120_000).toISOString());
    await call('GET', '/mcp/v1/watcher/email/new');
    expect(listNewMessages).toHaveBeenCalledWith('gmail', expect.objectContaining({ afterUid: 12, uidValidity: '777' }));
  });

  it('refuses an ack for a mailbox that is not enabled', async () => {
    const response = await call('POST', '/mcp/v1/watcher/email/ack', {
      body: { accountId: 'proton', uidValidity: '777', lastUid: 5 },
    });
    expect(response.status).toBe(403);
    expect(triage.get('proton').lastUid).toBe(0);
  });

  it('rejects a malformed ack', async () => {
    triage.save('gmail', { enabled: true }, 'key_admin');
    for (const body of [
      { accountId: 'gmail', uidValidity: '777', lastUid: -1 },
      { accountId: 'gmail', uidValidity: '777', lastUid: 1.5 },
      { accountId: 'gmail', lastUid: 3 },
      { uidValidity: '777', lastUid: 3 },
    ]) {
      const response = await call('POST', '/mcp/v1/watcher/email/ack', { body });
      expect(response.status).toBe(400);
    }
    expect(triage.get('gmail').lastUid).toBe(0);
  });

  it('keeps reading the other mailboxes when one fails, and does not advance the failed one', async () => {
    triage.save('gmail', { enabled: true }, 'key_admin');
    triage.save('proton', { enabled: true }, 'key_admin');
    listNewMessages.mockImplementation(async (selector: string) => {
      if (selector === 'gmail') throw new Error('imap down');
      return batch(selector, [21]);
    });
    const response = await call('GET', '/mcp/v1/watcher/email/new');
    const rows = response.body.accounts as Array<{ settings: { accountId: string } }>;
    expect(rows.map((row) => row.settings.accountId)).toEqual(['proton']);
    expect(triage.get('gmail').lastUid).toBe(0);
    expect(triage.get('gmail').lastRunAt).toBeNull();
  });
});
