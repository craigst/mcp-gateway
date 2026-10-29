import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ErrorCodes, GatewayError } from '../../src/core/errors.js';
import { openDatabase } from '../../src/core/db.js';
import { DefaultBackupService } from '../../src/backup/service.js';
import { BACKUP_GATEWAY_VERSION } from '../../src/backup/crypto.js';
import {
  HIDDEN_API_KEY_NAME,
  HIDDEN_GITHUB_TOKEN,
  HIDDEN_SECRET_VALUE,
  OPERATOR_PASSWORD,
  makeBackupConfig,
  makeRoot,
  removeRoot,
  seedState,
  type BackupHarness,
} from './support.js';

const harnesses: BackupHarness[] = [];
const roots: string[] = [];

beforeEach(() => {
  roots.push(makeRoot('backup-create-'));
});

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()?.dispose();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) removeRoot(root);
  }
});

function setup(): { harness: BackupHarness; service: DefaultBackupService } {
  const root = roots[roots.length - 1] as string;
  const config = makeBackupConfig(root);
  const db = openDatabase(':memory:');
  const harness = seedState(db, config);
  harnesses.push(harness);
  const service = new DefaultBackupService({ db, config, vault: harness.vault });
  return { harness, service };
}

describe('DefaultBackupService.create/list/read/remove', () => {
  it('writes an encrypted .mcpbak + metadata sidecar with correct counts and permissions', () => {
    const { harness, service } = setup();

    const metadata = service.create({ password: OPERATOR_PASSWORD });

    expect(metadata).toMatchObject({
      gatewayVersion: BACKUP_GATEWAY_VERSION,
      includeAudit: true,
      counts: {
        users: 1,
        keys: 1,
        servers: 3,
        tools: 1,
        profiles: 1,
        catalogSources: 1,
        secrets: 2,
        auditEntries: 2,
      },
    });
    expect(metadata.id).toMatch(/^backup_\d{8}T\d{9}Z_[0-9a-f]{6}$/);
    expect(metadata.fileName).toBe(`${metadata.id}.mcpbak`);

    const dir = join(harness.config.dataDir, 'backups');
    const envelopePath = join(dir, metadata.fileName);
    const metaPath = join(dir, `${metadata.id}.meta.json`);
    expect(existsSync(envelopePath)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(statSync(envelopePath).size).toBe(metadata.sizeBytes);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(envelopePath).mode & 0o777).toBe(0o600);
    expect(statSync(metaPath).mode & 0o777).toBe(0o600);

    // The on-disk envelope never contains plaintext secrets.
    const raw = readFileSync(envelopePath, 'utf8');
    expect(raw).not.toContain(HIDDEN_SECRET_VALUE);
    expect(raw).not.toContain(HIDDEN_GITHUB_TOKEN);
    expect(raw).not.toContain(OPERATOR_PASSWORD);
    expect(raw).not.toContain('password_hash');
    const metaRaw = readFileSync(metaPath, 'utf8');
    expect(metaRaw).not.toContain(HIDDEN_SECRET_VALUE);

    const { metadata: readMetadata, envelope } = service.read(metadata.id);
    expect(readMetadata.id).toBe(metadata.id);
    expect(envelope.format).toBe('mcp-gateway-backup');
    expect(envelope.cipher.name).toBe('aes-256-gcm');
  });

  it('supports excluding audit history and lists backups newest first', async () => {
    const { service } = setup();
    const withoutAudit = service.create({ password: OPERATOR_PASSWORD, includeAudit: false });
    expect(withoutAudit.includeAudit).toBe(false);
    expect(withoutAudit.counts.auditEntries).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const withAudit = service.create({ password: OPERATOR_PASSWORD, includeAudit: true });
    expect(withAudit.counts.auditEntries).toBe(2);

    const listed = service.list();
    expect(listed.map((entry) => entry.id)).toEqual([withAudit.id, withoutAudit.id]);
  });

  it('reads, removes and 404s unknown backups', () => {
    const { harness, service } = setup();
    const metadata = service.create({ password: OPERATOR_PASSWORD });

    service.remove(metadata.id);
    expect(existsSync(join(harness.config.dataDir, 'backups', metadata.fileName))).toBe(false);
    expect(service.list()).toEqual([]);

    try {
      service.read(metadata.id);
      throw new Error('expected read to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).code).toBe(ErrorCodes.TOOL_NOT_FOUND);
      expect((error as GatewayError).httpStatus).toBe(404);
    }
    expect(() => service.remove(metadata.id)).toThrowError(GatewayError);
    expect(() => service.read('../../etc/passwd')).toThrowError(GatewayError);
  });

  it('requires a password to create a backup', () => {
    const { service } = setup();
    expect(() => service.create({ password: '' })).toThrowError(GatewayError);
  });

  it('includes every vault secret (decrypted only in memory)', () => {
    const { harness, service } = setup();
    harness.vault.setSecret('EXTRA_SECRET', 'extra-secret-value');
    const metadata = service.create({ password: OPERATOR_PASSWORD });
    expect(metadata.counts.secrets).toBe(3);
    // The count reflects vault secrets but their values stay encrypted on disk.
    const raw = readFileSync(
      join(harness.config.dataDir, 'backups', metadata.fileName),
      'utf8',
    );
    expect(raw).not.toContain('extra-secret-value');
    expect(raw).not.toContain(HIDDEN_API_KEY_NAME);

    // Sanity: a restore round-trip (covered in restore.test.ts) would decrypt them.
    const { envelope } = service.read(metadata.id);
    expect(envelope.format).toBe('mcp-gateway-backup');
  });
});
