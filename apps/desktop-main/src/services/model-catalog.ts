import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { ModelDescriptor } from '@pi-ide/agent-contract';
import type { ProviderApi } from '@pi-ide/ipc-contracts';

/** Full provider record needed to list models (resolved by SecretService). */
export interface CatalogProvider {
  providerId: string;
  displayName: string;
  api: ProviderApi;
  apiKey: string;
  /** Effective endpoint (official API or gateway); null only when unknown. */
  baseUrl: string | null;
  /** Canonical Pi provider used to seed candidates for a derived route. */
  registryProviderId?: string;
}

interface ParsedModel {
  modelId: string;
  displayName: string;
  contextWindow?: number | null;
  registryModel?: ModelDescriptor;
}

export interface RemoteModelFetchResult {
  /** Models that completed a real, minimal inference request. */
  models: ModelDescriptor[];
  /** Unique model ids advertised by the provider's model-list endpoint. */
  advertisedCount: number;
  /** Unique same-provider model ids supplied by Pi's built-in registry. */
  registryCandidateCount: number;
  /** Unique ids in the advertised + registry union that were probed. */
  candidateCount: number;
  /** Candidate ids that did not complete the verification request. */
  unavailableModelIds: string[];
  /** Protocol routes attempted for the source credential. */
  routeCount: number;
  /** Derived protocol routes whose model-list request failed. */
  failedRouteIds: string[];
}

export interface ModelCatalogOptions {
  listTimeoutMs?: number;
  probeTimeoutMs?: number;
  probeConcurrency?: number;
  /** Non-secret, point-in-time verified catalogue persisted across app restarts. */
  cacheFile?: string;
}

interface ProbeResult {
  model: ParsedModel;
  available: boolean;
  status: number | null;
}

const CACHE_VERSION = 1;
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Anthropic protocol: GET <base>/v1/models, x-api-key auth. */
function anthropicRequest(provider: CatalogProvider): {
  url: string;
  headers: Record<string, string>;
} {
  const base = (provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  // Page-size query only for the official API — gateways may reject params.
  const query = base === 'https://api.anthropic.com' ? '?limit=100' : '';
  return {
    url: `${base}/v1/models${query}`,
    // Gateways commonly accept either header scheme; send both.
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${provider.apiKey}`,
    },
  };
}

/** OpenAI protocol: GET <base>/models (bases include /v1 by convention). */
function openaiRequest(provider: CatalogProvider): {
  url: string;
  headers: Record<string, string>;
} {
  const base = (provider.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  return {
    url: `${base}/models`,
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  };
}

function anthropicProbeRequest(
  provider: CatalogProvider,
  modelId: string,
): { url: string; headers: Record<string, string>; body: string } {
  const base = (provider.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  return {
    url: `${base}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    // A raw provider request avoids Charter's system preamble and tools. One
    // input character + one output token is enough to prove current routing.
    body: JSON.stringify({
      model: modelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: '1' }],
      stream: false,
    }),
  };
}

