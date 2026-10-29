import { describe, expect, it } from 'vitest';
import type { ToolDescriptor } from '../../src/core/types.js';
import {
  VAULTWARDEN_DEFAULT_APPROVAL_TOOLS,
  VAULTWARDEN_DEFAULT_HIGH_PRIVILEGE_TOOLS,
  VAULTWARDEN_DEFAULT_PROTECTION,
  defaultProtectionForTools,
  isKnownVaultwardenProtectionTool,
} from '../../src/vaultwarden/defaults.js';

function tool(name: string): ToolDescriptor {
  return {
    id: `srv_vw:${name}`,
    name,
    description: `${name} fixture`,
    serverId: 'srv_vw',
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
  };
}

describe('VAULTWARDEN_DEFAULT_APPROVAL_TOOLS', () => {
  it('covers the known dangerous delivery/rotation/mutation tools', () => {
    expect(VAULTWARDEN_DEFAULT_APPROVAL_TOOLS).toEqual(
      expect.arrayContaining([
        'vault_deliver_credential',
        'vault_create_webui_login',
        'vault_create_api_key',
        'vault_rotate_webui_login',
        'vault_set_uri',
        'vault_update_metadata',
        'vault_delete_item',
        'secrets_delete',
        'secrets_set_status',
      ]),
    );
    expect(VAULTWARDEN_DEFAULT_APPROVAL_TOOLS.length).toBeGreaterThanOrEqual(9);
  });

  it('does not contain read-only tools', () => {
    for (const name of ['vault_status', 'vault_list_local_ui', 'vault_get_metadata', 'secrets_list', 'secrets_get']) {
      expect(VAULTWARDEN_DEFAULT_APPROVAL_TOOLS).not.toContain(name);
    }
  });

  it('exposes matching high-privilege and UI default sets', () => {
    expect(VAULTWARDEN_DEFAULT_HIGH_PRIVILEGE_TOOLS).toEqual(VAULTWARDEN_DEFAULT_APPROVAL_TOOLS);
    expect(VAULTWARDEN_DEFAULT_PROTECTION.approvalTools).toEqual(VAULTWARDEN_DEFAULT_APPROVAL_TOOLS);
    expect(VAULTWARDEN_DEFAULT_PROTECTION.highPrivilegeTools).toEqual(VAULTWARDEN_DEFAULT_HIGH_PRIVILEGE_TOOLS);
  });

  it('recognises known protection tools by name', () => {
    expect(isKnownVaultwardenProtectionTool('vault_deliver_credential')).toBe(true);
    expect(isKnownVaultwardenProtectionTool('vault_status')).toBe(false);
  });
});

describe('defaultProtectionForTools', () => {
  it('protects known dangerous tools that the server exposes', () => {
    const { approvalTools, highPrivilegeTools } = defaultProtectionForTools([
      tool('vault_deliver_credential'),
      tool('vault_create_api_key'),
      tool('vault_rotate_webui_login'),
      tool('vault_set_uri'),
      tool('vault_update_metadata'),
      tool('vault_delete_item'),
      tool('secrets_delete'),
      tool('secrets_set_status'),
    ]);

    expect(approvalTools).toEqual([
      'vault_deliver_credential',
      'vault_create_api_key',
      'vault_rotate_webui_login',
      'vault_set_uri',
      'vault_update_metadata',
      'vault_delete_item',
      'secrets_delete',
      'secrets_set_status',
    ]);
    expect(highPrivilegeTools).toEqual(approvalTools);
  });

  it('never protects read-only status/list/get tools', () => {
    const { approvalTools, highPrivilegeTools } = defaultProtectionForTools([
      tool('vault_status'),
      tool('vault_list_local_ui'),
      tool('vault_get_metadata'),
      tool('vault_get_credential_metadata'),
      tool('secrets_list'),
      tool('secrets_get_status'),
      tool('vault_search'),
    ]);

    expect(approvalTools).toEqual([]);
    expect(highPrivilegeTools).toEqual([]);
  });

  it('falls back to the mutating-name pattern for unknown tools', () => {
    const { approvalTools } = defaultProtectionForTools([
      tool('vault_remove_shared_access'),
      tool('vault_write_note'),
      tool('vault_put_item'),
      tool('vault_delete_attachment'),
      tool('vault_rotate_token'),
      tool('vault_describe_item'),
      tool('vault_health'),
    ]);

    expect(approvalTools).toEqual([
      'vault_remove_shared_access',
      'vault_write_note',
      'vault_put_item',
      'vault_delete_attachment',
      'vault_rotate_token',
    ]);
  });

  it('only includes known names actually present and preserves descriptor order', () => {
    const { approvalTools } = defaultProtectionForTools([
      tool('vault_create_api_key'),
      tool('vault_status'),
      tool('vault_deliver_credential'),
    ]);
    expect(approvalTools).toEqual(['vault_create_api_key', 'vault_deliver_credential']);
  });

  it('deduplicates names and returns empty sets for no tools', () => {
    expect(defaultProtectionForTools([])).toEqual({ approvalTools: [], highPrivilegeTools: [] });
    const { approvalTools } = defaultProtectionForTools([
      tool('vault_deliver_credential'),
      tool('vault_deliver_credential'),
    ]);
    expect(approvalTools).toEqual(['vault_deliver_credential']);
  });
});
