import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export type TerminalRendererMode = 'auto' | 'software';
export type TerminalUnicodeVersion = '6' | '11';
export type ActiveTerminalRenderer = 'webgl' | 'software';

interface WebglState {
  addon: WebglAddon | null;
  failures: number;
  retryAfter: number;
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
 * Enable WebGL only after xterm is mounted. Setup failures and context loss
 * fall back immediately, then retry with bounded backoff at a mount/resume
 * boundary instead of leaving that terminal permanently on a stale renderer.
 */
export function syncTerminalRenderer(
  term: Terminal,
  mode: TerminalRendererMode,
): ActiveTerminalRenderer {
  const state = webglStates.get(term) ?? { addon: null, failures: 0, retryAfter: 0 };
  webglStates.set(term, state);

  if (mode === 'software') {
    try {
      state.addon?.dispose();
    } catch {
      // A partially initialized or context-lost addon may throw on disposal.
    }
    state.addon = null;
    state.failures = 0;
    state.retryAfter = 0;
    tagTerminal(term, 'software');
    return 'software';
  }

  if (state.addon) {
    tagTerminal(term, 'webgl');
    return 'webgl';
  }
  if (state.retryAfter > Date.now() || !term.element) {
    tagTerminal(term, 'software');
    return 'software';
  }

  const addon = new WebglAddon();
  addon.onContextLoss(() => {
    if (state.addon !== addon) return;
    state.addon = null;
    state.failures += 1;
    state.retryAfter = Date.now() + Math.min(30_000, 500 * 2 ** (state.failures - 1));
    try {
      addon.dispose();
    } catch {
      // Context loss teardown must never prevent software fallback.
    }
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
    state.failures = 0;
    state.retryAfter = 0;
    tagTerminal(term, 'webgl');
    try {
      // A newly attached WebGL canvas is empty until the next render event.
      term.refresh(0, term.rows - 1);
    } catch {
      // Mount and teardown can race.
    }
    return 'webgl';
  } catch {
    state.failures += 1;
    state.retryAfter = Date.now() + Math.min(30_000, 500 * 2 ** (state.failures - 1));
    try {
      addon.dispose();
    } catch {
      // A half-constructed addon can throw on disposal.
    }
    tagTerminal(term, 'software');
    return 'software';
  }
}

/** A visibility/resume boundary is a safe time to retry a failed GPU context. */
export function resetTerminalRendererRecovery(term: Terminal): void {
  const state = webglStates.get(term);
  if (state && !state.addon) state.retryAfter = 0;
}

/** Reparenting can leave a stale WebGL atlas or a paused software frame. */
export function repaintTerminalRenderer(term: Terminal): void {
  const state = webglStates.get(term);
  try {
    state?.addon?.clearTextureAtlas();
  } catch {
    // Atlas reset is best effort; refresh still repaints software/WebGL output.
  }
  try {
    term.refresh(0, term.rows - 1);
  } catch {
    // The terminal may have been disposed between reveal and repaint.
  }
}
