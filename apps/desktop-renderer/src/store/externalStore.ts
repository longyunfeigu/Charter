import { create } from 'zustand';
import { onEvent, rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from './appStore.js';
import { useTaskStore } from './taskStore.js';
import { useActivityStore } from './activityStore.js';
// Runtime-only access (inside handlers), so the module cycle with
// TerminalPanel → externalStore is harmless under ESM live bindings.
import { useTerminalStore } from '../views/TerminalPanel.js';
import type { TaskDto } from '@pi-ide/ipc-contracts';

export interface ExternalSessionFile {
  path: string;
  status: 'created' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface ExternalSession {
  terminalId: string;
  taskId: string;
  cli: string;
  snapshotRef: string | null;
  status: 'active' | 'ended';
  captureGrade: 'structured' | 'observed';
  files: ExternalSessionFile[];
}

/** ADR-0017 rev.2 — the side-panel placement, entered only by user intent. */
export interface PromotedSession {
  terminalId: string;
  taskId: string;
  /** The (terminal-only) dock was collapsed on promote; restore it on return. */
  collapsedDock: boolean;
  /** The managed-task rail was visible; restore it after the external rail leaves. */
  collapsedAgentPanel: boolean;
  /** A narrow window needed the primary sidebar temporarily closed. */
  collapsedSideBar: boolean;
}

interface ExternalStore {
  initialized: boolean;
  /** Agent CLI currently running per terminal (live badge; cleared on exit). */
  agentByTerminal: Record<string, string>;
  /**
   * Accounting task per terminal. Kept after the session ends so the session
   * bar / room entry stay reachable; replaced by the next session, cleared
   * when the terminal itself goes away.
   */
  taskByTerminal: Record<string, string>;
  /** Live sessions by task id (kept after end for the bar/room summary). */
  sessions: Record<string, ExternalSession>;
  /** Latest accounting delta — drives the peek's live auto-follow in the room. */
  lastDelta: { taskId: string; paths: string[]; seq: number } | null;
  /** Peek auto-follow per external task (absent = on). */
  follow: Record<string, boolean>;
  /** The session terminal currently placed in the side panel (user intent). */
  promoted: PromotedSession | null;
  /** Side panel width (px); floor keeps the TUI at a usable column count. */
  panelWidth: number;
  /** Task currently waiting for its CLI process to confirm a real resume. */
  resumingTaskId: string | null;
  setFollow(taskId: string, on: boolean): void;
  /** ADR-0017 rev.2 「意图升格」— move a session terminal to the side panel. */
  promote(terminalId: string): void;
  /** 「归位」— return the side-panel terminal to the dock. */
  unpromote(): void;
  /** Keep a useful editor/dock width when the application window narrows. */
  ensureSidePanelSpace(): void;
  setPanelWidth(width: number): void;
  /** Terminal closed/killed — drop its session UI state (panel, bar, badge). */
  handleTerminalClosed(terminalId: string): void;
  resumeTask(task: TaskDto): Promise<void>;
  init(): void;
}

let seq = 0;

async function signalExternalReply(
  taskId: string,
  edgeKey: string,
  boundary: 'structured' | 'observed',
  status: 'ok' | 'error' = 'ok',
  lastUserMessage: string | null = null,
): Promise<void> {
  const app = useAppStore.getState();
  app.signalSessionReply(taskId, edgeKey);

  // Session detection normally hydrated the renderer long before a reply
  // finishes. Fall back to the authoritative task read so an unusually fast
  // CLI cannot lose its notification to a renderer-store race.
  let task = useTaskStore.getState().tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    const result = await rpcResult('task.get', { taskId, eventsAfter: 0 });
    if (result.ok) task = result.data.task;
  }
  if (task) app.signalExternalSessionNotice(task, edgeKey, boundary, status, lastUserMessage);
}

export const PANEL_MIN_WIDTH = 480;
export const PANEL_MAX_WIDTH = 900;
export const PANEL_DEFAULT_WIDTH = 600;
export const FOCUS_SLOT_MIN_CENTER_WIDTH = 360;
const WORKBENCH_FIXED_CHROME_WIDTH = 64;

function effectivePanelWidth(panelWidth: number): number {
  return Math.min(
    panelWidth,
    Math.max(0, window.innerWidth - FOCUS_SLOT_MIN_CENTER_WIDTH - WORKBENCH_FIXED_CHROME_WIDTH),
  );
}

function sidePanelWouldCrushCenter(panelWidth: number): boolean {
  const layout = useAppStore.getState().layout;
  if (!layout.sideBarVisible) return false;
  const remaining =
    window.innerWidth -
    effectivePanelWidth(panelWidth) -
    layout.sideBarWidth -
    WORKBENCH_FIXED_CHROME_WIDTH;
  return remaining < FOCUS_SLOT_MIN_CENTER_WIDTH;
}

/** New/changed paths between two accounting states — drives the glow pulses. */
export function sessionDelta(
  prev: ExternalSessionFile[] | undefined,
  next: ExternalSessionFile[],
): string[] {
  const before = new Map(
    (prev ?? []).map((f) => [f.path, `${f.additions}/${f.deletions}/${f.status}`]),
  );
  return next
    .filter((f) => before.get(f.path) !== `${f.additions}/${f.deletions}/${f.status}`)
    .map((f) => f.path);
}

/** ADR-0017 rev.2: renderer projection of external CLI agent sessions. */
export const useExternalStore = create<ExternalStore>((set, get) => ({
  initialized: false,
  agentByTerminal: {},
  taskByTerminal: {},
  sessions: {},
  lastDelta: null,
  follow: {},
  promoted: null,
  panelWidth: PANEL_DEFAULT_WIDTH,
  resumingTaskId: null,

  setFollow(taskId, on) {
    set({ follow: { ...get().follow, [taskId]: on } });
  },

  promote(terminalId) {
    const taskId = get().taskByTerminal[terminalId];
    if (!taskId) return;
    const current = get().promoted;
    if (current?.terminalId === terminalId) {
      useTerminalStore
        .getState()
        .items.find((item) => item.id === terminalId)
        ?.term.focus();
      return;
    }
    if (current) {
      // Atomic focus-slot swap: placement changes, PTYs do not. Preserve the
      // layout snapshot from the original promotion and return the prior side
      // terminal to the selected dock slot in the same synchronous turn.
      set({
        promoted: {
          ...current,
          terminalId,
          taskId,
        },
      });
      useTerminalStore.setState({ active: current.terminalId });
      return;
    }
    const app = useAppStore.getState();
    const others = useTerminalStore.getState().items.filter((t) => t.id !== terminalId).length;
    const collapsedDock =
      others === 0 && app.layout.bottomPanelVisible && app.layout.bottomTab === 'terminal';
    const collapsedAgentPanel = app.layout.agentPanelVisible;
    const collapsedSideBar = sidePanelWouldCrushCenter(get().panelWidth);
    if (collapsedDock || collapsedAgentPanel || collapsedSideBar) {
      app.setLayout({
        ...(collapsedDock ? { bottomPanelVisible: false } : {}),
        ...(collapsedAgentPanel ? { agentPanelVisible: false } : {}),
        ...(collapsedSideBar ? { sideBarVisible: false } : {}),
      });
    }
    set({
      promoted: { terminalId, taskId, collapsedDock, collapsedAgentPanel, collapsedSideBar },
    });
  },

  unpromote() {
    const p = get().promoted;
    if (!p) return;
    if (p.collapsedDock || p.collapsedAgentPanel || p.collapsedSideBar) {
      useAppStore.getState().setLayout({
        ...(p.collapsedDock ? { bottomPanelVisible: true, bottomTab: 'terminal' as const } : {}),
        ...(p.collapsedAgentPanel ? { agentPanelVisible: true } : {}),
        ...(p.collapsedSideBar ? { sideBarVisible: true } : {}),
      });
    }
    // Hand the dock slot back to the returning terminal (it was excluded from
    // the dock while promoted, so `active` had moved on or gone null).
    const terminals = useTerminalStore.getState();
    if (terminals.items.some((t) => t.id === p.terminalId)) {
      useTerminalStore.setState({ active: p.terminalId });
    }
    set({ promoted: null });
  },

  ensureSidePanelSpace() {
    const current = get().promoted;
    if (!current || !sidePanelWouldCrushCenter(get().panelWidth)) return;
    set({ promoted: { ...current, collapsedSideBar: true } });
    useAppStore.getState().setLayout({ sideBarVisible: false });
  },

  setPanelWidth(width) {
    set({ panelWidth: Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)) });
  },

  handleTerminalClosed(terminalId) {
    const agents = { ...get().agentByTerminal };
    const tasks = { ...get().taskByTerminal };
    delete agents[terminalId];
    delete tasks[terminalId];
    if (get().promoted?.terminalId === terminalId) get().unpromote();
    set({ agentByTerminal: agents, taskByTerminal: tasks });
  },

  async resumeTask(task) {
    const external = task.external;
    if (!external || get().resumingTaskId) return;
    if (external.cli !== 'claude' && external.cli !== 'codex') {
      useAppStore
        .getState()
        .pushToast('error', `${external.cli} does not support one-click session resume.`);
      return;
    }
    set({ resumingTaskId: task.id });
    try {
      const terminals = useTerminalStore.getState();
      let terminalId = terminals.items.find(
        (item) => item.id === external.terminalId && !item.exited,
      )?.id;
      if (!terminalId) {
        terminalId =
          (await terminals.create({ taskId: task.id, title: `${external.cli} resume` })) ??
          undefined;
      }
      if (!terminalId) return;
      useTerminalStore.setState({ active: terminalId });
      const result = await rpcResult('external.resumeSession', { taskId: task.id, terminalId });
      if (!okOrToast(result)) return;
      useAppStore.getState().pushToast('success', `Resumed the previous ${external.cli} session.`);
      await useTaskStore.getState().refreshTasks();
    } finally {
      set({ resumingTaskId: null });
    }
  },

  init() {
    if (get().initialized) return;
    set({ initialized: true });

    onEvent('terminal.agentState', ({ id, agent, taskId }) => {
      const agents = { ...get().agentByTerminal };
      const tasks = { ...get().taskByTerminal };
      const app = useAppStore.getState();
      if (agent) {
        agents[id] = agent;
        if (taskId) {
          tasks[id] = taskId;
          app.pushToast(
            'success',
            `Detected a ${agent} session — entry snapshot taken, changes are being tracked (EXT).`,
          );
          // ADR-0017 rev.2: detection only decorates. Moving the terminal is a
          // user action unless the opt-in preference asks for the old behavior.
          if (app.settings?.terminal.autoPromoteExternal) {
            set({ agentByTerminal: agents, taskByTerminal: tasks });
            get().promote(id);
          }
        } else {
          app.pushToast(
            'info',
            `Detected a ${agent} session in this terminal (outside the focused project — not tracked).`,
          );
        }
      } else {
        delete agents[id];
        const endedTask = tasks[id];
        // The task stays attached to the terminal: the session bar keeps its
        // ended state and the room entry stays reachable. The pane also stays
        // wherever the user put it (决策 4 rev.2: no automatic return).
        if (endedTask) {
          const files = get().sessions[endedTask]?.files.length ?? 0;
          app.pushToast(
            'info',
            files > 0
              ? `External session ended — ${files} file${files === 1 ? '' : 's'} changed, ready for review.`
              : 'External session ended — no file changes.',
          );
        }
      }
      set({ agentByTerminal: agents, taskByTerminal: tasks });
      // The backing task appeared / changed state — keep the sidebar truthful.
      void useTaskStore.getState().refreshTasks();
    });

    onEvent('external.sessionChanged', (session) => {
      const sessions = get().sessions;
      const delta = sessionDelta(sessions[session.taskId]?.files, session.files);
      if (delta.length > 0) {
        // Feed the shared presence machinery: tree/task glow + the room rail's
        // filesTouched + FilePeek's pulse-following refetch all key off this.
        seq += 1;
        useActivityStore.getState().ingest({
          key: `ext-${session.taskId}-${seq}`,
          taskId: session.taskId,
          sequence: Date.now() + seq,
          at: new Date().toISOString(),
          kind: 'write',
          label: `${session.cli} edited ${delta.length} file${delta.length === 1 ? '' : 's'}`,
          status: 'ok',
          paths: delta,
          author: 'agent',
        });
      }
      set({
        sessions: { ...sessions, [session.taskId]: session },
        ...(delta.length > 0 && session.status === 'active'
          ? { lastDelta: { taskId: session.taskId, paths: delta, seq } }
          : {}),
      });
    });

    // Structured Claude/Codex streams expose a real reply/turn boundary.
    // Reflect it on the exact Session row instead of animating whichever room
    // happens to be selected at the time.
    onEvent('external.turn', ({ terminalId, taskId, status, lastUserMessage }) => {
      seq += 1;
      const edgeKey = `external-turn:${terminalId}:${seq}`;
      void signalExternalReply(taskId, edgeKey, 'structured', status, lastUserMessage ?? null);
    });

    // Interactive Claude/Codex TUIs do not expose structured result events.
    // The host therefore emits a presence-only output-settled edge after a
    // submitted prompt; it must never be promoted into semantic Replay data.
    onEvent('external.activitySettled', ({ terminalId, taskId, lastUserMessage }) => {
      seq += 1;
      const edgeKey = `external-settled:${terminalId}:${seq}`;
      void signalExternalReply(taskId, edgeKey, 'observed', 'ok', lastUserMessage ?? null);
    });

    // Focused-workspace changes intentionally do not clear terminal/session
    // placement. Each PTY now owns its own host-resolved project context.

    void rpcResult('external.listSessions', {}).then((res) => {
      if (!res.ok) return;
      const sessions: Record<string, ExternalSession> = {};
      const agents: Record<string, string> = {};
      const tasks: Record<string, string> = {};
      for (const s of res.data.sessions) {
        sessions[s.taskId] = s;
        if (s.status === 'active') {
          agents[s.terminalId] = s.cli;
          tasks[s.terminalId] = s.taskId;
        }
      }
      // No auto-promote on hydrate either — placement is user intent only.
      set({
        sessions: { ...get().sessions, ...sessions },
        agentByTerminal: { ...agents, ...get().agentByTerminal },
        taskByTerminal: { ...tasks, ...get().taskByTerminal },
      });
    });
  },
}));
