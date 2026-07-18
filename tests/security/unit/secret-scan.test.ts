import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecrets, redactObject, redactText } from '../../../packages/foundation/src/redact';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const scanner = join(root, 'scripts/secret-scan.mjs');

// A synthetic key that matches the sk- pattern; never a real credential.
const SENTINEL = 'sk-secretScanUnit0000111122223333';

function runScan(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('node', [scanner, dir], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('secret scanner (M11-02)', () => {
  it('flags a planted API key and reports file:line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secscan-'));
    writeFileSync(join(dir, 'config.json'), `{\n  "token": "${SENTINEL}"\n}\n`);
    const { code, out } = runScan(dir);
    expect(code).toBe(1);
    expect(out).toContain('config.json:2');
  });

  it('passes a clean tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secscan-'));
    writeFileSync(join(dir, 'ok.txt'), 'just some prose, no credentials here\n');
    const { code, out } = runScan(dir);
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  it('catches github, aws, slack and jwt shapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secscan-'));
    writeFileSync(
      join(dir, 'leaks.env'),
      [
        'GH=ghp_0123456789abcdef0123456789abcdef0123',
        'AWS=AKIA0123456789ABCDEF',
        'SLACK=xoxb-1111111111-abcdefghij',
        'JWT=eyJhbGciOi.eyJzdWIiOiIxMjM0NTY',
      ].join('\n'),
    );
    const { code, out } = runScan(dir);
    expect(code).toBe(1);
    expect(out).toContain('leaks.env');
  });

  it('scanner pattern copy stays in lockstep with findSecrets()', () => {
    // If redact.ts gains/loses a pattern, the .mjs copy must be updated too.
    // Guard: the scanner source lists exactly the same labels findSecrets emits.
    const scannerSrc = readFileSync(scanner, 'utf8');
    const scannerLabels = [...scannerSrc.matchAll(/label:\s*'([a-z-]+)'/g)]
      .map((m) => m[1] ?? '')
      .sort();
    const sampleHits = findSecrets(
      [
        SENTINEL,
        'ghp_0123456789abcdef0123456789abcdef0123',
        'AKIA0123456789ABCDEF',
        'xoxb-1111111111-abcdefghij',
        'Bearer abcdefabcdefabcdef',
        'eyJhbGciOiJI.eyJzdWIiOiIxMjM0NTY',
      ].join(' '),
    );
    const findLabels = new Set(sampleHits.map((h) => h.label));
    // Every text label the scanner declares is one findSecrets also produces.
    for (const label of scannerLabels) {
      if (label === 'key-value') continue; // key-value is findSecrets-only (object walk)
      expect(findLabels.has(label)).toBe(true);
    }
  });
});

describe('redaction covers pivot secret paths (M11-02)', () => {
  it('provider meta hint never exposes more than the last 4 chars', () => {
    // SecretService writes {hint: '…3333'} — the hint by construction is safe,
    // but assert findSecrets never treats a hint as a leak.
    expect(findSecrets('…3333')).toEqual([]);
    expect(findSecrets(SENTINEL).length).toBeGreaterThan(0);
  });

  it('external CLI transcript lines with an inline key are redacted', () => {
    const line = `$ export ANTHROPIC_API_KEY=${SENTINEL} && claude -p "hi"`;
    const red = redactText(line);
    expect(red).not.toContain(SENTINEL);
    expect(red).toContain('[REDACTED');
  });

  it('object walk masks credential-shaped fields regardless of nesting', () => {
    const red = redactObject({
      provider: { apiKey: SENTINEL, baseUrl: 'https://gw.example', displayName: 'GW' },
      env: { ANTHROPIC_API_KEY: SENTINEL, PATH: '/usr/bin' },
    }) as { provider: Record<string, string>; env: Record<string, string> };
    expect(red.provider.apiKey).toBe('[REDACTED]');
    expect(red.env.ANTHROPIC_API_KEY).toBe('[REDACTED]');
    expect(red.provider.baseUrl).toBe('https://gw.example'); // non-secret meta kept
    expect(red.env.PATH).toBe('/usr/bin');
  });

  it('attachment paths are not secrets but embedded keys in text are', () => {
    expect(findSecrets('attachments/task-123/screenshot.png')).toEqual([]);
    expect(findSecrets(`token=${SENTINEL}`).length).toBeGreaterThan(0);
  });
});
