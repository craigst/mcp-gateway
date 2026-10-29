/**
 * Credential providers (v0.7).
 *
 * One abstraction over three places credentials live:
 *   - `vaultwarden` (default): the imported `vaultwarden-mcp` sub-server. Its
 *     configuration is stored encrypted in the gateway vault (`CRED_*`) and
 *     materialised into `$HOME/.config/vaultwarden/mcp.env` (0700/0600) so the
 *     existing sub-server/autostart flow keeps working. Listing/reveal go
 *     through the sub-server's MCP tools; delivered values arrive as short-lived
 *     files which are read, consumed and removed locally.
 *   - `onepassword`: 1Password Connect (host + Bearer token over REST) or the
 *     `op` CLI with a service-account token. Values are decrypted by 1Password
 *     and picked from concealed fields.
 *   - `gateway`: the built-in AES-256 vault (secret names -> values).
 *
 * Secrets never appear in status/details/logs; provider configuration lives in
 * the gateway vault, never in SQLite.
 */
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { GatewayConfig } from '../core/config.js';
import { ErrorCodes, GatewayError, invalidParams } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import { createLogger } from '../core/logger.js';
import type { Logger } from '../core/logger.js';
import type {
  AuditService,
  CatalogRepository,
  CredentialProviderService,
  McpClient,
  Supervisor,
  VaultService,
} from '../core/ports.js';
import type {
  CredentialItem,
  CredentialItemQuery,
  CredentialProviderDescriptor,
  CredentialProviderId,
  CredentialProviderStatus,
  CredentialRevealResult,
  CredentialRef,
  ServerRecord,
} from '../core/types.js';

export const PROVIDER_IDS: readonly CredentialProviderId[] = ['vaultwarden', 'onepassword', 'gateway'];
export const DEFAULT_PROVIDER: CredentialProviderId = 'vaultwarden';
export const DEFAULT_PROVIDER_SETTING = 'credential.default_provider';

const VAULTWARDEN_REQUIRED_FIELDS = ['VAULTWARDEN_URL', 'BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD'] as const;
const VAULTWARDEN_OPTIONAL_FIELDS = ['VAULT_ORG_ID', 'VAULT_COLLECTION_ID'] as const;
const VAULTWARDEN_ENV_PATH = ['.config', 'vaultwarden', 'mcp.env'] as const;
const ONEPASSWORD_FIELDS = ['OP_CONNECT_HOST', 'OP_CONNECT_TOKEN'] as const;
const OP_CLI_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 200;
const DEFAULT_ITEMS = 50;
const REDACTED = '[REDACTED]';

export interface DefaultCredentialProviderServiceDeps {
  db: DatabaseSync;
  config: GatewayConfig;
  vault: VaultService;
  repository: CatalogRepository;
  supervisor: Supervisor;
  audit: AuditService;
  logger?: Logger;
  /** Override for tests; defaults to the OS home directory. */
  homeDir?: string;
}

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

const VAULTWARDEN_DESCRIPTOR: CredentialProviderDescriptor = {
  id: 'vaultwarden',
  name: 'Vaultwarden',
  description:
    'Self-hosted Bitwarden-compatible vault, accessed through the imported vaultwarden-mcp sub-server.',
  fields: [
    {
      key: 'VAULTWARDEN_URL',
      label: 'Vaultwarden URL',
      secret: false,
      required: true,
      placeholder: 'https://vault.example.com',
      hint: 'Base URL of your Vaultwarden instance.',
    },
    { key: 'BW_CLIENTID', label: 'Client ID', secret: false, required: true, hint: 'Bitwarden API client_id.' },
    {
      key: 'BW_CLIENTSECRET',
      label: 'Client secret',
      secret: true,
      required: true,
      hint: 'Stored encrypted in the gateway vault.',
    },
    {
      key: 'BW_PASSWORD',
      label: 'Master password',
      secret: true,
      required: true,
      hint: 'Used by the MCP server to unlock the vault.',
    },
    {
      key: 'VAULT_ORG_ID',
      label: 'Organisation ID',
      secret: false,
      required: false,
      hint: 'Optional organisation scope.',
    },
    {
      key: 'VAULT_COLLECTION_ID',
      label: 'Collection ID',
      secret: false,
      required: false,
      hint: 'Optional collection scope.',
    },
  ],
  docsHint:
    'Import the vaultwarden-mcp server from the catalog (its env file lives at ~/.config/vaultwarden/mcp.env), then save credentials here.',
};

const ONEPASSWORD_DESCRIPTOR: CredentialProviderDescriptor = {
  id: 'onepassword',
  name: '1Password',
  description:
    '1Password Connect (host + access token) or the 1Password CLI with a service-account token.',
  fields: [
    {
      key: 'OP_CONNECT_HOST',
      label: 'Connect host',
      secret: false,
      required: false,
      placeholder: 'https://op.example.com',
      hint: '1Password Connect server URL. Leave empty to use the op CLI instead.',
    },
    {
      key: 'OP_CONNECT_TOKEN',
      label: 'Access token',
      secret: true,
      required: true,
      hint: 'Connect access token, or an OP_SERVICE_ACCOUNT_TOKEN when using the op CLI. Stored encrypted.',
    },
  ],
  docsHint: 'Secrets are read on demand; the token is encrypted at rest in the gateway vault.',
};

const GATEWAY_DESCRIPTOR: CredentialProviderDescriptor = {
  id: 'gateway',
  name: 'Gateway vault',
  description: 'Credentials stored directly in the gateway AES-256 vault.',
  fields: [],
  docsHint: 'Add named secrets on the Vault page; they appear here as credential items.',
};

