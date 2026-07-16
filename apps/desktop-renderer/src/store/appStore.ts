import { create } from 'zustand';
import type {
  AppInfoDto,
  LayoutState,
  Settings,
  SideBarView,
  BottomTab,
} from '@pi-ide/ipc-contracts';
import { LayoutStateSchema } from '@pi-ide/ipc-contracts';
import { newId } from '@pi-ide/foundation';
import { onEvent, rpc, rpcResult } from '../bridge.js';
import { peekOpen, peekCloseTab, type PeekState } from '../views/peek.js';
import { applyAppearance } from '../appearance.js';

export type OverlayKind = 'none' | 'settings' | 'diagnostics' | 'about';
export type SettingsSection =
  | 'general'
  | 'editor'
  | 'terminal'
  | 'agent'
  | 'models'
  | 'permissions'
  | 'privacy'
  | 'updates'
  | 'about';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success' | 'warning';
  message: string;
}

interface AppStore {
  ready: boolean;
  appInfo: AppInfoDto | null;
  settings: Settings | null;
  settingsIssues: string[];
  layout: LayoutState;
  paletteOpen: boolean;
  /** ⌘K quick launcher (PIVOT-018): projects, tasks, files, actions. */
  launcherOpen: boolean;
  overlay: OverlayKind;
  settingsSection: SettingsSection;
  toasts: Toast[];
  /** Dual-form shell (ADR-0004): Home task launcher vs full IDE workspace. */
  surface: 'home' | 'workspace';
  /** Task Room (ADR-0008, PIVOT-021): task page inside the Home surface. */
  taskRoomTaskId: string | null;
  /**
   * Session-first shell: a terminal can be selected before external-agent
   * detection has created its accounting task. Once detection lands the shell
   * migrates this selection to the matching Task Room without moving the PTY.
   */
  sessionTerminalId: string | null;
  /** True while the Home project menu is opening a workspace — suppresses the auto-switch. */
  homePick: boolean;
  /** File refs queued for the next Home charter (e.g. "attach annotated image"). */
  pendingRefs: string[];
  /** New project dialog (empty/clone) — global so the sidebar entry works from any surface. */
  newProjectOpen: boolean;
  /** Diff-so-far lens (PIVOT-025) — global so boards in any surface share it. */
  lens: { taskId: string; path: string } | null;
  /** In-room file peek (ADR-0014, PIVOT-034) — global so it survives ⌘E round-trips. */
  peek: PeekState | null;
  /** ADR-0022 am.2: the Room's live-preview rail (taskId), exclusive with peek. */
  previewRailTaskId: string | null;
  openPreviewRail(taskId: string): void;
  closePreviewRail(): void;
  /** Bumped when a control asks the launcher composer to take focus. */
  composerFocusSeq: number;

  init(): Promise<void>;
  setSurface(surface: 'home' | 'workspace'): void;
  openTaskRoom(taskId: string): void;
  openTerminalSession(terminalId: string): void;
  closeTaskRoom(): void;
  setHomePick(inProgress: boolean): void;
  setLens(lens: { taskId: string; path: string } | null): void;
  openPeek(taskId: string, path: string, mode?: PeekState['mode']): void;
  closePeek(): void;
  closePeekTab(path: string): void;
  setPeekMode(mode: PeekState['mode']): void;
  setPeekActive(path: string): void;
  focusComposer(): void;
  addPendingRefs(refs: string[]): void;
  consumePendingRefs(): string[];
  setNewProjectOpen(open: boolean): void;
  setLayout(patch: Partial<LayoutState>): void;
  toggleSidebar(): void;
  toggleAgentPanel(): void;
  toggleBottomPanel(): void;
  showSideBarView(view: SideBarView): void;
  showBottomTab(tab: BottomTab): void;
  setPaletteOpen(open: boolean): void;
  setLauncherOpen(open: boolean): void;
  setOverlay(overlay: OverlayKind): void;
  openSettings(section?: SettingsSection): void;
  updateSettings(scope: 'global' | 'workspace', patch: Record<string, unknown>): Promise<void>;
  refreshSettings(): Promise<void>;
  pushToast(kind: Toast['kind'], message: string): void;
  dismissToast(id: string): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLayout: LayoutState | null = null;
function persistLayout(layout: LayoutState): void {
  pendingLayout = layout;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const toSave = pendingLayout;
    pendingLayout = null;
    if (toSave) void rpcResult('layout.save', { layout: toSave });
  }, 400);
}

/** Layout changes made within the debounce window must survive quitting (APP-003). */
function flushPendingLayout(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const toSave = pendingLayout;
  pendingLayout = null;
  if (toSave) void rpcResult('layout.save', { layout: toSave });
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingLayout);
}

