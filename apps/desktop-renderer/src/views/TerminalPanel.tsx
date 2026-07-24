import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { RecentWorkspaceDto } from '@pi-ide/ipc-contracts';
import { Terminal, type IMarker, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { onEvent, rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { revealPosition } from './SearchView.js';
import {
  detectFileLinks,
  detectWideCandidates,
  fileLinkHint,
  mergeFileLinks,
  readWrappedLine,
  resolveWideMatches,
  splitLineSuffix,
  type FileLinkMatch,
} from './terminal-file-links.js';
import { useExternalStore } from '../store/externalStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useDraftStore } from '../store/draftStore.js';
import { Ic } from './home-icons.js';
import { useQuickConsoleStore } from '../store/quickConsoleStore.js';
import { TerminalBlocks, type BlocksHost, type TermBlock } from './terminal-blocks.js';
import { TerminalUserInputTracker } from './terminal-input-provenance.js';
import { TerminalInputWriter } from './terminal-input-writer.js';
import {
  installTerminalUnicode,
  syncTerminalRenderer,
  syncTerminalUnicode,
} from './terminal-renderer.js';

export type TerminalLaunch = 'shell' | 'claude' | 'codex';
export type TerminalWorkingContext =
  | { kind: 'focused' }
  | { kind: 'recent'; projectPath: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'scratch' }
  // ADR-0038: adoption terminal — the host resolves the cwd from its own
  // discovery cache; the renderer only ever names the conversation.
  | { kind: 'archaeology'; cli: 'claude' | 'codex'; sessionId: string };

export interface TermInstance {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  /** ADR-0021: OSC 133/9;4 block model over this terminal's buffer. */
  blocks: TerminalBlocks;
  exited: boolean;
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
  launch: TerminalLaunch;
  quick: boolean;
  currentInput: string;
  lastCommand: string;
  hidden: boolean;
  inputWriter: TerminalInputWriter;
}

interface CreateTerminalRequest {
  taskId?: string;
  title?: string;
  context?: TerminalWorkingContext;
  launch?: TerminalLaunch;
  /** Composer first message — delivered by the host once the CLI TUI is ready. */
  initialPrompt?: string;
  quick?: boolean;
  reveal?: boolean;
}

interface TerminalHostInfo {
  id: string;
  title: string;
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
  launch: TerminalLaunch;
}

interface TerminalStore {
  items: TermInstance[];
  active: string | null;
  pendingKill: string | null;
  initialized: boolean;
  undoCloseId: string | null;
  init(): void;
  create(options?: CreateTerminalRequest): Promise<string | null>;
  adopt(id: string, outputTail?: string): Promise<void>;
  setContext(id: string, context: TerminalWorkingContext): Promise<boolean>;
  setActive(id: string): void;
  requestKill(id: string): Promise<void>;
  finalizeHidden(id: string): Promise<void>;
  undoClose(): void;
  confirmKill(id: string, confirmed: boolean): Promise<void>;
  rename(id: string, title: string): void;
  clearActive(): void;
}

export interface TerminalAppearance {
  fontFamily: string;
  theme: ITheme;
}

const QUICK_CLOSE_GRACE_MS = 5000;
const quickCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const adoptingTerminalIds = new Set<string>();

const terminalInputTrackers = new WeakMap<Terminal, TerminalUserInputTracker>();
const wiredInputElements = new WeakSet<HTMLElement>();

function wireTerminalUserInput(term: Terminal): void {
  const element = term.element;
  const tracker = terminalInputTrackers.get(term);
  if (!element || !tracker || wiredInputElements.has(element)) return;
  wiredInputElements.add(element);
  const mark = (): void => tracker.mark();
  // Capture before xterm's textarea handlers translate these DOM events into onData.
  element.addEventListener('paste', mark, true);
  element.addEventListener('input', mark, true);
  element.addEventListener('compositionend', mark, true);
}

// ---------- ADR-0021: terminal blocks (rail, jumps, actions, progress) ------

/** Monotonic per-terminal counters so block mutations re-render React views. */
interface BlocksVersionStore {
  versions: Record<string, number>;
  bump(id: string): void;
}
export const useBlocksVersion = create<BlocksVersionStore>((set, get) => ({
  versions: {},
  bump(id) {
    set({ versions: { ...get().versions, [id]: (get().versions[id] ?? 0) + 1 } });
  },
}));

/** Adapt a live xterm into the pure block model's host (IMarker ⊇ BlockMarker). */
function xtermBlocksHost(term: Terminal): BlocksHost {
  return {
    markCursorLine: () => term.registerMarker(0) ?? null,
    cursorColumn: () => term.buffer.active.cursorX,
    cursorLine: () => term.buffer.active.baseY + term.buffer.active.cursorY,
    lineText: (line) => term.buffer.active.getLine(line)?.translateToString(true) ?? '',
    now: () => Date.now(),
  };
}

export function selectBlock(
  item: TermInstance,
  block: TermBlock,
  options: { flash?: boolean; scroll?: boolean } = {},
): void {
  const range = item.blocks.rangeOf(block);
  item.blocks.selectedId = block.id;
  item.term.selectLines(range.start, range.end);
  if (options.scroll !== false) item.term.scrollToLine(Math.max(0, range.start - 1));
  if (options.flash) flashBlock(item, block);
  useBlocksVersion.getState().bump(item.id);
}

export function clearBlockSelection(item: TermInstance): void {
  item.blocks.selectedId = null;
  item.term.clearSelection();
  item.term.scrollToBottom();
  useBlocksVersion.getState().bump(item.id);
}

function flashBlock(item: TermInstance, block: TermBlock): void {
  // Our BlockMarker facade is the live IMarker underneath (xtermBlocksHost).
  const marker = block.marker as unknown as IMarker;
  if (marker.isDisposed) return;
  const decoration = item.term.registerDecoration({ marker, width: item.term.cols });
  if (!decoration) return;
  decoration.onRender((element) => element.classList.add('term-block-flash'));
  setTimeout(() => decoration.dispose(), 1500);
}

/** Whole-block text (command line through last output line), clipboard-ready. */
export function terminalBlockText(item: TermInstance, block: TermBlock): string {
  const range = item.blocks.rangeOf(block);
  const buffer = item.term.buffer.active;
  const lines: string[] = [];
  for (let line = range.start; line <= range.end; line += 1) {
    lines.push(buffer.getLine(line)?.translateToString(true) ?? '');
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n').trim().slice(-16_000);
}

/** ⌘↑/⌘↓ (Ctrl elsewhere) step through blocks; below the last block = back to live. */
function blockNavigationKey(item: TermInstance, event: KeyboardEvent): boolean {
  if (event.type !== 'keydown') return true;
  const isMac = window.product?.platform === 'darwin';
  const mod = isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (!mod || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return true;
  if (item.blocks.visibleBlocks().length === 0) return true;
  const target = item.blocks.step(event.key === 'ArrowUp' ? -1 : 1);
  event.preventDefault();
  if (target) selectBlock(item, target);
  else clearBlockSelection(item);
  return false;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** A finished long command reports to the host; PIVOT-014 hygiene lives there. */
function reportCommandEnd(terminalId: string, block: TermBlock, durationMs: number): void {
  // An unknown exit (lost D mark) means the prompt already returned under the
  // user's eyes — no notification and no bell for something we cannot describe.
  if (block.exitCode === null) return;
  const settings = useAppStore.getState().settings;
  const minMs = (settings?.terminal.longCommandSeconds ?? 15) * 1000;
  if (durationMs < minMs) return;
  void rpcResult('terminal.commandDone', {
    id: terminalId,
    blockId: block.id,
    command: block.command,
    exitCode: block.exitCode,
    durationMs: Math.round(durationMs),
  }).then((res) => {
    if (!res.ok || res.data.notified) return;
    // Focused (or notifications off): ring the row bell unless the user is
    // already looking at this exact terminal.
    const state = useTerminalStore.getState();
    const app = useAppStore.getState();
    const looking =
      state.active === terminalId &&
      (app.sessionTerminalId !== null || app.sessionTool === 'terminal');
    const item = state.items.find((t) => t.id === terminalId);
    if (item && !looking) {
      item.blocks.bell = true;
      useBlocksVersion.getState().bump(terminalId);
    }
  });
}

export function terminalAppearance(): TerminalAppearance {
  const skin = document.documentElement.dataset.skin ?? 'studio';
  const dark = document.documentElement.dataset.theme === 'dark';
  if (skin === 'studio') {
    return {
      fontFamily: "Menlo, Monaco, 'SF Mono', monospace",
      theme: dark
        ? { background: '#181818', foreground: '#cccccc' }
        : { background: '#ffffff', foreground: '#333333', cursor: '#333333' },
    };
  }
  if (skin === 'terminal') {
    return {
      fontFamily: "'Berkeley Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
      theme: dark
        ? {
            background: '#0d120f',
            foreground: '#b9f6c8',
            cursor: '#52ff78',
            cursorAccent: '#071009',
            selectionBackground: '#245b32',
            black: '#071009',
            red: '#ff6677',
            green: '#52ff78',
            yellow: '#e7c75f',
            blue: '#5c9cff',
            magenta: '#c793ff',
            cyan: '#5ce1d4',
            white: '#dfffe7',
            brightBlack: '#52705a',
            brightRed: '#ff8b98',
            brightGreen: '#8dffa6',
            brightYellow: '#ffe68f',
            brightBlue: '#8cbbff',
            brightMagenta: '#ddb9ff',
            brightCyan: '#91fff5',
            brightWhite: '#ffffff',
          }
        : {
            background: '#f0f6f1',
            foreground: '#102417',
            cursor: '#087c32',
            cursorAccent: '#f0f6f1',
            selectionBackground: '#b9dcc2',
            black: '#102417',
            red: '#a9343d',
            green: '#087c32',
            yellow: '#8a5b0a',
            blue: '#225cab',
            magenta: '#7642a0',
            cyan: '#126b67',
            white: '#e7efe8',
            brightBlack: '#5f7f67',
            brightRed: '#c74f59',
            brightGreen: '#199947',
            brightYellow: '#a97819',
            brightBlue: '#3e76c6',
            brightMagenta: '#925db8',
            brightCyan: '#29837e',
            brightWhite: '#ffffff',
          },
    };
  }
  if (skin === 'index') {
    return {
      fontFamily: "'IBM Plex Mono', 'SFMono-Regular', Menlo, Consolas, monospace",
      theme: dark
        ? {
            background: '#070707',
            foreground: '#f5f5f2',
            cursor: '#ff304f',
            cursorAccent: '#070707',
            selectionBackground: '#5a1521',
            black: '#070707',
            red: '#ff405c',
            green: '#5ec986',
            yellow: '#e8b34c',
            blue: '#76a9ed',
            magenta: '#d47cff',
            cyan: '#5ed0d0',
            white: '#d8d8d4',
            brightBlack: '#6f6f6c',
            brightRed: '#ff7890',
            brightGreen: '#83e0a4',
            brightYellow: '#f4ce7a',
            brightBlue: '#9bc2f5',
            brightMagenta: '#e5a3ff',
            brightCyan: '#86e5e5',
            brightWhite: '#ffffff',
          }
        : {
            background: '#ffffff',
            foreground: '#0b0b0b',
            cursor: '#d20f2f',
            cursorAccent: '#ffffff',
            selectionBackground: '#f3cbd2',
            black: '#0b0b0b',
            red: '#d20f2f',
            green: '#176d3a',
            yellow: '#8b5b00',
            blue: '#1c4f8f',
            magenta: '#7a2d91',
            cyan: '#176c70',
            white: '#e5e5e2',
            brightBlack: '#777773',
            brightRed: '#ef3855',
            brightGreen: '#2e8b50',
            brightYellow: '#a67513',
            brightBlue: '#3d70ad',
            brightMagenta: '#9650a9',
            brightCyan: '#34868a',
            brightWhite: '#ffffff',
          },
    };
  }
  return {
    // Archive's surrounding UI is intentionally editorial, but a terminal
    // still needs a real monospace cell grid. American Typewriter is
    // proportional and becomes the fallback on stock macOS installations.
    fontFamily:
      "Menlo, Monaco, 'SF Mono', 'SFMono-Regular', Consolas, 'PingFang SC', 'Microsoft YaHei UI', monospace",
    theme: dark
      ? {
          background: '#291f19',
          foreground: '#f0dfbd',
          cursor: '#ef7b57',
          cursorAccent: '#291f19',
          selectionBackground: '#664434',
          black: '#291f19',
          red: '#f17b67',
          green: '#8fb37d',
          yellow: '#e0ab65',
          blue: '#86aeb7',
          magenta: '#d697b5',
          cyan: '#8ac0b9',
          white: '#dfcfb1',
          brightBlack: '#927962',
          brightRed: '#ff9d89',
          brightGreen: '#b0d19e',
          brightYellow: '#f1c98c',
          brightBlue: '#aacbd1',
          brightMagenta: '#e8b8cd',
          brightCyan: '#addbd5',
          brightWhite: '#fff4dc',
        }
      : {
          background: '#fbf2df',
          foreground: '#392a21',
          cursor: '#b94e32',
          cursorAccent: '#fbf2df',
          selectionBackground: '#e8cbb2',
          black: '#392a21',
          red: '#a43129',
          green: '#4f754d',
          yellow: '#9a602d',
          blue: '#3f6674',
          magenta: '#8b506d',
          cyan: '#42756e',
          white: '#eadbc1',
          brightBlack: '#9b7965',
          brightRed: '#bd5138',
          brightGreen: '#668b62',
          brightYellow: '#b4773e',
          brightBlue: '#5a7d89',
          brightMagenta: '#a66a83',
          brightCyan: '#5e8e87',
          brightWhite: '#fffaf0',
        },
  };
}

/**
 * Mount an existing xterm into a host element. xterm 6's `open()` only
 * attaches on the FIRST call (re-open is a window-bookkeeping no-op), so every
 * re-mount — dock tab switch, side panel, room, surface round-trip — must move
 * the live element itself (ADR-0017 rev.2 substrate fix).
 */
export function mountTerminal(
  host: HTMLElement,
  item: Pick<TermInstance, 'term' | 'fit'>,
  appearance: 'normal' | 'quick' = 'normal',
): void {
  applyTerminalAppearance(item, appearance);
  const bottomPanelBody = host.closest<HTMLElement>('.bp-body');
  const el = item.term.element;
  if (!el) {
    host.replaceChildren();
    item.term.open(host);
  } else if (el.parentElement !== host) {
    host.replaceChildren(el);
  }
  const terminalSettings = useAppStore.getState().settings?.terminal;
  syncTerminalUnicode(item.term, terminalSettings?.unicodeVersion ?? '11');
  syncTerminalRenderer(item.term, terminalSettings?.renderer ?? 'auto');
  wireTerminalUserInput(item.term);
  try {
    item.fit.fit();
    item.term.refresh(0, item.term.rows - 1);
  } catch {
    // fit/refresh races during teardown are harmless
  }
  item.term.focus();
  // Reparenting and the right-rail layout update can settle in different
  // frames. Fit once more after layout so a terminal that came from the wider
  // side slot cannot keep drawing underneath the dock session list.
  requestAnimationFrame(() => {
    if (!host.isConnected || item.term.element?.parentElement !== host) return;
    try {
      item.fit.fit();
      item.term.refresh(0, item.term.rows - 1);
    } catch {
      // fit/refresh races during teardown are harmless
    }
  });
  // Chromium may scroll an overflow ancestor to reveal xterm's hidden input,
  // which used to lift the 34px context bar and New Terminal row out of view.
  // Keep the Bottom Panel chrome pinned while preserving keyboard focus.
  if (bottomPanelBody) {
    bottomPanelBody.scrollTop = 0;
    bottomPanelBody.scrollLeft = 0;
    requestAnimationFrame(() => {
      bottomPanelBody.scrollTop = 0;
      bottomPanelBody.scrollLeft = 0;
    });
  }
}

const QUICK_TERMINAL_APPEARANCE: TerminalAppearance = {
  fontFamily: "'SF Mono', Menlo, Monaco, Consolas, monospace",
  theme: {
    background: '#24231f',
    foreground: '#dcd7cd',
    cursor: '#dcd7cd',
    cursorAccent: '#24231f',
    selectionBackground: '#48566e',
    black: '#14130f',
    red: '#e08a80',
    green: '#7fce9e',
    yellow: '#e8b96b',
    blue: '#8fb0e8',
    magenta: '#c99ae8',
    cyan: '#78c6c2',
    white: '#dcd7cd',
    brightBlack: '#8f8a7f',
    brightRed: '#f2a69e',
    brightGreen: '#9adbb2',
    brightYellow: '#ffd28a',
    brightBlue: '#acc7f4',
    brightMagenta: '#ddb3f3',
    brightCyan: '#9addd9',
    brightWhite: '#f6f2e9',
  },
};

export function applyTerminalAppearance(
  item: Pick<TermInstance, 'term'>,
  mode: 'normal' | 'quick',
): void {
  const appearance = mode === 'quick' ? QUICK_TERMINAL_APPEARANCE : terminalAppearance();
  item.term.options.fontFamily = appearance.fontFamily;
  item.term.options.theme = appearance.theme;
}

/** Selection wins; otherwise capture the most recent visible non-empty output. */
export function terminalShareText(item: Pick<TermInstance, 'term'>): string {
  const selection = item.term.getSelection().trim();
  if (selection) return selection;
  const buffer = item.term.buffer.active;
  const end = Math.min(buffer.length, buffer.baseY + buffer.cursorY + 1);
  const start = Math.max(0, end - 24);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index)?.translateToString(true) ?? '';
    if (line.length > 0 || lines.length > 0) lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n').trim().slice(-16_000);
}

/** Keep a mounted xterm fitted to its actual host, including flex/grid changes
 * caused by opening the side focus slot or compacting the terminal list. */
export function observeTerminalFit(
  host: HTMLElement,
  item: Pick<TermInstance, 'term' | 'fit'>,
): () => void {
  let frame = 0;
  const scheduleFit = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!host.isConnected || item.term.element?.parentElement !== host) return;
      try {
        item.fit.fit();
      } catch {
        // fit races during teardown are harmless
      }
    });
  };
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(host);
  scheduleFit();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

/* ── ADR-0033: ⌘+click file/URL links in terminal output ─────────────────── */

const isMac = navigator.platform.startsWith('Mac');

let linkHint: HTMLDivElement | null = null;
function showLinkHint(event: MouseEvent, text: string): void {
  if (!linkHint) {
    linkHint = document.createElement('div');
    linkHint.className = 'terminal-link-hint';
    document.body.appendChild(linkHint);
  }
  linkHint.textContent = text;
  linkHint.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 280)}px`;
  linkHint.style.top = `${event.clientY + 18}px`;
  linkHint.style.display = 'block';
}
function hideLinkHint(): void {
  if (linkHint) linkHint.style.display = 'none';
}

/** Plain click must keep meaning "select text"; teach the modifier instead. */
let lastModifierHintAt = 0;
function openModifierHeld(event: MouseEvent): boolean {
  if (event.metaKey || event.ctrlKey) return true;
  const now = Date.now();
  if (now - lastModifierHintAt > 1500) {
    lastModifierHintAt = now;
    useAppStore
      .getState()
      .pushToast('info', `Hold ${isMac ? '⌘' : 'Ctrl'} and click to open the link.`);
  }
  return false;
}

async function openTerminalFileToken(terminalId: string, token: string): Promise<void> {
  hideLinkHint();
  const { path, line } = splitLineSuffix(token);
  const res = await rpcResult('terminal.openPath', { id: terminalId, path });
  if (!okOrToast(res)) return;
  if (res.data.action !== 'editor') return;
  const rel = res.data.workspacePath;
  if (!rel) {
    useAppStore.getState().pushToast('info', `${res.data.path} is outside the current workspace.`);
    return;
  }
  // Terminal sessions live outside the Editor surface — switch first (the
  // QuickOpen pattern); the PTY stays alive across the surface change.
  useAppStore.getState().setProjectTool('editor');
  await useEditorStore.getState().openFile(rel);
  if (line !== null) revealPosition(rel, line, 1);
}

/** WebLinksAddon activation (regex-detected http/https URLs). The sandboxed
 * renderer cannot window.open — route through the https-only allowlist. */
function activateWebUri(event: MouseEvent, uri: string): void {
  if (!openModifierHeld(event)) return;
  void rpcResult('app.openExternal', { url: uri }).then((res) => {
    if (res.ok && !res.data.opened) {
      useAppStore.getState().pushToast('warning', 'Only https links can be opened.');
    }
  });
}

/** OSC 8 hyperlinks (Claude Code emits file:// links around file mentions)
 * plus a regex provider for bare tokens like `rocket.html` from CLIs that do
 * not hyperlink. Both funnel into terminal.openPath, which resolves against
 * THIS terminal's cwd and never leaves it. */
function wireFileLinks(item: TermInstance): void {
  item.term.options.linkHandler = {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      if (uri.startsWith('file://')) {
        if (!openModifierHeld(event)) return;
        try {
          void openTerminalFileToken(item.id, decodeURIComponent(new URL(uri).pathname));
        } catch {
          // Malformed URI from the guest program — nothing to open.
        }
        return;
      }
      activateWebUri(event, uri);
    },
    hover: (event, uri) =>
      showLinkHint(event, uri.startsWith('file://') ? fileLinkHint(uri, isMac) : uri),
    leave: hideLinkHint,
  };
  // ADR-0033 am.1: verified wide matches (space/CJK boundaries) per logical
  // line text. Small LRU — hover re-fires constantly, the host stat only once.
  const wideCache = new Map<string, FileLinkMatch[]>();
  item.term.registerLinkProvider({
    provideLinks(y, callback) {
      const buffer = item.term.buffer.active;
      if (!buffer.getLine(y - 1)) {
        callback(undefined);
        return;
      }
      // The logical (unwrapped) line: fixes wrapped long paths and gives the
      // boundary scan the full text to expand into.
      const { text, cellAt } = readWrappedLine(buffer, y - 1);
      const toLinks = (matches: FileLinkMatch[]) =>
        matches.map((match) => {
          const head = cellAt[match.start];
          const tail = cellAt[match.end - 1];
          return {
            range: {
              start: { x: (head?.x ?? 0) + 1, y: (head?.y ?? y - 1) + 1 },
              end: { x: (tail?.x ?? 0) + 1, y: (tail?.y ?? y - 1) + 1 },
            },
            text: match.text,
            activate: (event: MouseEvent, token: string) => {
              if (!openModifierHeld(event)) return;
              void openTerminalFileToken(item.id, token);
            },
            hover: (event: MouseEvent, token: string) =>
              showLinkHint(event, fileLinkHint(token, isMac)),
            leave: hideLinkHint,
          };
        });
      const sure = detectFileLinks(text);
      const finish = (wide: FileLinkMatch[]) => {
        const merged = mergeFileLinks(sure, wide);
        callback(merged.length > 0 ? toLinks(merged) : undefined);
      };
      const groups = detectWideCandidates(text, sure);
      if (groups.length === 0) {
        finish([]);
        return;
      }
      const cached = wideCache.get(text);
      if (cached) {
        wideCache.delete(text); // re-insert: keep hot lines out of eviction
        wideCache.set(text, cached);
        finish(cached);
        return;
      }
      const tokens = [...new Set(groups.flat().map((c) => c.statPath))];
      void rpcResult('terminal.statTokens', { id: item.id, tokens }).then((res) => {
        if (!res.ok) {
          finish([]); // transient host error — uncached so a later hover retries
          return;
        }
        const existing = new Set(tokens.filter((_, i) => res.data.existing[i]));
        const wide = resolveWideMatches(groups, (path) => existing.has(path));
        wideCache.set(text, wide);
        if (wideCache.size > 64) {
          wideCache.delete(wideCache.keys().next().value!);
        }
        finish(wide);
      });
    },
  });
}

function makeTerm(fontSize: number, scrollback: number): { term: Terminal; fit: FitAddon } {
  const appearance = terminalAppearance();
  const term = new Terminal({
    fontSize,
    fontFamily: appearance.fontFamily,
    scrollback,
    cursorBlink: true,
    allowProposedApi: true,
    theme: appearance.theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  installTerminalUnicode(term);
  term.loadAddon(new WebLinksAddon(activateWebUri));
  return { term, fit };
}

function createTermInstance(
  info: TerminalHostInfo,
  options: { title?: string; quick?: boolean; outputTail?: string } = {},
): TermInstance {
  const settings = useAppStore.getState().settings;
  const quick = options.quick ?? false;
  const { term, fit } = makeTerm(
    settings?.terminal.fontSize ?? 12,
    settings?.terminal.scrollback ?? 5000,
  );
  const blocks = new TerminalBlocks(xtermBlocksHost(term), {
    onChange: () => useBlocksVersion.getState().bump(info.id),
    onCommandEnd: (block, durationMs) => reportCommandEnd(info.id, block, durationMs),
  });
  term.parser.registerOscHandler(133, (data) => blocks.handleOsc133(data));
  term.parser.registerOscHandler(9, (data) => blocks.handleOsc9(data));
  const inputTracker = new TerminalUserInputTracker();
  const inputWriter = new TerminalInputWriter(
    async (input) => {
      await rpcResult('terminal.write', input);
    },
    { startupDelayMs: 500 },
  );
  terminalInputTrackers.set(term, inputTracker);
  term.onKey(() => inputTracker.mark());
  term.onData((data) => {
    inputWriter.enqueue({
      id: info.id,
      data,
      userInitiated: inputTracker.consume(),
    });
  });
  term.onResize(({ cols, rows }) => {
    void rpcResult('terminal.resize', { id: info.id, cols, rows });
  });
  const item: TermInstance = {
    ...info,
    title: options.title ?? info.title,
    term,
    fit,
    blocks,
    exited: false,
    quick,
    currentInput: '',
    lastCommand: '',
    hidden: false,
    inputWriter,
  };
  term.onData((data) => {
    if (data === '\r') {
      item.lastCommand = item.currentInput.trim();
      item.currentInput = '';
    } else if (data === '\u007f') {
      item.currentInput = item.currentInput.slice(0, -1);
    } else if (!data.startsWith('\u001b') && data >= ' ') {
      item.currentInput += data;
    }
  });
  term.attachCustomKeyEventHandler((event) => blockNavigationKey(item, event));
  wireFileLinks(item);
  if (options.outputTail) {
    inputWriter.markReady();
    term.write(options.outputTail);
  }
  return item;
}

export function compactTerminalPath(path: string): string {
  const unixHome = path.match(/^\/Users\/[^/]+|^\/home\/[^/]+/)?.[0];
  if (unixHome) return `~${path.slice(unixHome.length)}`;
  const windowsHome = path.match(/^[A-Za-z]:\\Users\\[^\\]+/)?.[0];
  if (windowsHome) return `~${path.slice(windowsHome.length)}`;
  return path;
}

function agentDisplayName(agent: string): string {
  if (agent === 'claude') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return agent;
}

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  items: [],
  active: null,
  pendingKill: null,
  initialized: false,
  undoCloseId: null,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    const appearanceObserver = new MutationObserver(() => {
      for (const item of get().items) {
        applyTerminalAppearance(item, item.quick ? 'quick' : 'normal');
        item.term.refresh(0, item.term.rows - 1);
      }
    });
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin'],
    });
    onEvent('terminal.data', ({ id, data }) => {
      const item = get().items.find((t) => t.id === id);
      if (!item) return;
      item.inputWriter.markReady();
      item.term.write(data);
      // ADR-0021: plain-output progress fallback (OSC 9;4 always wins).
      item.blocks.feedOutput(data);
    });
    onEvent('terminal.exit', ({ id, exitCode }) => {
      const item = get().items.find((t) => t.id === id);
      if (item) {
        item.exited = true;
        item.term.write(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
      }
    });
    // ADR-0017: closing summary line when an external agent session ends —
    // display-buffer only (never written to the PTY). ADR-0021: session edges
    // are also block marks (purple rail dots) for observed-grade sessions.
    onEvent('terminal.agentState', ({ id, agent, taskId }) => {
      const item = get().items.find((t) => t.id === id);
      if (!item) return;
      if (agent !== null) {
        item.blocks.addTurnBlock(`✳ ${agentDisplayName(agent)} session started`, false);
        return;
      }
      item.blocks.addTurnBlock('✳ Session ended', false);
      if (!taskId) return;
      const files = useExternalStore.getState().sessions[taskId]?.files.length ?? 0;
      item.term.write(
        `\r\n\x1b[90m✻ session ended — ${files} file${files === 1 ? '' : 's'} changed, tracked for review\x1b[0m\r\n`,
      );
    });
    // ADR-0021: structured turn boundaries (Codex turn.completed / Claude
    // result) join the same rail as command blocks.
    onEvent('external.turn', ({ terminalId, label, status }) => {
      const item = get().items.find((t) => t.id === terminalId);
      item?.blocks.addTurnBlock(label, status === 'error');
    });
    // ADR-0021: a command notification's click lands on the block, not the app.
    onEvent('terminal.revealBlock', ({ id, blockId }) => {
      const item = get().items.find((t) => t.id === id);
      const block = item?.blocks.byId(blockId);
      if (!item || !block) return;
      useAppStore.getState().showBottomTab('terminal');
      set({ active: id });
      item.blocks.bell = false;
      // Let the terminal mount before scrolling/flashing the landing block.
      requestAnimationFrame(() => selectBlock(item, block, { flash: true }));
    });
    // ADR-0021: the Dock icon paints the same number as the tab ring and the
    // status bar — the earliest running determinate command, nothing invented.
    let lastDockProgress: number | null = null;
    setInterval(() => {
      const now = Date.now();
      let candidate: { startedAt: number; value: number } | null = null;
      for (const item of get().items) {
        const running = item.blocks.runningBlock();
        if (!running || running.kind !== 'command') continue;
        const progress = item.blocks.progressFor(now);
        if (progress?.kind !== 'determinate') continue;
        if (!candidate || running.startedAt < candidate.startedAt) {
          candidate = { startedAt: running.startedAt, value: progress.percent / 100 };
        }
      }
      const value = candidate ? Math.round(candidate.value * 100) / 100 : null;
      if (value !== lastDockProgress) {
        lastDockProgress = value;
        void rpcResult('terminal.progress', { value });
      }
    }, 1000);
    // Focused-workspace changes leave global terminals intact. Their PTYs and
    // renderer xterm instances are owned by the context recorded on each row.
  },

  async create(options) {
    const launch = options?.launch ?? 'shell';
    const res = await rpcResult('terminal.create', {
      ...(options?.taskId ? { taskId: options.taskId } : {}),
      ...(options?.context ? { context: options.context } : {}),
      ...(options?.initialPrompt?.trim() ? { initialPrompt: options.initialPrompt } : {}),
      launch,
    });
    if (!okOrToast(res)) return null;
    const item = createTermInstance(res.data, {
      title: options?.title ?? (options?.quick ? '⌥ quick' : res.data.title),
      quick: options?.quick,
    });
    set({ items: [...get().items, item], active: item.id });
    if (options?.reveal !== false) useAppStore.getState().showBottomTab('terminal');
    return item.id;
  },

  async adopt(id, outputTail = '') {
    if (get().items.some((item) => item.id === id) || adoptingTerminalIds.has(id)) return;
    adoptingTerminalIds.add(id);
    try {
      const result = await rpcResult('terminal.list', {});
      if (!result.ok) return;
      const info = result.data.items.find((item) => item.id === id);
      if (!info || get().items.some((item) => item.id === id)) return;
      // Main and renderer can briefly straddle schema versions during Vite
      // development reloads; fall back to the legacy plain-text snapshot.
      const recentData = result.data.recentData ?? {};
      const item = createTermInstance(info, {
        outputTail: recentData[id] ?? outputTail,
      });
      set({ items: [...get().items, item] });
    } finally {
      adoptingTerminalIds.delete(id);
    }
  },

  async setContext(id, context) {
    const res = await rpcResult('terminal.setContext', { id, context });
    if (!res.ok) {
      useAppStore.getState().pushToast('warning', res.error.userMessage);
      return false;
    }
    set({
      items: get().items.map((item) =>
        item.id === id
          ? {
              ...item,
              cwd: res.data.cwd,
              projectName: res.data.projectName,
              projectPath: res.data.projectPath,
              contextKind: res.data.contextKind,
              contextLabel: res.data.contextLabel,
              contextTaskId: res.data.contextTaskId,
            }
          : item,
      ),
    });
    return true;
  },

  setActive(id) {
    set({ active: id });
    // Looking at the terminal clears its attention bell (ADR-0021).
    const item = get().items.find((t) => t.id === id);
    if (item?.blocks.bell) {
      item.blocks.bell = false;
      useBlocksVersion.getState().bump(id);
    }
  },

  async requestKill(id) {
    const item = get().items.find((entry) => entry.id === id);
    if (item?.quick && !item.hidden) {
      const previous = get().undoCloseId;
      if (previous && previous !== id) {
        const previousTimer = quickCloseTimers.get(previous);
        if (previousTimer) clearTimeout(previousTimer);
        quickCloseTimers.delete(previous);
        void get().finalizeHidden(previous);
      }
      const items = get().items.map((entry) =>
        entry.id === id ? { ...entry, hidden: true } : entry,
      );
      const next = items.filter((entry) => !entry.hidden).at(-1);
      set({ items, active: next?.id ?? null, undoCloseId: id });
      useQuickConsoleStore.setState({ terminalId: null, open: false });
      quickCloseTimers.set(
        id,
        setTimeout(() => {
          quickCloseTimers.delete(id);
          void get().finalizeHidden(id);
        }, QUICK_CLOSE_GRACE_MS),
      );
      useAppStore.getState().pushToast('info', '“⌥ quick” closed · undo within 5 seconds with ⌘Z');
      return;
    }
    const res = await rpcResult('terminal.kill', { id, force: false });
    if (!res.ok) return;
    if (res.data.needsConfirm) {
      set({ pendingKill: id });
      return;
    }
    get()
      .items.find((t) => t.id === id)
      ?.term.dispose();
    const items = get().items.filter((t) => t.id !== id);
    set({ items, active: items.at(-1)?.id ?? null, pendingKill: null });
    if (useQuickConsoleStore.getState().terminalId === id) {
      useQuickConsoleStore.setState({ terminalId: null, open: false });
    }
    useExternalStore.getState().handleTerminalClosed(id);
  },

  async finalizeHidden(id) {
    const item = get().items.find((entry) => entry.id === id);
    if (!item?.hidden) return;
    const res = await rpcResult('terminal.kill', { id, force: false });
    if (!res.ok) return;
    const stillUndoable = get().undoCloseId === id;
    if (res.data.needsConfirm) {
      set({
        items: get().items.map((entry) => (entry.id === id ? { ...entry, hidden: false } : entry)),
        active: id,
        pendingKill: id,
        ...(stillUndoable ? { undoCloseId: null } : {}),
      });
      useAppStore.getState().showBottomTab('terminal');
      return;
    }
    item.term.dispose();
    useExternalStore.getState().handleTerminalClosed(id);
    set({
      items: get().items.filter((entry) => entry.id !== id),
      ...(stillUndoable ? { undoCloseId: null } : {}),
    });
  },

  undoClose() {
    const id = get().undoCloseId;
    if (!id) return;
    const timer = quickCloseTimers.get(id);
    if (timer) clearTimeout(timer);
    quickCloseTimers.delete(id);
    const item = get().items.find((entry) => entry.id === id && entry.hidden);
    if (!item) {
      set({ undoCloseId: null });
      return;
    }
    set({
      items: get().items.map((entry) => (entry.id === id ? { ...entry, hidden: false } : entry)),
      active: id,
      undoCloseId: null,
    });
    useQuickConsoleStore.getState().setTerminalId(id);
    useAppStore
      .getState()
      .pushToast('success', '“⌥ quick” restored · session and scrollback preserved');
  },

  async confirmKill(id, confirmed) {
    if (!confirmed) {
      set({ pendingKill: null });
      return;
    }
    await rpcResult('terminal.kill', { id, force: true });
    get()
      .items.find((t) => t.id === id)
      ?.term.dispose();
    const items = get().items.filter((t) => t.id !== id);
    set({ items, active: items.at(-1)?.id ?? null, pendingKill: null });
    if (useQuickConsoleStore.getState().terminalId === id) {
      useQuickConsoleStore.setState({ terminalId: null, open: false });
    }
    useExternalStore.getState().handleTerminalClosed(id);
  },

  rename(id, title) {
    set({ items: get().items.map((t) => (t.id === id ? { ...t, title } : t)) });
  },

  clearActive() {
    const active = get().items.find((t) => t.id === get().active);
    active?.term.clear();
  },
}));

/**
 * ADR-0017 rev.2 — the in-place session bar. All UI consequences of detection
 * land here (badge, snapshot chip, live file counter, actions); the terminal
 * itself never moves on detection. Ended sessions keep the bar (green state,
 * Review entry) until the terminal closes or a new session replaces it.
 */
export function SessionBar({ terminalId }: { terminalId: string }): React.JSX.Element | null {
  const item = useTerminalStore((s) => s.items.find((terminal) => terminal.id === terminalId));
  const taskId = useExternalStore((s) => s.taskByTerminal[terminalId]);
  const cli = useExternalStore((s) => s.agentByTerminal[terminalId] ?? null);
  const session = useExternalStore((s) => (taskId ? s.sessions[taskId] : undefined));
  const promoted = useExternalStore((s) => s.promoted);
  const task = useTaskStore((s) => (taskId ? s.tasks.find((entry) => entry.id === taskId) : null));
  if (!item) return null;
  const context = `${item.projectName} · context cwd ${compactTerminalPath(item.cwd)}`;
  if (!taskId) {
    return (
      <div className="term-session-bar shell" data-testid="terminal-context-bar">
        <Ic name="terminal" size={13} />
        <span className="tsb-shell-name">{item.title}</span>
        <span className="tsb-context" title={`Host-set context cwd: ${item.cwd}`}>
          {context}
        </span>
        <span className="tsb-sp" />
        <span className="tsb-pty-state">PTY {item.exited ? 'ended' : 'live'}</span>
      </div>
    );
  }
  const live = session ? session.status === 'active' : cli !== null;
  const files = session?.files.length ?? 0;
  const name = cli ?? session?.cli ?? 'agent';
  const slotTaken = promoted !== null && promoted.terminalId !== terminalId;
  const openRoom = (): void => useAppStore.getState().openTaskRoom(taskId);
  return (
    <div className={`term-session-bar ${live ? '' : 'ended'}`} data-testid="terminal-session-bar">
      <span className="tsb-dot" />
      <span className="tsb-cli">✳ {agentDisplayName(name)}</span>
      <span
        className="term-agent-ext"
        title="External agent session — unmanaged (outside the Tool Gateway); tracked & reviewable"
      >
        EXT · unmanaged
      </span>
      <span className="tsb-context" title={`Host-set context cwd: ${item.cwd}`}>
        {context}
      </span>
      {live ? (
        <span key={files} className="tsb-files" data-testid="session-bar-files">
          <b>{files}</b> file{files === 1 ? '' : 's'}
        </span>
      ) : (
        <span className="tsb-ended" data-testid="session-bar-ended">
          ✻ ended · {files} file{files === 1 ? '' : 's'}
        </span>
      )}
      <span className="tsb-sp" />
      {!live ? (
        <button
          className="tsb-btn"
          data-testid="session-bar-resume"
          disabled={!task?.external}
          title="Resume this CLI in the same recorded working context"
          onClick={() => task && void useExternalStore.getState().resumeTask(task)}
        >
          Resume
        </button>
      ) : null}
      {!live ? (
        <button
          className="tsb-btn review"
          data-testid="session-bar-review"
          title="Review this session's changes (accept or roll back byte-exactly)"
          onClick={openRoom}
        >
          Review
        </button>
      ) : null}
      <button
        className="tsb-btn"
        data-testid="session-bar-room"
        title="Open this session's Task Room — live changes, peek and review around this terminal"
        onClick={openRoom}
      >
        ⤢ Room
      </button>
      {live ? (
        <button
          className="tsb-btn primary"
          data-testid="session-bar-promote"
          title={
            slotTaken
              ? 'Atomically replace the terminal in the side focus slot'
              : 'Move this session terminal to the right side panel (return anytime)'
          }
          onClick={() => useExternalStore.getState().promote(terminalId)}
        >
          {slotTaken ? '⇄ Replace' : '⇥ Move side'}
        </button>
      ) : null}
    </div>
  );
}

/**
 * ADR-0021 — the marker rail: one dot per block (green ok / red non-zero exit
 * / blue running / purple turn), positioned by buffer fraction. Click = jump
 * to that block and flash it. Ghostty's jump_to_prompt made this keyboard-
 * reachable; the rail makes failures eye-reachable.
 */
function TerminalBlockRail({ item }: { item: TermInstance }): React.JSX.Element | null {
  useBlocksVersion((s) => s.versions[item.id] ?? 0);
  const [, setTick] = useState(0);
  useEffect(() => {
    const scroll = item.term.onScroll(() => setTick((t) => t + 1));
    const interval = setInterval(() => {
      if (item.blocks.runningBlock()) setTick((t) => t + 1);
    }, 1000);
    return () => {
      scroll.dispose();
      clearInterval(interval);
    };
  }, [item]);
  const blocks = item.blocks.visibleBlocks();
  if (blocks.length === 0) return null;
  const buffer = item.term.buffer.active;
  const totalLines = Math.max(1, buffer.baseY + item.term.rows);
  return (
    <div className="term-block-rail" data-testid="terminal-block-rail">
      {blocks.map((block) => {
        const cls =
          block.kind === 'turn'
            ? 'turn'
            : block.running
              ? 'run'
              : block.exitCode !== null && block.exitCode !== 0
                ? 'err'
                : 'ok';
        const top = Math.min(97, (Math.max(0, block.marker.line) / totalLines) * 96);
        const state = block.running
          ? 'running'
          : block.exitCode === null
            ? 'ended'
            : block.exitCode === 0
              ? '✓'
              : `exit ${block.exitCode}`;
        return (
          <button
            key={block.id}
            className={`term-rail-mark ${cls} ${item.blocks.selectedId === block.id ? 'on' : ''}`}
            style={{ top: `${top}%` }}
            title={`${block.command || (block.kind === 'turn' ? 'turn' : 'command')} · ${state}`}
            aria-label={`Jump to block: ${block.command || state}`}
            data-testid={`terminal-rail-${cls}`}
            onClick={() => selectBlock(item, block, { flash: true })}
          />
        );
      })}
    </div>
  );
}

/** ADR-0021 — actions for the selected block: copy / send to Room / save / rerun. */
function TerminalBlockToolbar({ item }: { item: TermInstance }): React.JSX.Element | null {
  useBlocksVersion((s) => s.versions[item.id] ?? 0);
  const taskRoomTaskId = useAppStore((s) => s.taskRoomTaskId);
  const block = item.blocks.selected();
  if (!block) return null;
  const busy = item.blocks.runningBlock() !== null;
  const rerunOf = block.rerunOf ? item.blocks.byId(block.rerunOf) : null;
  const duration = block.endedAt !== null ? formatElapsed(block.endedAt - block.startedAt) : null;
  const copyOutput = (): void => {
    void navigator.clipboard.writeText(terminalBlockText(item, block));
    useAppStore.getState().pushToast('success', 'Block output copied.');
  };
  const sendToRoom = (): void => {
    if (!taskRoomTaskId) return;
    const text = terminalBlockText(item, block);
    const lineCount = Math.max(1, text.split('\n').length);
    useDraftStore.getState().addTerminalRef(taskRoomTaskId, {
      id: `terminal-ref-${Date.now()}`,
      title: `Terminal block · ${block.command.slice(0, 40) || 'output'}`,
      text,
      cwd: item.cwd,
      contextLabel: `${item.projectName} · ${item.contextLabel}`,
      lineCount,
    });
    useAppStore
      .getState()
      .pushToast('success', `Added this ${lineCount}-line block to the current Room reply.`);
    useAppStore.getState().focusComposer();
  };
  const saveAttachment = (): void => {
    const blob = new Blob([terminalBlockText(item, block)], {
      type: 'text/plain;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `terminal-block-${new Date().toISOString().replaceAll(':', '-')}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const rerun = (): void => {
    if (busy || item.exited || !block.command) return;
    // User-domain action (TERM-005): the recorded command goes back to the
    // same PTY; the new block links to this one (VER-005 superseded, both stay).
    item.blocks.markNextCommandAsRerunOf(block.id);
    void rpcResult('terminal.write', { id: item.id, data: `${block.command}\r` });
    clearBlockSelection(item);
    item.term.focus();
  };
  return (
    <div className="term-block-toolbar" data-testid="terminal-block-toolbar">
      <span className="tbt-kind">{block.kind === 'turn' ? 'turn' : '%'}</span>
      <span className="tbt-cmd" title={block.command}>
        {block.command || '(command not recorded)'}
      </span>
      {block.running ? (
        <span className="tbt-state run">running</span>
      ) : block.exitCode === null ? (
        <span className="tbt-state">ended</span>
      ) : (
        <span className={`tbt-state ${block.exitCode === 0 ? 'ok' : 'err'}`}>
          {block.exitCode === 0 ? '✓' : `exit ${block.exitCode}`}
        </span>
      )}
      {duration ? <span className="tbt-meta">{duration}</span> : null}
      {rerunOf ? (
        <button
          className="tbt-btn link"
          title="This is a rerun — view the superseded run"
          onClick={() => selectBlock(item, rerunOf, { flash: true })}
        >
          rerun ↰
        </button>
      ) : null}
      <span className="tbt-sp" />
      <button className="tbt-btn" data-testid="block-copy" onClick={copyOutput}>
        Copy output
      </button>
      <button
        className="tbt-btn"
        data-testid="block-send-room"
        disabled={!taskRoomTaskId}
        title={
          taskRoomTaskId
            ? 'Add this block as a reference to the current Room reply (attributed to YOU)'
            : 'Open a Task Room first'
        }
        onClick={sendToRoom}
      >
        ⤴ Send to Room
      </button>
      <button className="tbt-btn" data-testid="block-save" onClick={saveAttachment}>
        Save as attachment
      </button>
      {block.kind === 'command' ? (
        <button
          className="tbt-btn"
          data-testid="block-rerun"
          disabled={busy || item.exited || !block.command}
          title={
            busy
              ? 'Wait for the current command to finish before rerunning'
              : item.exited
                ? 'The terminal has exited'
                : 'Run this command again in the same terminal (user action; no approval)'
          }
          onClick={rerun}
        >
          ↻ Rerun
        </button>
      ) : null}
      <button
        className="tbt-btn quiet"
        aria-label="Clear block selection"
        data-testid="block-dismiss"
        onClick={() => {
          clearBlockSelection(item);
          item.term.focus();
        }}
      >
        <Ic name="x" size={12} />
      </button>
    </div>
  );
}

/** ADR-0021 — per-row attention: progress ring while running, bell when done unfocused. */
function TerminalRowIndicator({ item }: { item: TermInstance }): React.JSX.Element | null {
  useBlocksVersion((s) => s.versions[item.id] ?? 0);
  const [now, setNow] = useState(Date.now());
  const running = item.blocks.runningBlock();
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running]);
  if (item.blocks.bell) {
    return (
      <span
        className="terminal-row-bell"
        data-testid={`terminal-bell-${item.id}`}
        title="Command finished — click the row to inspect"
      >
        ◐
      </span>
    );
  }
  if (!running || running.kind !== 'command') return null;
  const progress = item.blocks.progressFor(now);
  if (progress?.kind === 'determinate') {
    return (
      <span
        className={`terminal-row-ring ${progress.failed ? 'err' : ''}`}
        data-testid={`terminal-ring-${item.id}`}
        title={`${running.command} · ${progress.percent}%`}
        style={{
          background: `conic-gradient(${progress.failed ? 'var(--danger)' : 'var(--info)'} ${progress.percent}%, var(--border) 0)`,
        }}
      />
    );
  }
  return (
    <span
      className="terminal-row-ring indeterminate"
      data-testid={`terminal-ring-${item.id}`}
      title={`${running.command} · running ${formatElapsed(now - running.startedAt)}`}
    />
  );
}