function openAiProbeRequest(
  provider: CatalogProvider,
  modelId: string,
): { url: string; headers: Record<string, string>; body: string } {
  const base = (provider.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const openAiResponses = provider.providerId === 'openai';
  return {
    // Pi's built-in OpenAI provider uses Responses, including when its base URL
    // is redirected. Other OpenAI-compatible providers are synthesized by
    // Charter with Pi's openai-completions adapter.
    url: openAiResponses ? `${base}/responses` : `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: openAiResponses
      ? // Pi's OpenAI Responses adapter clamps to the provider's accepted
        // minimum; values below 16 are rejected before model routing occurs.
        JSON.stringify({ model: modelId, input: '1', max_output_tokens: 16, store: false })
      : JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: '1' }],
          // Match Pi's synthesized openai-completions adapter. Some mixed
          // gateways reject non-streaming chat requests even though Charter's
          // real streaming sessions are supported.
          max_completion_tokens: 16,
          store: false,
          stream: true,
        }),
  };
}

function parseAnthropic(body: unknown, provider: CatalogProvider): ParsedModel[] {
  const data = (body as { data?: Array<{ id: string; display_name?: string }> }).data ?? [];
  const canonicalAnthropic = (provider.registryProviderId ?? provider.providerId) === 'anthropic';
  return data
    .filter((model) => (canonicalAnthropic ? /^claude/i.test(model.id) : true))
    .map((m) => ({ modelId: m.id, displayName: m.display_name ?? m.id }));
}

/** OpenAI-shaped list — OpenRouter adds name/context_length; LiteLLM id only. */
function parseOpenAi(body: unknown, provider: CatalogProvider): ParsedModel[] {
  const data =
    (body as { data?: Array<{ id: string; name?: string; context_length?: number }> }).data ?? [];
  const builtInOpenAi = (provider.registryProviderId ?? provider.providerId) === 'openai';
  return data
    .filter((m) =>
      // The official OpenAI list is full of non-chat artifacts; gateways and
      // aggregators list exactly what they serve — keep everything there.
      builtInOpenAi ? /^(gpt|o[0-9]|chatgpt)/i.test(m.id) : true,
    )
    .map((m) => ({
      modelId: m.id,
      displayName: m.name ?? m.id,
      contextWindow: m.context_length ?? null,
    }));
}

export type FetchLike = (
  url: string,
  init: {
    method?: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

function hasApiError(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  return record.type === 'error' || (record.error !== undefined && record.error !== null);
}

function hasEventStreamError(body: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      if (hasApiError(JSON.parse(payload))) return true;
    } catch {
      // Ignore keepalive/vendor-specific SSE fields that are not JSON.
    }
  }
  return false;
}

function isCachedModel(value: unknown): value is ModelDescriptor {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<ModelDescriptor>;
  return (
    typeof model.providerId === 'string' &&
    typeof model.providerName === 'string' &&
    typeof model.modelId === 'string' &&
    typeof model.displayName === 'string' &&
    (typeof model.contextWindow === 'number' || model.contextWindow === null) &&
    typeof model.supportsThinking === 'boolean' &&
    Array.isArray(model.supportedThinkingLevels) &&
    model.supportedThinkingLevels.length > 0 &&
    model.supportedThinkingLevels.every((level) => THINKING_LEVELS.includes(level)) &&
    typeof model.configured === 'boolean' &&
    ['api-key', 'oauth', 'none', 'unknown'].includes(model.authKind ?? '')
  );
}

/**
 * Live provider model catalog (PIVOT-009/026/033): fetches each configured
 * provider's model list with its stored key, unions those ids with Pi's
 * same-provider registry, verifies every unique candidate with a minimal
 * inference, persists that point-in-time result, and merges it into
 * registry-backed models.list. Main process only.
 */
export class ModelCatalogService {
  private readonly cache = new Map<string, ModelDescriptor[]>();
  private readonly listTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probeConcurrency: number;
  private readonly cacheFile: string | null;

  constructor(
    private readonly getProvider: (providerId: string) => CatalogProvider | null,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    options: ModelCatalogOptions = {},
  ) {
    this.listTimeoutMs = options.listTimeoutMs ?? 12_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.probeConcurrency = Math.max(1, Math.min(options.probeConcurrency ?? 4, 8));
    this.cacheFile = options.cacheFile ?? null;
    this.loadCache();
  }

  cached(): ModelDescriptor[] {
    return [...this.cache.values()].flat();
  }

  /** Forget a provider's fetched models (credential deleted). */
  evict(providerId: string): void {
    this.cache.delete(providerId);
    this.persistCache();
  }

  /**
   * A configured provider is fail-closed: only its point-in-time verified ids
   * are exposed. Registry metadata still wins for an exact verified id, but
   * unverified registry ids never leak back into the picker.
   */
  merge(registry: ModelDescriptor[]): ModelDescriptor[] {
    const providerConfigured = new Map<string, boolean>();
    const configured = (providerId: string): boolean => {
      const known = providerConfigured.get(providerId);
      if (known !== undefined) return known;
      const value = this.getProvider(providerId) !== null;
      providerConfigured.set(providerId, value);
      return value;
    };
    const registryByKey = new Map(
      registry.map((model) => [`${model.providerId}::${model.modelId}`, model] as const),
    );
    const merged = registry.filter((model) => !configured(model.providerId));
    for (const [providerId, models] of this.cache) {
      if (!configured(providerId)) continue;
      for (const model of models) {
        const registryModel = registryByKey.get(`${providerId}::${model.modelId}`);
        merged.push(
          registryModel
            ? {
                ...registryModel,
                providerName: model.providerName,
                configured: true,
                authKind: 'api-key' as const,
              }
            : model,
        );
      }
    }
    return merged;
  }

  async fetchRemote(
    providerId: string,
    registryModels: readonly ModelDescriptor[] = [],
  ): Promise<RemoteModelFetchResult> {
    const provider = this.getProvider(providerId);
    if (!provider) {
      throw new ProductFailure(
        productError('MODELS_NO_CREDENTIAL', {
          userMessage: `Add an API key for "${providerId}" first, then fetch models.`,
        }),
      );
    }
    if (provider.api === 'openai' && provider.baseUrl === null && providerId !== 'openai') {
      throw new ProductFailure(
        productError('MODELS_NO_BASE_URL', {
          userMessage: `${provider.displayName} needs a Base URL before models can be listed.`,
        }),
      );
    }
    const request =
      provider.api === 'anthropic' ? anthropicRequest(provider) : openaiRequest(provider);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.listTimeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: 'GET',
        headers: request.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ProductFailure(
          productError(response.status === 401 ? 'MODELS_BAD_CREDENTIAL' : 'MODELS_FETCH_FAILED', {
            userMessage:
              response.status === 401
                ? `${provider.displayName} rejected the API key (401). Check the key in Settings.`
                : `${provider.displayName} model list failed with HTTP ${response.status}.`,
            retryable: response.status !== 401,
          }),
        );
      }
      const body = await response.json();
      const advertised =
        provider.api === 'anthropic' ? parseAnthropic(body, provider) : parseOpenAi(body, provider);
      const advertisedCandidates = [
        ...new Map(advertised.map((model) => [model.modelId, model] as const)).values(),
      ];
      const registryProviderId = provider.registryProviderId ?? providerId;
      const exactRegistryModels = registryModels.filter((model) => model.providerId === providerId);
      const registrySourceModels =
        exactRegistryModels.length > 0
          ? exactRegistryModels
          : registryModels.filter((model) => model.providerId === registryProviderId);
      const registryCandidates = [
        ...new Map(
          registrySourceModels.map(
            (model) =>
              [
                model.modelId,
                {
                  modelId: model.modelId,
                  displayName: model.displayName,
                  contextWindow: model.contextWindow,
                  registryModel: model,
                },
              ] as const,
          ),
        ).values(),
      ];
      // Pi's registry is the authoritative metadata/order for built-in
      // providers. The remote list can still contribute gateway-only ids.
      const candidates = [
        ...new Map(
          [...registryCandidates, ...advertisedCandidates].map(
            (model) => [model.modelId, model] as const,
          ),
        ).values(),
      ];
      const probeResults = await this.probeModels(provider, candidates);
      const verified = probeResults
        .filter((result) => result.available)
        .map((result) => result.model);
      const models: ModelDescriptor[] = verified.map((m) => ({
        providerId: provider.providerId,
        providerName: provider.displayName,
        modelId: m.modelId,
        displayName: m.displayName,
        contextWindow: m.contextWindow ?? null,
        supportsThinking: m.registryModel?.supportsThinking ?? false,
        // The list/probe APIs expose no reasoning metadata. Exact registry ids
        // recover their real capabilities in merge(); synthesized ids remain
        // permissive because the gateway owns their contract.
        supportedThinkingLevels: m.registryModel?.supportedThinkingLevels ?? [...THINKING_LEVELS],
        configured: true,
        authKind: 'api-key',
      }));
      this.cache.set(providerId, models);
      this.persistCache();
      const unavailable = probeResults.filter((result) => !result.available);
      this.logger.info('remote models fetched and verified', {
        providerId,
        advertised: advertisedCandidates.length,
        registryCandidates: registryCandidates.length,
        candidates: candidates.length,
        available: models.length,
        unavailable: unavailable.length,
      });
      for (const result of unavailable) {
        this.logger.debug('remote model unavailable', {
          providerId,
          modelId: result.model.modelId,
          status: result.status,
        });
      }
      return {
        models,
        advertisedCount: advertisedCandidates.length,
        registryCandidateCount: registryCandidates.length,
        candidateCount: candidates.length,
        unavailableModelIds: unavailable.map((result) => result.model.modelId),
        routeCount: 1,
        failedRouteIds: [],
      };
    } catch (e) {
      if (e instanceof ProductFailure) throw e;
      throw new ProductFailure(
        productError('MODELS_FETCH_FAILED', {
          userMessage: `Could not reach ${provider.displayName} to list models (network error or timeout).`,
          technicalMessage: errorMessage(e),
          retryable: true,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeModels(
    provider: CatalogProvider,
    models: ParsedModel[],
  ): Promise<ProbeResult[]> {
    if (models.length === 0) return [];
    const results = new Array<ProbeResult>(models.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const model = models[index];
        if (!model) return;
        results[index] = await this.probeModel(provider, model);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.probeConcurrency, models.length) }, () => worker()),
    );
    return results;
  }

  private async probeModel(provider: CatalogProvider, model: ParsedModel): Promise<ProbeResult> {
    const request =
      provider.api === 'anthropic'
        ? anthropicProbeRequest(provider, model.modelId)
        : openAiProbeRequest(provider, model.modelId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      let body: unknown = null;
      let streamError = false;
      const streamingOpenAi =
        provider.api === 'openai' && provider.providerId !== 'openai' && response.text;
      if (streamingOpenAi) {
        try {
          streamError = hasEventStreamError(await response.text!());
        } catch {
          // HTTP status still decides if a proxy closes without a readable body.
        }
      } else {
        try {
          body = await response.json();
        } catch {
          // A successful proxy may return an empty/non-JSON body. The HTTP
          // success still proves it accepted and routed the minimal request.
        }
      }
      return {
        model,
        available: response.ok && !streamError && !hasApiError(body),
        status: response.status,
      };
    } catch {
      return { model, available: false, status: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private loadCache(): void {
    if (!this.cacheFile) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as {
        version?: number;
        providers?: Record<string, unknown>;
      };
      if (parsed.version !== CACHE_VERSION || !parsed.providers) return;
      for (const [providerId, value] of Object.entries(parsed.providers)) {
        if (
          !Array.isArray(value) ||
          !value.every(isCachedModel) ||
          !value.every((model) => model.providerId === providerId)
        ) {
          continue;
        }
        this.cache.set(providerId, value);
      }
    } catch {
      // Missing/corrupt cache is non-fatal; Settings can rebuild it explicitly.
    }
  }

  private persistCache(): void {
    if (!this.cacheFile) return;
    const tempFile = `${this.cacheFile}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(
        tempFile,
        JSON.stringify({
          version: CACHE_VERSION,
          providers: Object.fromEntries(this.cache),
        }),
      );
      renameSync(tempFile, this.cacheFile);
    } catch (error) {
      rmSync(tempFile, { force: true });
      this.logger.warn('verified model cache could not be saved', { error: errorMessage(error) });
    }
  }
}
