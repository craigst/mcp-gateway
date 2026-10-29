/**
 * v0.2 end-to-end flows:
 *   - approval-gated Vaultwarden credential delivery (request → human approval →
 *     one-shot retrieval of the stored result; secret value never returned)
 *   - local harness discovery + import (Claude config → gateway server → run)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContainer, type GatewayContainer } from '../../src/container.js';
import type { GatewayConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import type { ServerRecord } from '../../src/core/types.js';

const ECHO_FIXTURE = resolve('tests/fixtures/mcp-echo-server.mjs');
const VAULT_FIXTURE = resolve('tests/fixtures/vaultwarden-fake-server.mjs');

interface JsonResponse {
  status: number;
  body: any;
}

function makeConfig(dataDir: string): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    dataDir,
    dbPath: join(dataDir, 'gateway.db'),
    uiDistDir: join(dataDir, 'ui'),
    vaultSecret: 'v02-e2e-vault-secret-0123456789abcdef',
    bootstrapMasterKey: `mcp_master_${'v'.repeat(48)}`,
    delegationMaxDepth: 3,
    gitImportAllowedPrefixes: ['file://'],
    reposDir: join(dataDir, 'repos'),
    logLevel: 'silent',
    requestBodyLimitBytes: 1_048_576,
    defaultToolTimeoutMs: 15_000,
    keyPepper: null,
    publicBaseUrl: 'http://127.0.0.1',
  };
}

describe('v0.2 approval gating + harness import', () => {
  let container: GatewayContainer;
  let baseUrl: string;
  let masterKey: string;
  let vaultServer: ServerRecord;
  let agentKey: string;
  let harnessConfigPath: string;
  const rootDir = join(process.cwd(), '.test-data', `v02-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

  const admin = async (method: string, path: string, body?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1/admin${path}`, {
      method,
      headers: { authorization: `Bearer ${masterKey}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const rpc = async (key: string, method: string, params?: unknown): Promise<JsonResponse> => {
    const response = await fetch(`${baseUrl}/mcp/v1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'v02', method, params }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    mkdirSync(rootDir, { recursive: true });

    // A fake Claude config that points at the real stdio echo fixture.
    harnessConfigPath = join(rootDir, 'claude.json');
    writeFileSync(
      harnessConfigPath,
      JSON.stringify({
        mcpServers: {
          'echo-import': {
            command: process.execPath,
            args: [ECHO_FIXTURE],
            env: { SECRET_TOKEN: 'should-never-leak-into-discovery-output' },
          },
          'remote-demo': { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer fake' } },
        },
      }),
    );
    process.env.MCP_DISCOVERY_CLAUDE_CONFIG = harnessConfigPath;

    const config = makeConfig(rootDir);
    container = createContainer({ config, logger: createLogger('e2e-v02', 'silent') });
    baseUrl = (await container.start()).url;
    masterKey = config.bootstrapMasterKey as string;

    const registered = await admin('POST', '/servers', {
      name: 'vaultwarden',
      runtime: 'node',
      transport: 'stdio',
      command: process.execPath,
      args: [VAULT_FIXTURE],
      highPrivilegeTools: ['vault_deliver_credential'],
      approvalRequiredTools: ['vault_deliver_credential'],
    });
    vaultServer = registered.body.server as ServerRecord;
    expect((await admin('POST', `/servers/${vaultServer.id}/start`)).status).toBe(200);

    const created = await admin('POST', '/keys/create', {
      name: 'vault-agent',
      keyType: 'agent',
      serverGrants: [
        {
          serverId: vaultServer.id,
          tools: ['vault_status', 'vault_deliver_credential', 'vault_create_api_key'],
          highPrivilegeTools: ['vault_deliver_credential'],
        },
      ],
      escalationAllowed: true,
    });
    agentKey = created.body.plaintext as string;
  });

  afterAll(async () => {
    delete process.env.MCP_DISCOVERY_CLAUDE_CONFIG;
    if (container) {
      const dataDir = container.config.dataDir;
      await container.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('gates a dangerous vault tool behind an approval ticket', async () => {
    const denied = await rpc(agentKey, 'tools/call', {
      name: 'vault_deliver_credential',
      arguments: { item: 'local-ui/demo/webui-login' },
    });
    expect(denied.body.error.code).toBe(-32004);
    expect(denied.body.error.data.status).toBe('ESCALATION_REQUIRED');
    expect(denied.body.error.data.reason).toBe('APPROVAL_REQUIRED');
    expect(denied.body.error.data.ticket_id).toMatch(/^esc-/);
    expect(denied.body.error.data.escalation_supported).toBe(true);
  });

  it('shows the pending credential request in the Vault Warden overview', async () => {
    const overview = await admin('GET', '/vaultwarden');
    expect(overview.status).toBe(200);
    expect(overview.body.installed).toBe(true);
    expect(overview.body.serverId).toBe(vaultServer.id);
    expect(overview.body.pendingApprovals.length).toBeGreaterThanOrEqual(1);
    const deliverTool = overview.body.tools.find((tool: { name: string }) => tool.name === 'vault_deliver_credential');
    expect(deliverTool.approvalRequired).toBe(true);
    expect(overview.body.defaults.approvalTools).toContain('vault_deliver_credential');
  });

  it('applies the default Vault Warden protection policy', async () => {
    const protectedResponse = await admin('POST', '/vaultwarden/protect', { serverId: vaultServer.id });
    expect(protectedResponse.status).toBe(200);
    const listed = (protectedResponse.body.server as ServerRecord).approvalRequiredTools ?? [];
    expect(listed).toContain('vault_deliver_credential');
    expect(listed).toContain('vault_create_api_key');
    expect(listed).not.toContain('vault_status');

    const tools = await admin('GET', `/servers/${vaultServer.id}/tools`);
    const statusTool = tools.body.tools.find((tool: { name: string }) => tool.name === 'vault_status');
    const deliverTool = tools.body.tools.find((tool: { name: string }) => tool.name === 'vault_deliver_credential');
    expect(statusTool.approvalRequired).toBe(false);
    expect(deliverTool.approvalRequired).toBe(true);
    expect(deliverTool.highPrivilege).toBe(true);
  });

  it('approves, executes once and returns the delivery path to the agent', async () => {
    const overview = await admin('GET', '/vaultwarden');
    const ticket = overview.body.pendingApprovals[0] as { ticketId: string };
    expect(ticket).toBeDefined();

    const approved = await admin('POST', `/escalations/${ticket.ticketId}/resolve`, {
      status: 'approved',
      note: 'credential delivery approved by test',
    });
    expect(approved.status).toBe(200);
    expect(approved.body.escalation.status).toBe('approved');
    const resultText = approved.body.result?.content?.[0]?.text as string;
    expect(resultText).toMatch(/vaultwarden-fixture|delivery|\.env|[\\/]/);
    // The deliver tool returns only a path, never a secret value.
    expect(resultText).not.toContain('password');
    const deliveredPath = resultText.trim();
    expect(existsSync(deliveredPath)).toBe(true);
    expect(statSync(deliveredPath).mode & 0o777).toBe(0o600);

    const retried = await rpc(agentKey, 'tools/call', {
      name: 'vault_deliver_credential',
      arguments: { item: 'local-ui/demo/webui-login' },
      _meta: { escalation_ticket: ticket.ticketId },
    });
    expect(retried.body.result.content[0].text).toBe(resultText);

    const consumed = await rpc(agentKey, 'tools/call', {
      name: 'vault_deliver_credential',
      arguments: { item: 'local-ui/demo/webui-login' },
      _meta: { escalation_ticket: ticket.ticketId },
    });
    expect(consumed.body.error.code).toBe(-32004);
    expect(consumed.body.error.data.status).toBe('ESCALATION_REQUIRED');
  });

  it('records vault tool calls in the access log for human review', async () => {
    const overview = await admin('GET', '/vaultwarden');
    const names = (overview.body.accessLog as Array<{ method: string; toolId: string | null; status: string }>).map(
      (entry) => entry.toolId,
    );
    expect(names.some((value) => value && value.includes('vault_deliver_credential'))).toBe(true);
    expect(overview.body.accessLog.length).toBeGreaterThan(0);
  });

  it('denies a pending credential request without executing it', async () => {
    await admin('PATCH', `/servers/${vaultServer.id}/policy`, {
      approvalRequiredTools: ['vault_create_api_key'],
    });
    const deniedRequest = await rpc(agentKey, 'tools/call', {
      name: 'vault_create_api_key',
      arguments: { name: 'demo-key' },
    });
    const ticketId = deniedRequest.body.error.data.ticket_id as string;
    expect(ticketId).toBeTruthy();

    const denied = await admin('POST', `/escalations/${ticketId}/resolve`, { status: 'denied', note: 'not allowed' });
    expect(denied.body.escalation.status).toBe('denied');

    const retry = await rpc(agentKey, 'tools/call', {
      name: 'vault_create_api_key',
      arguments: { name: 'demo-key' },
      _meta: { escalation_ticket: ticketId },
    });
    expect(retry.body.error).toBeDefined();
  });

  it('discovers local harness servers without leaking env values', async () => {
    const sources = await admin('GET', '/discovery/sources');
    expect(sources.status).toBe(200);
    const claude = sources.body.sources.find((source: { id: string }) => source.id === 'claude');
    expect(claude.exists).toBe(true);
    expect(claude.serverCount).toBe(2);

    const scan = await admin('POST', '/discovery/scan', {});
    expect(scan.status).toBe(200);
    const names = (scan.body.entries as Array<{ name: string }>).map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining(['echo-import', 'remote-demo']));

    const echoEntry = scan.body.entries.find((entry: { name: string }) => entry.name === 'echo-import');
    expect(echoEntry.envKeys).toEqual(['SECRET_TOKEN']);
    expect(JSON.stringify(scan.body)).not.toContain('should-never-leak-into-discovery-output');
    const claudeError = (scan.body.errors as Array<{ harness: string }>).find((entry) => entry.harness === 'claude');
    expect(claudeError).toBeUndefined();
  });

  it('imports a discovered harness server and runs it through the gateway', async () => {
    const imported = await admin('POST', '/discovery/import', {
      harness: 'claude',
      name: 'echo-import',
      transport: 'stdio',
      command: process.execPath,
      args: [ECHO_FIXTURE],
    });
    expect(imported.status).toBe(201);
    const server = imported.body.server as ServerRecord;
    expect(server.status).toBe('stopped');

    const started = await admin('POST', `/servers/${server.id}/start`);
    expect(started.body.server.status).toBe('running');

    const listed = await rpc(masterKey, 'tools/list', { serverId: server.id });
    expect((listed.body.result.tools as Array<{ name: string }>).length).toBe(5);

    const called = await rpc(masterKey, 'tools/call', { name: 'echo', arguments: { text: 'imported harness' }, serverId: server.id });
    expect(called.body.result.content[0].text).toBe('imported harness');
  });
});
