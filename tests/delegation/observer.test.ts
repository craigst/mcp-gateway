import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  observerToolResult,
  signApprovalToken,
  verifyApprovalToken,
} from '../../src/delegation/observer.js';

const SECRET = 'observer-hmac-secret';
const PAYLOAD = JSON.stringify({ targetId: 'observer-bot', verdict: 'payload safe', nonce: 'nonce-123' });

describe('approval tokens', () => {
  it('signs a deterministic base64url HMAC-SHA256 token', () => {
    const token = signApprovalToken(PAYLOAD, SECRET);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32-byte digest → 43 base64url characters, no padding.
    expect(token).toHaveLength(43);
    expect(signApprovalToken(PAYLOAD, SECRET)).toBe(token);
    expect(token).toBe(createHmac('sha256', SECRET).update(PAYLOAD).digest('base64url'));
  });

  it('verifies a sign/verify round-trip', () => {
    const token = signApprovalToken(PAYLOAD, SECRET);

    expect(verifyApprovalToken(token, PAYLOAD, SECRET)).toBe(true);
    expect(verifyApprovalToken(token, PAYLOAD, 'another-secret')).toBe(false);
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = signApprovalToken(PAYLOAD, 'wrong-secret');

    expect(verifyApprovalToken(token, PAYLOAD, SECRET)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signApprovalToken(PAYLOAD, SECRET);
    const first = token[0] === 'A' ? 'B' : 'A';
    const tampered = `${first}${token.slice(1)}`;

    expect(tampered).not.toBe(token);
    expect(verifyApprovalToken(tampered, PAYLOAD, SECRET)).toBe(false);
  });

  it('rejects a token when the payload was tampered with', () => {
    const token = signApprovalToken(PAYLOAD, SECRET);
    const tamperedPayload = JSON.stringify({ targetId: 'observer-bot', verdict: 'payload safe', nonce: 'nonce-999' });

    expect(verifyApprovalToken(token, tamperedPayload, SECRET)).toBe(false);
  });

  it('rejects empty, malformed and truncated tokens without throwing', () => {
    const token = signApprovalToken(PAYLOAD, SECRET);

    expect(verifyApprovalToken('', PAYLOAD, SECRET)).toBe(false);
    expect(verifyApprovalToken('not-a-valid-token', PAYLOAD, SECRET)).toBe(false);
    expect(verifyApprovalToken('!!!', PAYLOAD, SECRET)).toBe(false);
    expect(verifyApprovalToken(token.slice(0, 10), PAYLOAD, SECRET)).toBe(false);
  });

  it('signs empty payloads', () => {
    const token = signApprovalToken('', SECRET);

    expect(verifyApprovalToken(token, '', SECRET)).toBe(true);
    expect(verifyApprovalToken(token, 'x', SECRET)).toBe(false);
  });
});

describe('observerToolResult', () => {
  it('maps an observer call result onto the public delegation result', () => {
    const result = observerToolResult(
      { status: 'approved', verdict: 'payload safe', approvalToken: 'apr_123', output: { ok: true } },
      { targetId: 'observer-bot', depth: 2, traceId: 'tr_abc', latencyMs: 12.5 },
    );

    expect(result).toEqual({
      targetId: 'observer-bot',
      status: 'approved',
      verdict: 'payload safe',
      approvalToken: 'apr_123',
      output: { ok: true },
      latencyMs: 12.5,
      depth: 2,
      traceId: 'tr_abc',
    });
  });
});
