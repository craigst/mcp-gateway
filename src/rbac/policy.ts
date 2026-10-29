/**
 * Policy Decision Point: server grant -> tool whitelist -> high-privilege masking
 * -> argument guardrails.
 *
 * Zero-trust rules (spec §3, §4):
 *  - A key can only see/call servers present in its `serverGrants`.
 *  - High-privilege tools are invisible unless explicitly named in
 *    `grant.highPrivilegeTools`; a wildcard tool grant never unlocks them.
 *  - The master key has complete catalog access (spec §6).
 *
 * Denials are expressed as `AuthorizationDecision`s with machine-readable reasons;
 * mapping them to JSON-RPC `-32001` payloads is the gateway's responsibility.
 */
import { createLogger, type Logger } from '../core/logger.js';
import type { PolicyEngine } from '../core/ports.js';
import type {
  AuthenticatedKey,
  AuthorizationDecision,
  ServerGrant,
  ToolDescriptor,
  ToolGuardrail,
} from '../core/types.js';
import { evaluateGuardrails } from './guardrails.js';

export interface RbacPolicyEngineOptions {
  logger?: Logger;
}

function namesTool(identifiers: string[] | null | undefined, tool: ToolDescriptor): boolean {
  if (!Array.isArray(identifiers)) return false;
  return identifiers.includes(tool.name) || identifiers.includes(tool.id);
}

export class RbacPolicyEngine implements PolicyEngine {
  private readonly logger: Logger;

  constructor(options: RbacPolicyEngineOptions = {}) {
    this.logger = options.logger ?? createLogger('rbac');
  }

  /** The master key is the only key type with unrestricted catalog visibility. */
  private isMaster(key: AuthenticatedKey): boolean {
    return key.keyType === 'master';
  }

  private grantFor(key: AuthenticatedKey, serverId: string): ServerGrant | null {
    if (!Array.isArray(key.serverGrants)) return null;
    return key.serverGrants.find((grant) => grant.serverId === serverId) ?? null;
  }

  isServerPaused(key: AuthenticatedKey, serverId: string): boolean {
    return this.grantFor(key, serverId)?.paused === true;
  }

  isServerPermitted(key: AuthenticatedKey, serverId: string): boolean {
    if (this.isMaster(key)) return true;
    return this.grantFor(key, serverId) !== null;
  }

  isToolPermitted(key: AuthenticatedKey, tool: ToolDescriptor): boolean {
    if (this.isMaster(key)) return true;
    const grant = this.grantFor(key, tool.serverId);
    if (!grant) return false;
    if (tool.highPrivilege) return namesTool(grant.highPrivilegeTools, tool);
    if (grant.tools === undefined || grant.tools === null) return true;
    return namesTool(grant.tools, tool);
  }

  evaluateCall(
    key: AuthenticatedKey,
    tool: ToolDescriptor,
    args: Record<string, unknown>,
  ): AuthorizationDecision {
    const grant = this.grantFor(key, tool.serverId);

    // Pauses are availability restrictions layered on top of the grants. They are
    // reported with their own reasons but answered with the same -32001 envelope
    // as any other scope denial (the gateway maps the reason into `data.reason`).
    if (grant?.paused === true) {
      return {
        allowed: false,
        reason: 'SERVER_PAUSED',
        detail: `Server '${tool.serverId}' is paused for this key.`,
      };
    }

    if (!this.isMaster(key)) {
      if (!grant) {
        return {
          allowed: false,
          reason: 'SERVER_NOT_PERMITTED',
          detail: `Server '${tool.serverId}' is not granted to this key.`,
        };
      }
      if (tool.highPrivilege && !namesTool(grant.highPrivilegeTools, tool)) {
        return {
          allowed: false,
          reason: 'HIGH_PRIVILEGE_RESTRICTION',
          detail: `Tool '${tool.name}' requires an explicit high-privilege grant.`,
        };
      }
      if (
        !tool.highPrivilege &&
        grant.tools !== undefined &&
        grant.tools !== null &&
        !namesTool(grant.tools, tool)
      ) {
        return {
          allowed: false,
          reason: 'TOOL_NOT_PERMITTED',
          detail: `Tool '${tool.name}' is not whitelisted for this key.`,
        };
      }
    }

    // The tool is otherwise granted/visible, but an operator paused it for this key.
    if (grant && namesTool(grant.pausedTools, tool)) {
      return {
        allowed: false,
        reason: 'TOOL_PAUSED',
        detail: `Tool '${tool.name}' is paused for this key.`,
      };
    }

    // Guardrails attached to an explicit grant always apply, including for master keys.
    const guardrails = grant?.guardrails ?? [];
    if (guardrails.length > 0) {
      const guardrailDecision = evaluateGuardrails(guardrails, tool, args);
      if (!guardrailDecision.allowed) {
        this.logger.warn('guardrail denied tool call', {
          keyId: key.id,
          toolId: tool.id,
          detail: guardrailDecision.detail,
        });
        return guardrailDecision;
      }
    }

    return { allowed: true };
  }

  canDelegate(key: AuthenticatedKey): boolean {
    return key.delegationAllowed === true;
  }

  canEscalate(key: AuthenticatedKey): boolean {
    return key.escalationAllowed === true;
  }

  guardrailsFor(key: AuthenticatedKey, tool: ToolDescriptor): ToolGuardrail[] {
    return this.grantFor(key, tool.serverId)?.guardrails ?? [];
  }
}
