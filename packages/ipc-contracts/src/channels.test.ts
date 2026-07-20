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

  it('terminal.openPath takes a terminal id plus a bounded token and nothing else', () => {
    expect(
      validateChannelRequest('terminal.openPath', { id: 'term_1', path: 'rocket.html' }).ok,
    ).toBe(true);
    expect(validateChannelRequest('terminal.openPath', { id: 'term_1', path: '' }).ok).toBe(false);
    expect(
      validateChannelRequest('terminal.openPath', { id: 'term_1', path: 'a'.repeat(4097) }).ok,
    ).toBe(false);
    // strict(): no smuggling extra fields past the schema.
    expect(
      validateChannelRequest('terminal.openPath', {
        id: 'term_1',
        path: 'rocket.html',
        line: 3,
      }).ok,
    ).toBe(false);
  });

  it('accepts at most three conversation references when creating a task', () => {
    const base = {
      title: 'Use prior context',
      goalMd: 'Continue the earlier work',
      acceptance: [],
      mode: 'ask',
      model: { providerId: 'mock', modelId: 'mock-1' },
      verification: [],
      isolation: 'none',
    };
    expect(
      validateChannelRequest('task.create', {
        ...base,
        conversationRefTaskIds: ['task_1', 'task_2', 'task_3'],
      }).ok,
    ).toBe(true);
    expect(
      validateChannelRequest('task.create', {
        ...base,
        conversationRefTaskIds: ['task_1', 'task_2', 'task_3', 'task_4'],
      }).ok,
    ).toBe(false);
  });
});
