/**
 * v0.15 email access control — administration service.
 *
 * Email is one MCP server for every mailbox, so access has two layers:
 *   1. the gateway server grant (`email` in the key's serverGrants, pausable), and
 *   2. per-account decisions stored by EmailAccountAccessStore.
 *
 * EmailAccessService turns both layers into the console overview and applies
 * toggles through KeyService. Bots are resolved from the `omb` server; here a
 * deterministic fake listBots keeps the test offline.
 */
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord, ToolDescriptor } from '../../src/core/types.js';
import { EmailAccessService, type EmailAccessBot } from '../../src/email/access.js';
import { EmailService } from '../../src/email/service.js';
import type { EmailAccessSubject } from '../../src/email/types.js';
import { SqliteKeyService } from '../../src/rbac/keys.js';

const silent = createLogger('test', 'silent');
const SERVER_ID = 'srv_email';
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function makeServer(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: SERVER_ID,
    name: 'email',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: 'node',
    args: [],
    url: null,
    env: {},
    headers: {},
    manifest: null,
    highPrivilegeTools: [],
    delegationSupported: false,
    sourceUrl: null,
    workDir: null,
    envFile: null,
    approvalRequiredTools: [],
    lastError: null,
    pid: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeTool(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: `${SERVER_ID}:${name}`,
    name,
    description: `${name} description`,
    serverId: SERVER_ID,
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

/** Every tool the email server advertises in this test. */
const EMAIL_TOOLS: ToolDescriptor[] = [
  makeTool('email_list_accounts'),
  makeTool('email_list_messages'),
  makeTool('email_send', { highPrivilege: true }),
  makeTool('email_delete', { highPrivilege: true }),
];

const BOTS: EmailAccessBot[] = [
  { id: 'b1', name: 'Cleo', title: 'Chief of Staff', mcpServers: ['gateway-cleo'] },
  { id: 'b2', name: 'Scout', mcpServers: ['gateway-scout'] },
];

function subject(subjects: EmailAccessSubject[], id: string): EmailAccessSubject {
  const found = subjects.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Expected a subject with id '${id}'.`);
  return found;
}

function gatewayError(fn: () => unknown): GatewayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw new Error('Expected a GatewayError.');
}

let db: DatabaseSync;
let keys: SqliteKeyService;
let repository: SqliteCatalogRepository;
let email: EmailService;
let access: EmailAccessService;
let listBots: ReturnType<typeof vi.fn<() => Promise<EmailAccessBot[]>>>;
let workId: string;
let personalId: string;
let ombCleo: { keyId: string; name: string };
let plainKey: { keyId: string; name: string };
let revokedKey: { keyId: string; name: string };
let masterKey: { keyId: string; name: string };

beforeEach(() => {
  db = openDatabase(':memory:');
  keys = new SqliteKeyService(db, { logger: silent });
  repository = new SqliteCatalogRepository(db);
  email = new EmailService({ db });
  repository.upsertServer(makeServer());
  repository.upsertTools(SERVER_ID, EMAIL_TOOLS);

  // Dummy hosts only: creating an account never opens a connection.
  workId = email.createAccount({
    name: 'Work Mailbox',
    email: 'work@example.test',
    imapHost: '127.0.0.1',
    smtpHost: '127.0.0.1',
    imapUser: 'work',
    smtpUser: 'work',
    isDefault: true,
  }).id;
  personalId = email.createAccount({
    name: 'Personal Mailbox',
    email: 'personal@example.test',
    imapHost: '127.0.0.1',
    smtpHost: '127.0.0.1',
    imapUser: 'personal',
    smtpUser: 'personal',
  }).id;

  const cleo = keys.issue({
    name: 'omb-cleo',
    keyType: 'agent',
    serverGrants: [{ serverId: SERVER_ID, tools: null, highPrivilegeTools: ['email_send'] }],
  });
  ombCleo = { keyId: cleo.key.id, name: cleo.key.name };

  const plain = keys.issue({ name: 'plain-agent', keyType: 'agent' });
  plainKey = { keyId: plain.key.id, name: plain.key.name };

  // A revoked `omb-scout` key must not link the Scout bot (and is not listed).
  const scout = keys.issue({ name: 'omb-scout', keyType: 'agent', serverGrants: [{ serverId: SERVER_ID }] });
  keys.revoke(scout.key.id);
  revokedKey = { keyId: scout.key.id, name: scout.key.name };

  const master = keys.issue({ name: 'master-key', keyType: 'master' });
  masterKey = { keyId: master.key.id, name: master.key.name };

  listBots = vi.fn(async () => BOTS);
  access = new EmailAccessService({
    db,
    keys,
    email,
    repository,
    listBots,
    logger: silent,
  });
});

afterEach(() => {
  db.close();
});

describe('EmailAccessService.overview', () => {
  it('lists the email server, its accounts, the bots and the API keys', async () => {
    const overview = await access.overview();

    expect(overview.server).toEqual({
      id: SERVER_ID,
      name: 'email',
      status: 'running',
      toolCount: EMAIL_TOOLS.length,
      highPrivilegeTools: ['email_delete', 'email_send'],
    });
    expect(overview.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(overview.accounts).toEqual([
      expect.objectContaining({ id: workId, name: 'Work Mailbox', email: 'work@example.test', isDefault: true, enabled: true }),
      expect.objectContaining({ id: personalId, name: 'Personal Mailbox', email: 'personal@example.test', isDefault: false }),
    ]);
    // The fake resolver is used once and its result is cached inside the call.
    expect(listBots).toHaveBeenCalledTimes(1);
  });

  it('links a bot to its omb-<slug> key and leaves an unlinked bot keyless', async () => {
    const overview = await access.overview();

    expect(overview.bots).toHaveLength(2);

    const cleo = subject(overview.bots, 'bot:b1');
    expect(cleo).toMatchObject({
      kind: 'bot',
      name: 'Cleo',
      title: 'Chief of Staff',
      slug: 'cleo',
      botId: 'b1',
      keyId: ombCleo.keyId,
      keyName: 'omb-cleo',
      keyType: 'agent',
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
      locked: false,
      revoked: false,
      totalToolCount: EMAIL_TOOLS.length,
    });
    expect(cleo.accounts).toEqual({ [workId]: true, [personalId]: true });

    // Scout's only candidate key is revoked, so the bot has no gateway key.
    const scout = subject(overview.bots, 'bot:b2');
    expect(scout).toMatchObject({
      kind: 'bot',
      name: 'Scout',
      slug: 'scout',
      botId: 'b2',
      keyId: null,
      keyName: null,
      keyType: null,
      emailGranted: false,
      emailPaused: false,
      emailEnabled: false,
    });
    expect(scout.accounts).toEqual({ [workId]: false, [personalId]: false });
  });

  it('does not duplicate the bot key in the standalone key rows', async () => {
    const overview = await access.overview();

    // omb-cleo is shown as the bot row, not again as a key row.
    expect(overview.keys.map((entry) => entry.id)).not.toContain(`key:${ombCleo.keyId}`);
    expect(overview.keys.some((entry) => entry.keyId === ombCleo.keyId)).toBe(false);
    // The revoked key is hidden entirely.
    expect(overview.keys.map((entry) => entry.id)).not.toContain(`key:${revokedKey.keyId}`);
    expect(overview.keys.map((entry) => entry.id).sort()).toEqual(
      [`key:${plainKey.keyId}`, `key:${masterKey.keyId}`].sort(),
    );
  });

  it('marks the master key as locked with access to every account', async () => {
    const overview = await access.overview();
    const master = subject(overview.keys, `key:${masterKey.keyId}`);

    expect(master).toMatchObject({
      kind: 'key',
      keyType: 'master',
      locked: true,
      revoked: false,
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
      grantedToolCount: EMAIL_TOOLS.length,
      totalToolCount: EMAIL_TOOLS.length,
      accounts: { [workId]: true, [personalId]: true },
    });
  });

  it('shows a plain key with no grant as disabled with no account access', async () => {
    const overview = await access.overview();
    const plain = subject(overview.keys, `key:${plainKey.keyId}`);

    expect(plain).toMatchObject({
      kind: 'key',
      keyName: 'plain-agent',
      keyType: 'agent',
      emailGranted: false,
      emailPaused: false,
      emailEnabled: false,
      grantedToolCount: 0,
      totalToolCount: EMAIL_TOOLS.length,
      locked: false,
    });
    expect(plain.accounts).toEqual({ [workId]: true, [personalId]: true });
  });

  it('reflects explicit account decisions and a paused grant', async () => {
    access.accountAccess.set(plainKey.keyId, workId, false);
    keys.update(ombCleo.keyId, {
      serverGrants: [{ serverId: SERVER_ID, tools: null, paused: true }],
    });

    const overview = await access.overview();

    expect(subject(overview.keys, `key:${plainKey.keyId}`).accounts).toEqual({
      [workId]: false,
      [personalId]: true,
    });
    const cleo = subject(overview.bots, 'bot:b1');
    expect(cleo.emailGranted).toBe(true);
    expect(cleo.emailPaused).toBe(true);
    expect(cleo.emailEnabled).toBe(false);
  });
});

describe('EmailAccessService.updateKeyAccess', () => {
  it('pauses and resumes the whole email grant for a key', () => {
    const paused = access.updateKeyAccess(ombCleo.keyId, { enabled: false });
    expect(paused.key).toMatchObject({
      id: ombCleo.keyId,
      name: 'omb-cleo',
      emailGranted: true,
      emailPaused: true,
      emailEnabled: false,
    });
    expect(keys.get(ombCleo.keyId)?.serverGrants[0]).toMatchObject({ serverId: SERVER_ID, paused: true });

    const resumed = access.updateKeyAccess(ombCleo.keyId, { enabled: true });
    expect(resumed.key).toMatchObject({
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
    });
    // Enabling deletes the pause flag rather than storing paused: false.
    expect(keys.get(ombCleo.keyId)?.serverGrants[0]?.paused).toBeUndefined();
  });

  it('adds the complete email grant when enabling a key that has none', () => {
    const result = access.updateKeyAccess(plainKey.keyId, { enabled: true });

    expect(result.key).toMatchObject({
      id: plainKey.keyId,
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
      accounts: { [workId]: true, [personalId]: true },
    });

    const grant = keys.get(plainKey.keyId)?.serverGrants[0];
    expect(grant).toBeDefined();
    expect(grant?.serverId).toBe(SERVER_ID);
    // Every non-high-privilege tool is granted; the destructive tools are opt-in.
    expect(grant?.tools).toEqual(expect.arrayContaining(['email_list_accounts', 'email_list_messages']));
    expect(grant?.tools).not.toEqual(expect.arrayContaining(['email_send', 'email_delete']));
    expect(grant?.highPrivilegeTools).toEqual(expect.arrayContaining(['email_send', 'email_delete']));
    expect(grant?.highPrivilegeTools).not.toEqual(expect.arrayContaining(['email_list_accounts']));
  });

  it('persists account denials in the overview and clears them when re-allowed', async () => {
    const disabled = access.updateKeyAccess(plainKey.keyId, { accounts: { [workId]: false } });

    expect(disabled.key.accounts).toEqual({ [workId]: false, [personalId]: true });
    expect(access.accountAccess.decisionsFor(plainKey.keyId).get(workId)).toBe(false);
    expect(access.accountsFor(plainKey.keyId)).toEqual({ [workId]: false, [personalId]: true });

    const deniedOverview = await access.overview();
    expect(subject(deniedOverview.keys, `key:${plainKey.keyId}`).accounts).toEqual({
      [workId]: false,
      [personalId]: true,
    });

    const allowed = access.updateKeyAccess(plainKey.keyId, { accounts: { [workId]: true } });

    expect(allowed.key.accounts).toEqual({ [workId]: true, [personalId]: true });
    // Choosing "allow" removes the row so the account inherits the default.
    expect(access.accountAccess.decisionsFor(plainKey.keyId).size).toBe(0);

    const allowedOverview = await access.overview();
    expect(subject(allowedOverview.keys, `key:${plainKey.keyId}`).accounts).toEqual({
      [workId]: true,
      [personalId]: true,
    });
  });

  it('grants the server when an account is explicitly allowed on an ungranted key', () => {
    const result = access.updateKeyAccess(plainKey.keyId, { accounts: { [workId]: true } });

    expect(result.key.emailGranted).toBe(true);
    expect(keys.get(plainKey.keyId)?.serverGrants.some((grant) => grant.serverId === SERVER_ID)).toBe(true);
  });

  it('rejects unknown accounts, master keys, revoked keys and unknown keys', () => {
    const unknownAccount = gatewayError(() =>
      access.updateKeyAccess(plainKey.keyId, { accounts: { email_missing: false } }),
    );
    expect(unknownAccount.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(unknownAccount.httpStatus).toBe(400);
    expect(unknownAccount.message).toContain("Unknown email account 'email_missing'");

    const master = gatewayError(() => access.updateKeyAccess(masterKey.keyId, { enabled: false }));
    expect(master.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(master.httpStatus).toBe(400);
    expect(master.message.toLowerCase()).toContain('master');

    const revoked = gatewayError(() => access.updateKeyAccess(revokedKey.keyId, { enabled: true }));
    expect(revoked.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(revoked.httpStatus).toBe(400);
    expect(revoked.message.toLowerCase()).toContain('revoked');

    const missing = gatewayError(() => access.updateKeyAccess('key_missing', { enabled: true }));
    expect(missing.code).toBe(ErrorCodes.TOOL_NOT_FOUND);
    expect(missing.httpStatus).toBe(404);
    expect(missing.message).toContain('was not found');
  });

  it('validates the update body', () => {
    const badEnabled = gatewayError(() =>
      access.updateKeyAccess(plainKey.keyId, { enabled: 'yes' as never }),
    );
    expect(badEnabled.code).toBe(ErrorCodes.INVALID_PARAMS);

    const badAccounts = gatewayError(() =>
      access.updateKeyAccess(plainKey.keyId, { accounts: ['nope'] as never }),
    );
    expect(badAccounts.code).toBe(ErrorCodes.INVALID_PARAMS);

    const badValue = gatewayError(() =>
      access.updateKeyAccess(plainKey.keyId, { accounts: { [workId]: 'no' as never } }),
    );
    expect(badValue.code).toBe(ErrorCodes.INVALID_PARAMS);
    expect(badValue.message).toContain(workId);

    const badBody = gatewayError(() => access.updateKeyAccess(plainKey.keyId, null as never));
    expect(badBody.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

describe('EmailAccessService edge cases', () => {
  it('serves keys when the bot resolver fails (OMB unreachable)', async () => {
    const failing = new EmailAccessService({
      db,
      keys,
      email,
      repository,
      listBots: async () => {
        throw new Error('omb is down');
      },
      logger: silent,
    });

    const overview = await failing.overview();

    expect(overview.bots).toEqual([]);
    expect(overview.keys.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([`key:${plainKey.keyId}`, `key:${masterKey.keyId}`]),
    );
  });

  it('works without a bot resolver and reports an absent email server', async () => {
    const localDb = openDatabase(':memory:');
    try {
      const localKeys = new SqliteKeyService(localDb, { logger: silent });
      const localRepository = new SqliteCatalogRepository(localDb);
      const localEmail = new EmailService({ db: localDb });
      const service = new EmailAccessService({
        db: localDb,
        keys: localKeys,
        email: localEmail,
        repository: localRepository,
        logger: silent,
      });
      const issued = localKeys.issue({ name: 'solo-agent', keyType: 'agent' });

      const overview = await service.overview();
      expect(overview.server).toBeNull();
      expect(overview.accounts).toEqual([]);
      expect(overview.bots).toEqual([]);
      expect(subject(overview.keys, `key:${issued.key.id}`)).toMatchObject({
        emailGranted: false,
        emailEnabled: false,
        totalToolCount: 0,
      });

      const missing = gatewayError(() => service.updateKeyAccess(issued.key.id, { enabled: true }));
      expect(missing.code).toBe(ErrorCodes.TOOL_NOT_FOUND);
      expect(missing.httpStatus).toBe(404);
      expect(missing.message).toContain('not registered');
    } finally {
      localDb.close();
    }
  });
});
