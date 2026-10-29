/**
 * Argument guardrails.
 *
 * Two rule kinds are supported (spec §5.3):
 *  - `regex_applied_to_arguments`: a regex is run against the JSON-serialized arguments.
 *    By default a match is a DENIAL (deny-list); with `mustMatch: true` a non-match is
 *    a denial (allow-list, e.g. SQL must start with SELECT).
 *  - `json_schema`: a pragmatic JSON-Schema subset is validated against the arguments
 *    (type, properties, required, additionalProperties, items, enum, pattern,
 *    minLength/maxLength, minimum/maximum).
 *
 * The validator is intentionally small and dependency-free: guardrails must stay
 * deterministic and must never reach outside the process.
 */
import type {
  AuthorizationDecision,
  JsonSchema,
  ToolDescriptor,
  ToolGuardrail,
} from '../core/types.js';

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function describePath(path: string): string {
  if (path === '') return '$';
  return path.startsWith('[') ? `$${path}` : `$.${path}`;
}

/** Build a dot-separated child path without leading/trailing separators. */
function childPath(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    default:
      // Unknown type keyword: treat as unsatisfiable rather than silently passing.
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
  }
  return false;
}

function validateNode(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
): void {
  const where = describePath(path);

  // --- type ---------------------------------------------------------------
  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = expected.some((candidate) => matchesType(value, candidate));
    if (!ok) {
      errors.push(`${where}: expected ${expected.join(' | ')}, received ${valueType(value)}`);
      return;
    }
  }

  // --- enum ---------------------------------------------------------------
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${where}: value is not one of the allowed enum values`);
  }

  // --- string constraints --------------------------------------------------
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push(`${where}: does not match pattern ${schema.pattern}`);
        }
      } catch {
        errors.push(`${where}: schema pattern is not a valid regular expression`);
      }
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${where}: must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${where}: must be at most ${schema.maxLength} characters`);
    }
  }

  // --- numeric constraints -------------------------------------------------
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${where}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${where}: must be <= ${schema.maximum}`);
    }
  }

  // --- object constraints --------------------------------------------------
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          errors.push(`${where}.${name}: required property is missing`);
        }
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      if (!isPlainObject(propertySchema)) continue;
      validateNode(propertySchema as JsonSchema, value[name], childPath(path, name), errors);
    }
    const additional = schema.additionalProperties;
    if (additional === false || isPlainObject(additional)) {
      for (const [name, entry] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, name)) continue;
        if (additional === false) {
          errors.push(`${where}.${name}: additional properties are not allowed`);
        } else if (isPlainObject(additional)) {
          validateNode(additional as JsonSchema, entry, childPath(path, name), errors);
        }
      }
    }
  }

  // --- array constraints ---------------------------------------------------
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => {
      validateNode(schema.items as JsonSchema, item, `${path}[${index}]`, errors);
    });
  }
}

/** Validate `value` against the supported JSON-Schema subset. */
export function validateJsonSchema(schema: JsonSchema, value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}

function ruleApplies(rule: ToolGuardrail, tool: ToolDescriptor): boolean {
  if (rule.tool === undefined || rule.tool === null) return true;
  return rule.tool === tool.name || rule.tool === tool.id;
}

function serializeArguments(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    // Circular or otherwise unserializable arguments are still inspected.
    return String(args);
  }
}

function violation(detail: string): AuthorizationDecision {
  return {
    allowed: false,
    reason: 'GUARDRAIL_VIOLATION',
    detail: `Guardrail violation: ${detail}`,
  };
}

/**
 * Evaluate every guardrail that applies to `tool` against the call arguments.
 * Returns `{ allowed: true }` when no rule rejects the call. Unknown/malformed
 * rules fail closed.
 */
export function evaluateGuardrails(
  guardrails: ToolGuardrail[],
  tool: ToolDescriptor,
  args: Record<string, unknown>,
): AuthorizationDecision {
  for (const rule of guardrails) {
    if (!ruleApplies(rule, tool)) continue;

    if (rule.kind === 'regex_applied_to_arguments') {
      const pattern = rule.pattern;
      if (typeof pattern !== 'string' || pattern === '') {
        return violation(rule.message ?? 'guardrail rule has no pattern');
      }
      const flags = rule.flags ?? 'i';
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, flags);
      } catch {
        return violation(rule.message ?? `invalid guardrail pattern ${pattern}`);
      }
      const matched = regex.test(serializeArguments(args));
      const requireMatch = rule.mustMatch === true;
      if (requireMatch && !matched) {
        return violation(
          rule.message ?? `arguments did not match the required pattern /${pattern}/${flags}`,
        );
      }
      if (!requireMatch && matched) {
        return violation(rule.message ?? `arguments matched denied pattern /${pattern}/${flags}`);
      }
      continue;
    }

    if (rule.kind === 'json_schema') {
      if (!rule.schema) {
        return violation(rule.message ?? 'guardrail rule has no JSON schema');
      }
      const result = validateJsonSchema(rule.schema, args);
      if (!result.valid) {
        const firstError = result.errors[0] ?? 'arguments failed schema validation';
        return violation(rule.message ? `${rule.message}: ${firstError}` : firstError);
      }
      continue;
    }

    // Unknown rule kind: fail closed rather than silently allowing the call.
    return violation(rule.message ?? `unsupported guardrail kind '${String(rule.kind)}'`);
  }

  return { allowed: true };
}
