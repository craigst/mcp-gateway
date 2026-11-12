/**
 * The preview and bulk signals read from the first part of a message.
 *
 * These two booleans are what lets the watcher skip a newsletter or a bot
 * notification without spending a Jev call, so they have to be right on real
 * mail — in particular List-Unsubscribe, which mailparser returns as a
 * structure rather than a string.
 */
import { describe, expect, it } from 'vitest';
import { readPreview } from '../../src/email/service.js';

const message = (headers: string[], body = 'Hello there.'): Buffer =>
  Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n'), 'utf8');

const ISO = 'Date: Wed, 12 Nov 2026 09:00:00 +0000';

describe('readPreview', () => {
  it('flags a newsletter by its List-Unsubscribe structure', async () => {
    const source = message([
      'From: Deals <news@shop.example>',
      'Subject: This week',
      ISO,
      'List-Unsubscribe: <https://shop.example/u/1>, <mailto:u@shop.example>',
      'Precedence: bulk',
    ]);
    const result = await readPreview(source, 'This week', 'Deals <news@shop.example>');
    expect(result.listUnsubscribe).toBe(true);
    expect(result.automated).toBe(true);
    expect(result.preview).toContain('Hello there.');
  });

  it('flags an auto-submitted message', async () => {
    const result = await readPreview(
      message(['From: system@example.com', 'Subject: ticket', ISO, 'Auto-Submitted: auto-generated']),
      'ticket',
      'system@example.com',
    );
    expect(result.automated).toBe(true);
    expect(result.listUnsubscribe).toBe(false);
  });

  it('flags a no-reply sender even with no bulk headers', async () => {
    const result = await readPreview(
      message(['From: No Reply <no-reply@example.com>', 'Subject: done', ISO]),
      'done',
      'No Reply <no-reply@example.com>',
    );
    expect(result.automated).toBe(true);
  });

  it('treats Auto-Submitted: no as ordinary mail', async () => {
    const result = await readPreview(
      message(['From: ada@example.com', 'Subject: Q3', ISO, 'Auto-Submitted: no']),
      'Q3',
      'ada@example.com',
    );
    expect(result.automated).toBe(false);
    expect(result.listUnsubscribe).toBe(false);
  });

  it('leaves an ordinary personal message unflagged', async () => {
    const result = await readPreview(
      message(['From: Ada <ada@example.com>', 'Subject: Q3 numbers', ISO]),
      'Q3 numbers',
      'Ada <ada@example.com>',
    );
    expect(result).toMatchObject({ automated: false, listUnsubscribe: false });
    expect(result.preview).toBe('Hello there.');
  });

  it('reads text out of an HTML-only body without markup', async () => {
    const source = Buffer.from(
      [
        'From: ada@example.com',
        'Subject: hi',
        ISO,
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><p>Can you <b>send</b> them?</p><script>evil()</script></body></html>',
      ].join('\r\n'),
      'utf8',
    );
    const result = await readPreview(source, 'hi', 'ada@example.com');
    expect(result.preview).toBe('Can you send them?');
    expect(result.preview).not.toContain('evil');
  });

  it('falls back to the subject when the source is unparseable', async () => {
    const result = await readPreview(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'Fallback subject', 'x@example.com');
    expect(result.preview).toBe('Fallback subject');
  });

  it('caps the preview and survives no source at all', async () => {
    const long = 'a'.repeat(2000);
    const result = await readPreview(undefined, long, 'x@example.com');
    expect(result.preview.length).toBe(600);
    expect(result.listUnsubscribe).toBe(false);
  });
});
