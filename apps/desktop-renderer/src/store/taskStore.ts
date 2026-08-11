import type { AgentMode } from '@pi-ide/agent-contract';
import { create } from 'zustand';
import type {
  ChangeSetDto,
  ArtifactFeedbackRefDto,
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
import { STREAM_BUFFER_CAP } from '../views/timeline-window.js';
import {
  attentionFingerprint,
  dismissCurrentAttention,
  loadAttentionDismissals,
  saveAttentionDismissals,
  type AttentionDismissals,
} from './attentionDismissals.js';
import { clearScroll } from '../views/scrollMemory.js';

/**
 * Append a streaming delta, keeping only the last STREAM_BUFFER_CAP characters
 * (§16.5 memory bound). The completed agent/thinking event carries the full
 * text, so trimming the live preview loses nothing durable.
 */
function appendStreamDelta(text: string, delta: string): string {
  const next = text + delta;
  return next.length > STREAM_BUFFER_CAP ? next.slice(next.length - STREAM_BUFFER_CAP) : next;
}

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
  /**
   * Per-task timeline projections (ADR-0055): a bounded MRU cache so
   * re-opening a recently visited Session paints instantly from memory and
   * kept-alive rooms read their own task's data, never the active one's.
   * Invariant: for the active task, `timelines[activeTaskId] === timeline`
   * (same array reference).
   */
  timelines: Record<string, TimelineEventDto[]>;
  streaming: StreamingMessage | null;
  streamingThinking: StreamingThinking | null;
  models: ModelDescriptorDto[];
  workerAlive: boolean;
  newTaskOpen: boolean;
  loadingTimeline: boolean;
  initialized: boolean;
  attentionDismissals: AttentionDismissals;

  init(): void;
  refreshTasks(): Promise<void>;
  refreshModels(): Promise<void>;
  clearAttention(): void;
  /** Dismiss one task's current attention signal (For-you inbox, ADR-0056). */
  dismissAttention(taskId: string): void;
  openTask(taskId: string): Promise<void>;
  renameTask(taskId: string, title: string): Promise<boolean>;
  /** Archive (hide) a finished task; answered tasks are closed out (accepted) first. */
  archiveTask(taskId: string): Promise<boolean>;
  /** Permanently delete a settled Session and its Charter history. */
  deleteTask(taskId: string): Promise<boolean>;
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
    artifactRefs?: ArtifactFeedbackRefDto[];
  }): Promise<boolean>;
  send(
    text: string,
    during: 'steer' | 'followUp',
    /** ADR-0016: optional model/effort override for the next turn onward. */
    model?: TaskDto['model'],
    codeRefs?: CodeContextRefDto[],
    /** ADR-0024: file / folder / image references for this turn. */
    fileRefs?: FileContextRefDto[],
    artifactRefs?: ArtifactFeedbackRefDto[],
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
  // Terminal Replay binds to request.taskId, never to whichever Session later
  // becomes active underneath the standalone player.
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
  acceptTask(options?: { confirmEvidenceRisk?: boolean }): Promise<boolean>;

  // M9: verification + rollback
  rollbackTask(options?: { confirmDestructive?: boolean }): Promise<boolean>;
  runVerification(label?: string): Promise<void>;

  // ADR-0022: preview gate — marquee feedback + post-accept PR draft.
  /** Set only after the user explicitly opens a durable timeline draft. */
  prDraft: { taskId: string; draft: PrDraftDto } | null;
  openPrDraft(taskId: string, draft: PrDraftDto): void;
  dismissPrDraft(): void;
  /** Marquee feedback: same steer loop as request-fix, plus the screenshot. */
  sendPreviewFeedback(
    text: string,
    preview: PreviewAttachmentDto,
    codeRefs?: CodeContextRefDto[],
    fileRefs?: FileContextRefDto[],
    artifactRefs?: ArtifactFeedbackRefDto[],
  ): Promise<boolean>;

  // PIVOT-005: Home fast path — one-line intent charters a task.
  createFromIntent(input: {
    intent: string;
    mode: Exclude<AgentMode, 'full'>;
    model: { providerId: string; modelId: string };
  }): Promise<boolean>;
}

/**
 * MRU bound for cached per-task timelines. Sized like ORCA's hot working set:
 * large enough for the ordinary switch-around, small enough that memory stays
 * a few MB even with heavy transcripts. The active task is never evicted.
 */
