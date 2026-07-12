import { describe, expect, it } from 'vitest';
import { redactObject, redactText } from './redact.js';

describe('secret redaction', () => {
  it('masks common API key material in free text', () => {
    const samples = [
      'sk-ant-api03-abcdefghijklmnopqrstuvwx1234567890ABCDEFGH',
      'sk-proj-abc123DEF456ghi789JKL012mno345PQR678stu',
      'ghp_16ZX7BqLwMEyN0rVaGx2K9uQ4T8dS3fJcHb1',
      'AKIAIOSFODNN7EXAMPLE',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      'xoxb-1234567890-abcdefghijklmnop',
    ];
    for (const s of samples) {
      const out = redactText(`prefix ${s} suffix`);
      expect(out, s).not.toContain(s);
      expect(out).toContain('[REDACTED');
      expect(out).toContain('prefix');
      expect(out).toContain('suffix');
    }
  });

  it('masks values of key-like assignments and env exports', () => {
    const out = redactText('export OPENAI_API_KEY=abc123secretvalue && run');
    expect(out).not.toContain('abc123secretvalue');
    expect(out).toContain('OPENAI_API_KEY');
  });

  it('leaves ordinary text intact', () => {
    const text = 'const result = await fetch(url); // normal code, key concept';
    expect(redactText(text)).toBe(text);
  });

  it('deeply redacts objects and masks secret-named fields entirely', () => {
    const out = redactObject({
      apiKey: 'plain-value',
      nested: { authorization: 'Bearer abc', note: 'hello' },
      list: ['token=deadbeefcafe1234567890abcdef', 'fine'],
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).note).toBe('hello');
    const list = out.list as string[];
    expect(list[0]).not.toContain('deadbeefcafe');
    expect(list[1]).toBe('fine');
  });

  it('handles circular objects without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redactObject(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[CIRCULAR]');
  });
});
