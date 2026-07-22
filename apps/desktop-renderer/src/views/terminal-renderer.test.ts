import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';

const webglHarness = vi.hoisted(() => ({
  instances: [] as Array<{
    dispose: ReturnType<typeof vi.fn>;
    loseContext(): void;
  }>,
}));

const unicodeHarness = vi.hoisted(() => ({ instances: [] as object[] }));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    private contextLoss: (() => void) | null = null;
    dispose = vi.fn();

    constructor() {
      webglHarness.instances.push(this);
    }

    onContextLoss(listener: () => void): { dispose(): void } {
      this.contextLoss = listener;
      return { dispose: vi.fn() };
    }

    loseContext(): void {
      this.contextLoss?.();
    }
  },
}));

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    constructor() {
      unicodeHarness.instances.push(this);
    }
  },
}));

import {
  installTerminalUnicode,
  syncTerminalRenderer,
  syncTerminalUnicode,
} from './terminal-renderer.js';

function fakeTerminal(options: { mounted?: boolean; failLoad?: boolean } = {}): Terminal {
  const terminal = {
    element:
      options.mounted === false ? undefined : { dataset: {} as Record<string, string | undefined> },
    unicode: { activeVersion: '6' },
    rows: 24,
    loadAddon: vi.fn(() => {
      if (options.failLoad) throw new Error('renderer unavailable');
    }),
    refresh: vi.fn(),
  };
  return terminal as unknown as Terminal;
}

describe('terminal renderer enhancement', () => {
  beforeEach(() => {
    webglHarness.instances.length = 0;
    unicodeHarness.instances.length = 0;
  });

  it('registers Unicode 11 and can switch width tables live', () => {
    const term = fakeTerminal();
    installTerminalUnicode(term);
    syncTerminalUnicode(term, '11');

    expect(unicodeHarness.instances).toHaveLength(1);
    expect(term.loadAddon).toHaveBeenCalledWith(unicodeHarness.instances[0]);
    expect(term.unicode.activeVersion).toBe('11');
    expect(term.element?.dataset.terminalUnicode).toBe('11');
  });

  it('loads WebGL after mount and keeps the existing instance on remount', () => {
    const term = fakeTerminal();
    expect(syncTerminalRenderer(term, 'auto')).toBe('webgl');
    expect(syncTerminalRenderer(term, 'auto')).toBe('webgl');

    expect(webglHarness.instances).toHaveLength(1);
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.element?.dataset.terminalRenderer).toBe('webgl');
  });

  it('uses software rendering when selected or before the terminal is mounted', () => {
    const software = fakeTerminal();
    const unmounted = fakeTerminal({ mounted: false });

    expect(syncTerminalRenderer(software, 'software')).toBe('software');
    expect(syncTerminalRenderer(unmounted, 'auto')).toBe('software');
    expect(webglHarness.instances).toHaveLength(0);
    expect(software.element?.dataset.terminalRenderer).toBe('software');
  });

  it('falls back permanently for the terminal after WebGL context loss', () => {
    const term = fakeTerminal();
    expect(syncTerminalRenderer(term, 'auto')).toBe('webgl');

    const addon = webglHarness.instances[0]!;
    addon.loseContext();

    expect(addon.dispose).toHaveBeenCalledOnce();
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
    expect(term.element?.dataset.terminalRenderer).toBe('software');
    expect(syncTerminalRenderer(term, 'auto')).toBe('software');
    expect(webglHarness.instances).toHaveLength(1);
  });

  it('falls back when WebGL setup throws', () => {
    const term = fakeTerminal({ failLoad: true });
    expect(syncTerminalRenderer(term, 'auto')).toBe('software');
    expect(webglHarness.instances[0]?.dispose).toHaveBeenCalledOnce();
    expect(term.element?.dataset.terminalRenderer).toBe('software');
  });
});