const TIMELINE_CACHE_LIMIT = 8;

/** Write one task's timeline into the cache, touch recency, enforce the cap. */
function withTimeline(
  timelines: Record<string, TimelineEventDto[]>,
  taskId: string,
  timeline: TimelineEventDto[],
  activeTaskId: string | null,
): Record<string, TimelineEventDto[]> {
  const next: Record<string, TimelineEventDto[]> = {};
  for (const [key, value] of Object.entries(timelines)) {
    if (key !== taskId) next[key] = value;
  }
  next[taskId] = timeline; // insertion order doubles as recency (last = newest)
  const keys = Object.keys(next);
  let overflow = keys.length - TIMELINE_CACHE_LIMIT;
  for (const key of keys) {
    if (overflow <= 0) break;
    if (key === taskId || key === activeTaskId) continue;
    delete next[key];
    overflow -= 1;
  }
  return next;
}

/**
 * Merge a fresh server projection into a cached timeline, preserving the OLD
 * object reference for every event whose id+sequence match. Persisted events
 * are immutable, so identity can stand in for content — memoized rows then
 * skip re-rendering entirely, and an unchanged timeline keeps its array
 * reference (a no-op revalidation causes zero re-renders).
 */
function reconcileTimeline(
  cached: TimelineEventDto[] | undefined,
  fresh: TimelineEventDto[],
): TimelineEventDto[] {
  if (!cached || cached.length === 0) return fresh;
  const byId = new Map(cached.map((event) => [event.id, event]));
  let identical = cached.length === fresh.length;
  const merged = fresh.map((event, index) => {
    const previous = byId.get(event.id);
    const keep = previous !== undefined && previous.sequence === event.sequence ? previous : event;
    if (identical && keep !== cached[index]) identical = false;
    return keep;
  });
  // An event broadcast can land between the DB read and this reconcile; the
  // snapshot then lacks the newest live rows. Keep every cached event newer
  // than the snapshot tail (and live sequence-0 rows whose terminal event has
  // not arrived) so a revalidation never makes a just-appended message blink
  // out of the visible timeline.
  const freshIds = new Set(fresh.map((event) => event.id));
  const freshCallIds = new Set(fresh.map(timelineCallId).filter(Boolean));
  const maxFreshSequence = fresh.reduce((max, event) => Math.max(max, event.sequence), 0);
  const newerTail = cached.filter((event) => {
    if (freshIds.has(event.id)) return false;
    if (event.sequence > maxFreshSequence) return true;
    if (event.sequence === 0) {
      const callId = timelineCallId(event);
      return callId !== '' && !freshCallIds.has(callId);
    }
    return false;
  });
  if (newerTail.length === 0) return identical ? cached : merged;
  return [...merged, ...newerTail];
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
  timelines: {},
  streaming: null,
  streamingThinking: null,
  models: [],
  workerAlive: false,
  newTaskOpen: false,
  loadingTimeline: false,
  initialized: false,
  attentionDismissals: loadAttentionDismissals(),

  clearAttention() {
    const attentionDismissals = dismissCurrentAttention(get().tasks, get().attentionDismissals);
    saveAttentionDismissals(attentionDismissals);
    set({ attentionDismissals });
  },

  dismissAttention(taskId) {
    const task = get().tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    const attentionDismissals = {
      ...get().attentionDismissals,
      [taskId]: attentionFingerprint(task),
    };
    saveAttentionDismissals(attentionDismissals);
    set({ attentionDismissals });
  },

  init() {
    if (get().initialized) return;
    set({ initialized: true });

    onEvent('task.event', ({ taskId, event }) => {
      // Presence is global: a background Session must visibly react when its
      // agent finishes a reply, even when another Session owns the right pane.
      if (event.type === 'agent.message') {
        useAppStore.getState().signalSessionReply(taskId, `agent-message:${event.id}`);
      }
      // ADR-0055: events apply to the active task AND to any cached timeline,
      // so a kept-alive room stays current while hidden. Uncached tasks keep
      // today's behavior (dropped; a later open fetches the ledger).
      const state = get();
      const isActive = taskId === state.activeTaskId;
      const timeline = isActive ? state.timeline : state.timelines[taskId];
      if (timeline === undefined) return;
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
      const patch: Partial<TaskStore> = {
        timelines: withTimeline(state.timelines, taskId, next, state.activeTaskId),
      };
      if (isActive) {
        patch.timeline = next;
        // Completed agent message replaces the streaming bubble.
        if (event.type === 'agent.message') {
          patch.streaming = null;
          patch.streamingThinking = null;
        }
        // The persisted thinking block replaces its live stream.
        if (event.type === 'agent.thinking') patch.streamingThinking = null;
      }
      set(patch as never);
    });
    /**
     * A stream delta may only exist for a task that is actually running.
     * Main-process coalescing flushes before every settlement broadcast, but
     * a crash or an unforeseen bypass path could still deliver one late —
     * accepting it would resurrect a ghost "streaming" bubble on a settled
     * conversation (text that never reaches the persisted timeline).
     */
    const taskIsRunning = (taskId: string): boolean => {
      const task = get().tasks.find((candidate) => candidate.id === taskId);
      return task !== undefined && RUNNING_TASK_STATES.has(task.state);
    };
    onEvent('task.streamThinking', ({ taskId, runId, messageId, delta }) => {
      if (taskId !== get().activeTaskId || !taskIsRunning(taskId)) return;
      const current = get().streamingThinking;
      set({
        streamingThinking:
          current && current.messageId === messageId
            ? { ...current, text: appendStreamDelta(current.text, delta) }
            : { runId, messageId, text: delta, startedAt: Date.now() },
      });
    });
    onEvent('task.stream', ({ taskId, runId, messageId, delta }) => {
      if (taskId !== get().activeTaskId || !taskIsRunning(taskId)) return;
      const current = get().streaming;
      set({
        streaming:
          current && current.messageId === messageId
            ? { ...current, text: appendStreamDelta(current.text, delta) }
            : { runId, messageId, text: delta },
      });
    });
    onEvent('task.stateChanged', ({ taskId, state, task }) => {
      const tasks = get().tasks;
      const previous = tasks.find((candidate) => candidate.id === taskId);
      set({
        tasks: previous
          ? tasks.map((candidate) => (candidate.id === taskId ? task : candidate))
          : [task, ...tasks],
      });
      // Metadata-only refreshes (automatic title capture and user rename)
      // reuse this projection channel but are not completion edges.
      if (!previous || previous.state !== state) {
        useAppStore.getState().signalSessionCompletion(task);
      }
      if (
        taskId === get().activeTaskId &&
        (state === 'REVIEW_READY' || state === 'FAILED' || state === 'INTERRUPTED')
      ) {
        set({ streaming: null, streamingThinking: null });
        // Worker writes are recorded on their own ledgers. The commander gets
        // its complete projection when the run reaches an inspectable state.
        void get().refreshChangeSet();
      }
    });
    onEvent('task.deleted', ({ taskId }) => {
      clearScroll(taskId);
      const tasks = get().tasks.filter((task) => task.id !== taskId);
      const timelines = { ...get().timelines };
      delete timelines[taskId];
      const patch: Partial<TaskStore> = { tasks, timelines };
      if (get().activeTaskId === taskId) {
        patch.activeTaskId = null;
        patch.timeline = [];
        patch.streaming = null;
        patch.streamingThinking = null;
      }
      set(patch as never);
      const app = useAppStore.getState();
      if (app.taskRoomTaskId === taskId) {
        app.closeTaskRoom();
      }
      app.forgetTaskNavigation(taskId);
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
    // ADR-0055 stale-while-revalidate: a cached timeline paints immediately
    // (no "Loading…" flash, no blank frame); the ledger is re-read in the
    // background and reconciled preserving event identity, so an unchanged
    // history causes zero re-renders.
    const cached = get().timelines[taskId];
    set({
      activeTaskId: taskId,
      timeline: cached ?? [],
      timelines: withTimeline(get().timelines, taskId, cached ?? [], taskId),
      streaming: null,
      streamingThinking: null,
      loadingTimeline: cached === undefined,
      changeSet: null,
      loadingChangeSet: false,
      reviewOpen: false,
    });
    if (cached !== undefined) void get().refreshChangeSet();
    const res = await rpcResult('task.get', { taskId, eventsAfter: 0 });
    if (res.ok) {
      const tasks = get().tasks;
      const nextTasks = tasks.some((task) => task.id === taskId)
        ? tasks.map((task) => (task.id === taskId ? res.data.task : task))
        : [res.data.task, ...tasks];
      const fresh = reconcileTimeline(get().timelines[taskId], res.data.timeline);
      // The user may have selected a different Session while this request was
      // in flight. The per-task cache write is safe either way; only the
      // active singleton must never receive another task's data.
      if (get().activeTaskId !== taskId) {
        set({
          tasks: nextTasks,
          timelines: withTimeline(get().timelines, taskId, fresh, get().activeTaskId),
        });
        return;
      }
      set({
        tasks: nextTasks,
        timeline: fresh,
        timelines: withTimeline(get().timelines, taskId, fresh, taskId),
        loadingTimeline: false,
      });
      // The tool rail's file count must come from the durable change set, not
      // only this task's activity events. Mission commanders can own files
      // produced by bound worker Sessions whose write events live on those
      // child ledgers, so hydrate the aggregate as soon as the room opens.
      if (cached === undefined) void get().refreshChangeSet();
    } else {
      // Failed fetch: the empty placeholder this open planted must not
      // masquerade as a cached ledger on the next visit (events that arrived
      // meanwhile are real — keep those).
      if (cached === undefined && get().timelines[taskId]?.length === 0) {
        const timelines = { ...get().timelines };
        delete timelines[taskId];
        set({ timelines });
      }
      if (get().activeTaskId === taskId) set({ loadingTimeline: false });
    }
  },

  async renameTask(taskId, title) {
    const res = await rpcResult('task.rename', { taskId, title });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return false;
    }
    set({
      tasks: get().tasks.map((task) => (task.id === taskId ? res.data.task : task)),
    });
    useAppStore.getState().pushToast('success', 'Session renamed.');
    return true;
  },

  async archiveTask(taskId) {
    const app = useAppStore.getState();
    // ADR-0032: archive merges a worktree Session back into the main tree —
    // conflicts stop it and ask for explicit confirmation.
    let res = await rpcResult('task.archive', { taskId, confirmConflicts: false });
    if (res.ok && res.data.status === 'conflicts') {
      const paths = (res.data.conflicts ?? []).map((c) => c.path).join(', ');
      const confirmed = window.confirm(
        `The project changed while this Session worked in its worktree.\nMerging will overwrite: ${paths}\n\nArchive and overwrite anyway?`,
      );
      if (!confirmed) return false;
      res = await rpcResult('task.archive', { taskId, confirmConflicts: true });
      if (res.ok && res.data.status === 'conflicts') return false;
    }
    if (!res.ok) {
      app.pushToast('error', res.error.userMessage);
      return false;
    }
    if (useAppStore.getState().taskRoomTaskId === taskId) app.closeTaskRoom();
    app.forgetTaskNavigation(taskId);
    {
      // An archived Session leaves the switching set — drop its cached ledger.
      const timelines = { ...get().timelines };
      delete timelines[taskId];
      if (get().activeTaskId === taskId) {
        set({
          activeTaskId: null,
          timeline: [],
          timelines,
          streaming: null,
          streamingThinking: null,
        });
      } else {
        set({ timelines });
      }
    }
    await get().refreshTasks();
    app.pushToast('info', 'Session archived.');
    return true;
  },

  async deleteTask(taskId) {
    const app = useAppStore.getState();
    const deletingTask = get().tasks.find((task) => task.id === taskId) ?? null;
    const res = await rpcResult('task.delete', { taskId });
    if (!res.ok) {
      app.pushToast('error', res.error.userMessage);
      return false;
    }
    if (app.taskRoomTaskId === taskId) app.closeTaskRoom();
    app.forgetTaskNavigation(taskId);
    const tasks = get().tasks.filter((task) => task.id !== taskId);
    const timelines = { ...get().timelines };
    delete timelines[taskId];
    const patch: Partial<TaskStore> = { tasks, timelines };
    if (get().activeTaskId === taskId) {
      patch.activeTaskId = null;
      patch.timeline = [];
      patch.streaming = null;
      patch.streamingThinking = null;
    }
    set(patch as never);
    // A deleted tracked Claude/Codex transcript is now host-suppressed; force
    // refresh the archive so it cannot linger or reappear as "external".
    void import('./archaeologyStore.js').then(({ useArchaeologyStore }) =>
      useArchaeologyStore.getState().scan(true),
    );
    if (deletingTask?.external?.terminalId) {
      void import('../views/TerminalPanel.js').then(({ useTerminalStore }) =>
        useTerminalStore.getState().requestKill(deletingTask.external!.terminalId),
      );
    }
    app.pushToast('success', 'Session permanently deleted.');
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
      artifactRefs: input.artifactRefs ?? [],
    });
    if (!okOrToast(start)) return false;
    if (start.data.queued) {
      useAppStore.getState().pushToast('info', 'Queued: another agent run is active.');
    }
    return true;
  },

  async send(text, during, model, codeRefs = [], fileRefs = [], artifactRefs = []) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    const res = await rpcResult('task.message', {
      taskId,
      text,
      during,
      ...(model ? { model } : {}),
      codeRefs,
      fileRefs,
      artifactRefs,
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
    if (!task) {
      useAppStore.getState().pushToast('error', 'This session is no longer available.');
      return;
    }
    if (task?.external) {
      const { useExternalStore } = await import('./externalStore.js');
      await useExternalStore.getState().resumeTask(task);
      return;
    }
    const res = await rpcResult('task.start', {
      taskId,
      codeRefs: [],
      fileRefs: [],
      artifactRefs: [],
    });
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

  openPrDraft(taskId, draft) {
    set({ prDraft: { taskId, draft } });
  },

  dismissPrDraft() {
    set({ prDraft: null });
  },

  async sendPreviewFeedback(text, preview, codeRefs = [], fileRefs = [], artifactRefs = []) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    const res = await rpcResult('task.message', {
      taskId,
      text,
      during: 'steer',
      preview,
      codeRefs,
      fileRefs,
      artifactRefs,
    });
    if (!okOrToast(res)) return false;
    return true;
  },

  openReplay(request) {
    const taskId = request?.taskId ?? get().activeTaskId;
    if (!taskId) return;
    set({
      replayRequest: { taskId },
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

  async acceptTask(options) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    let confirmUnverified = options?.confirmEvidenceRisk === true;
    let confirmConflicts = false;
    for (;;) {
      const res = await rpcResult('task.accept', { taskId, confirmUnverified, confirmConflicts });
      if (!res.ok) {
        if (res.error.code === 'ACCEPT_NEEDS_CONFIRM' && !confirmUnverified) {
          // The main-process trust boundary describes whether evidence is
          // missing, failed, still running, or stale. Every UI entry point
          // receives the same second-decision contract.
          if (!window.confirm(res.error.userMessage)) return false;
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
      break;
    }
    // The durable task.prDraft timeline entry is the non-blocking next step.
    // Do not cover the newly settled Session with an automatic modal.
    set({ reviewOpen: false, prDraft: null });
    await get().refreshTasks();
    // The accept RPC can persist its final task.prDraft event after the
    // state-change broadcast. Re-read the active ledger so that a missed or
    // reordered renderer event cannot hide the durable next step until the
    // user leaves and reopens the Session.
    const detail = await rpcResult('task.get', { taskId, eventsAfter: 0 });
    if (detail.ok && get().activeTaskId === taskId) {
      const fresh = reconcileTimeline(get().timelines[taskId], detail.data.timeline);
      set({
        tasks: get().tasks.map((task) => (task.id === taskId ? detail.data.task : task)),
        timeline: fresh,
        timelines: withTimeline(get().timelines, taskId, fresh, taskId),
      });
    }
    return true;
  },

  async rollbackTask(options) {
    const taskId = get().activeTaskId;
    if (!taskId) return false;
    if (
      options?.confirmDestructive !== true &&
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
    // The restore invalidated the recorded change set: clear it immediately so
    // an open Diff tool can never keep showing rolled-back hunks, then refetch
    // the (now empty) truth from the main process.
    set({ reviewOpen: false, changeSet: null });
    await get().refreshTasks();
    await get().refreshChangeSet();
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
      const app = useAppStore.getState();
      // Review already updates its Checks evidence in place. A floating success
      // toast over the decision surface only obscures the result it repeats.
      if (app.sessionTool !== 'review') {
        app.pushToast('success', 'Verification finished. Results are recorded.');
      }
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
  'AWAITING_USER',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);
