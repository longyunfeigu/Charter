import { create } from 'zustand';
import type {
  AppInfoDto,
  LayoutState,
  Settings,
  SideBarView,
  BottomTab,
  TaskDto,
  UpdateStateDto,
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

export type OverlayKind = 'none' | 'settings' | 'diagnostics' | 'about';
/** Contextual tools owned by the active Session. These replace the old
 * app-level workspace shell. */
export type SessionTool = 'summary' | 'diff' | 'file' | 'preview' | 'terminal' | 'review';
export type PreviewRailMode = 'artifact' | 'live';
/** Historical V1 orchestration can still be opened programmatically while its
 * compatibility data is migrated. V2 Missions use their own product surface. */
export type SessionRoomView = 'conversation' | 'fleet';
/** Project-level tools used before a Session exists. They render inside the
 * persistent Session shell and never recreate the legacy IDE frame.
 * ADR-0029: 'editor' is the plain editor (no context column) — the one
 * project tree lives in the rail's Files pane. */
export type ProjectTool = 'editor' | 'search' | 'changes';
export type ProjectCenterTab = 'overview' | 'sessions' | 'files' | 'changes' | 'setup';
export type RemoteSubview = 'overview' | 'files' | 'forwards';
/** The rail's contextual views inside the single navigation surface.
 * 'files' is the persistent context-feeding tree (ADR-0024, ADR-0029). */
export type RailView =
  'sessions' | 'missions' | 'inbox' | 'projects' | 'files' | 'memory' | 'skills';

/** ADR-0042 — the identity of what the main content area is showing
 * (mirrors HomeShell's render priority). */
export type MainSurface =
  | { kind: 'home' }
  | { kind: 'room'; taskId: string }
  | { kind: 'mission'; missionId: string | null }
  | { kind: 'terminal'; terminalId: string }
  | { kind: 'project-center'; path: string; tab: ProjectCenterTab }
  | { kind: 'project-tool'; tool: ProjectTool }
  | { kind: 'archaeology'; scope: string | null }
  | { kind: 'remotes' };

/** ADR-0042 — every primary destination owns its main surface. Sessions,
 * Inbox and Files deliberately share one workbench because those panels feed
 * the same open conversation; Missions, Projects, Memory and Skills are independent
 * pages and must never leave another destination's main content on screen. */
export type RailGroup = 'workbench' | 'missions' | 'projects' | 'memory' | 'skills';

/** A browser-like navigation entry. Unlike MainSurface this deliberately keeps
 * the contextual state around the surface, so Back restores the page the user
 * actually left (Project tab, Mission inspector, Session tool, remote host),
 * not merely a compatible top-level destination. */
export interface NavigationSnapshot {
  railView: RailView;
  savedSurfaces: Record<RailGroup, MainSurface>;
  surface: 'home' | 'workspace';
  taskRoomTaskId: string | null;
  missionCenter: {
    missionId: string | null;
    assignmentId?: string | null;
    inspectorTab?: 'details' | 'session';
  } | null;
  sessionRoomView: SessionRoomView;
  sessionTerminalId: string | null;
  sessionTerminalScope: 'single' | 'all';
  projectTool: ProjectTool | null;
  projectCenter: { path: string; tab: ProjectCenterTab } | null;
  projectBottomTab: BottomTab | null;
  archaeology: { scope: string | null } | null;
  remotesOpen: boolean;
  remoteSelectedHostId: string | null;
  remoteSubview: RemoteSubview;
  peek: PeekState | null;
  previewRailTaskId: string | null;
  previewRailMode: PreviewRailMode;
  sessionTool: SessionTool;
  sessionToolsOpen: boolean;
  sessionToolExpanded: boolean;
}

export function navigationSnapshotLabel(snapshot: NavigationSnapshot | null): string {
  if (!snapshot) return 'previous page';
  const surface = mainSurfaceOf(snapshot);
  switch (surface.kind) {
    case 'project-center': {
      const name = surface.path.split('/').filter(Boolean).at(-1) ?? 'Project';
      const tab = surface.tab === 'overview' ? '' : ` · ${surface.tab}`;
      return `${name}${tab}`;
    }
    case 'room':
      return 'Session';
    case 'mission':
      return surface.missionId ? 'Mission' : 'All Missions';
    case 'terminal':
      return snapshot.remotesOpen ? 'Remote terminal' : 'Terminal';
    case 'archaeology':
      return surface.scope
        ? `${surface.scope.split('/').filter(Boolean).at(-1) ?? 'Project'} · Archive`
        : 'Session Archive';
    case 'project-tool':
      return surface.tool === 'search'
        ? 'Project search'
        : surface.tool === 'changes'
          ? 'Project changes'
          : 'Project files';
    case 'remotes':
      return 'Remote Explorer';
    default:
      switch (snapshot.railView) {
        case 'missions':
          return 'Missions';
        case 'inbox':
          return 'Needs attention';
        case 'projects':
          return 'Projects';
        case 'files':
          return 'Files';
        case 'memory':
          return 'Memory';
        case 'skills':
          return 'Skills';
        default:
          return 'Sessions';
      }
  }
}

export function railGroupOf(view: RailView): RailGroup {
  if (view === 'missions') return 'missions';
  if (view === 'projects') return 'projects';
  if (view === 'memory') return 'memory';
  if (view === 'skills') return 'skills';
  return 'workbench';
}

export function mainSurfaceOf(
  s: Pick<
    AppStore,
    | 'taskRoomTaskId'
    | 'missionCenter'
    | 'sessionTerminalId'
    | 'archaeology'
    | 'projectTool'
    | 'remotesOpen'
  > & { projectCenter?: { path: string; tab: ProjectCenterTab } | null },
): MainSurface {
  if (s.sessionTerminalId) return { kind: 'terminal', terminalId: s.sessionTerminalId };
  if (s.missionCenter) return { kind: 'mission', missionId: s.missionCenter.missionId };
  if (s.taskRoomTaskId) return { kind: 'room', taskId: s.taskRoomTaskId };
  if (s.projectCenter) {
    return { kind: 'project-center', path: s.projectCenter.path, tab: s.projectCenter.tab };
  }
  if (s.archaeology) return { kind: 'archaeology', scope: s.archaeology.scope };
  if (s.remotesOpen) return { kind: 'remotes' };
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

export function updateNoticeKey(update: UpdateStateDto | null): string | null {
  if (!update?.availableVersion) return null;
  if (update.phase === 'available' && update.delivery === 'manual') {
    return `manual:${update.availableVersion}`;
  }
  if (update.phase === 'downloaded' && update.delivery === 'automatic') {
    return `automatic:${update.availableVersion}`;
  }
  return null;
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
  updateState: UpdateStateDto | null;
  dismissedUpdateNoticeKey: string | null;
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
  /** Global Mission Center selection. A null id renders the portfolio overview. */
  missionCenter: {
    missionId: string | null;
    assignmentId?: string | null;
    inspectorTab?: 'details' | 'session';
  } | null;
  sessionRoomView: SessionRoomView;
  /**
   * Session-first shell: a terminal can be selected before external-agent
   * detection has created its accounting task. Once detection lands the shell
   * migrates this selection to the matching Task Room without moving the PTY.
   */
  sessionTerminalId: string | null;
  /** A Session row opens one PTY; the global manager is an explicit destination. */
  sessionTerminalScope: 'single' | 'all';
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
  /** Explicit entry intent: a live-preview badge must not be redirected to artifacts. */
  previewRailMode: PreviewRailMode;
  /** The right-hand tool canvas follows the Session instead of becoming a
   * second application shell. */
  sessionTool: SessionTool;
  /** Tools stay out of the reading surface until the user opens one or the
   * Session reaches a review state that requires a decision. */
  sessionToolsOpen: boolean;
  sessionToolExpanded: boolean;
  /** Manual conversation/tool split (% of the canvas given to the conversation)
   * per Session — set by the drag handle (design mock A). While present it
   * overrides the two-stop expanded model, so the Diff auto-expand no longer
   * shrinks a conversation the user widened by hand. */
  sessionSplit: Record<string, number>;
  sessionSplitDragging: boolean;
  projectTool: ProjectTool | null;
  /** Project selection is browsing state, deliberately independent from the
   * active workspace/working context. */
  projectCenter: { path: string; tab: ProjectCenterTab } | null;
  openProjectCenter(path: string, tab?: ProjectCenterTab): void;
  setProjectCenterTab(tab: ProjectCenterTab): void;
  closeProjectCenter(): void;
  /** Contextual lower panel for project diagnostics. It belongs to Project
   * Tools and does not resurrect the retired global workspace shell. */
  projectBottomTab: BottomTab | null;
  /** ADR-0038: session-archaeology page. `scope` narrows to one project path
   * (or discovered directory); null shows all agent activity on this machine. */
  archaeology: { scope: string | null } | null;
  openArchaeology(scope: string | null): void;
  closeArchaeology(): void;
  /** ADR-0047: Remote Explorer is an application navigation mode with its own
   * host/session hierarchy. Remote terminals keep this mode active. */
  remotesOpen: boolean;
  remoteSelectedHostId: string | null;
  remoteSubview: RemoteSubview;
  openRemotes(hostId?: string): void;
  closeRemotes(): void;
  selectRemoteHost(hostId: string, view?: RemoteSubview): void;
  setRemoteSubview(view: RemoteSubview): void;
  /** ADR-0029: the rail's panel view, lifted so commands and flows that mean
   * "show me the project files" can reveal the one tree. */
  railView: RailView;
  setRailView(view: RailView): void;
  /** ADR-0042: each nav group's last main surface, restored when the rail
   * returns to that group so left nav and main content always correspond. */
  savedSurfaces: Record<RailGroup, MainSurface>;
  /** True browser-style history shared by every product surface. */
  navigationBack: NavigationSnapshot[];
  navigationForward: NavigationSnapshot[];
  navigateBack(): void;
  navigateForward(): void;
  /** Remove dead Session destinations after archive/permanent deletion. */
  forgetTaskNavigation(taskId: string): void;
  /** Remove a Mission from navigation after it enters trash or is purged. */
  forgetMissionNavigation(missionId: string): void;
  openPreviewRail(taskId: string, mode?: PreviewRailMode): void;
  setPreviewRailMode(mode: PreviewRailMode): void;
  closePreviewRail(): void;
  setSessionTool(tool: SessionTool): void;
  setSessionToolsOpen(open: boolean): void;
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
  /** Navigate to the Sessions composer as one atomic history transition. */
  openSessionHome(): void;
  openTaskRoom(taskId: string): void;
  openMission(
    missionId?: string | null,
    assignmentId?: string | null,
    inspectorTab?: 'details' | 'session',
  ): void;
  setMissionDestination(assignmentId: string | null, inspectorTab?: 'details' | 'session'): void;
  closeMission(): void;
  setSessionRoomView(view: SessionRoomView): void;
  openTerminalSession(terminalId: string): void;
  openAllTerminals(terminalId: string): void;
  openRemoteTerminalSession(terminalId: string, hostId: string): void;
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
  checkForUpdates(): Promise<void>;
  openUpdateDownload(): Promise<boolean>;
  installUpdate(): Promise<boolean>;
  dismissUpdateNotice(): void;
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

interface OverlayFocusOrigin {
  element: HTMLElement;
  fallbackTestId: string | null;
}

let overlayFocusOrigin: OverlayFocusOrigin | null = null;
let overlayFocusRevision = 0;

function rememberOverlayFocus(): void {
  if (typeof document === 'undefined') return;
  const element = document.activeElement;
  if (!(element instanceof HTMLElement) || element === document.body) return;
  overlayFocusRevision += 1;
  overlayFocusOrigin = {
    element,
    fallbackTestId: element.dataset.overlayFocusReturn ?? null,
  };
}

function restoreOverlayFocus(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const origin = overlayFocusOrigin;
  overlayFocusOrigin = null;
  const revision = ++overlayFocusRevision;
  window.requestAnimationFrame(() => {
    if (!origin || revision !== overlayFocusRevision) return;
    const fallback = origin.fallbackTestId
      ? Array.from(document.querySelectorAll<HTMLElement>('[data-testid]')).find(
          (candidate) => candidate.dataset.testid === origin.fallbackTestId,
        )
      : null;
    const target = origin.element.isConnected ? origin.element : fallback;
    target?.focus();
  });
}

function loadRailView(): RailView {
  try {
    const saved = window.sessionStorage.getItem(RAIL_VIEW_KEY);
    if (
      saved === 'sessions' ||
      saved === 'missions' ||
      saved === 'inbox' ||
      saved === 'projects' ||
      saved === 'files' ||
      saved === 'memory' ||
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

/** ADR-0046: opening a Session makes its project the working context, so the
 * rail's Files tree always shows the files of the session being looked at.
 * Deferred imports — taskStore and workspaceStore both import this module, so
 * static imports would cycle. */
async function followTaskProject(taskId: string): Promise<void> {
  try {
    const [{ useTaskStore }, { useWorkspaceStore }] = await Promise.all([
      import('./taskStore.js'),
      import('./workspaceStore.js'),
    ]);
    const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
    if (
      task &&
      (!task.external?.remote || (task.external.remote.workspaceKind ?? 'remote') === 'local')
    ) {
      await useWorkspaceStore.getState().followProject(task.projectPath);
    }
  } catch {
    // Context alignment is best-effort — the room itself has already opened.
  }
}

export const useAppStore = create<AppStore>((set, get) => {
  let navigationDepth = 0;
  let restoringNavigation = false;

  const captureNavigation = (): NavigationSnapshot => {
    const state = get();
    return {
      railView: state.railView,
      savedSurfaces: { ...state.savedSurfaces },
      surface: state.surface,
      taskRoomTaskId: state.taskRoomTaskId,
      missionCenter: state.missionCenter ? { ...state.missionCenter } : null,
      sessionRoomView: state.sessionRoomView,
      sessionTerminalId: state.sessionTerminalId,
      sessionTerminalScope: state.sessionTerminalScope,
      projectTool: state.projectTool,
      projectCenter: state.projectCenter ? { ...state.projectCenter } : null,
      projectBottomTab: state.projectBottomTab,
      archaeology: state.archaeology ? { ...state.archaeology } : null,
      remotesOpen: state.remotesOpen,
      remoteSelectedHostId: state.remoteSelectedHostId,
      remoteSubview: state.remoteSubview,
      peek: state.peek ? { ...state.peek, paths: [...state.peek.paths] } : null,
      previewRailTaskId: state.previewRailTaskId,
      previewRailMode: state.previewRailMode,
      sessionTool: state.sessionTool,
      sessionToolsOpen: state.sessionToolsOpen,
      sessionToolExpanded: state.sessionToolExpanded,
    };
  };

  const sameNavigation = (a: NavigationSnapshot, b: NavigationSnapshot): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

  /** Coalesce nested opener calls into one history entry. setRailView, for
   * example, may restore a surface through another opener. */
  const navigate = (change: () => void): void => {
    const outer = navigationDepth === 0 && !restoringNavigation;
    const before = outer ? captureNavigation() : null;
    navigationDepth += 1;
    try {
      change();
    } finally {
      navigationDepth -= 1;
    }
    if (!outer || !before) return;
    const after = captureNavigation();
    if (sameNavigation(before, after)) return;
    const previous = get().navigationBack.at(-1);
    set({
      navigationBack: [
        ...get().navigationBack,
        ...(previous && sameNavigation(previous, before) ? [] : [before]),
      ].slice(-60),
      navigationForward: [],
    });
  };

  const restoreNavigation = (snapshot: NavigationSnapshot): void => {
    restoringNavigation = true;
    try {
      saveRailView(snapshot.railView);
      set({
        ...snapshot,
        savedSurfaces: { ...snapshot.savedSurfaces },
        missionCenter: snapshot.missionCenter ? { ...snapshot.missionCenter } : null,
        projectCenter: snapshot.projectCenter ? { ...snapshot.projectCenter } : null,
        archaeology: snapshot.archaeology ? { ...snapshot.archaeology } : null,
        peek: snapshot.peek ? { ...snapshot.peek, paths: [...snapshot.peek.paths] } : null,
      });
    } finally {
      restoringNavigation = false;
    }
    if (snapshot.taskRoomTaskId) void followTaskProject(snapshot.taskRoomTaskId);
  };

  /** ADR-0042 — explicit surface openers keep the contextual rail in step when
   * moving between nav groups.  Workbench's Sessions/Inbox/Files views are
   * deliberately sticky, except when leaving Mission: Mission owns its entire
   * surface, so keeping its rail beside an opened Session produces a
   * split-brain navigation state. */
  const crossRailPatch = (target: RailView): Partial<AppStore> => {
    const prev = get().railView;
    if (prev === target) return {};
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
      case 'mission':
        get().openMission(surface.missionId);
        return;
      case 'terminal':
        get().openTerminalSession(surface.terminalId);
        return;
      case 'archaeology':
        get().openArchaeology(surface.scope);
        return;
      case 'project-center':
        get().openProjectCenter(surface.path, surface.tab);
        return;
      case 'remotes':
        get().openRemotes();
        return;
      case 'project-tool':
        get().setProjectTool(surface.tool);
        return;
      default:
        set({
          taskRoomTaskId: null,
          missionCenter: null,
          sessionTerminalId: null,
          projectCenter: null,
          archaeology: null,
          remotesOpen: false,
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
    updateState: null,
    dismissedUpdateNoticeKey: null,
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
    missionCenter: null,
    sessionRoomView: 'conversation',
    sessionTerminalId: null,
    sessionTerminalScope: 'single',
    homePick: false,
    pendingRefs: [],
    newProjectOpen: false,
    lens: null,
    peek: null,
    previewRailTaskId: null,
    previewRailMode: 'live',
    sessionTool: 'summary',
    sessionToolsOpen: false,
    sessionToolExpanded: false,
    sessionSplit: {},
    sessionSplitDragging: false,
    projectTool: null,
    projectCenter: null,
    projectBottomTab: null,
    archaeology: null,
    remotesOpen: false,
    remoteSelectedHostId: null,
    remoteSubview: 'overview',
    railView: typeof window === 'undefined' ? 'sessions' : loadRailView(),
    savedSurfaces: {
      workbench: { kind: 'home' },
      missions: { kind: 'mission', missionId: null },
      projects: { kind: 'home' },
      memory: { kind: 'home' },
      skills: { kind: 'home' },
    },
    navigationBack: [],
    navigationForward: [],
    composerFocusSeq: 0,

    navigateBack() {
      const back = get().navigationBack;
      const target = back.at(-1);
      if (!target) return;
      const current = captureNavigation();
      set({
        navigationBack: back.slice(0, -1),
        navigationForward: [...get().navigationForward, current].slice(-60),
      });
      restoreNavigation(target);
    },
    navigateForward() {
      const forward = get().navigationForward;
      const target = forward.at(-1);
      if (!target) return;
      const current = captureNavigation();
      set({
        navigationBack: [...get().navigationBack, current].slice(-60),
        navigationForward: forward.slice(0, -1),
      });
      restoreNavigation(target);
    },
    forgetTaskNavigation(taskId) {
      const keep = (entry: NavigationSnapshot): boolean => entry.taskRoomTaskId !== taskId;
      set({
        navigationBack: get().navigationBack.filter(keep),
        navigationForward: get().navigationForward.filter(keep),
      });
    },
    forgetMissionNavigation(missionId) {
      const keep = (entry: NavigationSnapshot): boolean =>
        entry.missionCenter?.missionId !== missionId;
      set({
        navigationBack: get().navigationBack.filter(keep),
        navigationForward: get().navigationForward.filter(keep),
      });
    },

    openArchaeology(scope) {
      navigate(() => {
        set({
          archaeology: { scope },
          projectCenter: null,
          taskRoomTaskId: null,
          missionCenter: null,
          sessionTerminalId: null,
          remotesOpen: false,
          projectTool: null,
          projectBottomTab: null,
          surface: 'home',
          ...crossRailPatch('sessions'),
        });
      });
    },
    closeArchaeology() {
      set({ archaeology: null });
    },
    openProjectCenter(path, tab) {
      const current = get().projectCenter;
      navigate(() => {
        set({
          projectCenter: {
            path,
            tab: tab ?? (current?.path === path ? current.tab : 'overview'),
          },
          archaeology: null,
          taskRoomTaskId: null,
          missionCenter: null,
          sessionTerminalId: null,
          remotesOpen: false,
          projectTool: null,
          projectBottomTab: null,
          surface: 'home',
          ...crossRailPatch('projects'),
        });
      });
    },
    setProjectCenterTab(tab) {
      const current = get().projectCenter;
      if (current) set({ projectCenter: { ...current, tab } });
    },
    closeProjectCenter() {
      set({ projectCenter: null });
    },

    openRemotes(hostId) {
      navigate(() =>
        set({
          remotesOpen: true,
          projectCenter: null,
          remoteSelectedHostId: hostId ?? get().remoteSelectedHostId,
          remoteSubview: 'overview',
          taskRoomTaskId: null,
          missionCenter: null,
          sessionTerminalId: null,
          archaeology: null,
          projectTool: null,
          projectBottomTab: null,
          surface: 'home',
          ...crossRailPatch('sessions'),
        }),
      );
    },
    closeRemotes() {
      set({ remotesOpen: false, sessionTerminalId: null, remoteSubview: 'overview' });
    },
    selectRemoteHost(remoteSelectedHostId, remoteSubview = 'overview') {
      navigate(() =>
        set({
          remotesOpen: true,
          remoteSelectedHostId,
          remoteSubview,
          sessionTerminalId: null,
          taskRoomTaskId: null,
          missionCenter: null,
          archaeology: null,
          projectCenter: null,
          projectTool: null,
          projectBottomTab: null,
          surface: 'home',
        }),
      );
    },
    setRemoteSubview(remoteSubview) {
      navigate(() => {
        set({
          remotesOpen: true,
          remoteSubview,
          sessionTerminalId: null,
          taskRoomTaskId: null,
          missionCenter: null,
          surface: 'home',
        });
      });
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
      navigate(() => {
        // ADR-0042: crossing nav groups swaps the main surface with the rail.
        const target = get().savedSurfaces[railGroupOf(railView)];
        set({
          railView,
          savedSurfaces: { ...get().savedSurfaces, [railGroupOf(prev)]: mainSurfaceOf(get()) },
        });
        applySurface(target);
      });
    },

    setSurface(surface) {
      // The compatibility "workspace" value now opens a contextual tool state
      // inside the one Session shell. With an active Session it expands that
      // Session's tool canvas; otherwise it opens the current project's Files
      // tool beside the persistent global rail.
      if (surface === 'workspace' && get().taskRoomTaskId) {
        set({
          surface: 'home',
          sessionToolsOpen: true,
          sessionToolExpanded: true,
          projectTool: null,
          remotesOpen: false,
        });
        return;
      }
      navigate(() => {
        set({
          surface,
          // Surface navigation leaves Remotes — it sits above projectTool/home in
          // mainSurfaceOf, so a stale flag would swallow the switch.
          remotesOpen: false,
          ...(get().remotesOpen ? { sessionTerminalId: null } : {}),
          projectTool: surface === 'workspace' ? (get().projectTool ?? 'editor') : null,
          ...(surface === 'workspace' ? { projectCenter: null, missionCenter: null } : {}),
          ...(surface === 'workspace' ? crossRailPatch('files') : {}),
        });
      });
    },

    openSessionHome() {
      navigate(() => {
        saveRailView('sessions');
        set({
          railView: 'sessions',
          taskRoomTaskId: null,
          missionCenter: null,
          sessionRoomView: 'conversation',
          sessionTerminalId: null,
          sessionTerminalScope: 'single',
          surface: 'home',
          peek: null,
          previewRailTaskId: null,
          sessionTool: 'summary',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: false,
          ...crossRailPatch('sessions'),
        });
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
        sessionToolsOpen: true,
        ...(nextMode === 'diff' ? { sessionToolExpanded: true } : {}),
      });
    },
    closePeek() {
      set({
        peek: null,
        sessionTool: 'summary',
        sessionToolsOpen: false,
        sessionToolExpanded: false,
      });
    },
    openPreviewRail(taskId, previewRailMode = 'live') {
      set({
        previewRailTaskId: taskId,
        previewRailMode,
        peek: null,
        sessionTool: 'preview',
        sessionToolsOpen: true,
        sessionToolExpanded: false,
      });
    },
    setPreviewRailMode(previewRailMode) {
      set({ previewRailMode });
    },
    closePreviewRail() {
      set({
        previewRailTaskId: null,
        sessionTool: 'summary',
        sessionToolsOpen: false,
        sessionToolExpanded: false,
      });
    },
    setSessionTool(sessionTool) {
      set({
        sessionTool,
        sessionToolsOpen: true,
        ...(sessionTool === 'diff' ? { sessionToolExpanded: true } : {}),
        ...(sessionTool !== 'preview' ? { previewRailTaskId: null } : {}),
        ...(sessionTool !== 'diff' && sessionTool !== 'file' ? { peek: null } : {}),
      });
    },
    setSessionToolsOpen(sessionToolsOpen) {
      set({
        sessionToolsOpen,
        ...(!sessionToolsOpen
          ? {
              sessionTool: 'summary' as const,
              sessionToolExpanded: false,
              previewRailTaskId: null,
              peek: null,
            }
          : {}),
      });
    },
    setSessionToolExpanded(sessionToolExpanded) {
      set({ sessionToolExpanded, ...(sessionToolExpanded ? { sessionToolsOpen: true } : {}) });
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
      navigate(() => {
        set({
          projectTool,
          projectCenter: projectTool ? null : get().projectCenter,
          surface: projectTool ? 'workspace' : 'home',
          ...(projectTool
            ? {
                taskRoomTaskId: null,
                missionCenter: null,
                sessionTerminalId: null,
                archaeology: null,
                // ADR-0029/0040: project tools pair with the rail's Files tree
                // when arriving from the Projects page.
                ...crossRailPatch('files'),
              }
            : { projectBottomTab: null }),
        });
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
          sessionToolsOpen: true,
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
      navigate(() => {
        set({
          taskRoomTaskId: taskId,
          missionCenter: null,
          sessionRoomView: 'conversation',
          sessionTerminalId: null,
          surface: 'home',
          sessionTool: 'summary',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: false,
          sessionNotices: get().sessionNotices.filter((notice) => notice.taskId !== taskId),
          ...(peek && peek.taskId !== taskId ? { peek: null } : {}),
          ...crossRailPatch('sessions'),
        });
      });
      void followTaskProject(taskId);
    },

    openMission(missionId = null, assignmentId = null, inspectorTab = 'details') {
      saveRailView('missions');
      navigate(() => {
        set({
          missionCenter: {
            missionId,
            ...(assignmentId ? { assignmentId, inspectorTab } : {}),
          },
          taskRoomTaskId: null,
          sessionTerminalId: null,
          sessionRoomView: 'conversation',
          surface: 'home',
          peek: null,
          previewRailTaskId: null,
          sessionTool: 'summary',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: false,
          ...crossRailPatch('missions'),
          railView: 'missions',
        });
      });
    },

    setMissionDestination(assignmentId, inspectorTab = 'details') {
      const current = get().missionCenter;
      if (!current) return;
      set({
        missionCenter: {
          ...current,
          assignmentId,
          inspectorTab,
        },
      });
    },

    closeMission() {
      set({ missionCenter: null });
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
      navigate(() =>
        set({
          sessionTerminalId: terminalId,
          sessionTerminalScope: 'single',
          taskRoomTaskId: null,
          missionCenter: null,
          sessionRoomView: 'conversation',
          surface: 'home',
          peek: null,
          previewRailTaskId: null,
          sessionTool: 'terminal',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: false,
          ...crossRailPatch('sessions'),
        }),
      );
    },

    openAllTerminals(terminalId) {
      navigate(() =>
        set({
          sessionTerminalId: terminalId,
          sessionTerminalScope: 'all',
          taskRoomTaskId: null,
          missionCenter: null,
          sessionRoomView: 'conversation',
          surface: 'home',
          peek: null,
          previewRailTaskId: null,
          sessionTool: 'terminal',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: false,
          ...crossRailPatch('sessions'),
        }),
      );
    },

    openRemoteTerminalSession(terminalId, remoteSelectedHostId) {
      navigate(() =>
        set({
          sessionTerminalId: terminalId,
          sessionTerminalScope: 'single',
          taskRoomTaskId: null,
          missionCenter: null,
          sessionRoomView: 'conversation',
          surface: 'home',
          peek: null,
          previewRailTaskId: null,
          sessionTool: 'terminal',
          sessionToolsOpen: false,
          sessionToolExpanded: false,
          projectTool: null,
          projectCenter: null,
          projectBottomTab: null,
          archaeology: null,
          remotesOpen: true,
          remoteSelectedHostId,
          remoteSubview: 'overview',
          ...crossRailPatch('sessions'),
        }),
      );
    },

    closeTaskRoom() {
      set({
        taskRoomTaskId: null,
        missionCenter: null,
        sessionRoomView: 'conversation',
        sessionTerminalId: null,
        sessionTerminalScope: 'single',
        peek: null,
        previewRailTaskId: null,
        sessionTool: 'summary',
        sessionToolsOpen: false,
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
      const [info, settingsState, layoutRes, updateState] = await Promise.all([
        rpcResult('app.getInfo', {}),
        rpcResult('settings.get', {}),
        rpcResult('layout.get', {}),
        rpcResult('updates.getState', {}),
      ]);
      if (info.ok) set({ appInfo: info.data });
      if (settingsState.ok) {
        applyAppearance(settingsState.data.effective);
        set({ settings: settingsState.data.effective, settingsIssues: settingsState.data.issues });
      }
      if (layoutRes.ok && layoutRes.data.layout) set({ layout: layoutRes.data.layout });
      if (updateState.ok) set({ updateState: updateState.data });
      set({ ready: true });

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        applyAppearance(get().settings);
      });
      onEvent('settings.changed', () => {
        void get().refreshSettings();
      });
      onEvent('updates.changed', (next) => {
        set({ updateState: next });
      });
    },

    setLayout(patch) {
      const layout = { ...get().layout, ...patch };
      set({ layout });
      persistLayout(layout);
    },

    toggleSidebar() {
      if (!get().taskRoomTaskId) {
        get().setProjectTool(get().projectTool === 'editor' ? null : 'editor');
      }
    },
    toggleAgentPanel() {
      if (get().taskRoomTaskId) {
        set({
          sessionTool: 'summary',
          sessionToolsOpen: !get().sessionToolsOpen,
          sessionToolExpanded: false,
        });
      }
    },
    toggleBottomPanel() {
      if (get().taskRoomTaskId) {
        set({
          sessionTool: get().sessionTool === 'terminal' ? 'summary' : 'terminal',
          sessionToolsOpen: get().sessionTool !== 'terminal',
          sessionToolExpanded: get().sessionTool !== 'terminal',
        });
      }
    },
    showSideBarView(view) {
      if (!get().taskRoomTaskId) {
        if (view === 'search' || view === 'scm') {
          get().setProjectTool(view === 'search' ? 'search' : 'changes');
        } else {
          // ADR-0029: the one project tree lives in the rail's Files pane.
          get().setRailView(view === 'tasks' ? 'sessions' : 'files');
        }
        return;
      }
      set({
        sessionTool: view === 'explorer' ? 'file' : view === 'scm' ? 'diff' : 'summary',
        sessionToolsOpen: true,
        sessionToolExpanded: view === 'explorer' || view === 'scm',
      });
    },
    showBottomTab(tab) {
      if (!get().taskRoomTaskId) {
        if (tab !== 'terminal') {
          get().setProjectTool(get().projectTool ?? 'editor');
          set({ projectBottomTab: tab });
        }
        return;
      }
      set({
        surface: 'home',
        sessionTool: tab === 'terminal' ? 'terminal' : tab === 'tests' ? 'review' : 'summary',
        sessionToolsOpen: true,
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
      const previous = get().overlay;
      if (previous === 'none' && overlay !== 'none') rememberOverlayFocus();
      set({ overlay });
      if (previous !== 'none' && overlay === 'none') restoreOverlayFocus();
    },
    openSettings(settingsSection = 'general') {
      if (get().overlay === 'none') rememberOverlayFocus();
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

    async checkForUpdates() {
      const result = await rpcResult('updates.check', {});
      if (result.ok) set({ updateState: result.data });
      else get().pushToast('error', result.error.userMessage);
    },

    async openUpdateDownload() {
      const result = await rpcResult('updates.openDownload', {});
      if (!result.ok || !result.data.opened) {
        get().pushToast(
          'error',
          result.ok ? 'Could not open the release page.' : result.error.userMessage,
        );
        return false;
      }
      get().dismissUpdateNotice();
      return true;
    },

    async installUpdate() {
      let result = await rpcResult('updates.install', { force: false });
      if (result.ok && result.data.blockers.length > 0) {
        const detail = result.data.blockers.map((blocker) => `• ${blocker}`).join('\n');
        if (
          !window.confirm(`Work is still in progress:\n\n${detail}\n\nRestart and install anyway?`)
        ) {
          return false;
        }
        result = await rpcResult('updates.install', { force: true });
      }
      if (!result.ok) {
        get().pushToast('error', result.error.userMessage);
        return false;
      }
      if (!result.data.installing) {
        get().pushToast('warning', 'The update is not ready to install yet.');
        return false;
      }
      get().dismissUpdateNotice();
      return true;
    },

    dismissUpdateNotice() {
      const key = updateNoticeKey(get().updateState);
      if (key) set({ dismissedUpdateNoticeKey: key });
    },

    pushToast(kind, message) {
      const toast: Toast = { id: newId('toast'), kind, message };
      // Repeated feedback describes one current state, not a queue of separate
      // events. Replacing it also refreshes the dismissal deadline.
      set({
        toasts: [
          ...get().toasts.filter((item) => item.kind !== kind || item.message !== message),
          toast,
        ],
      });
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
      if (get().taskRoomTaskId === task.id) {
        set({
          sessionNotices: get().sessionNotices.filter((notice) => notice.taskId !== task.id),
        });
        return;
      }
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
      if (!info) {
        // A transient completion card describes one exact task-state edge. As
        // soon as the Session resumes or settles, remove the old edge instead
        // of letting REVIEW_READY copy contradict the current state.
        set({
          sessionCompletionSignals: get().sessionCompletionSignals.filter(
            (candidate) => candidate.taskId !== task.id,
          ),
          sessionNotices: get().sessionNotices.filter((candidate) => candidate.taskId !== task.id),
        });
        return;
      }
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
        sessionCompletionSignals: [
          ...get().sessionCompletionSignals.filter((candidate) => candidate.taskId !== task.id),
          signal,
        ].slice(-24),
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
      if (get().taskRoomTaskId === task.id) {
        set({
          sessionNotices: get().sessionNotices.filter((notice) => notice.taskId !== task.id),
        });
        return;
      }
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
