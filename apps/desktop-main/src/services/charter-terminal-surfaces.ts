import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { errorMessage } from '@pi-ide/foundation';
import type { CharterTerminalSurfaceDto } from '@pi-ide/ipc-contracts';
import { CHARTER_TERMINAL_SKILL } from './terminal-control-manual.js';

/**
 * ADR-0045: user-level instruction surfaces for external CLIs.
 *
 * The MCP wrapper chain (PATH-prepended shims) breaks whenever the user's own
 * shell wins the resolution race — aliases, profile PATH prepends, installer
 * migrations. These surfaces are immune to all of that: ~/.claude/skills and
 * ~/.codex/skills are read by every claude/codex session regardless of how it
 * was launched, and the manual they teach relies only on the pty-injected
 * CHARTER_* environment. Writes happen exclusively on an explicit settings
 * click; every safety rule stays enforced host-side either way.
 */
const SURFACE_TARGETS = [
  { target: 'claude', dir: '.claude' },
  { target: 'codex', dir: '.codex' },
] as const;

function skillFile(home: string, dir: string): string {
  return join(home, dir, 'skills', 'charter-terminal', 'SKILL.md');
}

function statusOf(target: 'claude' | 'codex', path: string): CharterTerminalSurfaceDto {
  try {
    const content = readFileSync(path, 'utf8');
    return {
      target,
      path,
      installed: true,
      upToDate: content === CHARTER_TERMINAL_SKILL,
      error: null,
    };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      target,
      path,
      installed: false,
      upToDate: false,
      error: missing ? null : errorMessage(error),
    };
  }
}

export function charterTerminalSurfaceStatus(home = homedir()): CharterTerminalSurfaceDto[] {
  return SURFACE_TARGETS.map(({ target, dir }) => statusOf(target, skillFile(home, dir)));
}

/** Install or refresh the manual on every surface. Per-target failures land in
 * the returned status (partial success is fine: one CLI may be sandboxed). */
export function installCharterTerminalSurfaces(home = homedir()): CharterTerminalSurfaceDto[] {
  return SURFACE_TARGETS.map(({ target, dir }) => {
    const file = skillFile(home, dir);
    try {
      mkdirSync(join(home, dir, 'skills', 'charter-terminal'), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, CHARTER_TERMINAL_SKILL, 'utf8');
      renameSync(tmp, file);
      return { target, path: file, installed: true, upToDate: true, error: null };
    } catch (error) {
      return { target, path: file, installed: false, upToDate: false, error: errorMessage(error) };
    }
  });
}
