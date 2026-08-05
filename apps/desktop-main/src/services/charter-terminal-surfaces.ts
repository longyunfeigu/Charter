import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from '@pi-ide/foundation';
import type { CharterTerminalSurfaceDto } from '@pi-ide/ipc-contracts';
import { CHARTER_TERMINAL_SKILL } from './terminal-control-manual.js';
import { CHARTER_ORCHESTRATION_SKILL } from './orchestration-manual.js';

/**
 * ADR-0045: user-level instruction surfaces for external CLIs.
 *
 * The MCP wrapper chain (PATH-prepended shims) breaks whenever the user's own
 * shell wins the resolution race — aliases, profile PATH prepends, installer
 * migrations. These surfaces are immune to all of that: ~/.claude/skills and
 * ~/.codex/skills are read by every claude/codex session regardless of how it
 * was launched, and the manual they teach relies only on the pty-injected
 * CHARTER_* environment. Charter synchronizes only its own reserved Skill
 * folders before external Sessions can launch; the Settings action remains an
 * explicit repair path. Every safety rule stays enforced host-side either way.
 */
export interface CharterTerminalSurfaceTarget {
  target: string;
  /** Absolute provider-owned skills root from the trusted Agent manifest. */
  root: string;
}

function skillFile(root: string): string {
  return join(root, 'charter-terminal', 'SKILL.md');
}

function orchestrationSkillFile(root: string): string {
  return join(root, 'charter-orchestration', 'SKILL.md');
}

function statusOf(
  target: string,
  path: string,
  orchestrationPath: string,
): CharterTerminalSurfaceDto {
  try {
    const content = readFileSync(path, 'utf8');
    return {
      target,
      path,
      installed: true,
      upToDate:
        content === CHARTER_TERMINAL_SKILL &&
        readFileSync(orchestrationPath, 'utf8') === CHARTER_ORCHESTRATION_SKILL,
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

export function charterTerminalSurfaceStatus(
  targets: readonly CharterTerminalSurfaceTarget[],
): CharterTerminalSurfaceDto[] {
  return targets.map(({ target, root }) =>
    statusOf(target, skillFile(root), orchestrationSkillFile(root)),
  );
}

/** Synchronize the product-owned manuals on every detected Agent surface.
 * Per-target failures land in the returned status (partial success is fine:
 * one CLI may be sandboxed). */
export function installCharterTerminalSurfaces(
  targets: readonly CharterTerminalSurfaceTarget[],
): CharterTerminalSurfaceDto[] {
  return targets.map(({ target, root }) => {
    const file = skillFile(root);
    try {
      mkdirSync(join(root, 'charter-terminal'), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, CHARTER_TERMINAL_SKILL, 'utf8');
      renameSync(tmp, file);
      const orchestrationFile = orchestrationSkillFile(root);
      mkdirSync(join(root, 'charter-orchestration'), { recursive: true });
      const orchestrationTmp = `${orchestrationFile}.tmp-${process.pid}`;
      writeFileSync(orchestrationTmp, CHARTER_ORCHESTRATION_SKILL, 'utf8');
      renameSync(orchestrationTmp, orchestrationFile);
      return { target, path: file, installed: true, upToDate: true, error: null };
    } catch (error) {
      return { target, path: file, installed: false, upToDate: false, error: errorMessage(error) };
    }
  });
}
