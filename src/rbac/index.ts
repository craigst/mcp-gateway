/**
 * Public RBAC surface.
 *
 * Other modules must import only through this barrel (or `src/core/ports.ts` for
 * interfaces); concrete classes are wired in `src/container.ts`.
 */
export { SqliteKeyService, type KeyServiceOptions } from './keys.js';
export {
  evaluateGuardrails,
  validateJsonSchema,
  type SchemaValidationResult,
} from './guardrails.js';
export { RbacPolicyEngine, type RbacPolicyEngineOptions } from './policy.js';
export { SqliteEscalationService, type EscalationServiceOptions } from './escalations.js';
export {
  SqliteKeyActivityService,
  type KeyActivityServiceDeps,
} from './key-activity.js';
