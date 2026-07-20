import { describe, expect, it } from 'vitest';
import { cwdRelativeToken, terminalOpenAction, verifyTokens } from './terminal-file-open.js';

describe('terminalOpenAction (ADR-0033 browser/editor split)', () => {
  it('sends browser-native files to the OS default app', () => {
    expect(terminalOpenAction('/p/rocket.html')).toBe('external');
    expect(terminalOpenAction('/p/ROCKET.HTML')).toBe('external');
    expect(terminalOpenAction('/p/a.htm')).toBe('external');
    expect(terminalOpenAction('/p/diagram.svg')).toBe('external');
    expect(terminalOpenAction('/p/spec.pdf')).toBe('external');
  });

  it('sends everything else to the editor, including extensionless names', () => {
    expect(terminalOpenAction('/p/src/app.ts')).toBe('editor');
    expect(terminalOpenAction('/p/index.css')).toBe('editor');
    expect(terminalOpenAction('/p/Makefile')).toBe('editor');
    // .html anywhere but the extension slot must not trigger the browser.
    expect(terminalOpenAction('/p/rocket.html.bak')).toBe('editor');
  });
});

describe('cwdRelativeToken (terminal cwd containment)', () => {
  const cwd = '/Users/dev/playground';

  it('passes relative tokens through untouched', () => {
    expect(cwdRelativeToken(cwd, 'rocket.html')).toBe('rocket.html');
    expect(cwdRelativeToken(cwd, 'src/app.ts')).toBe('src/app.ts');
  });

  it('converts absolute tokens inside the cwd (OSC 8 links) to relative', () => {
    expect(cwdRelativeToken(cwd, '/Users/dev/playground/rocket.html')).toBe('rocket.html');
    expect(cwdRelativeToken(cwd, '/Users/dev/playground/a/b.ts')).toBe('a/b.ts');
  });

  it('rejects absolute tokens outside the cwd and the cwd itself', () => {
    expect(cwdRelativeToken(cwd, '/etc/passwd')).toBeNull();
    expect(cwdRelativeToken(cwd, '/Users/dev/other/x.html')).toBeNull();
    expect(cwdRelativeToken(cwd, cwd)).toBeNull();
  });

  it('rejects blank tokens; ../ escapes are left to resolveInsideRoot', () => {
    expect(cwdRelativeToken(cwd, '   ')).toBeNull();
    // Documented split: lexical/symlink escape checks live in resolveInsideRoot.
    expect(cwdRelativeToken(cwd, '../secrets.env')).toBe('../secrets.env');
  });
});

describe('verifyTokens (ADR-0033 am.1 boundary probe)', () => {
  const cwd = '/Users/dev/playground';
  const filesOnDisk = new Set(['素材/截图 2026.png', 'Screenshot 2026-07-20 at 10.05.32.png']);
  const probe = async (_cwd: string, rel: string) => filesOnDisk.has(rel);

  it('answers per token, preserving request order', async () => {
    await expect(
      verifyTokens(
        cwd,
        ['素材/截图 2026.png', 'nope.png', 'Screenshot 2026-07-20 at 10.05.32.png'],
        probe,
      ),
    ).resolves.toEqual([true, false, true]);
  });

  it('containment rejections and probe errors both collapse to false', async () => {
    await expect(verifyTokens(cwd, ['/etc/passwd', '  '], probe)).resolves.toEqual([false, false]);
    const throwing = async () => {
      throw new Error('symlink escape');
    };
    await expect(verifyTokens(cwd, ['a b.png'], throwing)).resolves.toEqual([false]);
  });

  it('normalizes absolute in-cwd tokens the same way openPath does', async () => {
    await expect(
      verifyTokens(cwd, ['/Users/dev/playground/素材/截图 2026.png'], probe),
    ).resolves.toEqual([true]);
  });
});
