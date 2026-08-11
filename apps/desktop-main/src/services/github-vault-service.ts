import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';

/**
 * The GitHub personal access token, encrypted with the OS keychain (ADR-0056).
 *
 * Deliberately separate from SecretService (provider/api-key shaped — a GitHub
 * token stored there would surface in the model provider catalog) and from
 * SshVaultService (host-keyed). Same discipline as both: the renderer only
 * ever learns booleans and the verified login; plaintext stays in Main.
 */
export class GithubVaultService {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private get file(): string {
    return join(this.dir, 'github-token.bin');
  }

  private get metaFile(): string {
    return `${this.file}.meta`;
  }

  set(token: string, login: string): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new ProductFailure(
        productError('SEC_ENCRYPTION_UNAVAILABLE', {
          userMessage:
            'OS-level encryption is unavailable; the GitHub token cannot be stored safely.',
          severity: 'fatal',
        }),
      );
    }
    const encrypted = safeStorage.encryptString(JSON.stringify({ kind: 'github-token', token }));
    writeFileSync(this.file, encrypted);
    // login is display metadata (shown in Settings), never the secret itself.
    writeFileSync(this.metaFile, JSON.stringify({ login, updatedAt: new Date().toISOString() }));
    this.logger.info('github token stored', { login });
  }

  has(): boolean {
    return existsSync(this.file);
  }

  /** Login captured when the token was verified and stored; null when unset. */
  login(): string | null {
    if (!existsSync(this.metaFile)) return null;
    try {
      const meta = JSON.parse(readFileSync(this.metaFile, 'utf8')) as { login?: unknown };
      return typeof meta.login === 'string' && meta.login ? meta.login : null;
    } catch {
      return null;
    }
  }

  clear(): boolean {
    const existed = existsSync(this.file);
    rmSync(this.file, { force: true });
    rmSync(this.metaFile, { force: true });
    if (existed) this.logger.info('github token cleared');
    return existed;
  }

  /** Decrypt for one API call (main-process only, never to the renderer). */
  get(): string | null {
    if (!existsSync(this.file)) return null;
    try {
      const payload = JSON.parse(safeStorage.decryptString(readFileSync(this.file))) as {
        kind: string;
        token: string;
      };
      if (payload.kind !== 'github-token') return null;
      return payload.token;
    } catch (e) {
      this.logger.warn('github token unreadable', { error: errorMessage(e) });
      return null;
    }
  }
}
