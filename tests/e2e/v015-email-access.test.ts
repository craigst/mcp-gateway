/**
 * v0.15 end-to-end: admin email access control.
 *
 * One email MCP server fronts every mailbox, so the console has to answer two
 * questions per caller: may this key reach the server at all (server grant,
 * pausable), and which mailbox may it use (per-account decisions)?
 *
 * This exercises the real HTTP admin surface with a mastered key, a registered
 * email server + tools (inserted directly so no sub-server is started), one
 * configured account and one agent key holding the email grant. Nothing here
 * touches IMAP/SMTP: account creation only writes the shared gateway DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord, ToolDescriptor } from '../../src/core/types.js';

const MASTER_KEY = `mcp_master_${'e'.repeat(48)}`;
const VAULT_SECRET = 'v015-vault-secret-0123456789abcdefgh';
const EMAIL_SERVER_ID = 'srv_email';

const rootDir = join(process.cwd(), '.test-data', `v015-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
let container: GatewayContainer | null = null;
let baseUrl = '';

let accountId = '';
let keyId = '';
let agentKey = '';

function config(): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir: join(rootDir, 'data'),
    dbPath: join(rootDir, 'data', 'gateway.db'),
    uiDistDir: join(rootDir, 'ui'),
    vaultSecret: VAULT_SECRET,
    bootstrapMasterKey: MASTER_KEY,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(rootDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

function emailServerRecord(): ServerRecord {
  const now = new Date().toISOString();
  return {
    id: EMAIL_SERVER_ID,
    name: 'email',
    runtime: 'node',
    transport: 'stdio',
    status: 'running',
    command: process.execPath,
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
    createdAt: now,
    updatedAt: now,
  };
}

function emailTools(): ToolDescriptor[] {
  const tool = (name: string, highPrivilege = false): ToolDescriptor => ({
    id: `${EMAIL_SERVER_ID}:${name}`,
    name,
    description: `${name} description`,
    serverId: EMAIL_SERVER_ID,
    inputSchema: { type: 'object' },
    highPrivilege,
    tags: [],
  });
  return [
    tool('email_list_accounts'),
    tool('email_list_messages'),
    tool('email_send', true),
  ];
}

interface JsonResponse {
  status: number;
  body: any;
}

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const admin = (method: string, path: string, body?: unknown): Promise<JsonResponse> =>
  api(method, path, { token: MASTER_KEY, body });

function keyRow(overview: JsonResponse): any {
  const row = overview.body.keys.find((entry: { id: string }) => entry.id === `key:${keyId}`);
  expect(row).toBeDefined();
  return row;
}

describe('v0.15 admin email access control', () => {
  beforeAll(async () => {
    mkdirSync(rootDir, { recursive: true });
    container = createContainer({ config: config(), logger: createLogger('e2e-v015', 'silent') });
    baseUrl = (await container.start()).url;

    // Register the email server + tools without starting a sub-server: the
    // access service only needs catalog metadata and the shared DB.
    container.services.repository.upsertServer(emailServerRecord());
    container.services.repository.upsertTools(EMAIL_SERVER_ID, emailTools());

    const createdAccount = await admin('POST', '/email', {
      name: 'Work Mailbox',
      email: 'work@example.test',
      displayName: 'Work',
      imapHost: '127.0.0.1',
      imapPort: 143,
      imapUser: 'work',
      imapPassword: 'dummy-password',
      smtpHost: '127.0.0.1',
      smtpPort: 25,
      smtpUser: 'work',
      smtpPassword: 'dummy-password',
      isDefault: true,
    });
    expect(createdAccount.status).toBe(201);
    accountId = createdAccount.body.account.id;

    const createdKey = await admin('POST', '/keys/create', {
      name: 'agent-email',
      keyType: 'agent',
      serverGrants: [
        { serverId: EMAIL_SERVER_ID, tools: null, highPrivilegeTools: ['email_send'] },
      ],
    });
    expect(createdKey.status).toBe(201);
    keyId = createdKey.body.key.id;
    agentKey = createdKey.body.plaintext;
  });

  afterAll(async () => {
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('GET /email/access returns the server, its accounts and the granted key', async () => {
    const overview = await admin('GET', '/email/access');

    expect(overview.status).toBe(200);
    expect(overview.body.server).toEqual({
      id: EMAIL_SERVER_ID,
      name: 'email',
      status: 'running',
      toolCount: 3,
      highPrivilegeTools: ['email_send'],
    });
    expect(overview.body.accounts).toEqual([
      expect.objectContaining({
        id: accountId,
        name: 'Work Mailbox',
        email: 'work@example.test',
        isDefault: true,
        enabled: true,
      }),
    ]);
    // No `omb` server is registered, so no bots are resolved (and no network
    // call is attempted).
    expect(overview.body.bots).toEqual([]);

    const row = keyRow(overview);
    expect(row).toMatchObject({
      kind: 'key',
      keyId,
      keyName: 'agent-email',
      keyType: 'agent',
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
      locked: false,
      revoked: false,
      totalToolCount: 3,
    });
    expect(row.accounts).toEqual({ [accountId]: true });
    expect(typeof overview.body.generatedAt).toBe('string');
  });

  it('PATCH {accounts} disables one mailbox and the change survives a re-read', async () => {
    const patched = await admin('PATCH', `/email/access/keys/${keyId}`, {
      accounts: { [accountId]: false },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.key).toMatchObject({
      id: keyId,
      name: 'agent-email',
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
    });
    expect(patched.body.key.accounts).toEqual({ [accountId]: false });

    const overview = await admin('GET', '/email/access');
    expect(keyRow(overview).accounts).toEqual({ [accountId]: false });
  });

  it('PATCH {enabled:false} pauses the email grant and {enabled:true} restores it', async () => {
    const paused = await admin('PATCH', `/email/access/keys/${keyId}`, { enabled: false });

    expect(paused.status).toBe(200);
    expect(paused.body.key).toMatchObject({
      emailGranted: true,
      emailPaused: true,
      emailEnabled: false,
    });
    // The per-account denial is a separate layer and survives the pause.
    expect(paused.body.key.accounts).toEqual({ [accountId]: false });

    const pausedOverview = await admin('GET', '/email/access');
    const pausedRow = keyRow(pausedOverview);
    expect(pausedRow.emailPaused).toBe(true);
    expect(pausedRow.emailEnabled).toBe(false);

    const resumed = await admin('PATCH', `/email/access/keys/${keyId}`, { enabled: true });

    expect(resumed.status).toBe(200);
    expect(resumed.body.key).toMatchObject({
      emailGranted: true,
      emailPaused: false,
      emailEnabled: true,
    });
    const resumedOverview = await admin('GET', '/email/access');
    expect(keyRow(resumedOverview)).toMatchObject({ emailPaused: false, emailEnabled: true });
  });

  it('rejects unauthenticated and non-master callers', async () => {
    // No credentials at all -> invalid API key (401), not a scope denial.
    const unauthenticated = await api('GET', '/email/access');
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.error.code).toBe(-32005);

    // A valid non-master key is authenticated but not allowed to manage access.
    const agentRead = await api('GET', '/email/access', { token: agentKey });
    expect(agentRead.status).toBe(403);
    expect(agentRead.body.error.code).toBe(-32001);

    const agentWrite = await api('PATCH', `/email/access/keys/${keyId}`, {
      token: agentKey,
      body: { enabled: false },
    });
    expect(agentWrite.status).toBe(403);
  });

  it('returns 404 for an unknown key and 400 for the master key', async () => {
    const unknown = await admin('PATCH', '/email/access/keys/key_missing', { enabled: false });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toContain('was not found');

    const listed = await admin('GET', '/keys');
    const master = listed.body.keys.find(
      (entry: { keyType: string }) => entry.keyType === 'master',
    );
    expect(master).toBeDefined();

    const masterToggle = await admin('PATCH', `/email/access/keys/${master.id}`, {
      enabled: false,
    });
    expect(masterToggle.status).toBe(400);
    expect(masterToggle.body.error.message.toLowerCase()).toContain('master');

    // The master key still has every mailbox in the overview.
    const overview = await admin('GET', '/email/access');
    const masterRow = overview.body.keys.find(
      (entry: { id: string }) => entry.id === `key:${master.id}`,
    );
    expect(masterRow).toMatchObject({ locked: true, emailEnabled: true });
    expect(masterRow.accounts).toEqual({ [accountId]: true });
  });

  it('validates the access update body', async () => {
    const empty = await admin('PATCH', `/email/access/keys/${keyId}`, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain('Nothing to update');

    const badValue = await admin('PATCH', `/email/access/keys/${keyId}`, {
      accounts: { [accountId]: 'no' },
    });
    expect(badValue.status).toBe(400);

    const unknownAccount = await admin('PATCH', `/email/access/keys/${keyId}`, {
      accounts: { email_missing: false },
    });
    expect(unknownAccount.status).toBe(400);
    expect(unknownAccount.body.error.message).toContain("Unknown email account 'email_missing'");
  });
});
