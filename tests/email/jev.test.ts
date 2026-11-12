/**
 * The Jev client — the only place mail leaves the gateway for a model.
 *
 * Two properties matter more than the happy path:
 *   1. the request is the one Cloud's relay already accepts (same instructions,
 *      same criteria, same model), and
 *   2. every failure is a refusal, never a guess: a timeout, a 429 or a shape
 *      that does not check out returns ok:false and the mail is left alone.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  JEV_SCAM_CRITERIA,
  JEV_SCAM_INSTRUCTIONS,
  JEV_TRIAGE_INSTRUCTIONS,
  JEV_TRIAGE_OPTIONS,
  JevClient,
  clean,
  jevEndpoint,
  jevRequestBody,
  parseJevResponse,
} from '../../src/email/jev.js';

const KEY = 'apik_test_key';

const answer = (triage: string, probabilities: Record<string, number>, noul = 0.1) => ({
  answers: {
    triage: { type: 'choice', choice: triage, probabilities },
    scam: { type: 'noul', noul },
  },
  model: 'jev-1.14.0',
});

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const email = { from: 'Ada <ada@example.com>', subject: 'Q3 numbers', preview: 'Can you send them?' };

describe('jevRequestBody', () => {
  it('sends the contract Cloud\'s relay already accepts', () => {
    const body = jevRequestBody(email);
    expect(body.model).toBe('jev-latest');
    expect(body.questions.triage).toEqual({
      type: 'choice',
      instructions: JEV_TRIAGE_INSTRUCTIONS,
      criteria: { ...JEV_TRIAGE_OPTIONS },
    });
    expect(body.questions.scam).toEqual({
      type: 'noul',
      instructions: JEV_SCAM_INSTRUCTIONS,
      criteria: { ...JEV_SCAM_CRITERIA },
    });
    expect(body.state.email).toEqual(email);
  });

  it('caps the state so a long body cannot blow the relay limit', () => {
    const body = jevRequestBody({ from: 'a'.repeat(400), subject: 'b'.repeat(400), preview: 'c'.repeat(4000) });
    expect(body.state.email.from).toHaveLength(160);
    expect(body.state.email.subject).toHaveLength(200);
    expect(body.state.email.preview).toHaveLength(600);
  });

  it('sends at most 20 dismissed senders, cleaned', () => {
    const dismissed = Array.from({ length: 30 }, (_value, index) => `sender${index}@example.com`);
    const body = jevRequestBody(email, { dismissedFrom: dismissed });
    expect(body.state.dismissed_senders).toHaveLength(20);
    expect(body.state.dismissed_senders?.[0]).toBe('sender0@example.com');
  });

  it('omits dismissed_senders when there are none', () => {
    expect(jevRequestBody(email).state).not.toHaveProperty('dismissed_senders');
  });
});

describe('clean', () => {
  it('strips control characters, collapses whitespace and caps length', () => {
    expect(clean('a\u0000b\u001fc\n\n d', 100)).toBe('a b c d');
    expect(clean('x'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('jevEndpoint', () => {
  it('accepts https and loopback http, rejects anything else', () => {
    expect(jevEndpoint()?.toString()).toBe('https://api.typesafe.ai/v1/systemone');
    expect(jevEndpoint('http://127.0.0.1:9000')?.toString()).toBe('http://127.0.0.1:9000/v1/systemone');
    expect(jevEndpoint('http://api.typesafe.ai')).toBeNull();
    expect(jevEndpoint('https://user:pass@api.typesafe.ai')).toBeNull();
    expect(jevEndpoint('not a url')).toBeNull();
  });
});

describe('parseJevResponse', () => {
  it('reads both answers', () => {
    expect(parseJevResponse(answer('reply', { reply: 0.91, important: 0.09, skip: 0 }, 0.99))).toEqual({
      triage: 'reply',
      pTop: 0.91,
      scamP: 0.99,
    });
  });

  it('rejects an option that was not offered', () => {
    expect(parseJevResponse(answer('archive', { archive: 1 }))).toBeNull();
  });

  it('rejects probabilities that do not sum to one', () => {
    expect(parseJevResponse(answer('reply', { reply: 0.5, important: 0.2, skip: 0.2 }))).toBeNull();
  });

  it('rejects a choice that is not the most likely option', () => {
    expect(parseJevResponse(answer('skip', { reply: 0.8, important: 0.1, skip: 0.1 }))).toBeNull();
  });

  it('rejects a missing or out-of-range scam answer', () => {
    expect(parseJevResponse({ answers: { triage: { choice: 'skip', probabilities: { skip: 1 } } } })).toBeNull();
    expect(parseJevResponse(answer('skip', { skip: 1 }, 1.4))).toBeNull();
  });
});

describe('JevClient.judge', () => {
  const client = (fetchImpl: typeof fetch, apiKey: string | null = KEY): JevClient =>
    new JevClient({ apiKey, baseUrl: 'https://api.typesafe.ai', fetchImpl });

  it('is disabled with no key, and calls nothing', async () => {
    const fetchImpl = vi.fn();
    const result = await client(fetchImpl as unknown as typeof fetch, null).judge(email);
    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns the verdict and sends the bearer token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse(answer('reply', { reply: 0.95, important: 0.05, skip: 0 }, 0.02));
    }) as unknown as typeof fetch;
    const result = await client(fetchImpl).judge(email);
    expect(result).toMatchObject({ ok: true, verdict: { triage: 'reply', scamP: 0.02 } });
    expect(calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('maps refusals to reasons instead of guessing', async () => {
    const cases: Array<[number, string]> = [
      [401, 'rejected'],
      [429, 'rate_limited'],
      [503, 'overloaded'],
      [413, 'too_large'],
      [500, 'http_error'],
    ];
    for (const [status, reason] of cases) {
      const fetchImpl = (async () => jsonResponse({}, status)) as unknown as typeof fetch;
      await expect(client(fetchImpl).judge(email)).resolves.toMatchObject({ ok: false, reason });
    }
  });

  it('treats a shape it cannot trust as malformed', async () => {
    const bad = (async () => jsonResponse({ answers: { triage: { choice: 'reply', probabilities: { reply: 0.2 } } } })) as unknown as typeof fetch;
    await expect(client(bad).judge(email)).resolves.toMatchObject({ ok: false, reason: 'malformed' });
    const html = (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(client(html).judge(email)).resolves.toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('times out rather than hanging the batch', async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;
    await expect(client(slow).judge(email, { timeoutMs: 20 })).resolves.toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('reports an unreachable host without throwing', async () => {
    const broken = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(client(broken).judge(email)).resolves.toMatchObject({ ok: false, reason: 'unreachable' });
  });
});
