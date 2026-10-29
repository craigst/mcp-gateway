/**
 * Default protection policy for the Vaultwarden MCP server (v0.2).
 *
 * Vaultwarden tools either read non-sensitive metadata or perform dangerous
 * operations: delivering a credential to a short-lived file, creating/rotating
 * logins and API keys, changing item URIs/metadata, or deleting items. The
 * dangerous ones must be high-privilege and gated behind a supervisor approval.
 */
import type { ToolDescriptor } from '../core/types.js';

/**
 * Known mutating/delivery tool names shipped by `vaultwarden-mcp`.
 * Used as the preferred defaults when the server actually exposes them.
 */
export const VAULTWARDEN_DEFAULT_APPROVAL_TOOLS: string[] = [
  'vault_deliver_credential',
  'vault_create_webui_login',
  'vault_create_api_key',
  'vault_rotate_webui_login',
  'vault_set_uri',
  'vault_update_metadata',
  'vault_delete_item',
  'secrets_delete',
  'secrets_set_status',
];

/**
 * Default high-privilege set for Vaultwarden. Every approval-gated tool is also
 * high-privilege, so the two default sets start identical.
 */
export const VAULTWARDEN_DEFAULT_HIGH_PRIVILEGE_TOOLS: string[] = [...VAULTWARDEN_DEFAULT_APPROVAL_TOOLS];

/** Defaults used by the UI install call-to-action when no server is installed. */
export const VAULTWARDEN_DEFAULT_PROTECTION = {
  approvalTools: [...VAULTWARDEN_DEFAULT_APPROVAL_TOOLS],
  highPrivilegeTools: [...VAULTWARDEN_DEFAULT_HIGH_PRIVILEGE_TOOLS],
};

/**
 * Fallback heuristic for tools that are not in the known list. Read-only
 * inspection tools (`vault_status`, `vault_list_local_ui`, `vault_get_metadata`,
 * `secrets_list`, …) never match and are therefore never protected.
 */
const MUTATING_TOOL_PATTERN = /(deliver|create|rotate|delete|set_uri|update|write|put|remove)/;

/** True when a tool name is a known dangerous Vaultwarden operation. */
export function isKnownVaultwardenProtectionTool(name: string): boolean {
  return VAULTWARDEN_DEFAULT_APPROVAL_TOOLS.includes(name);
}

/**
 * Resolve the default protection sets for the tools a Vaultwarden server
 * actually exposes.
 *
 * Explicit known names win over the heuristic; other tools are protected when
 * their name looks mutating. Read-only status/list/get tools stay unprotected.
 * The result preserves the descriptor order (stable UI output).
 */
export function defaultProtectionForTools(tools: ToolDescriptor[]): {
  approvalTools: string[];
  highPrivilegeTools: string[];
} {
  const approvalTools: string[] = [];
  for (const tool of tools) {
    const name = tool.name;
    if (typeof name !== 'string' || name === '' || approvalTools.includes(name)) continue;
    if (isKnownVaultwardenProtectionTool(name) || MUTATING_TOOL_PATTERN.test(name)) {
      approvalTools.push(name);
    }
  }
  // All approval-gated tools are high-privilege by definition.
  return { approvalTools, highPrivilegeTools: [...approvalTools] };
}
