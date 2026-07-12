import { describe, expect, it } from 'vitest';
import { CHANNELS, getChannel, isKnownChannel, validateChannelRequest } from './channels.js';

describe('IPC channel registry', () => {
  it('every channel has a version and request/response schemas', () => {
    for (const [name, def] of Object.entries(CHANNELS)) {
      expect(name).toBe(def.name);
      expect(def.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(def.request).toBeTruthy();
      expect(def.response).toBeTruthy();
    }
    expect(Object.keys(CHANNELS).length).toBeGreaterThan(0);
  });

  it('rejects unknown channel names', () => {
    expect(isKnownChannel('app.getInfo')).toBe(true);
    expect(isKnownChannel('fs.readAnything')).toBe(false);
    expect(() => getChannel('nope.nope' as never)).toThrowError();
  });

  it('validates payloads against the channel request schema', () => {
    const ok = validateChannelRequest('app.getInfo', {});
    expect(ok.ok).toBe(true);
    const bad = validateChannelRequest('workspace.open', { path: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('IPC_SCHEMA_VIOLATION');
    }
  });
});
