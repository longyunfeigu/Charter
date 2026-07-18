import { safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { WorkerCredential } from '@pi-ide/agent-contract';
import {
  effectiveBaseUrl,
  providerPreset,
  type ProviderApi,
  type ProviderInfoDto,
} from '@pi-ide/ipc-contracts';

export interface ProviderMeta {
  baseUrl?: string | null;
  api?: ProviderApi;
  displayName?: string;
}

/** Legacy meta files (pre multi-provider) only knew anthropic/openai. */
function inferApi(providerId: string): ProviderApi {
  const preset = providerPreset(providerId);
  if (preset) return preset.api;
  return providerId === 'openai' ? 'openai' : 'anthropic';
}

function inferName(providerId: string): string {
  return providerPreset(providerId)?.displayName ?? providerId;
}

/**
 * Provider credentials encrypted with the OS keychain scope (ONB-004).
 * The renderer only ever sees `configured` + a masked hint; plaintext exists
 * in the main process transiently and in the agent worker for the session.
 * Non-secret provider meta (protocol, endpoint, display name) rides alongside.
 */
export class SecretService {
  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(providerId: string): string {
    const safe = providerId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.bin`);
  }

  setApiKey(providerId: string, apiKey: string, meta: ProviderMeta = {}): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new ProductFailure(
        productError('SEC_ENCRYPTION_UNAVAILABLE', {
          userMessage: 'OS-level encryption is unavailable; credentials cannot be stored safely.',
          severity: 'fatal',
        }),
      );
    }
    const normalizedBaseUrl = meta.baseUrl?.trim().replace(/\/+$/, '') || null;
    const api = meta.api ?? inferApi(providerId);
    const displayName = meta.displayName?.trim() || inferName(providerId);
    const payload = JSON.stringify({ kind: 'api-key', value: apiKey, baseUrl: normalizedBaseUrl });
    const encrypted = safeStorage.encryptString(payload);
    const hint = apiKey.length > 4 ? `…${apiKey.slice(-4)}` : '…';
    writeFileSync(this.fileFor(providerId), encrypted);
    writeFileSync(
      `${this.fileFor(providerId)}.meta`,
      JSON.stringify({
        providerId,
        hint,
        // Protocol/endpoint/name are not secrets — kept in meta for UI display.
        baseUrl: normalizedBaseUrl,
        api,
        displayName,
        updatedAt: new Date().toISOString(),
      }),
    );
    this.logger.info('credential stored', {
      providerId,
      api,
      hasBaseUrl: normalizedBaseUrl !== null,
    });
  }

  delete(providerId: string): boolean {
    const file = this.fileFor(providerId);
    const existed = existsSync(file);
    rmSync(file, { force: true });
    rmSync(`${file}.meta`, { force: true });
    if (existed) this.logger.info('credential deleted', { providerId });
    return existed;
  }

  list(): ProviderInfoDto[] {
    const items: ProviderInfoDto[] = [];
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.meta')) continue;
        try {
          const meta = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as {
            providerId: string;
            hint: string;
            baseUrl?: string | null;
            api?: ProviderApi;
            displayName?: string;
          };
          items.push({
            providerId: meta.providerId,
            configured: true,
            hint: meta.hint,
            baseUrl: meta.baseUrl ?? null,
            api: meta.api ?? inferApi(meta.providerId),
            displayName: meta.displayName ?? inferName(meta.providerId),
          });
        } catch {
          // skip broken meta
        }
      }
    } catch {
      // dir unreadable
    }
    return items.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  hasAny(): boolean {
    return this.list().length > 0;
  }

  private decrypt(providerId: string): { value: string; baseUrl: string | null } | null {
    try {
      const encrypted = readFileSync(this.fileFor(providerId));
      const payload = JSON.parse(safeStorage.decryptString(encrypted)) as {
        kind: string;
        value: string;
        baseUrl?: string | null;
      };
      if (payload.kind !== 'api-key') return null;
      return { value: payload.value, baseUrl: payload.baseUrl ?? null };
    } catch (e) {
      this.logger.warn('credential unreadable', {
        providerId,
        error: errorMessage(e),
      });
      return null;
    }
  }

  /** Full provider record for the model catalog (main-process only). */
  catalogProvider(providerId: string): {
    providerId: string;
    displayName: string;
    api: ProviderApi;
    apiKey: string;
    baseUrl: string | null;
  } | null {
    const info = this.list().find((i) => i.providerId === providerId);
    if (!info) return null;
    const secret = this.decrypt(providerId);
    if (!secret) return null;
    return {
      providerId,
      displayName: info.displayName,
      api: info.api,
      apiKey: secret.value,
      baseUrl: effectiveBaseUrl(providerId, info.api, info.baseUrl),
    };
  }

  /** Decrypted credentials for the agent worker (never crosses to the renderer). */
  credentialsForWorker(): WorkerCredential[] {
    const credentials: WorkerCredential[] = [];
    for (const item of this.list()) {
      const secret = this.decrypt(item.providerId);
      if (!secret) continue;
      // Builtin providers (anthropic/openai) keep the runtime's native config
      // unless the user explicitly set a gateway URL; custom providers always
      // get their EFFECTIVE endpoint (preset defaults resolved) so the
      // runtime adapter needs no preset knowledge.
      const builtin = providerPreset(item.providerId)?.builtin ?? false;
      credentials.push({
        providerId: item.providerId,
        kind: 'api-key',
        value: secret.value,
        baseUrl: builtin
          ? secret.baseUrl
          : effectiveBaseUrl(item.providerId, item.api, secret.baseUrl),
        api: item.api,
      });
    }
    return credentials;
  }
}
