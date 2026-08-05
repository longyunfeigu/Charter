import { describe, expect, it } from 'vitest';
import {
  alternateProviderApi,
  gatewayBaseUrlForApi,
  gatewayRouteProviderId,
  parseGatewayRouteProviderId,
} from './providers.js';

describe('mixed gateway provider routes', () => {
  it('uses an internal id that cannot collide with Settings provider ids', () => {
    const providerId = gatewayRouteProviderId('anthropic', 'openai');
    expect(providerId).toBe('anthropic__openai');
    expect(parseGatewayRouteProviderId(providerId)).toEqual({
      sourceProviderId: 'anthropic',
      api: 'openai',
    });
    expect(parseGatewayRouteProviderId('ordinary-provider')).toBeNull();
  });

  it('translates a gateway root between Anthropic and OpenAI base conventions', () => {
    expect(gatewayBaseUrlForApi('http://gateway.test/api/', 'anthropic', 'openai')).toBe(
      'http://gateway.test/api/v1',
    );
    expect(gatewayBaseUrlForApi('http://gateway.test/api/v1', 'openai', 'anthropic')).toBe(
      'http://gateway.test/api',
    );
    expect(gatewayBaseUrlForApi('http://gateway.test/api/v1/', 'openai', 'openai')).toBe(
      'http://gateway.test/api/v1',
    );
    expect(alternateProviderApi('anthropic')).toBe('openai');
    expect(alternateProviderApi('openai')).toBe('anthropic');
  });
});
