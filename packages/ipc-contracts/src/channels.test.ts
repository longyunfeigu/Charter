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

  it('terminal.statTokens bounds the candidate batch (ADR-0033 am.1)', () => {
    expect(
      validateChannelRequest('terminal.statTokens', { id: 'term_1', tokens: ['a b.png'] }).ok,
    ).toBe(true);
    expect(validateChannelRequest('terminal.statTokens', { id: 'term_1', tokens: [] }).ok).toBe(
      false,
    );
    expect(
      validateChannelRequest('terminal.statTokens', {
        id: 'term_1',
        tokens: Array.from({ length: 25 }, (_, i) => `f${i}.png`),
      }).ok,
    ).toBe(false);
    expect(
      validateChannelRequest('terminal.statTokens', { id: 'term_1', tokens: ['a'.repeat(1025)] })
        .ok,
    ).toBe(false);
    // strict(): no smuggling extra fields past the schema.
    expect(
      validateChannelRequest('terminal.statTokens', {
        id: 'term_1',
        tokens: ['a.png'],
        follow: true,
      }).ok,
    ).toBe(false);
  });

  it('archaeology.adopt takes a cli, an exact session uuid and a terminal (ADR-0038)', () => {
    const uuid = '6f3a92c1-1234-4abc-8def-0123456789ab';
    expect(
      validateChannelRequest('archaeology.adopt', {
        cli: 'claude',
        sessionId: uuid,
        terminalId: 'term_1',
      }).ok,
    ).toBe(true);
    // Only exact UUIDs — the id is eventually written into a PTY.
    expect(
      validateChannelRequest('archaeology.adopt', {
        cli: 'claude',
        sessionId: 'rm -rf /; echo',
        terminalId: 'term_1',
      }).ok,
    ).toBe(false);
    expect(
      validateChannelRequest('archaeology.adopt', {
        cli: 'gemini',
        sessionId: uuid,
        terminalId: 'term_1',
      }).ok,
    ).toBe(false);
    // strict(): no smuggling extra fields past the schema.
    expect(
      validateChannelRequest('archaeology.adopt', {
        cli: 'codex',
        sessionId: uuid,
        terminalId: 'term_1',
        cwd: '/etc',
      }).ok,
    ).toBe(false);
  });

  it('terminal.create accepts the archaeology context without a raw path (ADR-0038)', () => {
    const uuid = '6f3a92c1-1234-4abc-8def-0123456789ab';
    expect(
      validateChannelRequest('terminal.create', {
        context: { kind: 'archaeology', cli: 'claude', sessionId: uuid },
      }).ok,
    ).toBe(true);
    expect(
      validateChannelRequest('terminal.create', {
        context: { kind: 'archaeology', cli: 'claude', sessionId: uuid, cwd: '/etc' },
      }).ok,
    ).toBe(false);
  });

  it('screenshot.saveToAssets takes exactly one watcher path or PNG bytes (ADR-0036)', () => {
    expect(
      validateChannelRequest('screenshot.saveToAssets', {
        source: { kind: 'path', path: '/Users/u/Desktop/Screenshot.png' },
      }).ok,
    ).toBe(true);
    expect(
      validateChannelRequest('screenshot.saveToAssets', {
        source: { kind: 'bytes', dataBase64: 'iVBORw0KGgo=', name: 'annotated.png' },
      }).ok,
    ).toBe(true);
    expect(
      validateChannelRequest('screenshot.saveToAssets', {
        source: { kind: 'path', path: '' },
      }).ok,
    ).toBe(false);
    // strict(): no smuggling extra fields past the schema.
    expect(
      validateChannelRequest('screenshot.saveToAssets', {
        source: { kind: 'path', path: '/x.png', overwrite: true },
      }).ok,
    ).toBe(false);
  });

  it('screenshot.read takes a bounded path and nothing else (ADR-0036)', () => {
    expect(validateChannelRequest('screenshot.read', { path: '/Users/u/Desktop/s.png' }).ok).toBe(
      true,
    );
    expect(validateChannelRequest('screenshot.read', { path: '' }).ok).toBe(false);
    expect(validateChannelRequest('screenshot.read', { path: 'a'.repeat(2001) }).ok).toBe(false);
    expect(validateChannelRequest('screenshot.read', { path: '/x.png', raw: true }).ok).toBe(false);
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

  it('skills.usage bounds the window and rejects extra fields (ADR-0037)', () => {
    expect(validateChannelRequest('skills.usage', {}).ok).toBe(true);
    expect(validateChannelRequest('skills.usage', { windowDays: 45 }).ok).toBe(true);
    expect(validateChannelRequest('skills.usage', { windowDays: 0 }).ok).toBe(false);
    expect(validateChannelRequest('skills.usage', { windowDays: 366 }).ok).toBe(false);
    expect(validateChannelRequest('skills.usage', { windowDays: 1.5 }).ok).toBe(false);
    expect(validateChannelRequest('skills.usage', { windowDays: 45, extra: true }).ok).toBe(false);
  });
});
