import { describe, expect, it } from 'vitest';
import { resolveSettings } from './settings.js';

describe('settings resolution (SET-002 / WS-014)', () => {
  it('produces full defaults from empty input', () => {
    const { effective, issues } = resolveSettings(undefined, undefined);
    expect(issues).toHaveLength(0);
    expect(effective.general.theme).toBe('system');
    expect(effective.general.skin).toBe('studio');
    expect(effective.editor.fontSize).toBeGreaterThan(0);
    expect(effective.editor.autoSave).toBe('off');
    expect(effective.terminal.renderer).toBe('auto');
    expect(effective.terminal.unicodeVersion).toBe('11');
    expect(effective.privacy.telemetryEnabled).toBe(false);
  });

  it('applies workspace overrides on top of global values', () => {
    const { effective, overrideKeys } = resolveSettings(
      { editor: { fontSize: 16 } },
      { editor: { fontSize: 11, tabSize: 4 } },
    );
    expect(effective.editor.fontSize).toBe(11);
    expect(effective.editor.tabSize).toBe(4);
    expect(overrideKeys).toContain('editor.fontSize');
    expect(overrideKeys).toContain('editor.tabSize');
  });

  it('rejects invalid values with issues and falls back to defaults for those keys', () => {
    const { effective, issues } = resolveSettings(
      { editor: { fontSize: 'huge' }, general: { theme: 'dark' } },
      undefined,
    );
    expect(effective.general.theme).toBe('dark');
    expect(effective.editor.fontSize).toBe(13);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/editor\.fontSize|fontSize/);
  });

  it('never lets telemetry default to on even with garbage input', () => {
    const { effective } = resolveSettings({ privacy: 12345 } as never, undefined);
    expect(effective.privacy.telemetryEnabled).toBe(false);
  });

  it('accepts terminal rendering compatibility settings', () => {
    const { effective, issues } = resolveSettings(
      { terminal: { renderer: 'software', unicodeVersion: '6' } },
      undefined,
    );
    expect(issues).toHaveLength(0);
    expect(effective.terminal.renderer).toBe('software');
    expect(effective.terminal.unicodeVersion).toBe('6');
  });

  it('accepts the four coordinated application skins and rejects unknown ones', () => {
    for (const skin of ['studio', 'terminal', 'archive', 'index'] as const) {
      const { effective, issues } = resolveSettings({ general: { skin } }, undefined);
      expect(effective.general.skin).toBe(skin);
      expect(issues).toHaveLength(0);
    }

    const { effective, issues } = resolveSettings({ general: { skin: 'generic-blue' } }, undefined);
    expect(effective.general.skin).toBe('studio');
    expect(issues.some((issue) => issue.includes('general.skin'))).toBe(true);
  });
});