interface TerminalContextChoice {
  key: string;
  request: TerminalWorkingContext;
  title: string;
  cwd: string;
  kindLabel: string;
  owner: string;
  accounting: string;
  projectPath: string | null;
}

function NewTerminalDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const tasks = useTaskStore((s) => s.tasks);
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [launch, setLaunch] = useState<TerminalLaunch>('shell');
  const [selectedKey, setSelectedKey] = useState('focused');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) setRecent(result.data.items);
    });
    void useTaskStore.getState().refreshTasks();
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [open, onClose]);

  const contexts = useMemo<TerminalContextChoice[]>(() => {
    const choices: TerminalContextChoice[] = [];
    if (workspace) {
      choices.push({
        key: 'focused',
        request: { kind: 'focused' },
        title: workspace.displayName,
        cwd: workspace.path,
        kindLabel: 'FOCUSED',
        owner: `project: ${workspace.displayName}`,
        accounting: 'snapshot + watcher · external unmanaged',
        projectPath: workspace.path,
      });
    }
    for (const project of recent
      .filter((entry) => entry.exists && entry.path !== workspace?.path)
      .slice(0, 3)) {
      choices.push({
        key: `recent:${project.path}`,
        request: { kind: 'recent', projectPath: project.path },
        title: project.displayName,
        cwd: project.path,
        kindLabel: 'RECENT PROJECT',
        owner: `project: ${project.displayName}`,
        accounting: 'snapshot + watcher · external unmanaged',
        projectPath: project.path,
      });
    }
    for (const task of tasks
      .filter((entry) => entry.worktree && !entry.worktree.missing)
      .slice(0, 3)) {
      choices.push({
        key: `task:${task.id}`,
        request: { kind: 'task', taskId: task.id },
        title: `Task worktree · ${task.title}`,
        cwd: task.worktree!.path,
        kindLabel: 'ISOLATED',
        owner: `task worktree: ${task.title}`,
        accounting: 'isolated worktree · task-owned',
        projectPath: task.projectPath,
      });
    }
    choices.push({
      key: 'scratch',
      request: { kind: 'scratch' },
      title: 'Scratch',
      cwd: 'Charter data/scratch/terminal-*',
      kindLabel: 'TEMPORARY',
      owner: 'scratch context',
      accounting: 'no project accounting',
      projectPath: null,
    });
    return choices;
  }, [recent, tasks, workspace]);

  useEffect(() => {
    if (contexts.some((context) => context.key === selectedKey)) return;
    setSelectedKey(contexts[0]?.key ?? 'scratch');
  }, [contexts, selectedKey]);

  if (!open) return null;
  const selected = contexts.find((context) => context.key === selectedKey) ?? contexts[0];
  if (!selected) return null;
  const sameTree = useTerminalStore
    .getState()
    .items.some(
      (item) =>
        (selected.request.kind === 'task' && item.cwd === selected.cwd) ||
        (selected.projectPath !== null && item.projectPath === selected.projectPath),
    );
  const launchLabel = launch === 'shell' ? 'Shell' : launch === 'claude' ? 'Claude Code' : 'Codex';
  const createSelected = async (): Promise<void> => {
    setCreating(true);
    try {
      const id = await useTerminalStore.getState().create({
        context: selected.request,
        launch,
        title: launch === 'shell' ? undefined : launchLabel,
      });
      if (id) onClose();
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="terminal-create-backdrop"
      data-testid="terminal-create-dialog"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="terminal-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminal-create-title"
      >
        <header className="terminal-create-head">
          <div>
            <h2 id="terminal-create-title">New Terminal</h2>
            <p>Create a standard terminal session; the type only chooses its initial command.</p>
          </div>
          <button className="terminal-icon-button" aria-label="Close" onClick={onClose}>
            <Ic name="x" size={16} />
          </button>
        </header>
        <div className="terminal-create-body">
          <section className="terminal-form-section">
            <div className="terminal-form-label">
              01 · Type <span>always a real shell + PTY</span>
            </div>
            <div className="terminal-type-grid">
              {(
                [
                  ['shell', 'Shell', 'Open the default shell'],
                  ['claude', 'Claude Code', 'Run claude after creation'],
                  ['codex', 'Codex', 'Run codex after creation'],
                ] as const
              ).map(([value, title, detail]) => (
                <button
                  key={value}
                  className={`terminal-type-option ${launch === value ? 'selected' : ''}`}
                  data-testid={`terminal-type-${value}`}
                  onClick={() => setLaunch(value)}
                >
                  <strong>{title}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>
          </section>
          <section className="terminal-form-section">
            <div className="terminal-form-label">
              02 · Working context <span>does not change Editor focus</span>
            </div>
            <div className="terminal-context-list">
              {contexts.map((context) => (
                <button
                  key={context.key}
                  className={`terminal-context-option ${selected.key === context.key ? 'selected' : ''}`}
                  data-testid={`terminal-context-${context.request.kind}`}
                  onClick={() => setSelectedKey(context.key)}
                >
                  <span className="terminal-radio" />
                  <span className="terminal-context-copy">
                    <strong>{context.title}</strong>
                    <small>{compactTerminalPath(context.cwd)}</small>
                  </span>
                  <span className="terminal-context-kind">{context.kindLabel}</span>
                </button>
              ))}
            </div>
            <div className={`terminal-resolved ${sameTree && launch !== 'shell' ? 'warning' : ''}`}>
              <span className="terminal-resolved-key">resolved cwd</span>
              <span>{compactTerminalPath(selected.cwd)}</span>
              <span className="terminal-resolved-key">owner</span>
              <span>{selected.owner}</span>
              <span className="terminal-resolved-key">editor focus</span>
              <span>unchanged: {workspace?.displayName ?? 'no focused workspace'}</span>
              <span className="terminal-resolved-key">accounting</span>
              <span>
                {sameTree && launch !== 'shell'
                  ? 'Same working tree · changes may overlap'
                  : selected.accounting}
              </span>
            </div>
          </section>
        </div>
        <footer className="terminal-create-foot">
          <span>
            The host resolves cwd from project, task, or scratch identity; the Renderer never
            submits an arbitrary absolute path.
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="terminal-create-submit"
            disabled={creating}
            onClick={() => void createSelected()}
          >
            {creating ? 'Creating…' : `Create ${launchLabel}`}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function TerminalPanel(): React.JSX.Element {
  const store = useTerminalStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const tasks = useTaskStore((s) => s.tasks);
  const hostRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  // ADR-0017: external agent sessions decorate their terminal's tab.
  const agentByTerminal = useExternalStore((s) => s.agentByTerminal);
  const taskByTerminal = useExternalStore((s) => s.taskByTerminal);
  const sessions = useExternalStore((s) => s.sessions);
  // ADR-0017 rev.2「意图升格」: a terminal the user moved to the side panel is
  // not in the dock — its xterm belongs to the panel until 归位.
  const promoted = useExternalStore((s) => s.promoted);
  const quickConsoleOpen = useQuickConsoleStore((s) => s.open);
  const dockItems = store.items.filter((t) => !t.hidden && t.id !== promoted?.terminalId);
  const activeDock = dockItems.find((t) => t.id === store.active) ?? null;

  useEffect(() => {
    store.init();
    useExternalStore.getState().init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A promoted terminal cannot stay dock-active; hand the slot to a neighbour.
  useEffect(() => {
    if (!promoted || store.active !== promoted.terminalId) return;
    const next = store.items.filter((t) => !t.hidden && t.id !== promoted.terminalId).at(-1);
    useTerminalStore.setState({ active: next?.id ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promoted?.terminalId, store.active]);

  // This component is only mounted while the Terminal Session tool is visible;
  // the room and promoted side slot own their instances at other times.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeDock || (activeDock.quick && quickConsoleOpen)) return;
    mountTerminal(host, activeDock);
    return observeTerminalFit(host, activeDock);
  }, [activeDock, quickConsoleOpen]);

  return (
    <div className="terminal-panel-layout" data-testid="terminal-panel">
      <div className="terminal-main-pane">
        {activeDock ? <SessionBar terminalId={activeDock.id} /> : null}
        {activeDock ? <TerminalBlockToolbar item={activeDock} /> : null}
        <div className="terminal-host-wrap">
          <div
            ref={hostRef}
            className="terminal-host"
            data-testid="terminal-host"
            data-terminal-id={activeDock?.id}
          />
          {activeDock ? <TerminalBlockRail item={activeDock} /> : null}
        </div>
        {dockItems.length === 0 ? (
          <div className="terminal-dock-empty">
            <Ic name="terminal" size={18} />
            <span>
              {promoted
                ? 'The live terminal is in the side focus slot.'
                : workspace
                  ? 'Create a terminal in this project or another working context.'
                  : 'Open a project or choose a recent/scratch context.'}
            </span>
          </div>
        ) : null}
      </div>
      <aside className="terminal-list" aria-label="Terminal sessions">
        <div className="terminal-new-row">
          <button
            className="terminal-new-button"
            data-testid="terminal-new"
            disabled={!workspace}
            title={
              workspace ? `Create a shell in ${workspace.displayName}` : 'Open a project first'
            }
            onClick={() => void store.create({ context: { kind: 'focused' }, launch: 'shell' })}
          >
            <Ic name="plus" size={14} /> New Terminal
          </button>
          <button
            className="terminal-new-menu"
            data-testid="terminal-new-menu"
            title="Choose terminal type and working context"
            aria-label="Choose terminal type and working context"
            onClick={() => setNewTerminalOpen(true)}
          >
            <Ic name="chevron" size={14} />
          </button>
        </div>
        <div className="terminal-list-scroll">
          {store.items
            .filter((terminal) => !terminal.hidden)
            .map((terminal) => {
              const taskId = taskByTerminal[terminal.id];
              const task = taskId ? tasks.find((entry) => entry.id === taskId) : null;
              const session = taskId ? sessions[taskId] : undefined;
              const agent = agentByTerminal[terminal.id] ?? session?.cli ?? null;
              const inSide = promoted?.terminalId === terminal.id;
              const live = Boolean(agentByTerminal[terminal.id]) || session?.status === 'active';
              const ended = Boolean(session && session.status === 'ended');
              const stateLabel = inSide
                ? 'IN SIDE'
                : terminal.quick
                  ? quickConsoleOpen
                    ? 'QUICK · OPEN'
                    : 'QUICK'
                  : live
                    ? 'LIVE'
                    : ended
                      ? 'ENDED'
                      : 'IDLE';
              const dockActive = store.active === terminal.id && !inSide;
              // With a side focus slot, the strong selected color must describe
              // the terminal the user is actually looking at on the right.
              const selected = inSide || (!promoted && dockActive);
              const taskLabel = task?.title ?? terminal.contextLabel;
              const activate = (): void => {
                // When the focus slot is already in use, the session list is a
                // real switcher: clicking another live Agent atomically swaps
                // the two existing PTYs. No tiny secondary action is required.
                if (promoted && agent && live) {
                  useExternalStore.getState().promote(terminal.id);
                  return;
                }
                store.setActive(terminal.id);
              };
              const rowTitle = agent
                ? `${agentDisplayName(agent)} — ${inSide ? 'focus the side terminal' : promoted ? 'switch into the side slot' : 'open in the terminal dock'}`
                : `${terminal.title} — open in the terminal dock`;
              return (
                <div
                  key={terminal.id}
                  className={`terminal-list-row ${selected ? 'selected' : ''} ${inSide ? 'promoted' : ''} ${promoted && dockActive ? 'dock-active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={inSide}
                  data-testid={`terminal-tab-${terminal.id}`}
                  title={rowTitle}
                  onClick={activate}
                  onDoubleClick={() => !agent && !inSide && setRenaming(terminal.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    }
                  }}
                >
                  <span
                    className={`terminal-row-dot ${agent ? '' : 'shell'} ${terminal.exited || ended ? 'ended' : ''}`}
                  />
                  <span className="terminal-row-main">
                    {renaming === terminal.id ? (
                      <input
                        autoFocus
                        className="terminal-rename-input"
                        defaultValue={terminal.title}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter') {
                            store.rename(
                              terminal.id,
                              (event.target as HTMLInputElement).value || terminal.title,
                            );
                            setRenaming(null);
                          }
                          if (event.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <span className="terminal-row-title">
                        {agent ? (
                          <span
                            className="term-agent"
                            data-testid={
                              agentByTerminal[terminal.id]
                                ? `terminal-agent-${terminal.id}`
                                : undefined
                            }
                          >
                            ✳ {agentDisplayName(agent)} <span className="term-agent-ext">EXT</span>
                          </span>
                        ) : (
                          <>
                            {terminal.title}
                            {terminal.quick ? (
                              <span className="terminal-quick-badge">Quick Console</span>
                            ) : null}
                          </>
                        )}
                      </span>
                    )}
                    <span className="terminal-row-context">
                      {terminal.projectName} · {taskLabel}
                    </span>
                    <span
                      className="terminal-row-cwd"
                      title={`Host-set context cwd: ${terminal.cwd}`}
                    >
                      Context cwd · {compactTerminalPath(terminal.cwd)}
                    </span>
                  </span>
                  <span className="terminal-row-side">
                    <TerminalRowIndicator item={terminal} />
                    <span className={`terminal-row-place ${ended ? 'ended' : ''}`}>
                      {stateLabel}
                    </span>
                    <button
                      className="terminal-icon-button terminal-row-close"
                      aria-label={`Close ${terminal.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void store.requestKill(terminal.id);
                      }}
                    >
                      <Ic name="x" size={13} />
                    </button>
                  </span>
                  {taskId ? (
                    <span className="terminal-row-actions">
                      <button
                        className="terminal-row-action"
                        data-testid={`terminal-open-room-${terminal.id}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          useAppStore.getState().openTaskRoom(taskId);
                        }}
                      >
                        ⤢ Room
                      </button>
                      {live ? (
                        <button
                          className="terminal-row-action move"
                          data-testid={`terminal-row-promote-${terminal.id}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            useExternalStore.getState().promote(terminal.id);
                          }}
                        >
                          {inSide
                            ? '↗ Focus side'
                            : promoted
                              ? '⇄ Replace in side'
                              : '⇥ Move to side'}
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
        </div>
      </aside>

      <NewTerminalDialog open={newTerminalOpen} onClose={() => setNewTerminalOpen(false)} />

      {store.pendingKill ? (
        <div className="modal-backdrop">
          <div className="modal small" role="dialog" data-testid="terminal-kill-confirm">
            <div className="modal-header">Terminal has running processes</div>
            <div style={{ padding: 16 }}>
              <p>Closing this terminal will terminate its running processes.</p>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn"
                  onClick={() => void store.confirmKill(store.pendingKill!, false)}
                >
                  Cancel
                </button>
                <button
                  className="btn danger"
                  data-testid="terminal-kill-force"
                  onClick={() => void store.confirmKill(store.pendingKill!, true)}
                >
                  Kill and close
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ADR-0021 — status-bar leg of the three-surface progress: the earliest
 * running command block across all terminals. Determinate = same number as
 * the tab ring and the Dock; otherwise an honest "running · elapsed".
 */
export function TerminalRunStatusItem(): React.JSX.Element | null {
  const items = useTerminalStore((s) => s.items);
  useBlocksVersion((s) => s.versions);
  const [now, setNow] = useState(Date.now());
  // Tick only while a command block is actually running; refresh immediately
  // on start so a stale `now` can never yield a negative elapsed.
  const hasRunningCommand = items.some((item) => item.blocks.runningBlock()?.kind === 'command');
  useEffect(() => {
    if (!hasRunningCommand) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasRunningCommand]);
  let target: { item: TermInstance; block: TermBlock } | null = null;
  for (const item of items) {
    const block = item.blocks.runningBlock();
    if (block?.kind !== 'command') continue;
    if (!target || block.startedAt < target.block.startedAt) target = { item, block };
  }
  if (!target) return null;
  const progress = target.item.blocks.progressFor(now);
  const label = target.block.command.slice(0, 28) || 'command';
  const reveal = (): void => {
    useAppStore.getState().showBottomTab('terminal');
    useTerminalStore.getState().setActive(target!.item.id);
    selectBlock(target!.item, target!.block, { flash: true });
  };
  return (
    <button
      className="sb-item terminal-run-status"
      data-testid="status-terminal-run"
      title={`${target.block.command} — click to reveal this block`}
      onClick={reveal}
    >
      {progress?.kind === 'determinate' ? (
        <>
          <span className="trs-bar">
            <i style={{ width: `${progress.percent}%` }} />
          </span>
          {progress.percent}% · {label}
        </>
      ) : (
        <>
          <span className="trs-spin" />
          {label} · {formatElapsed(now - target.block.startedAt)}
        </>
      )}
    </button>
  );
}

export function TerminalContextsStatusItem(): React.JSX.Element | null {
  const items = useTerminalStore((s) => s.items);
  const agents = useExternalStore((s) => s.agentByTerminal);
  if (items.length === 0) return null;
  const contexts = new Set(items.map((item) => item.cwd)).size;
  const liveAgents = Object.keys(agents).length;
  return (
    <span
      className="sb-item terminal-context-status"
      data-testid="status-terminal-contexts"
      title={`${items.length} terminal sessions in ${contexts} independent working contexts`}
    >
      Terminal contexts: <strong>{contexts}</strong>
      {liveAgents > 0 ? <span className="terminal-live-status">● {liveAgents} live</span> : null}
    </span>
  );
}
