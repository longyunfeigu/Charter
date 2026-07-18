import { create } from 'zustand';
import type {
  AppInfoDto,
  LayoutState,
  Settings,
  SideBarView,
  BottomTab,
  TaskDto,
} from '@pi-ide/ipc-contracts';
import { LayoutStateSchema } from '@pi-ide/ipc-contracts';
import { newId } from '@pi-ide/foundation';
import { onEvent, rpc, rpcResult } from '../bridge.js';
import { peekOpen, peekCloseTab, type PeekState } from '../views/peek.js';
import { applyAppearance } from '../appearance.js';
import {
  externalSessionReplyInfo,
  sessionCompletionInfo,
  sessionDisplayTitle,
  type ExternalReplyBoundary,
  type SessionNoticeTone,
} from './sessionAttention.js';

export type OverlayKind = 'none' | 'settings' | 'diagnostics' | 'about';
/** Contextual tools owned by the active Session. These replace the old
 * app-level workspace shell. */
export type SessionTool = 'summary' | 'diff' | 'file' | 'preview' | 'terminal' | 'review';
/** Project-level tools used before a Session exists. They render inside the
 * persistent Session shell and never recreate the legacy IDE frame. */
export type ProjectTool = 'files' | 'search' | 'changes';
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

export interface SessionCompletionSignal {
  id: string;
  edgeKey: string;
  taskId: string;
  state: TaskDto['state'];
  tone: SessionNoticeTone;
}

export interface SessionReplySignal {
  id: string;
  edgeKey: string;
  taskId: string;
}

export interface SessionNotice extends SessionCompletionSignal {
  kind: 'completion' | 'reply';
  title: string;
  projectName: string;
  label: string;
  body: string;
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
  /** Short-lived run-completion edges that animate the matching Session row. */
  sessionCompletionSignals: SessionCompletionSignal[];
  /** Short-lived completed agent replies that add live presence to the matching row. */
  sessionReplySignals: SessionReplySignal[];
  /** Clickable, auto-expiring in-app completion notifications. */
  sessionNotices: SessionNotice[];
  /** A notification click asks the rail to reveal this exact Session. */
  sessionReveal: { taskId: string; seq: number } | null;
  /** Compatibility surface flag; the runtime now always renders the unified Session shell. */
  surface: 'home' | 'workspace';
  /** The managed task selected as the active user-facing Session. */
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
  /** The right-hand tool canvas follows the Session instead of becoming a
   * second application shell. */
  sessionTool: SessionTool;
  sessionToolExpanded: boolean;
  projectTool: ProjectTool | null;
  /** Contextual lower panel for project diagnostics. It belongs to Project
   * Tools and does not resurrect the retired global workspace shell. */
  projectBottomTab: BottomTab | null;
  openPreviewRail(taskId: string): void;
  closePreviewRail(): void;
  setSessionTool(tool: SessionTool): void;
  setSessionToolExpanded(expanded: boolean): void;
  setProjectTool(tool: ProjectTool | null): void;
  setProjectBottomTab(tab: BottomTab | null): void;
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
  signalSessionReply(taskId: string, edgeKey: string): void;
  signalExternalSessionNotice(
    task: TaskDto,
    edgeKey: string,
    boundary: ExternalReplyBoundary,
    status?: 'ok' | 'error',
  ): void;
  signalSessionCompletion(task: TaskDto): void;
  dismissSessionNotice(id: string): void;
  revealTaskSession(taskId: string): void;
  clearSessionReveal(seq: number): void;
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
  sessionCompletionSignals: [],
  sessionReplySignals: [],
  sessionNotices: [],
  sessionReveal: null,
  surface: 'home',
  taskRoomTaskId: null,
  sessionTerminalId: null,
  homePick: false,
  pendingRefs: [],
  newProjectOpen: false,
  lens: null,
  peek: null,
  previewRailTaskId: null,
  sessionTool: 'summary',
  sessionToolExpanded: false,
  projectTool: null,
  projectBottomTab: null,
  composerFocusSeq: 0,

