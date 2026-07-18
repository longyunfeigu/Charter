import type { AgentMode } from '@pi-ide/agent-contract';
import { create } from 'zustand';
import type {
  ChangeSetDto,
  CodeContextRefDto,
  FileContextRefDto,
  ModelDescriptorDto,
  PlanEditDto,
  PrDraftDto,
  PreviewAttachmentDto,
  ReplayRequest,
  TaskDto,
  TimelineEventDto,
} from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from './appStore.js';

export interface StreamingMessage {
  runId: string;
  messageId: string;
  text: string;
}

/** Live model reasoning (ADR-0011) — shown collapsed-by-default, then folds. */
export interface StreamingThinking {
  runId: string;
  messageId: string;
  text: string;
  startedAt: number;
}

interface TaskStore {
  tasks: TaskDto[];
  activeTaskId: string | null;
  timeline: TimelineEventDto[];
  streaming: StreamingMessage | null;
  streamingThinking: StreamingThinking | null;
  models: ModelDescriptorDto[];
  workerAlive: boolean;
  newTaskOpen: boolean;
  loadingTimeline: boolean;
  initialized: boolean;

  init(): void;
  refreshTasks(): Promise<void>;
  refreshModels(): Promise<void>;
  openTask(taskId: string): Promise<void>;
  /** Archive (hide) a finished task; answered tasks are closed out (accepted) first. */
  archiveTask(taskId: string): Promise<boolean>;
  setNewTaskOpen(open: boolean): void;
  createAndStart(input: {
    title: string;
    goalMd: string;
    acceptance: string[];
    mode: AgentMode;
    model: {
      providerId: string;
      modelId: string;
      /** Reasoning effort; falls back to Settings → Models → default thinking level. */
      thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    };
    verification?: Array<{
      label: string;
      executable: string;
      args: string[];
      cwd: string;
      timeoutMs: number;
    }>;
    /** ADR-0009: dispatch target project (defaults to the focused workspace). */
    projectPath?: string;
    /** ADR-0009: isolate the task in its own git worktree. */
    isolation?: 'none' | 'worktree';
    /** ADR-0009 am.2: command run once inside the fresh worktree (deps, codegen). */
    worktreeSetup?: string;
    /** Up to three existing task conversations used as background context. */
    conversationRefTaskIds?: string[];
    /** ADR-0022 am.2: preview feedback seeding this task's first run. */
    preview?: PreviewAttachmentDto;
    /** Frozen source snapshots for the new Session's first turn. */
    codeRefs?: CodeContextRefDto[];
    /** ADR-0024: file / folder / image references for the first turn. */
    fileRefs?: FileContextRefDto[];
  }): Promise<boolean>;
  send(
    text: string,
    during: 'steer' | 'followUp',
    /** ADR-0016: optional model/effort override for the next turn onward. */
    model?: TaskDto['model'],
    codeRefs?: CodeContextRefDto[],
    /** ADR-0024: file / folder / image references for this turn. */
    fileRefs?: FileContextRefDto[],
  ): Promise<boolean>;
  stop(): Promise<void>;
  /** Restart an INTERRUPTED/FAILED task's run (M10 recovery). */
  resumeTask(taskId?: string): Promise<void>;
  decidePermission(input: {
    requestId: string;
    kind: 'allow' | 'deny';
    scope: 'once' | 'task' | 'workspace' | 'always';
    expectedParamsHash: string;
    reason?: string;
    applyToSimilar?: boolean;
  }): Promise<void>;
  answerUser(callId: string, answer: string): Promise<void>;

  // M8: plan approval + review
  reviewOpen: boolean;
  changeSet: ChangeSetDto | null;
  loadingChangeSet: boolean;
  // P2 (PIVOT-017) → Replay V3 (ADR-0017 am.8): an explicit entry request —
  // the overlay binds to request.taskId, depth and anchor, never to whatever
  // activeTaskId later becomes.
  replayRequest: ReplayRequest | null;
  openReplay(request?: Partial<ReplayRequest>): void;
  closeReplay(): void;
  decidePlan(input: {
    decision: 'approve' | 'reject' | 'request_changes';
    editedPlan?: PlanEditDto;
    reason?: string;
    codeRefs?: CodeContextRefDto[];
    confirmRemovedDone?: boolean;
  }): Promise<boolean>;
  openReview(): Promise<void>;
  closeReview(): void;
  refreshChangeSet(): Promise<void>;
  reviewDecision(input: {
    path: string;
    scope: 'file' | 'hunk';
    decision: 'accept' | 'reject';
    hunkKey?: string;
    expectedCurrentHash?: string;
  }): Promise<void>;
  acceptTask(): Promise<boolean>;

