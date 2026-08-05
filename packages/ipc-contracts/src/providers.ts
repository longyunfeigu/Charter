import { z } from 'zod';

/**
 * Multi-provider registry (ADR-0009 addendum): a provider is an id + wire
 * protocol + optional endpoint + key. Presets cover the common services; any
 * OpenAI- or Anthropic-compatible gateway can be added as a custom provider.
 */

export const ProviderApiSchema = z.enum(['anthropic', 'openai']);
export type ProviderApi = z.infer<typeof ProviderApiSchema>;

/**
 * Internal provider ids used when one configured gateway exposes more than
 * one wire protocol. The separator contains `_`, which Settings never allows
 * in user-created provider ids, so derived routes cannot collide with a
 * persisted credential.
 */
const GATEWAY_ROUTE_SEPARATOR = '__';

export function gatewayRouteProviderId(sourceProviderId: string, api: ProviderApi): string {
  return `${sourceProviderId}${GATEWAY_ROUTE_SEPARATOR}${api}`;
}

export function parseGatewayRouteProviderId(
  providerId: string,
): { sourceProviderId: string; api: ProviderApi } | null {
  const separator = providerId.lastIndexOf(GATEWAY_ROUTE_SEPARATOR);
  if (separator <= 0) return null;
  const sourceProviderId = providerId.slice(0, separator);
  const api = providerId.slice(separator + GATEWAY_ROUTE_SEPARATOR.length);
  return api === 'anthropic' || api === 'openai' ? { sourceProviderId, api } : null;
}

export function alternateProviderApi(api: ProviderApi): ProviderApi {
  return api === 'anthropic' ? 'openai' : 'anthropic';
}

/** Translate the user-entered endpoint between Anthropic and OpenAI bases. */
export function gatewayBaseUrlForApi(
  baseUrl: string,
  sourceApi: ProviderApi,
  targetApi: ProviderApi,
): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  if (sourceApi === targetApi) return normalized;
  if (targetApi === 'openai') {
    return normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  }
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

export interface ProviderPreset {
  providerId: string;
  displayName: string;
  api: ProviderApi;
  /** Endpoint used when the user leaves Base URL empty; null = provider's official API. */
  defaultBaseUrl: string | null;
  /** Known natively to the runtime's model registry (models exist without synthesis). */
  builtin: boolean;
  /** The provider has no official public endpoint — a Base URL must be supplied. */
  baseUrlRequired: boolean;
  /** UI placeholder for the Base URL field. */
  placeholder: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    api: 'anthropic',
    defaultBaseUrl: null,
    builtin: true,
    baseUrlRequired: false,
    placeholder: 'https://api.anthropic.com (default) or your gateway',
  },
  {
    providerId: 'openai',
    displayName: 'OpenAI',
    api: 'openai',
    defaultBaseUrl: null,
    builtin: true,
    baseUrlRequired: false,
    placeholder: 'https://api.openai.com/v1 (default) or your gateway',
  },
  {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    api: 'openai',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    builtin: false,
    baseUrlRequired: false,
    placeholder: 'https://openrouter.ai/api/v1 (default)',
  },
  {
    providerId: 'litellm',
    displayName: 'LiteLLM',
    api: 'openai',
    defaultBaseUrl: null,
    builtin: false,
    baseUrlRequired: true,
    placeholder: 'http://localhost:4000/v1',
  },
];

export function providerPreset(providerId: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((p) => p.providerId === providerId) ?? null;
}

/** Official API base per protocol when nothing else is configured. */
export function officialBaseUrl(providerId: string, api: ProviderApi): string | null {
  const preset = providerPreset(providerId);
  if (preset?.defaultBaseUrl) return preset.defaultBaseUrl;
  if (providerId === 'anthropic') return 'https://api.anthropic.com';
  if (providerId === 'openai') return 'https://api.openai.com/v1';
  void api;
  return null;
}

/** Stored (user) base URL → the endpoint actually used. */
export function effectiveBaseUrl(
  providerId: string,
  api: ProviderApi,
  stored: string | null,
): string | null {
  return stored ?? officialBaseUrl(providerId, api);
}

/** One configured provider as the renderer sees it (key never crosses). */
export const ProviderInfoSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  api: ProviderApiSchema,
  configured: z.boolean(),
  hint: z.string(),
  baseUrl: z.string().nullable(),
});
export type ProviderInfoDto = z.infer<typeof ProviderInfoSchema>;
