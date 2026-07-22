import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export type TerminalRendererMode = 'auto' | 'software';
export type TerminalUnicodeVersion = '6' | '11';
export type ActiveTerminalRenderer = 'webgl' | 'software';

interface WebglState {
  addon: WebglAddon | null;
  failed: boolean;
}

const webglStates = new WeakMap<Terminal, WebglState>();

function tagTerminal(
  term: Terminal,
  renderer: ActiveTerminalRenderer,
  unicodeVersion?: TerminalUnicodeVersion,
): void {
  if (!term.element) return;
  term.element.dataset.terminalRenderer = renderer;
  if (unicodeVersion) term.element.dataset.terminalUnicode = unicodeVersion;
}

/** Register both width providers once so the active version can change live. */
export function installTerminalUnicode(term: Terminal): void {
  term.loadAddon(new Unicode11Addon());
}

export function syncTerminalUnicode(term: Terminal, version: TerminalUnicodeVersion): void {
  if (term.unicode.activeVersion !== version) term.unicode.activeVersion = version;
  tagTerminal(
    term,
    term.element?.dataset.terminalRenderer === 'webgl' ? 'webgl' : 'software',
    version,
  );
}

/**
 * Enable WebGL only after xterm is mounted. A failed setup or context loss is
 * sticky for that terminal instance, avoiding a retry/flicker loop while the
 * normal renderer keeps the shell usable.
 */
export function syncTerminalRenderer(
  term: Terminal,
  mode: TerminalRendererMode,
): ActiveTerminalRenderer {
  const state = webglStates.get(term) ?? { addon: null, failed: false };
  webglStates.set(term, state);

  if (mode === 'software') {
    state.addon?.dispose();
    state.addon = null;
    tagTerminal(term, 'software');
    return 'software';
  }

  if (state.addon) {
    tagTerminal(term, 'webgl');
    return 'webgl';
  }
  if (state.failed || !term.element) {
    tagTerminal(term, 'software');
    return 'software';
  }

  const addon = new WebglAddon();
  addon.onContextLoss(() => {
    if (state.addon !== addon) return;
    state.addon = null;
    state.failed = true;
    addon.dispose();
    tagTerminal(term, 'software');
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      // A context loss can race terminal teardown.
    }
  });

  try {
    term.loadAddon(addon);
    state.addon = addon;
    tagTerminal(term, 'webgl');
    return 'webgl';
  } catch {
    state.failed = true;
    addon.dispose();
    tagTerminal(term, 'software');
    return 'software';
  }
}