const DESCRIPTORS: CredentialProviderDescriptor[] = [
  VAULTWARDEN_DESCRIPTOR,
  ONEPASSWORD_DESCRIPTOR,
  GATEWAY_DESCRIPTOR,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProviderId(value: unknown): value is CredentialProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Vault secret name for one provider configuration field (`CRED_<PROVIDER>_<FIELD>`). */
export function credentialSecretName(provider: CredentialProviderId, field: string): string {
  return `CRED_${provider.toUpperCase()}_${field.toUpperCase()}`;
}

function scrub(text: string, token: string | null | undefined): string {
  if (typeof token !== 'string' || token.length === 0) return text;
  return text.split(token).join(REDACTED);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ITEMS;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ITEMS);
}

function firstText(content: unknown[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
    }
  }
  return parts.join('\n').trim();
}

function resultText(result: { content?: unknown[]; structuredContent?: unknown }): string {
  const text = firstText(Array.isArray(result.content) ? result.content : []);
  if (text.length > 0) return text;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    try {
      return JSON.stringify(result.structuredContent);
    } catch {
      return '';
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const values: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) values.push(item);
    else if (isRecord(item)) {
      const href = asString(item.href) ?? asString(item.url);
      if (href !== null) values.push(href);
    }
  }
  return values;
}

/**
 * Parses a delivered credential file into a value.
 *
 * Delivered files are usually `KEY=VALUE` lines (the `VALUE`/`PASSWORD` key is
 * preferred, then the requested field, then the first value); a raw single
 * value is returned as-is.
 */
export function parseDeliveredValue(raw: string, field: string | null): string {
  const text = raw.replace(/\r\n/g, '\n');
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (match === null) continue;
    const key = (match[1] as string).toUpperCase();
    let value = match[2] as string;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  if (values.size > 0) {
    if (field !== null) {
      const requested = values.get(field.toUpperCase());
      if (requested !== undefined) return requested;
    }
    for (const preferred of ['VALUE', 'PASSWORD', 'CREDENTIAL', 'SECRET', 'TOKEN']) {
      const value = values.get(preferred);
      if (value !== undefined) return value;
    }
    return [...values.values()][0] as string;
  }
  return text.trim();
}

/** Extracts a delivery file path from a tool-result text (possibly labelled). */
export function extractDeliveryPath(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Structured result: {"path": "/tmp/…"}.
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      for (const key of ['path', 'file', 'filePath', 'delivery_file', 'deliveryFile']) {
        const candidate = parsed[key];
        if (typeof candidate === 'string') {
          const expanded = expandHome(candidate);
          if (existsSync(expanded)) return expanded;
        }
      }
    }
  } catch {
    // Not JSON — fall through to text parsing.
  }

  // Text like "delivered to /tmp/x.env" or "/tmp/x.env".
  const match = /(?:^|[\s:=("'])((?:~|\/)[^\s"'<>`]+)/m.exec(trimmed);
  if (match !== null) {
    const expanded = expandHome((match[1] as string).replace(/[.,;:)]+$/, ''));
    if (existsSync(expanded)) return expanded;
  }
  return null;
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

interface ParsedItemRecord {
  id: string;
  name: string;
  username: string | null;
  category: string | null;
  urls: string[];
}

/** Parses a Vaultwarden tool-result text into item records (JSON or line format). */
export function parseVaultwardenItems(text: string): ParsedItemRecord[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    parsed = undefined;
  }

  const records: ParsedItemRecord[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim().length > 0) {
      records.push({
        id: value.trim(),
        name: value.trim(),
        username: null,
        category: null,
        urls: [],
      });
      return;
    }
    if (!isRecord(value)) return;
    const id =
      asString(value.alias) ??
      asString(value.id) ??
      asString(value.name) ??
      asString(value.label) ??
      asString(value.title);
    if (id === null) return;
    const name =
      asString(value.name) ??
      asString(value.label) ??
      asString(value.title) ??
      asString(value.alias) ??
      id;
    records.push({
      id,
      name,
      username: asString(value.username) ?? asString(value.login) ?? asString(value.user),
      category: asString(value.category) ?? asString(value.type),
      urls: asStringArray(value.urls).concat(asString(value.url) ?? []).filter((url) => url.length > 0),
    });
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) push(item);
    return records;
  }
  if (isRecord(parsed)) {
    for (const key of ['secrets', 'items', 'results', 'entries']) {
      const list = parsed[key];
      if (Array.isArray(list)) {
        for (const item of list) push(item);
        if (records.length > 0) return records;
      }
    }
    push(parsed);
    return records;
  }

  // Line-oriented fallback: "alias — name", "alias: name", "alias name".
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.replace(/^\s*[-*•]\s*/, '').trim();
    if (line.length === 0) continue;
    const separator = /^([^\s:—-]+)\s*(?::|—|-|\s)\s*(.*)$/.exec(line);
    const id = separator === null ? line : (separator[1] as string);
    const name = separator === null || (separator[2] as string).length === 0 ? line : (separator[2] as string);
    records.push({ id, name, username: null, category: null, urls: [] });
  }
  return records;
}

function toCredentialItem(provider: CredentialProviderId, record: ParsedItemRecord): CredentialItem {
  return {
    provider,
    id: record.id,
    name: record.name,
    username: record.username,
    category: record.category,
    urls: record.urls,
    fields: provider === 'gateway' ? ['value'] : ['password'],
  };
}

interface OnepasswordField {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  value?: unknown;
}

