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
}

interface ParsedModel {
  modelId: string;
  displayName: string;
  contextWindow?: number | null;
}

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

function parseAnthropic(body: unknown): ParsedModel[] {
  const data = (body as { data?: Array<{ id: string; display_name?: string }> }).data ?? [];
  return data.map((m) => ({ modelId: m.id, displayName: m.display_name ?? m.id }));
}

/** OpenAI-shaped list — OpenRouter adds name/context_length; LiteLLM id only. */
function parseOpenAi(body: unknown, provider: CatalogProvider): ParsedModel[] {
  const data =
    (body as { data?: Array<{ id: string; name?: string; context_length?: number }> }).data ?? [];
  const officialOpenAi = provider.providerId === 'openai' && provider.baseUrl === null;
  return data
    .filter((m) =>
      // The official OpenAI list is full of non-chat artifacts; gateways and
      // aggregators list exactly what they serve — keep everything there.
      officialOpenAi ? /^(gpt|o[0-9]|chatgpt)/i.test(m.id) : true,
    )
    .map((m) => ({
      modelId: m.id,
      displayName: m.name ?? m.id,
      contextWindow: m.context_length ?? null,
    }));
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Live provider model catalog (PIVOT-009/026/033): fetches each configured
 * provider's model list with its stored key over its protocol, caches per
 * session, and merges into the registry-backed models.list. Main process only.
 */
export class ModelCatalogService {
  private readonly cache = new Map<string, ModelDescriptor[]>();

  constructor(
    private readonly getProvider: (providerId: string) => CatalogProvider | null,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly timeoutMs = 12_000,
  ) {}

  cached(): ModelDescriptor[] {
    return [...this.cache.values()].flat();
  }

  /** Forget a provider's fetched models (credential deleted). */
  evict(providerId: string): void {
    this.cache.delete(providerId);
  }

  /** Merge registry models with remotely fetched ones (registry wins on id clashes). */
  merge(registry: ModelDescriptor[]): ModelDescriptor[] {
    const seen = new Set(registry.map((m) => `${m.providerId}::${m.modelId}`));
    const merged = [...registry];
    for (const model of this.cached()) {
      const key = `${model.providerId}::${model.modelId}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(model);
      }
    }
    return merged;
  }

  async fetchRemote(providerId: string): Promise<ModelDescriptor[]> {
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
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(request.url, {
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
      const parsed =
        provider.api === 'anthropic' ? parseAnthropic(body) : parseOpenAi(body, provider);
      const models: ModelDescriptor[] = parsed.map((m) => ({
        providerId: provider.providerId,
        providerName: provider.displayName,
        modelId: m.modelId,
        displayName: m.displayName,
        contextWindow: m.contextWindow ?? null,
        supportsThinking: false,
        // Gateway-listed models expose no reasoning metadata — offer the full
        // range; the runtime clamps per model at session creation.
        supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        configured: true,
        authKind: 'api-key',
      }));
      this.cache.set(providerId, models);
      this.logger.info('remote models fetched', { providerId, count: models.length });
      return models;
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
}
