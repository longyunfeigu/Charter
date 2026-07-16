import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from '@pi-ide/foundation';
import { SHELL_INTEGRATION_FILES } from '@pi-ide/terminal-service';

/**
 * ADR-0021: materialize the shell-integration scripts once per launch under
 * the app's own data directory. Returns the directory to hand to
 * TerminalManager, or null when writing failed — spawning then degrades to
 * plain terminals instead of erroring (TERM-003).
 */
export function writeShellIntegrationFiles(userDataDir: string, logger: Logger): string | null {
  const dir = join(userDataDir, 'shell-integration');
  try {
    for (const file of SHELL_INTEGRATION_FILES) {
      const target = join(dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, 'utf8');
    }
    return dir;
  } catch (e) {
    logger.warn('shell integration scripts unavailable — terminals stay plain', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
