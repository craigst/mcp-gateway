import { describe, expect, it } from 'vitest';
import type { JsonSchema, ToolDescriptor, ToolGuardrail } from '../../src/core/types.js';
import { evaluateGuardrails, validateJsonSchema } from '../../src/rbac/guardrails.js';

function tool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: 'srv_echo:echo',
    name: 'echo',
    description: 'Echo the provided input',
    serverId: 'srv_echo',
    inputSchema: { type: 'object' },
    highPrivilege: false,
    tags: [],
    ...overrides,
  };
}

function schema(overrides: Partial<JsonSchema> = {}): JsonSchema {
  return { type: 'object', ...overrides };
}

describe('validateJsonSchema', () => {
  it('accepts a valid object', () => {
    const result = validateJsonSchema(
      schema({
        properties: { sql: { type: 'string' }, count: { type: 'integer' } },
        required: ['sql'],
      }),
      { sql: 'SELECT 1', count: 2 },
    );
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('reports missing required properties', () => {
    const result = validateJsonSchema(
      schema({ properties: { sql: { type: 'string' } }, required: ['sql'] }),
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('sql');
    expect(result.errors.join(' ')).toContain('required');
  });

  it('reports wrong primitive types', () => {
    const result = validateJsonSchema(schema({ properties: { count: { type: 'number' } } }), {
      count: 'two',
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/expected number/);
  });

  it('supports integer vs number', () => {
    expect(validateJsonSchema({ type: 'integer' }, 2).valid).toBe(true);
    expect(validateJsonSchema({ type: 'integer' }, 2.5).valid).toBe(false);
    expect(validateJsonSchema({ type: 'number' }, 2.5).valid).toBe(true);
  });

  it('supports union types including null', () => {
    const union: JsonSchema = { type: ['string', 'null'] };
    expect(validateJsonSchema(union, 'value').valid).toBe(true);
    expect(validateJsonSchema(union, null).valid).toBe(true);
    expect(validateJsonSchema(union, 3).valid).toBe(false);
    expect(validateJsonSchema({ type: 'null' }, null).valid).toBe(true);
    expect(validateJsonSchema({ type: 'null' }, 'x').valid).toBe(false);
  });

  it('validates pattern, minLength and maxLength', () => {
    const pattern: JsonSchema = { type: 'string', pattern: '^SELECT' };
    expect(validateJsonSchema(pattern, 'SELECT 1').valid).toBe(true);
    expect(validateJsonSchema(pattern, 'DROP TABLE').valid).toBe(false);
    expect(validateJsonSchema({ type: 'string', minLength: 3 }, 'ab').valid).toBe(false);
    expect(validateJsonSchema({ type: 'string', maxLength: 3 }, 'abcd').valid).toBe(false);
  });

  it('validates enum membership', () => {
    const enumSchema: JsonSchema = { type: 'string', enum: ['read', 'write'] };
    expect(validateJsonSchema(enumSchema, 'read').valid).toBe(true);
    expect(validateJsonSchema(enumSchema, 'drop').valid).toBe(false);
    const objectEnum: JsonSchema = { enum: [{ mode: 'a' }] };
    expect(validateJsonSchema(objectEnum, { mode: 'a' }).valid).toBe(true);
    expect(validateJsonSchema(objectEnum, { mode: 'b' }).valid).toBe(false);
  });

  it('enforces additionalProperties: false', () => {
    const strict = schema({ properties: { sql: { type: 'string' } }, additionalProperties: false });
    expect(validateJsonSchema(strict, { sql: 'SELECT 1' }).valid).toBe(true);
    const result = validateJsonSchema(strict, { sql: 'SELECT 1', sneaky: true });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('additional');
  });

  it('validates additionalProperties supplied as a schema', () => {
    const extra = schema({
      properties: { sql: { type: 'string' } },
      additionalProperties: { type: 'number' },
    });
    expect(validateJsonSchema(extra, { sql: 'x', limit: 5 }).valid).toBe(true);
    expect(validateJsonSchema(extra, { sql: 'x', limit: 'five' }).valid).toBe(false);
  });

  it('validates array items', () => {
    const arraySchema: JsonSchema = { type: 'array', items: { type: 'string' } };
    expect(validateJsonSchema(arraySchema, ['a', 'b']).valid).toBe(true);
    const result = validateJsonSchema(arraySchema, ['a', 2]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('[1]');
  });

  it('validates minimum and maximum', () => {
    const bounds: JsonSchema = { type: 'number', minimum: 1, maximum: 10 };
    expect(validateJsonSchema(bounds, 5).valid).toBe(true);
    expect(validateJsonSchema(bounds, 0).valid).toBe(false);
    expect(validateJsonSchema(bounds, 11).valid).toBe(false);
  });

  it('validates nested property paths', () => {
    const nested: JsonSchema = {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          properties: { status: { type: 'string' } },
          required: ['status'],
        },
      },
    };
    const result = validateJsonSchema(nested, { filter: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('$.filter.status');
  });

  it('fails closed on unparseable patterns', () => {
    const result = validateJsonSchema({ type: 'string', pattern: '(' }, 'x');
    expect(result.valid).toBe(false);
  });
});

describe('evaluateGuardrails', () => {
  it('denies arguments matching a deny-list regex', () => {
    const rule: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: '\\b(DROP|UPDATE|DELETE)\\b',
      message: 'destructive SQL is not allowed',
    };
    const decision = evaluateGuardrails([rule], tool({ name: 'read_query' }), {
      sql: 'DROP TABLE users',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('GUARDRAIL_VIOLATION');
    expect(decision.detail).toContain('destructive SQL is not allowed');
  });

  it('allows arguments that do not match a deny-list regex', () => {
    const rule: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: '\\b(DROP|UPDATE|DELETE)\\b',
    };
    expect(evaluateGuardrails([rule], tool(), { sql: 'SELECT 1' })).toEqual({ allowed: true });
  });

  it('is case-insensitive by default and honours explicit flags', () => {
    const insensitive: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: 'drop',
    };
    expect(evaluateGuardrails([insensitive], tool(), { sql: 'DROP TABLE' }).allowed).toBe(false);

    const sensitive: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: 'drop',
      flags: '',
    };
    expect(evaluateGuardrails([sensitive], tool(), { sql: 'DROP TABLE' }).allowed).toBe(true);
  });

  it('supports mustMatch allow-list rules', () => {
    const mustMatch: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: '\\bSELECT\\b',
      mustMatch: true,
      message: 'queries must be SELECT-only',
    };
    expect(evaluateGuardrails([mustMatch], tool(), { sql: 'SELECT 1' }).allowed).toBe(true);
    const denied = evaluateGuardrails([mustMatch], tool(), { sql: 'DELETE FROM t' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('GUARDRAIL_VIOLATION');
    expect(denied.detail).toContain('SELECT-only');
  });

  it('denies arguments that fail a json_schema rule', () => {
    const rule: ToolGuardrail = {
      kind: 'json_schema',
      message: 'invalid payload',
      schema: {
        type: 'object',
        properties: { sql: { type: 'string', pattern: '^SELECT' } },
        required: ['sql'],
      },
    };
    const denied = evaluateGuardrails([rule], tool(), { sql: 'DELETE FROM t' });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('GUARDRAIL_VIOLATION');
    expect(denied.detail).toContain('invalid payload');

    expect(evaluateGuardrails([rule], tool(), { sql: 'SELECT 1' }).allowed).toBe(true);
  });

  it('applies rules only to the matching tool name or id', () => {
    const rule: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: 'danger',
      tool: 'other_tool',
    };
    expect(evaluateGuardrails([rule], tool({ name: 'echo' }), { text: 'danger' }).allowed).toBe(
      true,
    );
    expect(
      evaluateGuardrails([rule], tool({ name: 'other_tool' }), { text: 'danger' }).allowed,
    ).toBe(false);
    expect(
      evaluateGuardrails(
        [{ ...rule, tool: 'srv:other_tool' }],
        tool({ id: 'srv:other_tool', name: 'renamed' }),
        { text: 'danger' },
      ).allowed,
    ).toBe(false);
  });

  it('treats a missing tool selector as applying to every tool', () => {
    const rule: ToolGuardrail = {
      kind: 'regex_applied_to_arguments',
      pattern: 'danger',
    };
    expect(evaluateGuardrails([rule], tool({ name: 'a' }), { text: 'danger' }).allowed).toBe(false);
    expect(evaluateGuardrails([rule], tool({ name: 'b' }), { text: 'danger' }).allowed).toBe(false);
  });

  it('returns allowed when there are no rules', () => {
    expect(evaluateGuardrails([], tool(), { any: 'thing' })).toEqual({ allowed: true });
  });

  it('fails closed on an unknown rule kind', () => {
    const decision = evaluateGuardrails(
      [{ kind: 'mystery' } as unknown as ToolGuardrail],
      tool(),
      {},
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('GUARDRAIL_VIOLATION');
  });
});
