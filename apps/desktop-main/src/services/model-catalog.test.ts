import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductFailure, createLogger } from '@pi-ide/foundation';
import type { ModelDescriptor } from '@pi-ide/agent-contract';
import { ModelCatalogService, type CatalogProvider, type FetchLike } from './model-catalog.js';

const logger = createLogger('test', { write: () => undefined });

function fetchReturning(status: number, body: unknown): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic',
    apiKey: 'sk-test-123',
    baseUrl: 'https://api.anthropic.com',
    ...overrides,
  };
}

const anthropicBody = {
  data: [
    { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
    { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
  ],
};

describe('ModelCatalogService (PIVOT-009/033)', () => {
  it('fetches, maps and caches provider models with the stored key', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => (init.method === 'POST' ? { content: [] } : anthropicBody),
      };
    };
    const catalog = new ModelCatalogService(() => provider(), logger, fetchImpl);
    const result = await catalog.fetchRemote('anthropic');
    expect(result.models.map((m) => m.modelId)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
    expect(result.models[0]!.displayName).toBe('Claude Opus 4.8');
    expect(result.models[0]!.configured).toBe(true);
    expect(result.advertisedCount).toBe(2);
    expect(result.registryCandidateCount).toBe(0);
    expect(result.candidateCount).toBe(2);
    expect(result.routeCount).toBe(1);
    expect(result.failedRouteIds).toEqual([]);
    expect(result.unavailableModelIds).toEqual([]);
    expect(seen).toHaveLength(3); // one list + one minimal probe per model
    expect(seen[0]!.headers['x-api-key']).toBe('sk-test-123');
    expect(seen.slice(1).every((request) => request.method === 'POST')).toBe(true);
    expect(catalog.cached()).toHaveLength(2);
  });

  it('only exposes verified ids and preserves exact registry metadata', async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init.method !== 'POST') {
        return { ok: true, status: 200, json: async () => anthropicBody };
      }
      const model = (JSON.parse(init.body ?? '{}') as { model?: string }).model;
      return model === 'claude-opus-4-8'
        ? { ok: false, status: 500, json: async () => ({ type: 'error', error: 'no account' }) }
        : { ok: true, status: 200, json: async () => ({ content: [] }) };
    };
    const catalog = new ModelCatalogService(() => provider(), logger, fetchImpl);
    const registry: ModelDescriptor[] = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        modelId: 'claude-opus-4-8',
        displayName: 'Opus (registry)',
        contextWindow: 200000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
        configured: true,
        authKind: 'api-key',
      },
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        modelId: 'claude-haiku-4-5',
        displayName: 'Haiku (registry)',
        contextWindow: 200000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high'],
        configured: true,
        authKind: 'api-key',
      },
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        modelId: 'claude-sonnet-5',
        displayName: 'Sonnet 5 (registry)',
        contextWindow: 200000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'medium'],
        configured: true,
        authKind: 'api-key',
      },
    ];
    // Configured providers are fail-closed until Settings verification runs.
    expect(catalog.merge(registry)).toEqual([]);

    const result = await catalog.fetchRemote('anthropic', registry);
    expect(result.advertisedCount).toBe(2);
    expect(result.registryCandidateCount).toBe(3);
    expect(result.candidateCount).toBe(3);
    expect(result.unavailableModelIds).toEqual(['claude-opus-4-8']);
    const merged = catalog.merge(registry);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.modelId).toBe('claude-haiku-4-5');
    expect(merged[0]!.displayName).toBe('Haiku (registry)');
    expect(merged[0]!.supportsThinking).toBe(true);
    expect(merged[1]!.modelId).toBe('claude-sonnet-5');
    expect(merged[1]!.displayName).toBe('Sonnet 5 (registry)');
  });

  it('probes the unique same-provider union without mixing in another provider', async () => {
    const probed: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'claude-haiku-4-5', display_name: 'Haiku advertised duplicate' },
              { id: 'claude-gateway-only', display_name: 'Gateway only' },
            ],
          }),
        };
      }
      probed.push((JSON.parse(init.body ?? '{}') as { model: string }).model);
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    };
    const catalog = new ModelCatalogService(() => provider(), logger, fetchImpl);
    const registry: ModelDescriptor[] = [
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        modelId: 'claude-haiku-4-5',
        displayName: 'Haiku registry',
        contextWindow: 200000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'low'],
        configured: true,
        authKind: 'api-key',
      },
      {
        providerId: 'anthropic',
        providerName: 'Anthropic',
        modelId: 'claude-sonnet-5',
        displayName: 'Sonnet 5 registry only',
        contextWindow: 200000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'medium'],
        configured: true,
        authKind: 'api-key',
      },
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        contextWindow: 400000,
        supportsThinking: true,
        supportedThinkingLevels: ['medium'],
        configured: true,
        authKind: 'api-key',
      },
    ];

    const result = await catalog.fetchRemote('anthropic', registry);

    expect(result.advertisedCount).toBe(2);
    expect(result.registryCandidateCount).toBe(2);
    expect(result.candidateCount).toBe(3);
    expect(probed).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-gateway-only']);
    expect(probed).not.toContain('gpt-5.6-sol');
  });

  it('seeds a derived OpenAI route from canonical registry models and probes streaming chat', async () => {
    const requests: Array<{ model: string; stream?: boolean; max?: number }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init.method !== 'POST') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'gpt-5.4' }, { id: 'claude-sonnet-5' }] }),
        };
      }
      const body = JSON.parse(init.body ?? '{}') as {
        model: string;
        stream?: boolean;
        max_completion_tokens?: number;
      };
      requests.push({
        model: body.model,
        stream: body.stream,
        max: body.max_completion_tokens,
      });
      const ok = body.model === 'gpt-5.6-sol';
      return {
        // Some gateways return an SSE error under HTTP 200. Verification must
        // inspect the stream instead of treating the status alone as success.
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () =>
          ok
            ? 'data: {"choices":[{"delta":{"content":"1"}}]}\n\ndata: [DONE]\n\n'
            : 'data: {"error":{"message":"unavailable"}}\n\ndata: [DONE]\n\n',
      };
    };
    const catalog = new ModelCatalogService(
      () =>
        provider({
          providerId: 'anthropic__openai',
          displayName: 'OpenAI via Anthropic gateway',
          api: 'openai',
          baseUrl: 'http://gateway.test/api/v1',
          registryProviderId: 'openai',
        }),
      logger,
      fetchImpl,
    );
    const openAiRegistry: ModelDescriptor[] = [
      {
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        contextWindow: 272000,
        supportsThinking: true,
        supportedThinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
        configured: false,
        authKind: 'unknown',
      },
    ];

    const result = await catalog.fetchRemote('anthropic__openai', openAiRegistry);

    expect(result.advertisedCount).toBe(1); // Claude id is not an OpenAI-route candidate.
    expect(result.registryCandidateCount).toBe(1);
    expect(result.candidateCount).toBe(2);
    expect(result.models).toEqual([
      expect.objectContaining({
        providerId: 'anthropic__openai',
        modelId: 'gpt-5.6-sol',
        displayName: 'GPT-5.6 Sol',
        supportsThinking: true,
      }),
    ]);
    expect(requests).toEqual([
      { model: 'gpt-5.6-sol', stream: true, max: 16 },
      { model: 'gpt-5.4', stream: true, max: 16 },
    ]);
  });

  it('classifies missing keys and bad keys', async () => {
    const noKey = new ModelCatalogService(() => null, logger, fetchReturning(200, {}));
    await expect(noKey.fetchRemote('anthropic')).rejects.toSatisfy(
      (e: unknown) => e instanceof ProductFailure && e.error.code === 'MODELS_NO_CREDENTIAL',
    );

    const badKey = new ModelCatalogService(() => provider(), logger, fetchReturning(401, {}));
    await expect(badKey.fetchRemote('anthropic')).rejects.toSatisfy(
      (e: unknown) => e instanceof ProductFailure && e.error.code === 'MODELS_BAD_CREDENTIAL',
    );
  });

  it('uses the gateway base URL for anthropic-protocol providers, both auth headers', async () => {
    const seen: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () => (init.method === 'POST' ? { content: [] } : anthropicBody),
      };
    };
    const catalog = new ModelCatalogService(
      () => provider({ apiKey: 'cr-gw-1', baseUrl: 'http://10.0.0.9:3000/api/' }),
      logger,
      fetchImpl,
    );
    await catalog.fetchRemote('anthropic');
    expect(seen[0]!.url).toBe('http://10.0.0.9:3000/api/v1/models');
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.headers['x-api-key']).toBe('cr-gw-1');
    expect(seen[0]!.headers['Authorization']).toBe('Bearer cr-gw-1');
    expect(seen.slice(1).every((request) => request.url.endsWith('/api/v1/messages'))).toBe(true);
    expect(JSON.parse(seen[1]!.body ?? '{}')).toMatchObject({
      model: 'claude-opus-4-8',
      max_tokens: 1,
    });
  });

  it('filters the OFFICIAL OpenAI list down to chat-capable models', async () => {
    const seen: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, method: init.method ?? 'GET', body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () =>
          init.method === 'POST'
            ? { output: [] }
            : {
                data: [
                  { id: 'gpt-5.2' },
                  { id: 'o4-mini' },
                  { id: 'whisper-1' },
                  { id: 'dall-e-3' },
                ],
              },
      };
    };
    const catalog = new ModelCatalogService(
      () =>
        provider({
          providerId: 'openai',
          displayName: 'OpenAI',
          api: 'openai',
          // SecretService resolves the official default before this layer.
          baseUrl: 'https://api.openai.com/v1',
        }),
      logger,
      fetchImpl,
    );
    const result = await catalog.fetchRemote('openai');
    expect(result.models.map((m) => m.modelId)).toEqual(['gpt-5.2', 'o4-mini']);
    expect(seen.slice(1).every((request) => request.url.endsWith('/responses'))).toBe(true);
    expect(JSON.parse(seen[1]!.body ?? '{}')).toMatchObject({
      model: 'gpt-5.2',
      max_output_tokens: 16,
    });
  });

  it('OpenRouter: /models on the base, Bearer auth, name + context_length mapped, no filter', async () => {
    const seen: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () =>
          init.method === 'POST'
            ? { choices: [] }
            : {
                data: [
                  {
                    id: 'anthropic/claude-sonnet-4.5',
                    name: 'Claude Sonnet 4.5',
                    context_length: 200000,
                  },
                  {
                    id: 'meta-llama/llama-4-70b',
                    name: 'Llama 4 70B',
                    context_length: 131072,
                  },
                ],
              },
      };
    };
    const catalog = new ModelCatalogService(
      () =>
        provider({
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          api: 'openai',
          apiKey: 'sk-or-1',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      logger,
      fetchImpl,
    );
    const result = await catalog.fetchRemote('openrouter');
    expect(seen[0]!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(seen[0]!.headers['Authorization']).toBe('Bearer sk-or-1');
    expect(seen[0]!.headers['x-api-key']).toBeUndefined();
    expect(seen.slice(1).every((request) => request.url.endsWith('/chat/completions'))).toBe(true);
    expect(JSON.parse(seen[1]!.body ?? '{}')).toMatchObject({
      model: 'anthropic/claude-sonnet-4.5',
      max_completion_tokens: 16,
      stream: true,
    });
    expect(result.models.map((m) => m.modelId)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'meta-llama/llama-4-70b',
    ]);
    expect(result.models[0]!.displayName).toBe('Claude Sonnet 4.5');
    expect(result.models[0]!.contextWindow).toBe(200000);
    expect(result.models[0]!.providerName).toBe('OpenRouter');
  });

  it('LiteLLM/custom openai-compatible providers refuse to fetch without a base URL', async () => {
    const catalog = new ModelCatalogService(
      () =>
        provider({ providerId: 'litellm', displayName: 'LiteLLM', api: 'openai', baseUrl: null }),
      logger,
      fetchReturning(200, { data: [] }),
    );
    await expect(catalog.fetchRemote('litellm')).rejects.toSatisfy(
      (e: unknown) => e instanceof ProductFailure && e.error.code === 'MODELS_NO_BASE_URL',
    );
  });

  it('evict() forgets a deleted provider; other caches survive', async () => {
    const catalog = new ModelCatalogService(
      () => provider(),
      logger,
      fetchReturning(200, anthropicBody),
    );
    await catalog.fetchRemote('anthropic');
    expect(catalog.cached()).toHaveLength(2);
    catalog.evict('anthropic');
    expect(catalog.cached()).toHaveLength(0);
  });

  it('persists the verified catalogue across service restarts and evicts it atomically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'charter-model-catalog-'));
    const cacheFile = join(dir, 'verified-models.json');
    try {
      const first = new ModelCatalogService(
        () => provider(),
        logger,
        fetchReturning(200, anthropicBody),
        { cacheFile },
      );
      await first.fetchRemote('anthropic');

      const restored = new ModelCatalogService(
        () => provider(),
        logger,
        async () => {
          throw new Error('network should not be needed to restore the cache');
        },
        { cacheFile },
      );
      expect(restored.cached().map((model) => model.modelId)).toEqual([
        'claude-opus-4-8',
        'claude-haiku-4-5',
      ]);
      restored.evict('anthropic');

      const afterEvict = new ModelCatalogService(
        () => provider(),
        logger,
        fetchReturning(200, anthropicBody),
        { cacheFile },
      );
      expect(afterEvict.cached()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
