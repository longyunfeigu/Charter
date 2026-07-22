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
import { newId, type ProductError } from '@pi-ide/foundation';
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

export type OverlayKind = 'none' | 'settings' | 'diagnostics' | 'about' | 'memory';
/** Contextual tools owned by the active Session. These replace the old
 * app-level workspace shell. */
export type SessionTool = 'summary' | 'diff' | 'file' | 'preview' | 'terminal' | 'review';
/** Primary content inside a Commander Session. Fleet is a Session-local view,
 * never a global navigation destination or a replacement for Home. */
export type SessionRoomView = 'conversation' | 'fleet';
/** Project-level tools used before a Session exists. They render inside the
 * persistent Session shell and never recreate the legacy IDE frame.
 * ADR-0029: 'editor' is the plain editor (no context column) — the one
 * project tree lives in the rail's Files pane. */
export type ProjectTool = 'editor' | 'search' | 'changes';
/** The rail's contextual views inside the single navigation surface.
 * 'files' is the persistent context-feeding tree (ADR-0024, ADR-0029). */
export type RailView = 'sessions' | 'inbox' | 'projects' | 'files' | 'skills';

/** ADR-0042 — the identity of what the main content area is showing
 * (mirrors HomeShell's render priority). */
export type MainSurface =
  | { kind: 'home' }
  | { kind: 'room'; taskId: string }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'project-tool'; tool: ProjectTool }
  | { kind: 'archaeology'; scope: string | null };

/** ADR-0042 — rail views form two navigation groups that each own their main
 * surface. sessions/inbox/files are one workbench (inbox is a filtered session
 * list; Files feeds the open conversation), projects is its own page. */
export type RailGroup = 'workbench' | 'projects' | 'skills';

export function railGroupOf(view: RailView): RailGroup {
  if (view === 'projects') return 'projects';
  if (view === 'skills') return 'skills';
  return 'workbench';
}

export function mainSurfaceOf(
  s: Pick<AppStore, 'taskRoomTaskId' | 'sessionTerminalId' | 'archaeology' | 'projectTool'>,
): MainSurface {
  if (s.sessionTerminalId) return { kind: 'terminal', terminalId: s.sessionTerminalId };
  if (s.taskRoomTaskId) return { kind: 'room', taskId: s.taskRoomTaskId };
  if (s.archaeology) return { kind: 'archaeology', scope: s.archaeology.scope };
  if (s.projectTool) return { kind: 'project-tool', tool: s.projectTool };
  return { kind: 'home' };
}
export type SettingsSection =
  | 'general'
  | 'editor'
  | 'terminal'
  | 'agent'
  | 'skills'
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
  sessionRoomView: SessionRoomView;
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
  /** Manual conversation/tool split (% of the canvas given to the conversation)
   * per Session — set by the drag handle (design mock A). While present it
   * overrides the two-stop expanded model, so the Diff auto-expand no longer
   * shrinks a conversation the user widened by hand. */
  sessionSplit: Record<string, number>;
  sessionSplitDragging: boolean;
  projectTool: ProjectTool | null;
  /** Contextual lower panel for project diagnostics. It belongs to Project
   * Tools and does not resurrect the retired global workspace shell. */
  projectBottomTab: BottomTab | null;
  /** ADR-0038: session-archaeology page. `scope` narrows to one project path
   * (or discovered directory); null shows all agent activity on this machine. */
  archaeology: { scope: string | null } | null;
  openArchaeology(scope: string | null): void;
  closeArchaeology(): void;
  /** ADR-0029: the rail's panel view, lifted so commands and flows that mean
   * "show me the project files" can reveal the one tree. */
  railView: RailView;
  setRailView(view: RailView): void;
  /** ADR-0042: each nav group's last main surface, restored when the rail
   * returns to that group so left nav and main content always correspond. */
  savedSurfaces: Record<RailGroup, MainSurface>;
  openPreviewRail(taskId: string): void;
  closePreviewRail(): void;
  setSessionTool(tool: SessionTool): void;
  setSessionToolExpanded(expanded: boolean): void;
  /** pct = conversation share (20–80); null returns the Session to the stops. */
  setSessionSplit(taskId: string, pct: number | null): void;
  setSessionSplitDragging(dragging: boolean): void;
  /** Hydrate a Session's remembered split from localStorage once. */
  ensureSessionSplit(taskId: string): void;
  setProjectTool(tool: ProjectTool | null): void;
  setProjectBottomTab(tab: BottomTab | null): void;
  /** Bumped when a control asks the launcher composer to take focus. */
  composerFocusSeq: number;

  init(): Promise<void>;
  setSurface(surface: 'home' | 'workspace'): void;
  openTaskRoom(taskId: string): void;
  setSessionRoomView(view: SessionRoomView): void;
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
    /** The user message this reply answers — shown instead of the session title. */
    lastUserMessage?: string | null,
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

