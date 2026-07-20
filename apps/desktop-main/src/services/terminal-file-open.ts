import { extname, isAbsolute, relative } from 'node:path';
import { TERMINAL_EXTERNAL_OPEN_EXTENSIONS } from '@pi-ide/ipc-contracts';

const EXTERNAL_EXTS = new Set<string>(TERMINAL_EXTERNAL_OPEN_EXTENSIONS);

/** ADR-0033: browser-native files go to the OS default app, the rest to the editor. */
export function terminalOpenAction(path: string): 'external' | 'editor' {
  return EXTERNAL_EXTS.has(extname(path).toLowerCase()) ? 'external' : 'editor';
}

/**
 * Normalize a clicked terminal token to a cwd-relative path. Absolute tokens
 * (OSC 8 file:// links) must already live under the terminal's cwd — anything
 * else is rejected here, so `resolveInsideRoot` only ever sees relative input
 * and still enforces the lexical + symlink containment on top of this.
 */
export function cwdRelativeToken(cwd: string, token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) {
    const rel = relative(cwd, trimmed);
    // '' means the token IS the cwd — a directory, never an openable file.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    return rel;
  }
  return trimmed;
}