  // M9: verification + rollback
  rollbackTask(): Promise<boolean>;
  runVerification(label?: string): Promise<void>;

  // ADR-0022: preview gate — marquee feedback + post-accept PR draft.
  /** Set after a successful accept when the ledger produced a draft. */
  prDraft: { taskId: string; draft: PrDraftDto } | null;
  dismissPrDraft(): void;
  /** Marquee feedback: same steer loop as request-fix, plus the screenshot. */
  sendPreviewFeedback(
    text: string,
    preview: PreviewAttachmentDto,
    codeRefs?: CodeContextRefDto[],
    fileRefs?: FileContextRefDto[],
  ): Promise<boolean>;

  // PIVOT-005: Home fast path — one-line intent charters a task.
  createFromIntent(input: {
    intent: string;
    mode: Exclude<AgentMode, 'full'>;
    model: { providerId: string; modelId: string };
  }): Promise<boolean>;
}

/** callId of a tool-lifecycle timeline event, or '' for everything else. */
function timelineCallId(event: TimelineEventDto): string {
  if (event.type !== 'tool.call' && event.type !== 'agent.toolProposed') return '';
  const payload = event.payload as
    { callId?: unknown; call?: { callId?: unknown } } | null | undefined;
  const raw = payload?.callId ?? payload?.call?.callId;
  return typeof raw === 'string' ? raw : '';
}