function sessionSplitKey(taskId: string): string {
  return `charter.sessionSplit.${taskId}`;
}

const RAIL_VIEW_KEY = 'charter.rail.view.v1';

function loadRailView(): RailView {
  try {
    const saved = window.sessionStorage.getItem(RAIL_VIEW_KEY);
    if (
      saved === 'sessions' ||
      saved === 'inbox' ||
      saved === 'projects' ||
      saved === 'files' ||
      saved === 'skills'
    ) {
      return saved;
    }
  } catch {
    // Session-local navigation persistence is best effort.
  }
  return 'sessions';
}

function saveRailView(view: RailView): void {
  try {
    window.sessionStorage.setItem(RAIL_VIEW_KEY, view);
  } catch {
    // Session-local navigation persistence is best effort.
  }
}

function readStoredSessionSplit(taskId: string): number | null {
  const raw = Number(window.localStorage.getItem(sessionSplitKey(taskId)));
  return Number.isFinite(raw) && raw >= 20 && raw <= 80 ? raw : null;
}

export const useAppStore = create<AppStore>((set, get) => {
  /** ADR-0042 — openers of group-owned surfaces keep the rail in step: when
   * the surface belongs to a different nav group than the rail shows, flip the
   * rail and remember what the group we're leaving displayed. */
  const crossRailPatch = (target: RailView): Partial<AppStore> => {
    const prev = get().railView;
    if (railGroupOf(prev) === railGroupOf(target)) return {};
    saveRailView(target);
    return {
      railView: target,
      savedSurfaces: { ...get().savedSurfaces, [railGroupOf(prev)]: mainSurfaceOf(get()) },
    };
  };

  /** Re-apply a remembered surface through its owning opener so every opener
   * invariant (tool resets, peek scoping, mutual exclusion) holds. */
  const applySurface = (surface: MainSurface): void => {
    switch (surface.kind) {
      case 'room':
        get().openTaskRoom(surface.taskId);
        return;
      case 'terminal':
        get().openTerminalSession(surface.terminalId);
        return;
      case 'archaeology':
        get().openArchaeology(surface.scope);
        return;
      case 'project-tool':
        get().setProjectTool(surface.tool);
        return;
      default:
        set({
          taskRoomTaskId: null,
          sessionTerminalId: null,
          archaeology: null,
          projectTool: null,
          projectBottomTab: null,
          surface: 'home',
        });
    }
  };

  return {
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
    sessionRoomView: 'conversation',
    sessionTerminalId: null,
    homePick: false,
    pendingRefs: [],
    newProjectOpen: false,
    lens: null,
    peek: null,
    previewRailTaskId: null,
    sessionTool: 'summary',
    sessionToolExpanded: false,
    sessionSplit: {},
    sessionSplitDragging: false,
    projectTool: null,
    projectBottomTab: null,
    archaeology: null,
    railView: typeof window === 'undefined' ? 'sessions' : loadRailView(),
    savedSurfaces: {
      workbench: { kind: 'home' },
      projects: { kind: 'home' },
      skills: { kind: 'home' },
    },
    composerFocusSeq: 0,

    openArchaeology(scope) {
      set({
        archaeology: { scope },
        taskRoomTaskId: null,
        sessionTerminalId: null,
        projectTool: null,
        projectBottomTab: null,
        surface: 'home',
        ...crossRailPatch('projects'),
      });
    },
    closeArchaeology() {
      set({ archaeology: null });
    },

    setRailView(railView) {
      const prev = get().railView;
      saveRailView(railView);
      if (railGroupOf(railView) === railGroupOf(prev)) {
        // Panel swap inside one group (Sessions ⇄ Inbox ⇄ Files) — the main
        // surface is the group's and stays put (ADR-0024 context feeding).
        set({ railView });
        return;
      }
      // ADR-0042: crossing nav groups swaps the main surface with the rail.
      const target = get().savedSurfaces[railGroupOf(railView)];
      set({
        railView,
        savedSurfaces: { ...get().savedSurfaces, [railGroupOf(prev)]: mainSurfaceOf(get()) },
      });
      applySurface(target);
    },

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
        projectTool: surface === 'workspace' ? (get().projectTool ?? 'editor') : null,
        ...(surface === 'workspace' ? crossRailPatch('files') : {}),
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
    setSessionSplit(taskId, pct) {
      const sessionSplit = { ...get().sessionSplit };
      if (pct === null) {
        delete sessionSplit[taskId];
        window.localStorage.removeItem(sessionSplitKey(taskId));
      } else {
        const clamped = Math.min(Math.max(pct, 20), 80);
        sessionSplit[taskId] = clamped;
        window.localStorage.setItem(sessionSplitKey(taskId), String(Math.round(clamped * 10) / 10));
      }
      set({ sessionSplit });
    },
    setSessionSplitDragging(sessionSplitDragging) {
      set({ sessionSplitDragging });
    },
    ensureSessionSplit(taskId) {
      if (taskId in get().sessionSplit) return;
      const stored = readStoredSessionSplit(taskId);
      if (stored !== null) {
        set({ sessionSplit: { ...get().sessionSplit, [taskId]: stored } });
      }
    },
    setProjectTool(projectTool) {
      set({
        projectTool,
        surface: projectTool ? 'workspace' : 'home',
        ...(projectTool
          ? {
              taskRoomTaskId: null,
              sessionTerminalId: null,
              archaeology: null,
              // ADR-0029/0040: project tools pair with the rail's Files tree
              // when arriving from the Projects page.
              ...crossRailPatch('files'),
            }
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
        sessionRoomView: 'conversation',
        sessionTerminalId: null,
        surface: 'home',
        sessionTool: 'summary',
        sessionToolExpanded: false,
        projectTool: null,
        projectBottomTab: null,
        archaeology: null,
        ...(peek && peek.taskId !== taskId ? { peek: null } : {}),
        ...crossRailPatch('sessions'),
      });
    },

    setSessionRoomView(sessionRoomView) {
      set({ sessionRoomView });
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
        sessionRoomView: 'conversation',
        surface: 'home',
        peek: null,
        previewRailTaskId: null,
        sessionTool: 'terminal',
        sessionToolExpanded: false,
        projectTool: null,
        projectBottomTab: null,
        archaeology: null,
        ...crossRailPatch('sessions'),
      });
    },

    closeTaskRoom() {
      set({
        taskRoomTaskId: null,
        sessionRoomView: 'conversation',
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
        set({ projectTool: get().projectTool === 'editor' ? null : 'editor' });
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
        if (view === 'search' || view === 'scm') {
          set({
            surface: 'workspace',
            projectTool: view === 'search' ? 'search' : 'changes',
            ...crossRailPatch('files'),
          });
        } else {
          // ADR-0029: the one project tree lives in the rail's Files pane.
          get().setRailView(view === 'tasks' ? 'sessions' : 'files');
        }
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
            projectTool: get().projectTool ?? 'editor',
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
    signalExternalSessionNotice(task, edgeKey, boundary, status = 'ok', lastUserMessage = null) {
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
        // A reply notice names the message it answers, not the session: after
        // "who are you", a banner reading like the first message is a lie.
        title: lastUserMessage?.trim() || sessionDisplayTitle(task),
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
  };
});

/** Toast a failed rpcResult's user message; narrows to the success shape. */
export function okOrToast<T>(
  res: { ok: true; data: T } | { ok: false; error: ProductError },
): res is { ok: true; data: T } {
  if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
  return res.ok;
}

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
