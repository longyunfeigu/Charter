import { describe, expect, it } from 'vitest';
import { cwdRelativeToken, terminalOpenAction } from './terminal-file-open.js';

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