  setSurface(surface) {
    // The compatibility "workspace" value now opens a contextual tool state
    // inside the one Session shell. With an active Session it expands that
    // Session's tool canvas; otherwise it opens the current project's Files
    // tool beside the persistent global rail.
    if (surface === 'workspace' && get().taskRoomTaskId) {
      set({ surface: 'home', sessionToolExpanded: true, projectTool: null });
      return;
    }
    set({
      surface,
      projectTool: surface === 'workspace' ? (get().projectTool ?? 'files') : null,
    });
  },

  setLens(lens) {
    set({ lens });
  },

  openPeek(taskId, path, mode) {
    // Peek and the preview rail share the room's side column — exclusive.
    const nextMode = mode ?? 'diff';
    set({
      peek: peekOpen(get().peek, taskId, path, nextMode),
      previewRailTaskId: null,
      sessionTool: nextMode === 'diff' ? 'diff' : 'file',
      ...(nextMode === 'diff' ? { sessionToolExpanded: true } : {}),
    });
  },
  closePeek() {
    set({ peek: null, sessionTool: 'summary', sessionToolExpanded: false });
  },
  openPreviewRail(taskId) {
    set({ previewRailTaskId: taskId, peek: null, sessionTool: 'preview' });
  },
  closePreviewRail() {
    set({ previewRailTaskId: null, sessionTool: 'summary', sessionToolExpanded: false });
  },
  setSessionTool(sessionTool) {
    set({
      sessionTool,
      ...(sessionTool === 'diff' ? { sessionToolExpanded: true } : {}),
      ...(sessionTool !== 'preview' ? { previewRailTaskId: null } : {}),
      ...(sessionTool !== 'diff' && sessionTool !== 'file' ? { peek: null } : {}),
    });
  },
  setSessionToolExpanded(sessionToolExpanded) {
    set({ sessionToolExpanded });
  },
  setProjectTool(projectTool) {
    set({
      projectTool,
      surface: projectTool ? 'workspace' : 'home',
      ...(projectTool
        ? { taskRoomTaskId: null, sessionTerminalId: null }
        : { projectBottomTab: null }),
    });
  },
  setProjectBottomTab(projectBottomTab) {
    set({ projectBottomTab });
  },
  closePeekTab(path) {
    const peek = get().peek;
    if (peek) set({ peek: peekCloseTab(peek, path) });
  },
  setPeekMode(mode) {
    const peek = get().peek;
    if (peek) {
      set({
        peek: { ...peek, mode },
        sessionTool: mode === 'diff' ? 'diff' : 'file',
        ...(mode === 'diff' || mode === 'edit' ? { sessionToolExpanded: true } : {}),
      });
    }
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
      sessionTool: 'summary',
      sessionToolExpanded: false,
      projectTool: null,
      projectBottomTab: null,
      ...(peek && peek.taskId !== taskId ? { peek: null } : {}),
    });
  },

  revealTaskSession(taskId) {
    get().openTaskRoom(taskId);
    set({
      sessionReveal: {
        taskId,
        seq: (get().sessionReveal?.seq ?? 0) + 1,
      },
    });
  },
  clearSessionReveal(seq) {
    if (get().sessionReveal?.seq === seq) set({ sessionReveal: null });
  },

  openTerminalSession(terminalId) {
    set({
      sessionTerminalId: terminalId,
      taskRoomTaskId: null,
      surface: 'home',
      peek: null,
      previewRailTaskId: null,
      sessionTool: 'terminal',
      sessionToolExpanded: false,
      projectTool: null,
      projectBottomTab: null,
    });
  },

  closeTaskRoom() {
    set({
      taskRoomTaskId: null,
      sessionTerminalId: null,
      peek: null,
      previewRailTaskId: null,
      sessionTool: 'summary',
      sessionToolExpanded: false,
      projectTool: null,
      projectBottomTab: null,
    });
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
    if (!get().taskRoomTaskId) {
      set({ projectTool: get().projectTool === 'files' ? null : 'files' });
    }
  },
  toggleAgentPanel() {
    if (get().taskRoomTaskId) {
      set({ sessionTool: 'summary', sessionToolExpanded: !get().sessionToolExpanded });
    }
  },
  toggleBottomPanel() {
    if (get().taskRoomTaskId) {
      set({
        sessionTool: get().sessionTool === 'terminal' ? 'summary' : 'terminal',
        sessionToolExpanded: get().sessionTool !== 'terminal',
      });
    }
  },
  showSideBarView(view) {
    if (!get().taskRoomTaskId) {
      set({
        surface: 'workspace',
        projectTool: view === 'search' ? 'search' : view === 'scm' ? 'changes' : 'files',
      });
      return;
    }
    set({
      sessionTool: view === 'explorer' ? 'file' : view === 'scm' ? 'diff' : 'summary',
      sessionToolExpanded: view === 'explorer' || view === 'scm',
    });
  },
  showBottomTab(tab) {
    if (!get().taskRoomTaskId) {
      if (tab !== 'terminal') {
        set({
          surface: 'workspace',
          projectTool: 'files',
          projectBottomTab: tab,
        });
      }
      return;
    }
    set({
      surface: 'home',
      sessionTool: tab === 'terminal' ? 'terminal' : tab === 'tests' ? 'review' : 'summary',
      sessionToolExpanded: tab === 'terminal',
    });
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
  signalSessionReply(taskId, edgeKey) {
    if (get().sessionReplySignals.some((signal) => signal.edgeKey === edgeKey)) return;
    const id = newId('session-reply');
    set({
      sessionReplySignals: [...get().sessionReplySignals, { id, edgeKey, taskId }].slice(-32),
    });
    setTimeout(() => {
      set({
        sessionReplySignals: get().sessionReplySignals.filter((candidate) => candidate.id !== id),
      });
    }, 4_200);
  },
  signalExternalSessionNotice(task, edgeKey, boundary, status = 'ok') {
    const info = externalSessionReplyInfo(task, boundary, status);
    if (!info || get().settings?.notifications.enabled === false) return;
    // If the process already crossed a terminal task-state edge, that stronger
    // task notification owns the banner. The row presence signal still runs.
    if (sessionCompletionInfo(task)) return;
    if (get().sessionNotices.some((notice) => notice.edgeKey === edgeKey)) return;

    const id = newId('session-reply-notice');
    const notice: SessionNotice = {
      id,
      edgeKey,
      taskId: task.id,
      state: task.state,
      tone: info.tone,
      kind: 'reply',
      title: sessionDisplayTitle(task),
      projectName: task.projectName,
      label: info.label,
      body: info.body,
    };
    // A later reply for this Session replaces the earlier one instead of
    // stacking repeated cards for the same long-lived interactive process.
    set({
      sessionNotices: [
        ...get().sessionNotices.filter((candidate) => candidate.taskId !== task.id),
        notice,
      ].slice(-3),
    });
    setTimeout(() => get().dismissSessionNotice(id), 5_000);
  },
  signalSessionCompletion(task) {
    const info = sessionCompletionInfo(task);
    if (!info) return;
    const edgeKey = `${task.id}:${task.state}:${task.updatedAt}`;
    if (get().sessionCompletionSignals.some((signal) => signal.edgeKey === edgeKey)) return;

    const id = newId('session-completion');
    const signal: SessionCompletionSignal = {
      id,
      edgeKey,
      taskId: task.id,
      state: task.state,
      tone: info.tone,
    };
    set({
      sessionCompletionSignals: [...get().sessionCompletionSignals, signal].slice(-24),
    });
    setTimeout(() => {
      set({
        sessionCompletionSignals: get().sessionCompletionSignals.filter(
          (candidate) => candidate.id !== id,
        ),
      });
    }, 4_200);

    // The global notification preference gates banners, while the quieter row
    // pulse remains available as local Session-page feedback.
    if (get().settings?.notifications.enabled === false) return;
    const notice: SessionNotice = {
      ...signal,
      kind: 'completion',
      title: sessionDisplayTitle(task),
      projectName: task.projectName,
      label: info.label,
      body: info.body,
    };
    // A task-state completion is stronger than a preceding external reply
    // edge, so it atomically replaces that Session's transient reply card.
    set({
      sessionNotices: [
        ...get().sessionNotices.filter((candidate) => candidate.taskId !== task.id),
        notice,
      ].slice(-3),
    });
    setTimeout(() => get().dismissSessionNotice(id), 5_000);
  },
  dismissSessionNotice(id) {
    set({ sessionNotices: get().sessionNotices.filter((notice) => notice.id !== id) });
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