function pickOnepasswordValue(fields: OnepasswordField[], requested: string | null): { label: string | null; value: string } | null {
  const withValue = fields
    .map((field) => ({
      id: asString(field.id),
      label: asString(field.label),
      type: asString(field.type),
      value: typeof field.value === 'string' && field.value.length > 0 ? field.value : null,
    }))
    .filter((field): field is { id: string | null; label: string | null; type: string | null; value: string } =>
      field.value !== null,
    );

  if (requested !== null) {
    const wanted = requested.toLowerCase();
    const exact = withValue.find(
      (field) =>
        (field.label ?? '').toLowerCase() === wanted || (field.id ?? '').toLowerCase() === wanted,
    );
    if (exact !== undefined) return { label: exact.label ?? exact.id, value: exact.value };
  }

  const concealed = withValue.find(
    (field) =>
      (field.type ?? '').toUpperCase() === 'CONCEALED' &&
      /password|credential|api key|token|secret/i.test(field.label ?? ''),
  );
  if (concealed !== undefined) return { label: concealed.label, value: concealed.value };

  const labelled = withValue.find((field) =>
    /password|credential|api key|token|secret/i.test(`${field.label ?? ''} ${field.id ?? ''}`),
  );
  if (labelled !== undefined) return { label: labelled.label, value: labelled.value };

  const anyConcealed = withValue.find((field) => (field.type ?? '').toUpperCase() === 'CONCEALED');
  if (anyConcealed !== undefined) return { label: anyConcealed.label, value: anyConcealed.value };

  const first = withValue[0];
  return first === undefined ? null : { label: first.label, value: first.value };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DefaultCredentialProviderService implements CredentialProviderService {
  private readonly db: DatabaseSync;
  private readonly config: GatewayConfig;
  private readonly vault: VaultService;
  private readonly repository: CatalogRepository;
  private readonly supervisor: Supervisor;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly homeDir: string;
  private opCliAvailable: Promise<boolean> | null = null;

  constructor(deps: DefaultCredentialProviderServiceDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.vault = deps.vault;
    this.repository = deps.repository;
    this.supervisor = deps.supervisor;
    this.audit = deps.audit;
    this.logger = deps.logger ?? createLogger('credentials', 'silent');
    this.homeDir = deps.homeDir ?? homedir();
    void this.audit;
  }

  // -------------------------------------------------------------------------
  // Descriptors / status
  // -------------------------------------------------------------------------

  descriptors(): CredentialProviderDescriptor[] {
    return DESCRIPTORS.map((descriptor) => ({ ...descriptor, fields: descriptor.fields.map((field) => ({ ...field })) }));
  }

  async listProviders(): Promise<CredentialProviderStatus[]> {
    const defaultId = await this.defaultProvider();
    return Promise.all(PROVIDER_IDS.map((id) => this.statusFor(id, defaultId)));
  }

  async getProvider(id: CredentialProviderId): Promise<CredentialProviderStatus> {
    this.assertProviderId(id);
    return this.statusFor(id, await this.defaultProvider());
  }

  private async statusFor(id: CredentialProviderId, defaultId: CredentialProviderId): Promise<CredentialProviderStatus> {
    switch (id) {
      case 'vaultwarden':
        return this.vaultwardenStatus(defaultId === 'vaultwarden');
      case 'onepassword':
        return this.onepasswordStatus(defaultId === 'onepassword');
      case 'gateway':
        return this.gatewayStatus(defaultId === 'gateway');
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  private gatewayStatus(isDefault: boolean): CredentialProviderStatus {
    const enabled = this.vault.isEnabled();
    const count = enabled ? this.vault.listSecrets().length : 0;
    return {
      id: 'gateway',
      name: GATEWAY_DESCRIPTOR.name,
      kind: 'builtin',
      configured: enabled,
      isDefault,
      available: enabled,
      state: enabled ? 'connected' : 'unavailable',
      message: enabled
        ? `${count} encrypted secret(s) available in the gateway vault`
        : 'Vault is not configured (set MCP_VAULT_SECRET)',
      details: { mode: 'gateway', secrets: count },
    };
  }

  private vaultwardenStatus(isDefault: boolean): CredentialProviderStatus {
    const server = this.findVaultwardenServer();
    const config = this.vaultwardenConfig();
    const configured = config.missing.length === 0;
    const details: Record<string, unknown> = {
      serverId: server?.id ?? null,
      serverName: server?.name ?? null,
      serverStatus: server?.status ?? null,
      envPath: this.vaultwardenEnvPath(),
      missing: config.missing,
    };
    if (!this.vault.isEnabled()) {
      return {
        id: 'vaultwarden',
        name: VAULTWARDEN_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: false,
        isDefault,
        available: server !== null,
        state: 'unavailable',
        message: 'Vault is not configured (set MCP_VAULT_SECRET); credentials cannot be stored',
        details,
      };
    }
    if (!configured) {
      return {
        id: 'vaultwarden',
        name: VAULTWARDEN_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: false,
        isDefault,
        available: server !== null,
        state: server === null ? 'unavailable' : 'not-configured',
        message:
          server === null
            ? 'vaultwarden-mcp is not installed. Import it from the catalog, then configure credentials.'
            : `Not configured: missing ${config.missing.join(', ')}`,
        details,
      };
    }
    if (server === null) {
      return {
        id: 'vaultwarden',
        name: VAULTWARDEN_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: true,
        isDefault,
        available: false,
        state: 'unavailable',
        message: 'Credentials are configured but the vaultwarden-mcp server is not installed. Import it from the catalog.',
        details,
      };
    }
    const failed = server.status === 'failed';
    return {
      id: 'vaultwarden',
      name: VAULTWARDEN_DESCRIPTOR.name,
      kind: 'password-manager',
      configured: true,
      isDefault,
      available: true,
      state: failed ? 'error' : 'connected',
      message: failed
        ? 'vaultwarden-mcp last failed to start; run Test to retry'
        : `Configured for server '${server.name}' (${server.status})`,
      details,
    };
  }

  private async onepasswordStatus(isDefault: boolean): Promise<CredentialProviderStatus> {
    const config = this.onepasswordConfig();
    const cli = config.host === null ? await this.isOpCliAvailable() : false;
    const details: Record<string, unknown> = {
      mode: config.host !== null ? 'connect' : cli ? 'cli' : null,
      host: config.host,
      cliAvailable: cli,
    };
    if (!this.vault.isEnabled()) {
      return {
        id: 'onepassword',
        name: ONEPASSWORD_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: false,
        isDefault,
        available: false,
        state: 'unavailable',
        message: 'Vault is not configured (set MCP_VAULT_SECRET); provider credentials cannot be stored',
        details,
      };
    }
    if (config.token === null) {
      return {
        id: 'onepassword',
        name: ONEPASSWORD_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: false,
        isDefault,
        available: true,
        state: 'not-configured',
        message: 'Not configured. Add a 1Password Connect token (or a service-account token for the op CLI).',
        details,
      };
    }
    if (config.host !== null) {
      return {
        id: 'onepassword',
        name: ONEPASSWORD_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: true,
        isDefault,
        available: true,
        state: 'connected',
        message: `1Password Connect configured (${config.host})`,
        details,
      };
    }
    if (cli) {
      return {
        id: 'onepassword',
        name: ONEPASSWORD_DESCRIPTOR.name,
        kind: 'password-manager',
        configured: true,
        isDefault,
        available: true,
        state: 'connected',
        message: 'Configured for the 1Password CLI (service-account token)',
        details,
      };
    }
    return {
      id: 'onepassword',
      name: ONEPASSWORD_DESCRIPTOR.name,
      kind: 'password-manager',
      configured: false,
      isDefault,
      available: true,
      state: 'not-configured',
      message:
        'Set OP_CONNECT_HOST for 1Password Connect, or install the 1Password CLI (op) for service-account mode. The token is stored but cannot be used yet.',
      details,
    };
  }

  // -------------------------------------------------------------------------
  // Configure / clear / test
  // -------------------------------------------------------------------------

  async configure(id: CredentialProviderId, values: Record<string, string>): Promise<CredentialProviderStatus> {
    this.assertProviderId(id);
    if (!isRecord(values)) throw invalidParams('"values" must be an object of string values');
    switch (id) {
      case 'vaultwarden':
        return this.configureVaultwarden(values);
      case 'onepassword':
        return this.configureOnepassword(values);
      case 'gateway':
        throw invalidParams('The gateway vault provider is built-in and cannot be configured');
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  async clear(id: CredentialProviderId): Promise<CredentialProviderStatus> {
    this.assertProviderId(id);
    switch (id) {
      case 'vaultwarden':
        this.clearVaultwarden();
        return this.statusFor(id, await this.defaultProvider());
      case 'onepassword':
        this.clearOnepassword();
        return this.statusFor(id, await this.defaultProvider());
      case 'gateway':
        throw invalidParams('The gateway vault provider is built-in and cannot be cleared');
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  async test(id: CredentialProviderId): Promise<CredentialProviderStatus> {
    this.assertProviderId(id);
    switch (id) {
      case 'vaultwarden':
        return this.testVaultwarden(await this.defaultIdEquals('vaultwarden'));
      case 'onepassword':
        return this.testOnepassword(await this.defaultIdEquals('onepassword'));
      case 'gateway':
        return this.gatewayStatus(await this.defaultIdEquals('gateway'));
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  // -------------------------------------------------------------------------
  // Default provider
  // -------------------------------------------------------------------------

  async defaultProvider(): Promise<CredentialProviderId> {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(DEFAULT_PROVIDER_SETTING) as { value?: string } | undefined;
    const stored = row?.value;
    return isProviderId(stored) ? stored : DEFAULT_PROVIDER;
  }

  async setDefault(id: CredentialProviderId): Promise<void> {
    this.assertProviderId(id);
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(DEFAULT_PROVIDER_SETTING, id);
    this.logger.info('default credential provider updated', { provider: id });
  }

  private async defaultIdEquals(id: CredentialProviderId): Promise<boolean> {
    return (await this.defaultProvider()) === id;
  }

  // -------------------------------------------------------------------------
  // Items / reveal / refs
  // -------------------------------------------------------------------------

  async listItems(id: CredentialProviderId, query: CredentialItemQuery = {}): Promise<CredentialItem[]> {
    this.assertProviderId(id);
    const limit = clampLimit(query.limit);
    const search = typeof query.search === 'string' ? query.search.trim() : '';
    switch (id) {
      case 'gateway':
        return this.gatewayItems(search, limit);
      case 'vaultwarden':
        return this.vaultwardenItems(search, limit);
      case 'onepassword':
        return this.onepasswordItems(search, limit);
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  async reveal(id: CredentialProviderId, itemId: string, field?: string | null): Promise<CredentialRevealResult> {
    this.assertProviderId(id);
    if (typeof itemId !== 'string' || itemId.trim().length === 0) {
      throw invalidParams('"itemId" is required');
    }
    const wantedField = typeof field === 'string' && field.trim().length > 0 ? field.trim() : null;
    switch (id) {
      case 'gateway': {
        const value = this.vault.getSecret(itemId.trim());
        if (value === null) {
          throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, `Credential '${itemId}' was not found in the gateway vault`, {
            httpStatus: 404,
            data: { status: 'NOT_FOUND', details: { provider: 'gateway', itemId } },
          });
        }
        return { provider: 'gateway', itemId: itemId.trim(), field: wantedField ?? 'value', value };
      }
      case 'vaultwarden':
        return this.revealVaultwarden(itemId.trim(), wantedField);
      case 'onepassword':
        return this.onepasswordReveal(itemId.trim(), wantedField);
      default:
        throw invalidParams(`Unknown credential provider '${String(id)}'`);
    }
  }

  async resolveRefs(refs: CredentialRef[]): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    if (!Array.isArray(refs)) return resolved;
    for (const ref of refs) {
      if (!isRecord(ref)) continue;
      const key = asString(ref.key);
      if (key === null) continue;
      if (!isProviderId(ref.provider)) {
        throw invalidParams(`Credential reference '${key}' has an unknown provider`);
      }
      const itemId = asString(ref.itemId);
      if (itemId === null) throw invalidParams(`Credential reference '${key}' has no item id`);
      try {
        const revealed = await this.reveal(ref.provider, itemId, ref.field ?? null);
        resolved[key] = revealed.value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GatewayError(
          ErrorCodes.UPSTREAM_ERROR,
          `Unable to resolve credential reference '${key}': ${message}`,
          { cause: error, data: { status: 'UPSTREAM_ERROR', details: { key, provider: ref.provider } } },
        );
      }
    }
    return resolved;
  }

  async initialize(): Promise<void> {
    if (!this.vault.isEnabled()) return;
    const config = this.vaultwardenConfig();
    if (config.missing.length > 0) return;
    try {
      this.writeVaultwardenEnv(config.values ?? {});
      this.logger.debug('materialised vaultwarden mcp.env during startup', {
        envPath: this.vaultwardenEnvPath(),
      });
    } catch (error) {
      this.logger.warn('failed to materialise vaultwarden mcp.env', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Gateway vault provider
  // -------------------------------------------------------------------------

  private gatewayItems(search: string, limit: number): CredentialItem[] {
    if (!this.vault.isEnabled()) {
      throw new GatewayError(ErrorCodes.NOT_IMPLEMENTED, 'Vault is not configured (set MCP_VAULT_SECRET)', {
        httpStatus: 503,
        data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' },
      });
    }
    const needle = search.toLowerCase();
    return this.vault
      .listSecrets()
      .map((secret) => secret.name)
      .filter((name) => needle.length === 0 || name.toLowerCase().includes(needle))
      .sort((left, right) => left.localeCompare(right))
      .slice(0, limit)
      .map((name) => toCredentialItem('gateway', { id: name, name, username: null, category: 'gateway-vault', urls: [] }));
  }

  // -------------------------------------------------------------------------
  // Vaultwarden provider
  // -------------------------------------------------------------------------

  private vaultwardenEnvPath(): string {
    return join(this.homeDir, ...VAULTWARDEN_ENV_PATH);
  }

  private findVaultwardenServer(): ServerRecord | null {
    const servers = this.repository.listServers();
    const matches = servers.filter((server) => {
      const name = server.name.toLowerCase();
      if (name === 'vaultwarden') return true;
      if (name.includes('vaultwarden')) return true;
      if ((server.sourceUrl ?? '').toLowerCase().includes('vaultwarden')) return true;
      if (server.manifest !== null && JSON.stringify(server.manifest).toLowerCase().includes('vaultwarden')) return true;
      return false;
    });
    if (matches.length === 0) return null;
    return matches.find((server) => server.name === 'vaultwarden') ?? (matches[0] as ServerRecord);
  }

  private vaultwardenConfig(): { values: Record<string, string>; missing: string[] } {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    if (this.vault.isEnabled()) {
      for (const key of VAULTWARDEN_REQUIRED_FIELDS) {
        const value = this.readProviderSecret('vaultwarden', key);
        if (value === null) missing.push(key);
        else values[key] = value;
      }
      for (const key of VAULTWARDEN_OPTIONAL_FIELDS) {
        const value = this.readProviderSecret('vaultwarden', key);
        if (value !== null) values[key] = value;
      }
    } else {
      missing.push(...VAULTWARDEN_REQUIRED_FIELDS);
    }
    return { values, missing };
  }

  private async configureVaultwarden(values: Record<string, string>): Promise<CredentialProviderStatus> {
    this.assertVaultEnabled();
    const normalised: Record<string, string> = {};
    for (const key of VAULTWARDEN_REQUIRED_FIELDS) {
      const value = this.readConfigValue(values, key);
      if (value === null) throw invalidParams(`"${key}" is required`, { field: key });
      normalised[key] = value;
    }
    for (const key of VAULTWARDEN_OPTIONAL_FIELDS) {
      const value = this.readConfigValue(values, key);
      if (value === null) continue;
      normalised[key] = value;
    }
    for (const [key, value] of Object.entries(normalised)) {
      this.writeProviderSecret('vaultwarden', key, value);
    }
    for (const key of VAULTWARDEN_OPTIONAL_FIELDS) {
      if (!(key in normalised)) this.deleteProviderSecret('vaultwarden', key);
    }
    const envPath = this.writeVaultwardenEnv(normalised);
    const server = this.findVaultwardenServer();
    if (server !== null) {
      if (server.envFile !== envPath) {
        this.repository.upsertServer({ ...server, envFile: envPath, updatedAt: nowIso() });
      }
      if (this.supervisor.status(server.id) === 'running') {
        try {
          await this.supervisor.restart(server.id);
        } catch (error) {
          this.logger.warn('vaultwarden restart after configuration failed', {
            serverId: server.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.logger.info('vaultwarden credentials configured', {
      serverId: server?.id ?? null,
      envPath,
      fields: Object.keys(normalised),
    });
    return this.vaultwardenStatus(await this.defaultIdEquals('vaultwarden'));
  }

  private clearVaultwarden(): void {
    for (const key of [...VAULTWARDEN_REQUIRED_FIELDS, ...VAULTWARDEN_OPTIONAL_FIELDS]) {
      this.deleteProviderSecret('vaultwarden', key);
    }
    try {
      rmSync(this.vaultwardenEnvPath(), { force: true });
    } catch (error) {
      this.logger.warn('failed to remove vaultwarden mcp.env', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.logger.info('vaultwarden credentials cleared');
  }

  private writeVaultwardenEnv(values: Record<string, string>): string {
    const envPath = this.vaultwardenEnvPath();
    const dir = join(this.homeDir, '.config', 'vaultwarden');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort on platforms without POSIX modes.
    }
    const order = [...VAULTWARDEN_REQUIRED_FIELDS, ...VAULTWARDEN_OPTIONAL_FIELDS];
    const lines: string[] = [];
    for (const key of order) {
      const value = values[key];
      if (value === undefined) continue;
      lines.push(`${key}=${value}`);
    }
    writeFileSync(envPath, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // Best effort.
    }
    return envPath;
  }

  private async testVaultwarden(isDefault: boolean): Promise<CredentialProviderStatus> {
    const base = this.vaultwardenStatus(isDefault);
    if (!base.configured || !base.available) return base;
    let server: ServerRecord;
    try {
      const connection = await this.requireVaultwardenClient();
      server = connection.server;
      const text = await this.callVaultwardenTool(connection.client, 'vault_status', {});
      const lower = text.toLowerCase();
      if (lower.includes('incomplete') || lower.includes('not configured') || lower.includes('missing')) {
        return this.statusWithMessage(base, 'error', `vault_status reported a configuration problem: ${text}`);
      }
      return {
        ...base,
        state: 'connected',
        message: `Vaultwarden connected${text.length > 0 ? ` (${text})` : ''}`,
        details: { ...base.details, serverId: server.id, testedAt: nowIso() },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.statusWithMessage(base, 'error', `Vaultwarden test failed: ${this.scrubProviderSecrets(message)}`);
    }
  }

  private statusWithMessage(
    base: CredentialProviderStatus,
    state: CredentialProviderStatus['state'],
    message: string,
  ): CredentialProviderStatus {
    return { ...base, state, message };
  }

  private async requireVaultwardenClient(): Promise<{ server: ServerRecord; client: McpClient }> {
    const server = this.findVaultwardenServer();
    if (server === null) {
      throw new GatewayError(
        ErrorCodes.TOOL_NOT_FOUND,
        'vaultwarden-mcp is not installed. Import it from the catalog first.',
        { httpStatus: 404, data: { status: 'NOT_FOUND', reason: 'SERVER_NOT_INSTALLED' } },
      );
    }
    if (this.supervisor.status(server.id) !== 'running') {
      await this.supervisor.start(server.id);
    }
    const client = this.supervisor.client(server.id);
    if (client === null) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'vaultwarden-mcp did not start', {
        data: { status: 'UPSTREAM_ERROR', details: { serverId: server.id } },
      });
    }
    return { server, client };
  }

  private async callVaultwardenTool(
    client: McpClient,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const result = await client.callTool(name, args, { timeoutMs: this.config.defaultToolTimeoutMs });
    const text = resultText(result);
    if (result.isError === true) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `vaultwarden-mcp tool '${name}' failed: ${text}`, {
        data: { status: 'UPSTREAM_ERROR', details: { tool: name } },
      });
    }
    return text;
  }

  private assertVaultwardenConfigured(): void {
    const config = this.vaultwardenConfig();
    if (config.missing.length > 0) {
      throw invalidParams(
        `Vaultwarden credentials are not configured (missing ${config.missing.join(', ')})`,
      );
    }
  }

  private async vaultwardenItems(search: string, limit: number): Promise<CredentialItem[]> {
    this.assertVaultwardenConfigured();
    const { client } = await this.requireVaultwardenClient();
    let text: string | null = null;
    const errors: string[] = [];

    const attempts: Array<{ tool: string; args: Record<string, unknown> }> =
      search.length > 0
        ? [{ tool: 'secrets_search', args: { query: search } }]
        : [{ tool: 'secrets_list', args: {} }, { tool: 'secrets_search', args: { query: '' } }];
    for (const attempt of attempts) {
      try {
        text = await this.callVaultwardenTool(client, attempt.tool, attempt.args);
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (text === null) {
      // Documented fallback tool for older vaultwarden-mcp builds.
      try {
        text = await this.callVaultwardenTool(client, 'vault_list_local_ui', {});
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        throw new GatewayError(
          ErrorCodes.UPSTREAM_ERROR,
          `Unable to list Vaultwarden credentials: ${this.scrubProviderSecrets(errors[errors.length - 1] ?? 'unknown error')}`,
          { cause: error, data: { status: 'UPSTREAM_ERROR', details: { provider: 'vaultwarden' } } },
        );
      }
    }

    const needle = search.toLowerCase();
    return parseVaultwardenItems(text)
      .map((record) => toCredentialItem('vaultwarden', record))
      .filter((item) => {
        if (needle.length === 0) return true;
        return (
          item.id.toLowerCase().includes(needle) ||
          item.name.toLowerCase().includes(needle) ||
          (item.username ?? '').toLowerCase().includes(needle)
        );
      })
      .slice(0, limit);
  }

  private async revealVaultwarden(itemId: string, field: string | null): Promise<CredentialRevealResult> {
    this.assertVaultwardenConfigured();
    const { client } = await this.requireVaultwardenClient();
    const effectiveField = field ?? 'password';
    const attempts: Array<() => Promise<string>> = [
      async () => {
        const text = await this.callVaultwardenTool(client, 'secrets_resolve_to_file', {
          alias: itemId,
          var_name: 'VALUE',
        });
        return this.readDeliveredCredential(client, text, effectiveField);
      },
      async () => {
        const text = await this.callVaultwardenTool(client, 'vault_deliver_credential', {
          name: itemId,
          field: effectiveField,
        });
        return this.readDeliveredCredential(client, text, effectiveField);
      },
    ];
    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        const value = await attempt();
        return { provider: 'vaultwarden', itemId, field: effectiveField, value };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const message = errors[errors.length - 1] ?? 'unknown error';
    throw new GatewayError(
      ErrorCodes.UPSTREAM_ERROR,
      `Unable to reveal Vaultwarden credential '${itemId}': ${this.scrubProviderSecrets(message)}`,
      { data: { status: 'UPSTREAM_ERROR', details: { provider: 'vaultwarden', itemId } } },
    );
  }

  private async readDeliveredCredential(client: McpClient, text: string, field: string): Promise<string> {
    const path = extractDeliveryPath(text);
    if (path === null) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, 'Vaultwarden did not return a credential delivery file', {
        data: { status: 'UPSTREAM_ERROR', details: { provider: 'vaultwarden' } },
      });
    }
    try {
      const raw = readFileSync(path, 'utf8');
      return parseDeliveredValue(raw, field);
    } finally {
      await this.consumeDelivery(client, path);
    }
  }

  private async consumeDelivery(client: McpClient, path: string): Promise<void> {
    try {
      await client.callTool('vault_consume_delivery', { path }, { timeoutMs: 5_000 });
    } catch {
      // Best effort: older builds may not expose the consume tool.
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // The delivered file may already be gone.
    }
  }

  // -------------------------------------------------------------------------
  // 1Password provider
  // -------------------------------------------------------------------------

  private onepasswordConfig(): { host: string | null; token: string | null } {
    if (!this.vault.isEnabled()) return { host: null, token: null };
    return {
      host: this.readProviderSecret('onepassword', 'OP_CONNECT_HOST'),
      token: this.readProviderSecret('onepassword', 'OP_CONNECT_TOKEN'),
    };
  }

  private async configureOnepassword(values: Record<string, string>): Promise<CredentialProviderStatus> {
    this.assertVaultEnabled();
    const token = this.readConfigValue(values, 'OP_CONNECT_TOKEN');
    if (token === null) throw invalidParams('"OP_CONNECT_TOKEN" is required', { field: 'OP_CONNECT_TOKEN' });
    const host = this.readConfigValue(values, 'OP_CONNECT_HOST');
    if (host !== null && !/^https?:\/\//i.test(host)) {
      throw invalidParams('"OP_CONNECT_HOST" must be an http(s) URL');
    }
    this.writeProviderSecret('onepassword', 'OP_CONNECT_TOKEN', token);
    if (host !== null) this.writeProviderSecret('onepassword', 'OP_CONNECT_HOST', host.replace(/\/+$/, ''));
    else this.deleteProviderSecret('onepassword', 'OP_CONNECT_HOST');
    this.logger.info('1password credentials configured', { mode: host === null ? 'cli-or-unset' : 'connect' });
    return this.onepasswordStatus(await this.defaultIdEquals('onepassword'));
  }

  private clearOnepassword(): void {
    for (const key of ONEPASSWORD_FIELDS) this.deleteProviderSecret('onepassword', key);
    this.logger.info('1password credentials cleared');
  }

  private async testOnepassword(isDefault: boolean): Promise<CredentialProviderStatus> {
    const base = await this.onepasswordStatus(isDefault);
    if (!base.configured) return base;
    const config = this.onepasswordConfig();
    if (config.token === null) return base;
    try {
      if (config.host !== null) {
        const vaults = await this.connectJson<unknown[]>(config.host, config.token, '/v1/vaults');
        return {
          ...base,
          state: 'connected',
          message: `1Password Connect connected (${Array.isArray(vaults) ? vaults.length : 0} vault(s))`,
          details: { ...base.details, testedAt: nowIso() },
        };
      }
      const vaults = await this.runOpJson(config.token, ['vault', 'list', '--format=json']);
      return {
        ...base,
        state: 'connected',
        message: `1Password CLI connected (${Array.isArray(vaults) ? vaults.length : 0} vault(s))`,
        details: { ...base.details, testedAt: nowIso() },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, state: 'error', message: `1Password test failed: ${this.scrubProviderSecrets(message)}` };
    }
  }

  private async onepasswordItems(search: string, limit: number): Promise<CredentialItem[]> {
    const config = this.onepasswordConfig();
    const token = config.token;
    if (token === null) throw invalidParams('1Password is not configured');
    if (config.host !== null) {
      const vaults = await this.connectJson<unknown[]>(config.host, token, '/v1/vaults');
      const items: CredentialItem[] = [];
      for (const rawVault of Array.isArray(vaults) ? vaults : []) {
        if (items.length >= limit) break;
        if (!isRecord(rawVault)) continue;
        const vaultId = asString(rawVault.id);
        if (vaultId === null) continue;
        const vaultName = asString(rawVault.name) ?? vaultId;
        const query = search.length > 0 ? `?filter=${encodeURIComponent(search)}` : '';
        const overviews = await this.connectJson<unknown[]>(
          config.host,
          token,
          `/v1/vaults/${encodeURIComponent(vaultId)}/items${query}`,
        );
        for (const rawItem of Array.isArray(overviews) ? overviews : []) {
          if (items.length >= limit) break;
          if (!isRecord(rawItem)) continue;
          const itemId = asString(rawItem.id);
          if (itemId === null) continue;
          const title = asString(rawItem.title) ?? asString(rawItem.name) ?? itemId;
          if (search.length > 0 && !title.toLowerCase().includes(search.toLowerCase())) continue;
          items.push({
            provider: 'onepassword',
            id: `${vaultId}/${itemId}`,
            name: title,
            username: null,
            category: asString(rawItem.category) ?? vaultName,
            urls: asStringArray(rawItem.urls),
            fields: ['password'],
          });
        }
      }
      return items;
    }

    if (!(await this.isOpCliAvailable())) {
      throw invalidParams(
        '1Password is not usable: set OP_CONNECT_HOST or install the 1Password CLI (op)',
      );
    }
    const vaults = await this.runOpJson(token, ['vault', 'list', '--format=json']);
    void vaults;
    const rawItems = await this.runOpJson(token, ['item', 'list', '--format=json']);
    const items: CredentialItem[] = [];
    for (const rawItem of Array.isArray(rawItems) ? rawItems : []) {
      if (items.length >= limit) break;
      if (!isRecord(rawItem)) continue;
      const itemId = asString(rawItem.id);
      if (itemId === null) continue;
      const title = asString(rawItem.title) ?? asString(rawItem.name) ?? itemId;
      if (search.length > 0 && !title.toLowerCase().includes(search.toLowerCase())) continue;
      const vault = isRecord(rawItem.vault) ? rawItem.vault : null;
      items.push({
        provider: 'onepassword',
        id: itemId,
        name: title,
        username: null,
        category: asString(rawItem.category) ?? (vault === null ? null : asString(vault.name)),
        urls: asStringArray(rawItem.urls),
        fields: ['password'],
      });
    }
    return items;
  }

  private async onepasswordReveal(itemId: string, field: string | null): Promise<CredentialRevealResult> {
    const config = this.onepasswordConfig();
    const token = config.token;
    if (token === null) throw invalidParams('1Password is not configured');

    let fields: OnepasswordField[];
    if (config.host !== null) {
      const separator = itemId.indexOf('/');
      if (separator <= 0 || separator === itemId.length - 1) {
        throw invalidParams('1Password item id must be in the form "<vaultId>/<itemId>"');
      }
      const vaultId = itemId.slice(0, separator);
      const rawItemId = itemId.slice(separator + 1);
      const detail = await this.connectJson<Record<string, unknown>>(
        config.host,
        token,
        `/v1/vaults/${encodeURIComponent(vaultId)}/items/${encodeURIComponent(rawItemId)}`,
      );
      fields = Array.isArray(detail.fields) ? (detail.fields as OnepasswordField[]) : [];
    } else {
      if (!(await this.isOpCliAvailable())) {
        throw invalidParams('1Password is not usable: set OP_CONNECT_HOST or install the 1Password CLI (op)');
      }
      const detail = await this.runOpJson(token, ['item', 'get', itemId, '--format=json', '--reveal']);
      fields = isRecord(detail) && Array.isArray(detail.fields) ? (detail.fields as OnepasswordField[]) : [];
    }

    const picked = pickOnepasswordValue(fields, field);
    if (picked === null) {
      throw new GatewayError(ErrorCodes.INVALID_PARAMS, `No usable field was found on 1Password item '${itemId}'`, {
        httpStatus: 400,
        data: { status: 'INVALID_PARAMS', details: { itemId, field } },
      });
    }
    return {
      provider: 'onepassword',
      itemId,
      field: field ?? picked.label,
      value: picked.value,
    };
  }

  private async connectJson<T>(host: string, token: string, path: string): Promise<T> {
    const url = `${host.replace(/\/+$/, '')}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new GatewayError(
        ErrorCodes.UPSTREAM_ERROR,
        `1Password Connect request failed: ${scrub(message, token)}`,
        { cause: error, data: { status: 'UPSTREAM_ERROR', details: { mode: 'connect' } } },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(ErrorCodes.KEY_INVALID, '1Password Connect rejected the access token', {
        httpStatus: 401,
        data: { status: 'UNAUTHORIZED', reason: 'INVALID_CREDENTIALS' },
      });
    }
    if (response.status === 404) {
      throw new GatewayError(ErrorCodes.TOOL_NOT_FOUND, '1Password Connect item or vault was not found', {
        httpStatus: 404,
        data: { status: 'NOT_FOUND' },
      });
    }
    if (!response.ok) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, `1Password Connect returned HTTP ${response.status}`, {
        data: { status: 'UPSTREAM_ERROR', details: { mode: 'connect' } },
      });
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new GatewayError(ErrorCodes.UPSTREAM_ERROR, '1Password Connect returned invalid JSON', {
        cause: error,
        data: { status: 'UPSTREAM_ERROR', details: { mode: 'connect' } },
      });
    }
  }

  private isOpCliAvailable(): Promise<boolean> {
    if (this.opCliAvailable === null) {
      this.opCliAvailable = new Promise<boolean>((resolve) => {
        execFile('op', ['--version'], { timeout: 3_000, windowsHide: true }, (error) => resolve(error === null));
      });
    }
    return this.opCliAvailable;
  }

  private runOpJson(token: string, args: string[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      execFile(
        'op',
        args,
        {
          timeout: OP_CLI_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            const detail = scrub(stderr.trim() || error.message, token);
            reject(
              new GatewayError(ErrorCodes.UPSTREAM_ERROR, `1Password CLI failed: ${detail}`, {
                cause: error,
                data: { status: 'UPSTREAM_ERROR', details: { mode: 'cli' } },
              }),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout) as unknown);
          } catch (parseError) {
            reject(
              new GatewayError(ErrorCodes.UPSTREAM_ERROR, '1Password CLI returned invalid JSON', {
                cause: parseError,
                data: { status: 'UPSTREAM_ERROR', details: { mode: 'cli' } },
              }),
            );
          }
        },
      );
    });
  }

  // -------------------------------------------------------------------------
  // Vault-backed config helpers
  // -------------------------------------------------------------------------

  private assertProviderId(id: CredentialProviderId): void {
    if (!isProviderId(id)) throw invalidParams(`Unknown credential provider '${String(id)}'`);
  }

  private assertVaultEnabled(): void {
    if (!this.vault.isEnabled()) {
      throw new GatewayError(
        ErrorCodes.NOT_IMPLEMENTED,
        'Vault is not configured (set MCP_VAULT_SECRET); provider credentials cannot be stored',
        { httpStatus: 503, data: { status: 'NOT_CONFIGURED', reason: 'VAULT_DISABLED' } },
      );
    }
  }

  private readConfigValue(values: Record<string, string>, key: string): string | null {
    const raw = values[key];
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (raw.includes('\0') || raw.includes('\n') || raw.includes('\r')) {
      throw invalidParams(`"${key}" must not contain control characters or line breaks`, { field: key });
    }
    // Secret values may legitimately contain surrounding whitespace.
    return key.includes('PASSWORD') || key.includes('SECRET') || key.includes('TOKEN') ? raw : trimmed;
  }

  private readProviderSecret(provider: CredentialProviderId, field: string): string | null {
    if (!this.vault.isEnabled()) return null;
    try {
      return this.vault.getSecret(credentialSecretName(provider, field));
    } catch {
      return null;
    }
  }

  private writeProviderSecret(provider: CredentialProviderId, field: string, value: string): void {
    this.assertVaultEnabled();
    this.vault.setSecret(credentialSecretName(provider, field), value);
  }

  private deleteProviderSecret(provider: CredentialProviderId, field: string): void {
    try {
      this.vault.deleteSecret(credentialSecretName(provider, field));
    } catch {
      // Deleting a missing secret is a no-op.
    }
  }

  private scrubProviderSecrets(text: string): string {
    let scrubbed = text;
    for (const provider of ['vaultwarden', 'onepassword'] as const) {
      for (const field of ['BW_CLIENTID', 'BW_CLIENTSECRET', 'BW_PASSWORD', 'OP_CONNECT_TOKEN']) {
        const secret = this.readProviderSecret(provider, field);
        if (secret !== null) scrubbed = scrub(scrubbed, secret);
      }
    }
    return scrubbed;
  }
}
