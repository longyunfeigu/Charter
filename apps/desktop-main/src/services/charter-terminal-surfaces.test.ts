import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  charterTerminalSurfaceStatus,
  installCharterTerminalSurfaces,
} from './charter-terminal-surfaces.js';
import { CHARTER_TERMINAL_SKILL } from './terminal-control-manual.js';

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'charter-surfaces-'));
  homes.push(home);
  return home;
}

function surfaceTargets(home: string) {
  return [
    { target: 'claude', root: join(home, '.claude', 'skills') },
    { target: 'codex', root: join(home, '.codex', 'skills') },
    { target: 'kimi', root: join(home, '.kimi-code', 'skills') },
  ];
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('charter-terminal user-level instruction surfaces (ADR-0045)', () => {
  it('reports both CLIs as not installed on a fresh home', () => {
    const home = tempHome();
    const statuses = charterTerminalSurfaceStatus(surfaceTargets(home));
    expect(statuses.map((s) => s.target)).toEqual(['claude', 'codex', 'kimi']);
    expect(statuses.every((s) => !s.installed && !s.upToDate && s.error === null)).toBe(true);
  });

  it('installs the bundled manual into ~/.claude/skills and ~/.codex/skills', () => {
    const home = tempHome();
    const installed = installCharterTerminalSurfaces(surfaceTargets(home));
    expect(installed.every((s) => s.installed && s.upToDate && s.error === null)).toBe(true);
    for (const dir of ['.claude', '.codex', '.kimi-code']) {
      const content = readFileSync(
        join(home, dir, 'skills', 'charter-terminal', 'SKILL.md'),
        'utf8',
      );
      expect(content).toBe(CHARTER_TERMINAL_SKILL);
    }
  });

  it('flags an outdated install and refreshes it on the next install click', () => {
    const home = tempHome();
    installCharterTerminalSurfaces(surfaceTargets(home));
    const claudeFile = join(home, '.claude', 'skills', 'charter-terminal', 'SKILL.md');
    writeFileSync(claudeFile, '# stale manual from an older build\n', 'utf8');

    const before = charterTerminalSurfaceStatus(surfaceTargets(home));
    expect(before.find((s) => s.target === 'claude')).toMatchObject({
      installed: true,
      upToDate: false,
    });
    expect(before.find((s) => s.target === 'codex')).toMatchObject({
      installed: true,
      upToDate: true,
    });

    installCharterTerminalSurfaces(surfaceTargets(home));
    expect(readFileSync(claudeFile, 'utf8')).toBe(CHARTER_TERMINAL_SKILL);
  });

  it('degrades to a per-target error instead of throwing when one CLI dir is unwritable', () => {
    const home = tempHome();
    // ~/.claude/skills exists but is read-only; ~/.codex must still succeed.
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    chmodSync(join(home, '.claude', 'skills'), 0o500);
    try {
      const installed = installCharterTerminalSurfaces(surfaceTargets(home));
      const claude = installed.find((s) => s.target === 'claude')!;
      const codex = installed.find((s) => s.target === 'codex')!;
      expect(claude.installed).toBe(false);
      expect(claude.error).toBeTruthy();
      expect(codex.installed).toBe(true);
      expect(codex.error).toBeNull();
    } finally {
      chmodSync(join(home, '.claude', 'skills'), 0o700);
    }
  });
});
