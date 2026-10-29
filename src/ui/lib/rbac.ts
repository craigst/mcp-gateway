/**
 * Pure RBAC scope-grid helpers: grant summarisation, high-privilege detection,
 * scope matrix construction for the key-creation grid, and form validation.
 *
 * Kept dependency-free (apart from core types) so it is trivially unit-testable.
 */
import { KEY_TYPES } from '../../core/types.js';
import type { KeyType, ServerGrant, ServerRecord } from '../../core/types.js';

export interface GrantSummary {
  serverId: string;
  /** `null` means every non-high-privilege tool of the server is granted. */
  tools: string[] | null;
  toolCount: number | null;
  highPrivilegeTools: string[];
  guardrailCount: number;
}

/** Normalise a key's server grants into display-friendly summaries. */
export function summarizeGrants(grants?: readonly ServerGrant[] | null): GrantSummary[] {
  return (grants ?? []).map((grant) => ({
    serverId: grant.serverId,
    tools: grant.tools ? [...grant.tools] : null,
    toolCount: grant.tools ? grant.tools.length : null,
    highPrivilegeTools: grant.highPrivilegeTools ? [...grant.highPrivilegeTools] : [],
    guardrailCount: grant.guardrails?.length ?? 0,
  }));
}

/** One-line description used by the key table. */
export function describeGrants(grants?: readonly ServerGrant[] | null): string {
  const summaries = summarizeGrants(grants);
  if (summaries.length === 0) return 'No grants';
  return summaries
    .map((summary) => {
      const tools =
        summary.toolCount === null
          ? 'all tools'
          : `${summary.toolCount} tool${summary.toolCount === 1 ? '' : 's'}`;
      const highPrivilege =
        summary.highPrivilegeTools.length > 0 ? ` + ${summary.highPrivilegeTools.length} high-priv` : '';
      return `${summary.serverId} (${tools}${highPrivilege})`;
    })
    .join(' · ');
}

function toolBareName(toolId: string): string {
  const separator = toolId.lastIndexOf(':');
  return separator >= 0 ? toolId.slice(separator + 1) : toolId;
}

/**
 * High-privilege tools are only callable when explicitly named in
 * `highPrivilegeTools` — they can never be implied by a broad `tools: null` grant.
 */
export function isHighPrivilegeGranted(grant: ServerGrant | null | undefined, toolId: string): boolean {
  if (!grant) return false;
  const granted = grant.highPrivilegeTools ?? [];
  if (granted.includes(toolId)) return true;
  const bare = toolBareName(toolId);
  return bare !== toolId && granted.includes(bare);
}

/** Minimal structural tool shape accepted by `buildScopeMatrix`. */
export interface ScopeTool {
  id: string;
  name: string;
  serverId: string;
  highPrivilege?: boolean;
}

export interface ScopeCell {
  toolId: string;
  toolName: string;
  highPrivilege: boolean;
  /** Whether the key may invoke the tool given these grants. */
  granted: boolean;
  /** Whether the high-privilege tool was explicitly granted. */
  highPrivilegeGranted: boolean;
}

export interface ScopeRow {
  serverId: string;
  serverName: string;
  server: ServerRecord | null;
  grant: ServerGrant | null;
  serverGranted: boolean;
  cells: ScopeCell[];
  toolCount: number;
  grantedCount: number;
}

/**
 * Build the rows powering the RBAC scope grid: one row per registered server,
 * one cell per tool, with the effective grant state for a key.
 */
export function buildScopeMatrix(
  servers: readonly ServerRecord[],
  tools: readonly ScopeTool[],
  grants?: readonly ServerGrant[] | null,
): ScopeRow[] {
  const grantList = grants ?? [];
  const toolsByServer = new Map<string, ScopeTool[]>();
  for (const tool of tools) {
    const bucket = toolsByServer.get(tool.serverId);
    if (bucket) bucket.push(tool);
    else toolsByServer.set(tool.serverId, [tool]);
  }

  return servers.map((server) => {
    const grant = grantList.find((candidate) => candidate.serverId === server.id) ?? null;
    const highPrivilegeNames = new Set(server.highPrivilegeTools ?? []);
    const serverTools = toolsByServer.get(server.id) ?? [];
    const cells: ScopeCell[] = serverTools.map((tool) => {
      const highPrivilege =
        tool.highPrivilege === true ||
        highPrivilegeNames.has(tool.name) ||
        highPrivilegeNames.has(tool.id);
      const highPrivilegeGranted =
        isHighPrivilegeGranted(grant, tool.id) || isHighPrivilegeGranted(grant, tool.name);
      let granted = false;
      if (grant) {
        if (highPrivilege) granted = highPrivilegeGranted;
        else if (grant.tools == null) granted = true;
        else granted = grant.tools.includes(tool.name) || grant.tools.includes(tool.id);
      }
      return {
        toolId: tool.id,
        toolName: tool.name,
        highPrivilege,
        granted,
        highPrivilegeGranted,
      };
    });
    return {
      serverId: server.id,
      serverName: server.name,
      server,
      grant,
      serverGranted: grant !== null,
      cells,
      toolCount: cells.length,
      grantedCount: cells.filter((cell) => cell.granted).length,
    };
  });
}

// ---------------------------------------------------------------------------
// Key creation form validation
// ---------------------------------------------------------------------------

export interface KeyFormState {
  name: string;
  keyType: KeyType;
  serverGrants: ServerGrant[];
  delegationAllowed: boolean;
  escalationAllowed: boolean;
  /** Raw form value; blank/null means "never expires". */
  expiresInSeconds?: number | string | null;
}

export interface KeyFormErrors {
  name?: string;
  keyType?: string;
  expiresInSeconds?: string;
  serverGrants?: string;
}

export function validateKeyForm(form: KeyFormState): KeyFormErrors {
  const errors: KeyFormErrors = {};

  const name = form.name.trim();
  if (name.length === 0) errors.name = 'Name is required';
  else if (name.length < 2) errors.name = 'Name must be at least 2 characters';
  else if (name.length > 64) errors.name = 'Name must be at most 64 characters';

  if (!KEY_TYPES.includes(form.keyType)) errors.keyType = 'Select a valid key type';

  const expires = form.expiresInSeconds;
  if (expires !== null && expires !== undefined && String(expires).trim() !== '') {
    const parsed = typeof expires === 'number' ? expires : Number(expires);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.expiresInSeconds = 'Expiry must be a positive number of seconds';
    } else if (!Number.isInteger(parsed)) {
      errors.expiresInSeconds = 'Expiry must be a whole number of seconds';
    }
  }

  const serverIds = form.serverGrants.map((grant) => grant.serverId.trim());
  if (serverIds.some((id) => id.length === 0)) {
    errors.serverGrants = 'Every grant needs a server';
  } else if (new Set(serverIds).size !== serverIds.length) {
    errors.serverGrants = 'Duplicate server grants are not allowed';
  }

  return errors;
}

export function hasFormErrors(errors: KeyFormErrors): boolean {
  return Object.values(errors).some((value) => typeof value === 'string' && value.length > 0);
}
