import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteApprovalService } from '../../src/approvals/service.js';
import { SqliteCatalogRepository } from '../../src/catalog/repository.js';
import { openDatabase } from '../../src/core/db.js';
import { ErrorCodes } from '../../src/core/errors.js';
import { newId, nowIso } from '../../src/core/ids.js';
import { createLogger } from '../../src/core/logger.js';
import { DefaultSupervisor } from '../../src/gateway/supervisor.js';
import type { GatewayConfig } from '../../src/core/config.js';
import type { AuthenticatedKey, EscalationTicket, ServerRecord } from '../../src/core/types.js';

const VAULTWARDEN_FIXTURE = resolve('tests/fixtures/vaultwarden-fake-server.mjs');
const DELIVER_TOOL = 'vault_deliver_credential';

const agentKey: AuthenticatedKey = {
  id: 'key_agent_vault',
  name: 'vault-agent',
  keyType: 'agent',
  keyPrefix: 'mcp_ag_abcde',
  serverGrants: [],
  delegationAllowed: false,
  escalationAllowed: true,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  metadata: {},
};

function buildConfig(): GatewayConfig {
  const dataDir = join(process.cwd(), '.test-data', `approvals-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dataDir, { recursive: true });
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: null,
    bootstrapMasterKey: null,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: [],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 5_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

describe('SqliteApprovalService', () => {
  let config: GatewayConfig;
  let db: DatabaseSync;
  let repository: SqliteCatalogRepository;
  let supervisor: DefaultSupervisor;
  let approvals: SqliteApprovalService;
  let server: ServerRecord;
  let deliveredDir: string;

  beforeEach(() => {
    config = buildConfig();
    db = openDatabase(config.dbPath);
    repository = new SqliteCatalogRepository(db);
    supervisor = new DefaultSupervisor({
      repository,
      config,
      logger: createLogger('approvals-test', 'silent'),
    });
    approvals = new SqliteApprovalService({
      db,
      repository,
      supervisor,
      logger: createLogger('approvals-test', 'silent'),
      timeoutMs: 5_000,
    });

    const now = nowIso();
    server = {
      id: newId('srv'),
      name: 'vaultwarden',
      runtime: 'node',
      transport: 'stdio',
      status: 'stopped',
      command: process.execPath,
      args: [VAULTWARDEN_FIXTURE],
      url: null,
      env: {},
      manifest: null,
      highPrivilegeTools: ['vault_deliver_credential', 'vault_rotate_webui_login', 'vault_create_api_key'],
      delegationSupported: false,
      sourceUrl: 'https://github.com/example/vaultwarden-mcp',
      workDir: null,
      envFile: null,
      approvalRequiredTools: ['vault_deliver_credential', 'vault_rotate_webui_login', 'vault_create_api_key'],
      lastError: null,
      pid: null,
      createdAt: now,
      updatedAt: now,
    };
    repository.upsertServer(server);
    deliveredDir = join(config.dataDir, 'delivered');
  });

  afterEach(async () => {
    await supervisor.shutdown();
    db.close();
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  function createApproval(toolName = DELIVER_TOOL, args: Record<string, unknown> = { item: 'fixture' }): EscalationTicket {
    return approvals.createToolApproval({
      key: agentKey,
      serverId: server.id,
      toolId: `${server.id}:${toolName}`,
      toolName,
      arguments: args,
      requestId: 'req_test_approval',
    });
  }

  function deliveredFiles(): string[] {
    try {
      return readdirSync(deliveredDir).map((name) => join(deliveredDir, name));
    } catch {
      return [];
    }
  }

  describe('requiresApproval', () => {
    it('returns true for tools listed in approvalRequiredTools', () => {
      expect(approvals.requiresApproval(server.id, 'vault_deliver_credential')).toBe(true);
      expect(approvals.requiresApproval(server.id, 'vault_rotate_webui_login')).toBe(true);
    });

    it('returns false for read-only tools and unknown servers', () => {
      expect(approvals.requiresApproval(server.id, 'vault_status')).toBe(false);
      expect(approvals.requiresApproval(server.id, 'vault_get_metadata')).toBe(false);
      expect(approvals.requiresApproval('srv_missing', 'vault_deliver_credential')).toBe(false);
    });
  });

  describe('createToolApproval', () => {
    it('persists a pending tool_approval ticket capturing the call', () => {
      const ticket = createApproval(DELIVER_TOOL, { item: 'vault-item', dir: deliveredDir });

      expect(ticket.id).toMatch(/^esc_[0-9a-f]+$/);
      expect(ticket.ticketId).toMatch(/^esc-\d{8}-[0-9a-f]{4}$/);
      expect(ticket.status).toBe('pending');
      expect(ticket.ticketType).toBe('tool_approval');
      expect(ticket.reason).toBe('APPROVAL_REQUIRED');
      expect(ticket.keyId).toBe(agentKey.id);
      expect(ticket.serverId).toBe(server.id);
      expect(ticket.toolId).toBe(`${server.id}:${DELIVER_TOOL}`);
      expect(ticket.requestPayload).toEqual({ requestId: 'req_test_approval', toolName: DELIVER_TOOL });
      expect(ticket.toolArguments).toEqual({ item: 'vault-item', dir: deliveredDir });
      expect(ticket.result).toBeUndefined();
      expect(ticket.consumedAt).toBeNull();
      expect(ticket.resolvedAt).toBeNull();
      expect(ticket.resolvedBy).toBeNull();
      expect(ticket.note).toBeNull();

      const row = db
        .prepare('SELECT ticket_type, tool_arguments, status FROM escalations WHERE ticket_id = ?')
        .get(ticket.ticketId) as { ticket_type: string; tool_arguments: string; status: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.ticket_type).toBe('tool_approval');
      expect(JSON.parse(row!.tool_arguments)).toEqual({ item: 'vault-item', dir: deliveredDir });
      expect(row?.status).toBe('pending');
    });
  });

  describe('takeResult', () => {
    it('reports pending before a supervisor decision', () => {
      const ticket = createApproval();
      const result = approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!);
      expect(result.state).toBe('pending');
      expect(result.ticket?.ticketId).toBe(ticket.ticketId);
      expect(result.result).toBeUndefined();
    });

    it('reports invalid for a tampered key/tool, unknown ticket or scope ticket', () => {
      const ticket = createApproval();

      expect(approvals.takeResult(ticket.ticketId, 'key_other', ticket.toolId!).state).toBe('invalid');
      expect(approvals.takeResult(ticket.ticketId, agentKey.id, `${server.id}:vault_status`).state).toBe('invalid');
      expect(approvals.takeResult('esc-20990101-dead', agentKey.id, ticket.toolId!).state).toBe('invalid');

      // Invalid attempts must not consume or reveal the ticket.
      const stillPending = approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!);
      expect(stillPending.state).toBe('pending');
    });
  });

  describe('approveAndExecute', () => {
    it('executes the stored call once, stores the result and consumes the ticket on retry', async () => {
      const ticket = createApproval(DELIVER_TOOL, { item: 'vault-item', dir: deliveredDir });

      const executed = await approvals.approveAndExecute(ticket.ticketId, 'supervisor', 'looks fine');
      expect(executed.ticket.status).toBe('approved');
      expect(executed.ticket.resolvedBy).toBe('supervisor');
      expect(executed.ticket.note).toBe('looks fine');
      expect(executed.ticket.consumedAt).toBeNull();
      expect(executed.ticket.result).toEqual(executed.result);

      // The result is a path only — never a secret value.
      const content = executed.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(content.isError).toBeFalsy();
      expect(content.content).toHaveLength(1);
      const path = content.content[0]!.text;
      expect(path.startsWith(deliveredDir)).toBe(true);
      expect(path.includes('FIXTURE_ONLY')).toBe(false);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toContain('FIXTURE_ONLY=not-a-real-secret');

      const collected = approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!);
      expect(collected.state).toBe('approved');
      expect(collected.result).toEqual(executed.result);

      // Exactly one delivery happened and the ticket is now spent.
      expect(deliveredFiles()).toHaveLength(1);
      expect(approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!).state).toBe('consumed');
    });

    it('refuses to execute or approve twice', async () => {
      const ticket = createApproval(DELIVER_TOOL, { item: 'vault-item', dir: deliveredDir });
      await approvals.approveAndExecute(ticket.ticketId, 'supervisor');

      await expect(approvals.approveAndExecute(ticket.ticketId, 'supervisor')).rejects.toMatchObject({
        code: ErrorCodes.INVALID_PARAMS,
      });
      // The double-approval attempt never reached the sub-server.
      expect(deliveredFiles()).toHaveLength(1);
    });

    it('stores an execution failure as an isError result but keeps the approval', async () => {
      const ticket = createApproval('vault_rotate_webui_login', { item: 'ui', fail: true });

      const executed = await approvals.approveAndExecute(ticket.ticketId, 'supervisor');
      const result = executed.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(executed.ticket.status).toBe('approved');
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Execution failed:');
      expect(result.content[0]!.text).toContain('simulated execution failure');

      const collected = approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!);
      expect(collected.state).toBe('approved');
      expect((collected.result as { isError?: boolean }).isError).toBe(true);
    });

    it('stores a tool-level isError result verbatim', async () => {
      const ticket = createApproval(DELIVER_TOOL, { item: 'vault-item', failResult: true });
      const executed = await approvals.approveAndExecute(ticket.ticketId, 'supervisor');
      const result = executed.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toBe('fixture: delivery failed');
      expect(executed.ticket.status).toBe('approved');
    });

    it('refuses to approve a denied ticket', async () => {
      const ticket = createApproval();
      approvals.deny(ticket.ticketId, 'supervisor', 'not needed');
      await expect(approvals.approveAndExecute(ticket.ticketId, 'supervisor')).rejects.toMatchObject({
        code: ErrorCodes.INVALID_PARAMS,
      });
    });
  });

  describe('deny', () => {
    it('denies a pending ticket and reports the decision to the agent', () => {
      const ticket = createApproval();
      const denied = approvals.deny(ticket.ticketId, 'supervisor', 'policy');
      expect(denied.status).toBe('denied');
      expect(denied.resolvedBy).toBe('supervisor');
      expect(denied.note).toBe('policy');
      expect(denied.resolvedAt).not.toBeNull();

      const result = approvals.takeResult(ticket.ticketId, agentKey.id, ticket.toolId!);
      expect(result.state).toBe('denied');
      expect(result.result).toBeUndefined();
      expect(deliveredFiles()).toHaveLength(0);
    });

    it('refuses to deny twice', () => {
      const ticket = createApproval();
      approvals.deny(ticket.ticketId, 'supervisor');
      expect(() => approvals.deny(ticket.ticketId, 'supervisor')).toThrowError(
        /already denied and cannot be denied/,
      );
    });
  });

  describe('listPending', () => {
    it('lists only pending tool approvals for the given server', () => {
      const first = createApproval();
      createApproval('vault_rotate_webui_login', { item: 'ui' });
      approvals.deny(first.ticketId, 'supervisor');

      const pending = approvals.listPending(server.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.toolId).toBe(`${server.id}:vault_rotate_webui_login`);
      expect(approvals.listPending('srv_other')).toHaveLength(0);
    });
  });
});