export const useAppStore = create<AppStore>((set, get) => ({
  ready: false,
  appInfo: null,
  settings: null,
  settingsIssues: [],
  layout: LayoutStateSchema.parse({}),
  paletteOpen: false,
  launcherOpen: false,
  overlay: 'none',
  settingsSection: 'general',
  toasts: [],
  surface: 'home',
  taskRoomTaskId: null,
  sessionTerminalId: null,
  homePick: false,
  pendingRefs: [],
  newProjectOpen: false,
  lens: null,
  peek: null,
  previewRailTaskId: null,
  composerFocusSeq: 0,

  setSurface(surface) {
    set({ surface });
  },

  setLens(lens) {
    set({ lens });
  },

  openPeek(taskId, path, mode) {
    // Peek and the preview rail share the room's side column — exclusive.
    set({ peek: peekOpen(get().peek, taskId, path, mode), previewRailTaskId: null });
  },
  closePeek() {
    set({ peek: null });
  },
  openPreviewRail(taskId) {
    set({ previewRailTaskId: taskId, peek: null });
  },
  closePreviewRail() {
    set({ previewRailTaskId: null });
  },
  closePeekTab(path) {
    const peek = get().peek;
    if (peek) set({ peek: peekCloseTab(peek, path) });
  },
  setPeekMode(mode) {
    const peek = get().peek;
    if (peek) set({ peek: { ...peek, mode } });
  },
  setPeekActive(path) {
    const peek = get().peek;
    if (peek && peek.paths.includes(path)) set({ peek: { ...peek, active: path } });
  },

  focusComposer() {
    set({ composerFocusSeq: get().composerFocusSeq + 1 });
  },

  openTaskRoom(taskId) {
    // The peek belongs to one room — entering a different task's room resets it.
    const peek = get().peek;
    set({
      taskRoomTaskId: taskId,
      sessionTerminalId: null,
      surface: 'home',
      ...(peek && peek.taskId !== taskId ? { peek: null } : {}),
    });
  },

  openTerminalSession(terminalId) {
    set({
      sessionTerminalId: terminalId,
      taskRoomTaskId: null,
      surface: 'home',
      peek: null,
      previewRailTaskId: null,
    });
  },

  closeTaskRoom() {
    set({ taskRoomTaskId: null, sessionTerminalId: null, peek: null, previewRailTaskId: null });
  },

  setHomePick(inProgress) {
    set({ homePick: inProgress });
  },

  addPendingRefs(refs) {
    set({ pendingRefs: [...new Set([...get().pendingRefs, ...refs])].slice(0, 20) });
  },

  consumePendingRefs() {
    const refs = get().pendingRefs;
    if (refs.length > 0) set({ pendingRefs: [] });
    return refs;
  },

  setNewProjectOpen(open) {
    set({ newProjectOpen: open });
  },

  async init() {
    const [info, settingsState, layoutRes] = await Promise.all([
      rpcResult('app.getInfo', {}),
      rpcResult('settings.get', {}),
      rpcResult('layout.get', {}),
    ]);
    if (info.ok) set({ appInfo: info.data });
    if (settingsState.ok) {
      applyAppearance(settingsState.data.effective);
      set({ settings: settingsState.data.effective, settingsIssues: settingsState.data.issues });
    }
    if (layoutRes.ok && layoutRes.data.layout) set({ layout: layoutRes.data.layout });
    set({ ready: true });

    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyAppearance(get().settings);
    });
    onEvent('settings.changed', () => {
      void get().refreshSettings();
    });
  },

  setLayout(patch) {
    const layout = { ...get().layout, ...patch };
    set({ layout });
    persistLayout(layout);
  },

  toggleSidebar() {
    get().setLayout({ sideBarVisible: !get().layout.sideBarVisible });
  },
  toggleAgentPanel() {
    get().setLayout({ agentPanelVisible: !get().layout.agentPanelVisible });
  },
  toggleBottomPanel() {
    if (get().surface === 'home') {
      get().setSurface('workspace');
      get().setLayout({ bottomPanelVisible: true });
      return;
    }
    get().setLayout({ bottomPanelVisible: !get().layout.bottomPanelVisible });
  },
  showSideBarView(view) {
    get().setLayout({ sideBarView: view, sideBarVisible: true });
  },
  showBottomTab(tab) {
    // Bottom-panel commands remain globally available while Home covers the
    // workbench. Reveal the Editor before opening the requested tab so actions
    // such as Terminal → New Terminal never succeed invisibly behind Home.
    get().setSurface('workspace');
    get().setLayout({ bottomTab: tab, bottomPanelVisible: true });
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  setLauncherOpen(open) {
    set({ launcherOpen: open });
  },
  setOverlay(overlay) {
    set({ overlay });
  },
  openSettings(settingsSection = 'general') {
    set({ overlay: 'settings', settingsSection });
  },

  async updateSettings(scope, patch) {
    const result = await rpcResult('settings.update', { scope, patch });
    if (result.ok) {
      applyAppearance(result.data.effective);
      set({ settings: result.data.effective, settingsIssues: result.data.issues });
    } else {
      get().pushToast('error', `${result.error.userMessage} (${result.error.code})`);
    }
  },

  async refreshSettings() {
    const result = await rpcResult('settings.get', {});
    if (result.ok) {
      applyAppearance(result.data.effective);
      set({ settings: result.data.effective, settingsIssues: result.data.issues });
    }
  },

  pushToast(kind, message) {
    const toast: Toast = { id: newId('toast'), kind, message };
    set({ toasts: [...get().toasts, toast] });
    setTimeout(() => get().dismissToast(toast.id), kind === 'error' ? 8000 : 4000);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export async function reportClientError(
  code: string,
  message: string,
  stack?: string,
): Promise<void> {
  try {
    await rpc('app.reportClientError', { code, message, ...(stack ? { stack } : {}) });
  } catch {
    // never loop on error reporting
  }
}
