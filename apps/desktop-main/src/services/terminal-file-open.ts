import { extname, isAbsolute, relative, sep } from 'node:path';
import { TERMINAL_EXTERNAL_OPEN_EXTENSIONS } from '@pi-ide/ipc-contracts';

const EXTERNAL_EXTS = new Set<string>(TERMINAL_EXTERNAL_OPEN_EXTENSIONS);

/** ADR-0033: browser-native files go to the OS default app, the rest to the editor. */
export function terminalOpenAction(path: string): 'external' | 'editor' {
  return EXTERNAL_EXTS.has(extname(path).toLowerCase()) ? 'external' : 'editor';
}

export type TerminalPathToken =
  { kind: 'relative'; path: string } | { kind: 'absolute'; path: string };

/**
 * Classify a clicked terminal token without weakening relative-path containment.
 * Absolute paths outside the terminal cwd are an explicit user capability and
 * may be read for a bounded preview. Relative paths still go through
 * `resolveInsideRoot`, so `../../secret` never becomes an existence oracle.
 */
export function classifyTerminalPathToken(cwd: string, token: string): TerminalPathToken | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) {
    const rel = relative(cwd, trimmed);
    if (rel === '') return null;
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      return { kind: 'absolute', path: trimmed };
    }
    return { kind: 'relative', path: rel };
  }
  return { kind: 'relative', path: trimmed };
}

/**
 * ADR-0033 am.1: batch-verify boundary candidates for `terminal.statTokens`.
 * Per token: normalize against the terminal cwd, then ask `probe` whether a
 * regular file exists there. Containment rejection and probe errors (missing
 * file, symlink escape from resolveInsideRoot) all collapse to `false` — the
 * renderer only needs "is this candidate real", never why not.
 */
export async function verifyTokens(
  cwd: string,
  tokens: string[],
  probe: (cwd: string, candidate: TerminalPathToken) => Promise<boolean>,
): Promise<boolean[]> {
  return Promise.all(
    tokens.map(async (token) => {
      const candidate = classifyTerminalPathToken(cwd, token);
      if (candidate === null) return false;
      try {
        return await probe(cwd, candidate);
      } catch {
        return false;
      }
    }),
  );
}