/** Derive a task title from free-form intent (first line, cleaned, ≤64 chars). */
export function titleFromIntent(intent: string): string {
  const firstLine = intent.split('\n')[0]?.trim() ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ');
  if (cleaned.length <= 64) return cleaned || 'New task';
  return `${cleaned.slice(0, 61)}…`;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  activeTaskId: null,
  timeline: [],
  streaming: null,
  streamingThinking: null,
  models: [],
  workerAlive: false,
  newTaskOpen: false,
  loadingTimeline: false,
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });

    onEvent('task.event', ({ taskId, event }) => {
      // Presence is global: a background Session must visibly react when its
      // agent finishes a reply, even when another Session owns the right pane.
      if (event.type === 'agent.message') {
        useAppStore.getState().signalSessionReply(taskId, `agent-message:${event.id}`);
      }
      if (taskId !== get().activeTaskId) return;
      const timeline = get().timeline;
      // Ephemeral events have sequence 0; persisted ones are monotonic.
      if (event.sequence > 0 && timeline.some((e) => e.id === event.id)) return;
      // Tool lifecycle: one timeline entry per callId. Live states
      // (PROPOSED → WAITING_PERMISSION → RUNNING, ADR-0006) replace each other
      // in place, and the persisted terminal event replaces them all.
      const callId = timelineCallId(event);
      const base = callId
        ? timeline.filter((e) => e.sequence > 0 || timelineCallId(e) !== callId)
        : timeline;
      const next = [...base, event].sort((a, b) =>
        a.sequence === 0 || b.sequence === 0 ? 0 : a.sequence - b.sequence,
      );
      // Completed agent message replaces the streaming bubble.
      const patch: Partial<TaskStore> = { timeline: next };
      if (event.type === 'agent.message') {
        patch.streaming = null;
        patch.streamingThinking = null;
      }
      // The persisted thinking block replaces its live stream.
      if (event.type === 'agent.thinking') patch.streamingThinking = null;
      set(patch as never);
    });
    onEvent('task.streamThinking', ({ taskId, runId, messageId, delta }) => {
      if (taskId !== get().activeTaskId) return;
      const current = get().streamingThinking;
      set({
        streamingThinking:
          current && current.messageId === messageId
            ? { ...current, text: current.text + delta }
            : { runId, messageId, text: delta, startedAt: Date.now() },
      });
    });
    onEvent('task.stream', ({ taskId, runId, messageId, delta }) => {
      if (taskId !== get().activeTaskId) return;
      const current = get().streaming;
      set({
        streaming:
          current && current.messageId === messageId
            ? { ...current, text: current.text + delta }
            : { runId, messageId, text: delta },
      });
    });
    onEvent('task.stateChanged', ({ taskId, state, task }) => {
      const tasks = get().tasks;
      set({
        tasks: tasks.some((candidate) => candidate.id === taskId)
          ? tasks.map((candidate) => (candidate.id === taskId ? task : candidate))
          : [task, ...tasks],
      });
      useAppStore.getState().signalSessionCompletion(task);
      if (
        taskId === get().activeTaskId &&
        (state === 'REVIEW_READY' || state === 'FAILED' || state === 'INTERRUPTED')
      ) {
        set({ streaming: null, streamingThinking: null });
      }
    });
    onEvent('agent.workerStatus', ({ alive }) => {
      const wasAlive = get().workerAlive;
      set({ workerAlive: alive });
      // Cold-start race: a models.list issued before the worker was ready
      // yields an empty catalog — refetch the moment the worker comes up.
      if (alive && !wasAlive) void get().refreshModels();
    });
    // ADR-0009: tasks are global — switching the focused project must not
    // clear the list, the open room, or its timeline.
    onEvent('workspace.changed', () => {
      void get().refreshTasks();
    });
    void get().refreshTasks();
  },

  async refreshTasks() {
    const res = await rpcResult('task.list', {
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    });
    if (res.ok) set({ tasks: res.data.tasks });
  },

  async refreshModels() {
    const res = await rpcResult('models.list', {});
    if (res.ok) set({ models: res.data.models, workerAlive: res.data.workerAlive });
  },

  async openTask(taskId) {
    set({
      activeTaskId: taskId,
      timeline: [],
      streaming: null,
      streamingThinking: null,
      loadingTimeline: true,
      changeSet: null,
      loadingChangeSet: false,
      reviewOpen: false,
    });
    const res = await rpcResult('task.get', { taskId, eventsAfter: 0 });
    if (res.ok) {
      const tasks = get().tasks;
      const nextTasks = tasks.some((task) => task.id === taskId)
        ? tasks.map((task) => (task.id === taskId ? res.data.task : task))
        : [res.data.task, ...tasks];
      // The user may have selected a different Session while this request was
      // in flight. Keep the task catalog fresh, but never project stale
      // timeline data into the newly selected right pane.
      if (get().activeTaskId !== taskId) {
        set({ tasks: nextTasks });
        return;
      }
      set({ tasks: nextTasks, timeline: res.data.timeline, loadingTimeline: false });
    } else if (get().activeTaskId === taskId) {
      set({ loadingTimeline: false });
    }
  },

  async archiveTask(taskId) {
    const app = useAppStore.getState();
    const task = get().tasks.find((t) => t.id === taskId);
    // Light completion (ADR-0009): an answered task (zero changes) is closed
    // out — accepting the no-op result — before it is archived.
    if (task && task.state === 'REVIEW_READY' && task.changedFiles === 0) {
      const accepted = await rpcResult('task.accept', {
        taskId,
        confirmUnverified: false,
        confirmConflicts: false,
      });
      if (!accepted.ok) {
        app.pushToast('error', accepted.error.userMessage);
        return false;
      }
    }
    const res = await rpcResult('task.archive', { taskId });
    if (!res.ok) {
      app.pushToast('error', res.error.userMessage);
      return false;
    }
    if (useAppStore.getState().taskRoomTaskId === taskId) app.closeTaskRoom();
    if (get().activeTaskId === taskId) {
      set({ activeTaskId: null, timeline: [], streaming: null, streamingThinking: null });
    }
    await get().refreshTasks();
    app.pushToast('info', 'Task archived.');
    return true;
  },

  setNewTaskOpen(open) {
    set({ newTaskOpen: open });
  },

  async createAndStart(input) {
    // Effort: an explicit composer choice wins; otherwise the Settings default
    // applies (previously that setting was never read — a dead control).
    const thinkingLevel =
      input.model.thinkingLevel ??
      useAppStore.getState().settings?.models.defaultThinkingLevel ??
      'medium';
    const create = await rpcResult('task.create', {
      title: input.title,
      goalMd: input.goalMd,
      acceptance: input.acceptance,
      mode: input.mode,
      model: { ...input.model, thinkingLevel },
      verification: input.verification ?? [],
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      isolation: input.isolation ?? 'none',
      ...(input.worktreeSetup?.trim() ? { worktreeSetup: input.worktreeSetup.trim() } : {}),
      conversationRefTaskIds: input.conversationRefTaskIds ?? [],
    });
    if (!okOrToast(create)) return false;
    const task = create.data.task;
    set({ newTaskOpen: false });
    await get().openTask(task.id);
    await get().refreshTasks();
    const start = await rpcResult('task.start', {
      taskId: task.id,
      ...(input.preview ? { preview: input.preview } : {}),
      codeRefs: input.codeRefs ?? [],
      fileRefs: input.fileRefs ?? [],
    });
    if (!okOrToast(start)) return false;
    if (start.data.queued) {
      useAppStore.getState().pushToast('info', 'Queued: another agent run is active.');
    }
    return true;
  },

  async send(text, during, model, codeRefs = [], fileRefs = []) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    const res = await rpcResult('task.message', {
      taskId,
      text,
      during,
      ...(model ? { model } : {}),
      codeRefs,
      fileRefs,
    });
    if (!okOrToast(res)) return false;
    // ADR-0016: an override updates the task's model — refresh so the composer
    // pill and task lists reflect the model serving the next turn.
    if (model) void get().refreshTasks();
    return true;
  },

  async stop() {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    await rpcResult('task.stop', { taskId });
  },

  async resumeTask(requestedTaskId) {
    const taskId = requestedTaskId ?? get().activeTaskId;
    if (!taskId) return;
    const task = get().tasks.find((item) => item.id === taskId);
    if (task?.external) {
      const { useExternalStore } = await import('./externalStore.js');
      await useExternalStore.getState().resumeTask(task);
      return;
    }
    const res = await rpcResult('task.start', { taskId, codeRefs: [], fileRefs: [] });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
    else if (res.data.queued) {
      useAppStore.getState().pushToast('info', 'Queued: all agent slots are busy.');
    }
  },

  async decidePermission(input) {
    const res = await rpcResult('task.permissionDecision', {
      requestId: input.requestId,
      kind: input.kind,
      scope: input.scope,
      expectedParamsHash: input.expectedParamsHash,
      ...(input.reason ? { reason: input.reason } : {}),
      applyToSimilar: input.applyToSimilar ?? false,
    });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
    } else if (res.data.resolvedRequestIds.length === 0) {
      useAppStore
        .getState()
        .pushToast('info', 'That approval is no longer valid — the request was refreshed.');
    }
  },

  async answerUser(callId, answer) {
    const res = await rpcResult('task.answerUser', { callId, answer });
    if (!res.ok) useAppStore.getState().pushToast('error', res.error.userMessage);
    else if (!res.data.ok)
      useAppStore.getState().pushToast('info', 'This question is no longer waiting.');
  },

  reviewOpen: false,
  changeSet: null,
  loadingChangeSet: false,
  replayRequest: null,
  prDraft: null,

  dismissPrDraft() {
    set({ prDraft: null });
  },

  async sendPreviewFeedback(text, preview, codeRefs = [], fileRefs = []) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    const res = await rpcResult('task.message', {
      taskId,
      text,
      during: 'steer',
      preview,
      codeRefs,
      fileRefs,
    });
    if (!okOrToast(res)) return false;
    return true;
  },

  openReplay(request) {
    const taskId = request?.taskId ?? get().activeTaskId;
    if (!taskId) return;
    set({
      replayRequest: {
        taskId,
        depth: request?.depth ?? 'recap',
        anchor: request?.anchor ?? { type: 'result' },
        ...(request?.liveFollow !== undefined ? { liveFollow: request.liveFollow } : {}),
      },
    });
  },
  closeReplay() {
    set({ replayRequest: null });
  },

  async decidePlan(input) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    const res = await rpcResult('task.planDecision', {
      taskId,
      decision: input.decision,
      ...(input.editedPlan ? { editedPlan: input.editedPlan } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      codeRefs: input.codeRefs ?? [],
      confirmRemovedDone: input.confirmRemovedDone ?? false,
    });
    if (!okOrToast(res)) return false;
    await get().refreshTasks();
    return true;
  },

  async openReview() {
    set({ reviewOpen: true });
    await get().refreshChangeSet();
  },

  closeReview() {
    set({ reviewOpen: false });
  },

  async refreshChangeSet() {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    set({ loadingChangeSet: true });
    const res = await rpcResult('task.changeSet', { taskId });
    if (get().activeTaskId !== taskId) return;
    if (res.ok) set({ changeSet: res.data.changeSet, loadingChangeSet: false });
    else {
      set({ loadingChangeSet: false });
      useAppStore.getState().pushToast('error', res.error.userMessage);
    }
  },

  async reviewDecision(input) {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    const res = await rpcResult('task.reviewDecision', {
      taskId,
      path: input.path,
      scope: input.scope,
      decision: input.decision,
      ...(input.hunkKey ? { hunkKey: input.hunkKey } : {}),
      ...(input.expectedCurrentHash ? { expectedCurrentHash: input.expectedCurrentHash } : {}),
    });
    if (!okOrToast(res)) return;
    if (res.data.status === 'stale') {
      useAppStore
        .getState()
        .pushToast('info', 'The file changed while reviewing — the view was refreshed.');
    }
    if (get().activeTaskId !== taskId) return;
    set({ changeSet: res.data.changeSet });
  },

  async acceptTask() {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    let confirmUnverified = false;
    let confirmConflicts = false;
    let lastAccept: { prDraft?: PrDraftDto | null } | null = null;
    for (;;) {
      const res = await rpcResult('task.accept', { taskId, confirmUnverified, confirmConflicts });
      if (!res.ok) {
        if (res.error.code === 'ACCEPT_NEEDS_CONFIRM' && !confirmUnverified) {
          // VER-007/E2E-018: unverified changes need a second, explicit confirmation.
          if (
            !window.confirm(
              'No verification was run for this task. Accept the unverified changes anyway?',
            )
          ) {
            return false;
          }
          confirmUnverified = true;
          continue;
        }
        useAppStore.getState().pushToast('error', res.error.userMessage);
        return false;
      }
      // ADR-0009: worktree merge-back conflicts need an explicit override.
      if (res.data.status === 'conflicts' && !confirmConflicts) {
        const list = (res.data.conflicts ?? []).map((c) => `• ${c.path}: ${c.reason}`).join('\n');
        if (
          !window.confirm(
            `Some files changed in the main project while this task ran in its worktree:\n\n${list}\n\n` +
              'Merge anyway? Your main-tree versions of these files will be replaced.',
          )
        ) {
          return false;
        }
        confirmConflicts = true;
        continue;
      }
      lastAccept = res.data;
      break;
    }
    set({ reviewOpen: false });
    // ADR-0022: surface the evidence-ledger PR draft (git projects only).
    const draft = lastAccept?.prDraft ?? null;
    set({ prDraft: draft ? { taskId, draft } : null });
    await get().refreshTasks();
    return true;
  },

  async rollbackTask() {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    if (
      !window.confirm(
        'Roll back all changes made by this task? Files are restored byte-exact to their pre-task state.',
      )
    ) {
      return false;
    }
    let res = await rpcResult('task.rollback', { taskId, force: false });
    if (res.ok && res.data.status === 'conflicts') {
      const conflictList = (res.data.conflicts ?? [])
        .map((c) => `• ${c.path}: ${c.reason}`)
        .join('\n');
      const override = window.confirm(
        `Some files changed outside this task after the agent touched them:\n\n${conflictList}\n\n` +
          'Restore the pre-task state anyway? Your outside edits to these files will be replaced.',
      );
      if (!override) return false;
      res = await rpcResult('task.rollback', { taskId, force: true });
    }
    if (!okOrToast(res)) return false;
    set({ reviewOpen: false });
    await get().refreshTasks();
    useAppStore
      .getState()
      .pushToast('info', `Rolled back ${res.data.restored?.length ?? 0} file(s).`);
    return true;
  },

  async createFromIntent(input) {
    return get().createAndStart({
      title: titleFromIntent(input.intent),
      goalMd: input.intent,
      acceptance: [],
      mode: input.mode,
      model: input.model,
    });
  },

  async runVerification(label) {
    const taskId = get().activeTaskId;
    if (!taskId) return;
    const res = await rpcResult('task.runVerification', {
      taskId,
      ...(label ? { label } : {}),
    });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
    } else if (!res.data.configured) {
      useAppStore.getState().pushToast('info', 'No verification commands are configured.');
    } else {
      useAppStore.getState().pushToast('success', 'Verification finished. Results are recorded.');
    }
  },
}));

export function activeTask(state: TaskStore): TaskDto | null {
  return state.tasks.find((t) => t.id === state.activeTaskId) ?? null;
}

export const RUNNING_TASK_STATES = new Set([
  'EXPLORING',
  'PLANNING',
  'IN_PROGRESS',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);
