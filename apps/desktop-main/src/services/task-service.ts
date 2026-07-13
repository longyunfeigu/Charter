import {
  createSequenceAllocator,
  newId,
  productError,
  ProductFailure,
  redactObject,
  type Logger,
} from '@pi-ide/foundation';
import { assertTransition, isRunningState, type TaskState } from '@pi-ide/app-domain';
import type {
  AgentEvent,
  AgentMode,
  CreateSessionInput,
  ModelRef,
  RuntimeSessionRef,
  TaskPlan,
  ToolCallRequest,
} from '@pi-ide/agent-contract';
import type {
  ActivityItem,
  AskUserPromptDto,
  ChangeSetDto,
  ChangeSetFileDto,
  PermissionCardDto,
  PlanEditDto,
  TaskDto,
  TimelineEventDto,
  VerificationCommandSchema,
} from '@pi-ide/ipc-contracts';
import { projectActivity } from '@pi-ide/ipc-contracts';
import type { z } from 'zod';
import type { SqlDatabase } from '@pi-ide/persistence';
import {
  normalizeProposedPlan,
  applyPlanEdit,
  applyStatusUpdates,
  WRITE_TOOL_NAMES,
  type AskUserPrompt,
  type PermissionRequestCard,
  type PlanGate,
  type PlanStepUpdate,
  type ProposedPlanInput,
  type ToolAuditRecord,
  type ToolGateway,
  type VerificationGate,
} from '@pi-ide/tool-gateway';
import { parseHunks } from '@pi-ide/change-service';
import type {
  VerificationCommand as VerCommand,
  VerificationRunRecord,
} from '@pi-ide/verification-service';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitService } from '@pi-ide/git-service';
import { openWorkspaceInfo } from '@pi-ide/workspace-service';
import type { AgentHost, RuntimeKind } from './agent-host.js';
import type { WorkspaceHost } from './workspace-host.js';
import type { SettingsService } from './settings-service.js';
import type { AppPaths } from '../app-paths.js';
import { ProjectContexts, type ProjectContext } from './project-contexts.js';
import { WorktreeService, type TaskWorktree } from './worktree-service.js';
import { broadcast } from '../broadcast.js';

type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

function countPatchLines(patch: string | null): { additions: number; deletions: number } {
  if (!patch) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

export interface CreateTaskInput {
  title: string;
  goalMd: string;
  acceptance: string[];
  mode: AgentMode;
  model: ModelRef;
  verification: VerificationCommand[];
  /** ADR-0009: dispatch target; defaults to the focused workspace. */
  projectPath?: string;
  /** ADR-0009: run in an isolated git worktree. */
  isolation?: 'none' | 'worktree';
}

interface TaskRow {
  id: string;
  workspace_id: string;
  title: string;
  goal_md: string;
  acceptance_json: string;
  mode: string;
  state: string;
  model_json: string;
  verification_json: string;
  git_baseline_json: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  worktree_json: string | null;
  changed_files: number | null;
  project_path: string;
  project_name: string;
}

const TASK_SELECT =
  'SELECT t.*, w.canonical_path AS project_path, w.display_name AS project_name FROM tasks t JOIN workspaces w ON w.id = t.workspace_id';

/**
 * Task engine (spec §6): persistence-backed state machine, immutable event log,
 * run orchestration against the AgentHost, tool audit projection.
 */
export class TaskService {
  private readonly sequences = createSequenceAllocator();
  private readonly sessionRefs = new Map<string, RuntimeSessionRef>();
  private readonly runsByTask = new Map<string, string>();
  private readonly startQueue: Array<{ taskId: string; prompt: string | undefined }> = [];
  /** Per-root agent contexts (ADR-0009) — tasks execute against these, never "the open workspace". */
  private readonly contexts: ProjectContexts;
  private readonly worktrees: WorktreeService;
  /** Pending permission request → owning context (routes decisions). */
  private readonly requestContext = new Map<string, ProjectContext>();
  /** Open ask_user questions waiting for an answer, keyed by callId. */
  private readonly pendingAsks = new Map<
    string,
    { prompt: AskUserPromptDto; resolve: (answer: string) => void; cleanup: () => void }
  >();
  /** Plan projection per task (rebuilt from task_events on demand). */
  private readonly planRecords = new Map<
    string,
    {
      plan: TaskPlan | null;
      status: 'none' | 'awaiting' | 'approved' | 'rejected';
      version: number;
    }
  >();
  /** propose_plan calls blocked on a user decision, keyed by taskId. */
  private readonly planWaiters = new Map<
    string,
    {
      resolve: (
        outcome:
          | { decision: 'approved' | 'edited'; plan: TaskPlan }
          | { decision: 'changes_requested'; plan: TaskPlan; feedback: string },
      ) => void;
      reject: (error: unknown) => void;
      cleanup: () => void;
    }
  >();
  /** State-transition observers (notifications, PIVOT-014). */
  private readonly stateChangeListeners = new Set<
    (info: {
      taskId: string;
      from: TaskState;
      to: TaskState;
      title: string;
      changedFiles: number | null;
    }) => void
  >();

  constructor(
    private readonly db: SqlDatabase,
    private readonly host: AgentHost,
    private readonly workspace: WorkspaceHost,
    private readonly settings: SettingsService,
    paths: AppPaths,
    private readonly logger: Logger,
  ) {
    this.worktrees = new WorktreeService(paths, logger);
    this.contexts = new ProjectContexts(
      this.db,
      paths,
      settings,
      workspace,
      {
        // Unknown task falls back to ask (fail closed = read-only).
        modeForTask: (taskId) => {
          try {
            return this.getTask(taskId).mode;
          } catch {
            return 'ask';
          }
        },
        planApproved: (taskId) => this.planStatus(taskId).status === 'approved',
        audit: (record) => this.persistToolAudit(record),
        onPermissionPending: (card, context) => {
          this.requestContext.set(card.requestId, context);
          this.onPermissionPending(card);
        },
        onPermissionResolved: (info) => {
          this.requestContext.delete(info.requestId);
          this.onPermissionResolved(info);
        },
        askUser: (prompt, signal) => this.askUser(prompt, signal),
        planGate: () => this.planGate(),
        verificationGate: () => this.verificationGate(),
      },
      logger,
    );
    host.delegate = {
      onAgentEvent: (taskId, runId, event) => this.onAgentEvent(taskId, runId, event),
      onRunEnded: (taskId, runId) => this.onRunEnded(taskId, runId),
      onWorkerCrashed: (taskIds) => this.onWorkerCrashed(taskIds),
      gatewayForTask: (taskId) => this.gatewayForTask(taskId),
      onToolLifecycle: (taskId, call, result) => this.onToolLifecycle(taskId, call, result),
    };
    // ADR-0009: switching the focused editor workspace no longer cancels or
    // rebinds anything — agent contexts are independent mounts.
  }

  // ---------- project contexts (ADR-0009) ----------

  /** The agent context a task executes in: its worktree, or its project root. */
  contextForTask(taskId: string): ProjectContext {
    const row = this.getRow(taskId);
    const worktree = row.worktree_json ? (JSON.parse(row.worktree_json) as TaskWorktree) : null;
    const root = worktree?.path ?? row.project_path;
    return this.contexts.forRoot({
      root,
      wsId: row.workspace_id,
      isGitRepo: existsSync(join(root, '.git')),
    });
  }

  private gatewayForTask(taskId: string): ToolGateway | null {
    try {
      return this.contextForTask(taskId).gateway;
    } catch {
      return null;
    }
  }

  /** Workspace row for a dispatch target path, creating the identity if new. */
  private async workspaceRowForPath(
    path: string,
  ): Promise<{ id: string; canonicalPath: string; displayName: string; isGitRepo: boolean }> {
    const info = await openWorkspaceInfo(path);
    const row = this.db
      .prepare('SELECT id, display_name FROM workspaces WHERE canonical_path = ?')
      .get(info.canonicalPath) as { id: string; display_name: string } | undefined;
    if (row) {
      return {
        id: row.id,
        canonicalPath: info.canonicalPath,
        displayName: row.display_name,
        isGitRepo: info.isGitRepo,
      };
    }
    const id = newId('ws');
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO workspaces (id, canonical_path, display_name, trust_state, last_opened_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, info.canonicalPath, info.displayName, 'untrusted', now, now);
    return {
      id,
      canonicalPath: info.canonicalPath,
      displayName: info.displayName,
      isGitRepo: info.isGitRepo,
    };
  }

  // ---------- permissions (PERM-001..010) ----------

  private cardToDto(card: PermissionRequestCard): PermissionCardDto {
    return {
      requestId: card.requestId,
      callId: card.callId,
      runId: card.runId,
      taskId: card.taskId,
      toolName: card.tool.name,
      toolDescription: card.tool.description,
      reason: null,
      risk: { level: card.risk.level, reasons: card.risk.reasons },
      preview: {
        summary: card.preview.summary,
        ...(card.preview.detail !== undefined ? { detail: card.preview.detail } : {}),
        ...(card.preview.diff !== undefined ? { diff: card.preview.diff } : {}),
        ...(card.preview.command !== undefined ? { command: card.preview.command } : {}),
        ...(card.preview.targets !== undefined ? { targets: card.preview.targets } : {}),
      },
      input: card.input,
      paramsHash: card.paramsHash,
      options: card.options,
      createdAt: card.createdAt,
    };
  }

  private onPermissionPending(card: PermissionRequestCard): void {
    this.recordEvent(card.taskId, 'permission.requested', { card: this.cardToDto(card) });
    this.safeTransition(card.taskId, 'AWAITING_PERMISSION');
  }

  private onPermissionResolved(info: {
    requestId: string;
    taskId: string;
    outcome: 'allowed' | 'denied' | 'cancelled' | 'invalidated';
    scope?: 'once' | 'task' | 'workspace' | 'always';
    actor?: string;
    reason?: string;
    card: PermissionRequestCard;
    pendingLeftForTask: number;
  }): void {
    this.recordEvent(info.taskId, 'permission.decided', {
      requestId: info.requestId,
      outcome: info.outcome,
      scope: info.scope ?? null,
      actor: info.actor ?? null,
      reason: info.reason ?? null,
      toolName: info.card.tool.name,
      risk: info.card.risk.level,
      summary: info.card.preview.summary,
    });
    if (info.pendingLeftForTask === 0) {
      const task = this.getTask(info.taskId);
      if (task.state === 'AWAITING_PERMISSION') this.setState(info.taskId, 'IN_PROGRESS');
    }
  }

  decidePermission(input: {
    requestId: string;
    kind: 'allow' | 'deny';
    scope: 'once' | 'task' | 'workspace' | 'always';
    expectedParamsHash: string;
    reason?: string;
    applyToSimilar?: boolean;
  }): { resolvedRequestIds: string[] } {
    const engine = this.requestContext.get(input.requestId)?.permissions;
    if (!engine) return { resolvedRequestIds: [] };
    return engine.resolve({
      requestId: input.requestId,
      kind: input.kind,
      scope: input.scope,
      expectedParamsHash: input.expectedParamsHash,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.applyToSimilar !== undefined ? { applyToSimilar: input.applyToSimilar } : {}),
      actor: 'user',
    });
  }

  pendingPermissions(taskId: string): {
    permissions: PermissionCardDto[];
    asks: AskUserPromptDto[];
  } {
    let pending: PermissionRequestCard[] = [];
    try {
      pending = this.contextForTask(taskId).permissions.pendingForTask(taskId);
    } catch {
      pending = [];
    }
    return {
      permissions: pending.map((c) => this.cardToDto(c)),
      asks: [...this.pendingAsks.values()].map((a) => a.prompt).filter((p) => p.taskId === taskId),
    };
  }

  // ---------- ask_user gate ----------

  private askUser(prompt: AskUserPrompt, signal: AbortSignal): Promise<string> {
    const dto: AskUserPromptDto = {
      callId: prompt.callId,
      taskId: prompt.taskId,
      runId: prompt.runId,
      question: prompt.question,
      options: prompt.options,
      allowFreeForm: prompt.allowFreeForm,
      createdAt: new Date().toISOString(),
    };
    this.recordEvent(prompt.taskId, 'agent.question', { prompt: dto });
    return new Promise<string>((resolve, reject) => {
      const onAbort = () => {
        this.pendingAsks.delete(prompt.callId);
        reject(
          new ProductFailure(
            productError('CANCELLED', { userMessage: 'The run stopped before an answer arrived.' }),
          ),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingAsks.set(prompt.callId, {
        prompt: dto,
        resolve,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });
      if (signal.aborted) onAbort();
    });
  }

  answerUser(callId: string, answer: string): boolean {
    const entry = this.pendingAsks.get(callId);
    if (!entry) return false;
    this.pendingAsks.delete(callId);
    entry.cleanup();
    this.recordEvent(entry.prompt.taskId, 'user.message', {
      text: answer,
      kind: 'answer',
      callId,
    });
    entry.resolve(answer);
    return true;
  }

  private cancelAllAsks(reason: string): void {
    for (const [callId, entry] of [...this.pendingAsks]) {
      this.pendingAsks.delete(callId);
      entry.cleanup();
      // Resolving with a cancellation marker unblocks the tool executor; the
      // run that owned it is being torn down anyway.
      entry.resolve(`(no answer: ${reason})`);
      this.logger.info('ask_user cancelled', { callId, reason });
    }
  }

  get projectContexts(): ProjectContexts {
    return this.contexts;
  }

  // ---------- plan approval flow (M8-01, AG-007/008, §13.2) ----------

  private planGate(): PlanGate {
    return {
      propose: (input, signal) => this.proposePlan(input, signal),
      update: (input) => this.updatePlanStatuses(input),
    };
  }

  /** Current plan projection for a task; rebuilt from the event log when cold. */
  private planStatus(taskId: string): {
    plan: TaskPlan | null;
    status: 'none' | 'awaiting' | 'approved' | 'rejected';
    version: number;
  } {
    const cached = this.planRecords.get(taskId);
    if (cached) return cached;
    const rows = this.db
      .prepare(
        "SELECT type, payload_json FROM task_events WHERE task_id = ? AND type IN ('agent.planProposed','agent.planUpdated','user.planEdited','user.planDecision') ORDER BY sequence",
      )
      .all(taskId) as Array<{ type: string; payload_json: string }>;
    let plan: TaskPlan | null = null;
    let status: 'none' | 'awaiting' | 'approved' | 'rejected' = 'none';
    let version = 0;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as { plan?: TaskPlan; decision?: string };
      switch (row.type) {
        case 'agent.planProposed':
          plan = payload.plan ?? plan;
          status = 'awaiting';
          break;
        case 'agent.planUpdated':
        case 'user.planEdited':
          plan = payload.plan ?? plan;
          break;
        case 'user.planDecision':
          status = payload.decision === 'approved' ? 'approved' : 'rejected';
          break;
      }
      if (plan) version = Math.max(version, plan.version);
    }
    const record = { plan, status, version };
    this.planRecords.set(taskId, record);
    return record;
  }

  private async proposePlan(
    input: { taskId: string; runId: string; callId: string; plan: ProposedPlanInput },
    signal: AbortSignal,
  ): Promise<
    | { decision: 'approved' | 'edited'; plan: TaskPlan }
    | { decision: 'changes_requested'; plan: TaskPlan; feedback: string }
  > {
    const task = this.getTask(input.taskId);
    const version = this.planStatus(input.taskId).version + 1;
    const plan = normalizeProposedPlan(input.plan, version);
    this.recordEvent(input.taskId, 'agent.planProposed', { plan, callId: input.callId });

    if (task.mode === 'auto') {
      // §5.2/§19.3 default: Auto approves the plan automatically and keeps going.
      this.planRecords.set(input.taskId, { plan, status: 'approved', version });
      this.recordEvent(input.taskId, 'user.planDecision', {
        decision: 'approved',
        auto: true,
        edited: false,
        version,
      });
      this.hopStates(input.taskId, ['PLANNING', 'IN_PROGRESS']);
      return { decision: 'approved', plan };
    }

    this.planRecords.set(input.taskId, { plan, status: 'awaiting', version });
    this.hopStates(input.taskId, ['PLANNING', 'AWAITING_PLAN_APPROVAL']);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.planWaiters.delete(input.taskId);
        const record = this.planStatus(input.taskId);
        this.planRecords.set(input.taskId, { ...record, status: 'none' });
        reject(
          new ProductFailure(
            productError('CANCELLED', {
              userMessage: 'The run stopped before the plan was decided.',
            }),
          ),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.planWaiters.set(input.taskId, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });
      if (signal.aborted) onAbort();
    });
  }

  /** User decision on a proposed plan (IPC task.planDecision). */
  decidePlan(input: {
    taskId: string;
    decision: 'approve' | 'reject' | 'request_changes';
    editedPlan?: PlanEditDto;
    reason?: string;
    confirmRemovedDone?: boolean;
  }): TaskDto {
    const record = this.planStatus(input.taskId);
    if (record.status !== 'awaiting' || !record.plan) {
      throw new ProductFailure(
        productError('PLAN_NOT_AWAITING', {
          userMessage: 'This task has no plan waiting for a decision.',
        }),
      );
    }
    const task = this.getTask(input.taskId);

    if (input.decision === 'request_changes') {
      // ADR-0009: the composer is the "Request changes" control — the blocked
      // propose_plan resolves with the feedback and the model revises (v+1).
      const feedback = (input.reason ?? '').trim() || 'Please revise the plan.';
      this.planRecords.set(input.taskId, {
        plan: record.plan,
        status: 'none',
        version: record.version,
      });
      this.recordEvent(input.taskId, 'user.planDecision', {
        decision: 'changes_requested',
        auto: false,
        edited: false,
        reason: feedback,
        version: record.version,
      });
      const waiter = this.planWaiters.get(input.taskId);
      if (waiter) {
        this.planWaiters.delete(input.taskId);
        waiter.cleanup();
        waiter.resolve({ decision: 'changes_requested', plan: record.plan, feedback });
      }
      if (task.state === 'AWAITING_PLAN_APPROVAL') this.setState(input.taskId, 'IN_PROGRESS');
      return this.getTask(input.taskId);
    }

    if (input.decision === 'approve') {
      let finalPlan = record.plan;
      let edited = false;
      if (input.editedPlan) {
        const result = applyPlanEdit(record.plan, input.editedPlan, record.version + 1);
        if (result.removedDone.length > 0 && !input.confirmRemovedDone) {
          throw new ProductFailure(
            productError('PLAN_EDIT_REMOVES_DONE', {
              userMessage:
                'This edit removes steps that are already done. Confirm the removal to proceed.',
              context: { removed: result.removedDone.map((s) => s.title) },
              retryable: true,
            }),
          );
        }
        if (result.changed) {
          finalPlan = result.plan;
          edited = true;
          this.recordEvent(input.taskId, 'user.planEdited', {
            plan: finalPlan,
            version: finalPlan.version,
          });
        }
      }
      this.planRecords.set(input.taskId, {
        plan: finalPlan,
        status: 'approved',
        version: finalPlan.version,
      });
      this.recordEvent(input.taskId, 'user.planDecision', {
        decision: 'approved',
        auto: false,
        edited,
        version: finalPlan.version,
      });
      if (task.state === 'AWAITING_PLAN_APPROVAL') this.setState(input.taskId, 'IN_PROGRESS');
      const waiter = this.planWaiters.get(input.taskId);
      if (waiter) {
        this.planWaiters.delete(input.taskId);
        waiter.cleanup();
        waiter.resolve({ decision: edited ? 'edited' : 'approved', plan: finalPlan });
      }
      return this.getTask(input.taskId);
    }

    // Reject: §6.1 AWAITING_PLAN_APPROVAL → CANCELLED; the run is aborted.
    this.planRecords.set(input.taskId, {
      plan: record.plan,
      status: 'rejected',
      version: record.version,
    });
    this.recordEvent(input.taskId, 'user.planDecision', {
      decision: 'rejected',
      auto: false,
      edited: false,
      reason: input.reason ?? null,
      version: record.version,
    });
    const waiter = this.planWaiters.get(input.taskId);
    if (waiter) {
      this.planWaiters.delete(input.taskId);
      waiter.cleanup();
      waiter.reject(
        new ProductFailure(
          productError('PLAN_REJECTED', {
            userMessage: input.reason
              ? `The user rejected the plan: ${input.reason}`
              : 'The user rejected the plan; the task was cancelled.',
          }),
        ),
      );
    }
    if (task.state === 'AWAITING_PLAN_APPROVAL') this.setState(input.taskId, 'CANCELLED');
    const runId = this.runsByTask.get(input.taskId) ?? this.host.activeRunForTask(input.taskId);
    if (runId) this.host.abort(runId, 'user_stop');
    return this.getTask(input.taskId);
  }

  private async updatePlanStatuses(input: {
    taskId: string;
    updates: PlanStepUpdate[];
    note?: string;
  }): Promise<TaskPlan> {
    const record = this.planStatus(input.taskId);
    if (record.status !== 'approved' || !record.plan) {
      throw new ProductFailure(
        productError('PLAN_NOT_APPROVED', {
          userMessage: 'There is no approved plan to update — propose a plan first.',
          retryable: true,
        }),
      );
    }
    const { plan, delta } = applyStatusUpdates(record.plan, input.updates, record.version + 1);
    if (delta.length > 0) {
      this.planRecords.set(input.taskId, { plan, status: 'approved', version: plan.version });
      this.recordEvent(input.taskId, 'agent.planUpdated', {
        plan,
        delta,
        note: input.note ?? null,
      });
    }
    return plan;
  }

  private cancelAllPlanWaits(reason: string): void {
    for (const [taskId, waiter] of [...this.planWaiters]) {
      this.planWaiters.delete(taskId);
      waiter.cleanup();
      waiter.reject(
        new ProductFailure(
          productError('CANCELLED', { userMessage: `Plan approval cancelled: ${reason}` }),
        ),
      );
    }
  }

  /** Walk through legal intermediate states, ignoring hops that do not apply. */
  private hopStates(taskId: string, states: TaskState[]): void {
    for (const state of states) {
      try {
        this.setState(taskId, state);
      } catch (e) {
        this.logger.warn('state hop skipped', {
          taskId,
          to: state,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // ---------- review projection and decisions (M8-05, CHG-005/007/008) ----------

  /** Net change set with hunks and review-state projection for the Review page. */
  async changeSetForReview(taskId: string): Promise<ChangeSetDto> {
    const changes = this.contextForTask(taskId).changes;
    const cs = await changes.changeSet(taskId);
    const decisions = this.reviewDecisions(taskId);
    const files: ChangeSetFileDto[] = cs.files.map((file) => {
      const fileDecision = decisions.files.get(file.path);
      const hunkDecisions = decisions.hunks.get(file.path);
      const hunks = parseHunks(file.diff).map((hunk) => ({
        key: hunk.key,
        header: hunk.header,
        lines: hunk.lines,
        state: (hunkDecisions?.get(hunk.key) ??
          (fileDecision === 'accepted' ? 'accepted' : 'pending')) as
          'pending' | 'accepted' | 'rejected',
      }));
      const anyHunkDecided = hunks.some((h) => h.state !== 'pending');
      const allAccepted =
        hunks.length > 0 ? hunks.every((h) => h.state === 'accepted') : fileDecision === 'accepted';
      const reviewState: ChangeSetFileDto['reviewState'] =
        fileDecision === 'accepted' || allAccepted
          ? 'accepted'
          : anyHunkDecided
            ? 'partial'
            : 'pending';
      return {
        path: file.path,
        status: file.status,
        renamedFrom: file.renamedFrom,
        binary: file.binary,
        additions: file.additions,
        deletions: file.deletions,
        currentHash: file.currentHash,
        reviewState,
        hunks,
      };
    });
    return {
      taskId,
      files,
      totalAdditions: cs.totalAdditions,
      totalDeletions: cs.totalDeletions,
    };
  }

  private reviewDecisions(taskId: string): {
    files: Map<string, 'accepted' | 'rejected'>;
    hunks: Map<string, Map<string, 'accepted' | 'rejected'>>;
  } {
    const rows = this.db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'review.decision' ORDER BY sequence",
      )
      .all(taskId) as Array<{ payload_json: string }>;
    const files = new Map<string, 'accepted' | 'rejected'>();
    const hunks = new Map<string, Map<string, 'accepted' | 'rejected'>>();
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as {
        path: string;
        scope: 'file' | 'hunk';
        decision: 'accept' | 'reject';
        hunkKey: string | null;
      };
      const state = payload.decision === 'accept' ? 'accepted' : 'rejected';
      if (payload.scope === 'file') {
        files.set(payload.path, state);
      } else if (payload.hunkKey) {
        const perFile = hunks.get(payload.path) ?? new Map<string, 'accepted' | 'rejected'>();
        perFile.set(payload.hunkKey, state);
        hunks.set(payload.path, perFile);
      }
    }
    return { files, hunks };
  }

  /** Apply a review decision. Rejects mutate the working tree via the ChangeService. */
  async applyReviewDecision(input: {
    taskId: string;
    path: string;
    scope: 'file' | 'hunk';
    decision: 'accept' | 'reject';
    hunkKey?: string;
    expectedCurrentHash?: string;
  }): Promise<{ status: 'applied' | 'stale'; changeSet: ChangeSetDto }> {
    const task = this.getTask(input.taskId);
    if (task.state !== 'REVIEW_READY') {
      throw new ProductFailure(
        productError('REVIEW_NOT_READY', {
          userMessage: `Review decisions are only possible in REVIEW_READY (current: ${task.state}).`,
        }),
      );
    }
    const changes = this.contextForTask(input.taskId).changes;
    if (input.decision === 'reject') {
      try {
        if (input.scope === 'hunk') {
          if (!input.hunkKey || !input.expectedCurrentHash) {
            throw new ProductFailure(
              productError('REVIEW_BAD_REQUEST', {
                userMessage: 'Rejecting a hunk requires the hunk key and the current file hash.',
              }),
            );
          }
          await changes.rejectHunk(input.taskId, null, {
            path: input.path,
            hunkKey: input.hunkKey,
            expectedCurrentHash: input.expectedCurrentHash,
          });
        } else {
          await changes.revertFile(input.taskId, null, {
            path: input.path,
            ...(input.expectedCurrentHash !== undefined
              ? { expectedCurrentHash: input.expectedCurrentHash }
              : {}),
          });
        }
      } catch (e) {
        if (e instanceof ProductFailure && e.error.code === 'CHG_REVIEW_STALE') {
          return { status: 'stale', changeSet: await this.changeSetForReview(input.taskId) };
        }
        throw e;
      }
    }
    this.recordEvent(input.taskId, 'review.decision', {
      path: input.path,
      scope: input.scope,
      decision: input.decision,
      hunkKey: input.hunkKey ?? null,
    });
    return { status: 'applied', changeSet: await this.changeSetForReview(input.taskId) };
  }

  /** REVIEW_READY → ACCEPTED (user accepts the workspace state; not a git commit).
   * Worktree tasks merge their net change set back into the main tree first
   * (ADR-0009); conflicts stop the accept unless explicitly confirmed. */
  async acceptTask(
    taskId: string,
    options: { confirmUnverified?: boolean; confirmConflicts?: boolean } = {},
  ): Promise<{
    task: TaskDto;
    status: 'accepted' | 'conflicts';
    conflicts?: Array<{ path: string; reason: string }>;
  }> {
    const task = this.getTask(taskId);
    if (task.state !== 'REVIEW_READY') {
      throw new ProductFailure(
        productError('TASK_NOT_REVIEWABLE', {
          userMessage: `Only a task in REVIEW_READY can be accepted (current: ${task.state}).`,
        }),
      );
    }
    const context = this.contextForTask(taskId);
    // VER-007/E2E-018: accepting real changes without any verification needs a
    // second, explicit confirmation.
    const verificationRuns = context.verifications.listForTask(taskId);
    if (verificationRuns.length === 0 && task.mode !== 'ask' && !options.confirmUnverified) {
      const changed = await context.changes.changeSet(taskId);
      if (changed.files.length > 0) {
        throw new ProductFailure(
          productError('ACCEPT_NEEDS_CONFIRM', {
            userMessage:
              'No verification was run for this task. Confirm explicitly to accept unverified changes.',
            retryable: true,
          }),
        );
      }
    }

    // ADR-0009: merge the worktree's net changes back into the main tree.
    if (task.worktree) {
      const mainRoot = task.projectPath;
      const cs = await context.changes.changeSet(taskId);
      if (cs.files.length > 0) {
        const conflicts = await this.worktrees.mergeBackPreflight(mainRoot, cs);
        if (conflicts.length > 0 && !options.confirmConflicts) {
          this.recordEvent(taskId, 'merge.blocked', { conflicts });
          return { task: this.getTask(taskId), status: 'conflicts', conflicts };
        }
        const { merged } = await this.worktrees.mergeBack(mainRoot, context.root, cs);
        this.recordEvent(taskId, 'task.mergedBack', {
          files: merged,
          branch: task.worktree.branch,
          conflictsOverridden: conflicts.map((c) => c.path),
        });
      }
      await this.worktrees.discard(mainRoot, task.worktree as TaskWorktree);
      this.contexts.drop(context.root);
    }

    // §6.1: ACCEPTED requires a final report; it is recorded when the run completes.
    const hasReport = this.db
      .prepare("SELECT id FROM task_events WHERE task_id = ? AND type = 'report.final' LIMIT 1")
      .get(taskId) as { id: string } | undefined;
    if (!hasReport) {
      this.recordEvent(
        taskId,
        'report.final',
        await this.buildFinalReportData(taskId, null, 'completed'),
      );
    }
    this.recordEvent(taskId, 'task.accepted', {
      at: new Date().toISOString(),
      unverifiedConfirmed: verificationRuns.length === 0 && options.confirmUnverified === true,
    });
    return { task: this.setState(taskId, 'ACCEPTED'), status: 'accepted' };
  }

  /** Full rollback with preflight (CHG-009/010, M9-04). Conflicts stop; force overrides explicitly. */
  async rollbackTask(
    taskId: string,
    options: { force?: boolean } = {},
  ): Promise<
    | { status: 'ok'; task: TaskDto; restored: string[] }
    | { status: 'conflicts'; task: TaskDto; conflicts: Array<{ path: string; reason: string }> }
  > {
    const task = this.getTask(taskId);
    if (!['REVIEW_READY', 'INTERRUPTED', 'FAILED'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_ROLLBACKABLE', {
          userMessage: `The task cannot be rolled back from state ${task.state}.`,
        }),
      );
    }
    // ADR-0009: a worktree task never touched the main tree — rollback is
    // simply discarding the worktree (byte-exact by construction).
    if (task.worktree) {
      const context = this.contextForTask(taskId);
      await this.worktrees.discard(task.projectPath, task.worktree as TaskWorktree);
      this.contexts.drop(context.root);
      this.recordEvent(taskId, 'task.rolledBack', {
        ok: true,
        restored: [],
        discardedWorktree: true,
        conflictsOverridden: [],
        failed: [],
      });
      return {
        status: 'ok',
        task: this.setState(taskId, 'ROLLED_BACK'),
        restored: [],
      };
    }
    const changes = this.contextForTask(taskId).changes;
    const preflight = await changes.rollbackPreflight(taskId);
    if (preflight.conflicts.length > 0 && !options.force) {
      this.recordEvent(taskId, 'rollback.blocked', {
        conflicts: preflight.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
      });
      return {
        status: 'conflicts',
        task: this.getTask(taskId),
        conflicts: preflight.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
      };
    }
    const report = await changes.rollback(taskId, { force: options.force ?? false });
    this.recordEvent(taskId, 'task.rolledBack', {
      ok: report.ok,
      restored: report.restored,
      conflictsOverridden: report.conflictsOverridden,
      failed: report.verified.filter((v) => !v.ok),
    });
    if (!report.ok) {
      throw new ProductFailure(
        productError('CHG_ROLLBACK_INCOMPLETE', {
          userMessage:
            'Some files could not be restored; snapshots are kept for manual recovery. See the timeline for details.',
          context: { failed: report.verified.filter((v) => !v.ok) },
        }),
      );
    }
    return { status: 'ok', task: this.setState(taskId, 'ROLLED_BACK'), restored: report.restored };
  }

  // ---------- verification (M9-01/02, VER-001..010) ----------

  private verificationGate(): VerificationGate {
    return {
      run: async (input, signal) => {
        const runs = await this.runVerifications(input.taskId, {
          ...(input.label !== undefined ? { label: input.label } : {}),
          initiator: 'agent',
          signal,
        });
        return {
          configured: runs !== null,
          runs: (runs ?? []).map((r) => ({
            id: r.id,
            label: r.label,
            state: r.state,
            exitCode: r.exitCode,
            outputExcerpt: r.outputExcerpt.slice(0, 800),
          })),
        };
      },
    };
  }

  /** Fingerprint of the task's current net change set (VER-008 stale detection). */
  private async codeRevision(taskId: string): Promise<string | null> {
    try {
      const changes = this.contextForTask(taskId).changes;
      const cs = await changes.changeSet(taskId);
      const shape = cs.files.map((f) => [f.path, f.currentHash]);
      return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 24);
    } catch {
      return null;
    }
  }

  /** Run configured verification commands; null = none configured (VER-001/010). */
  async runVerifications(
    taskId: string,
    options: { label?: string; initiator: 'agent' | 'user'; signal?: AbortSignal },
  ): Promise<VerificationRunRecord[] | null> {
    const service = this.contextForTask(taskId).verifications;
    const task = this.getTask(taskId);
    const commands = (task.verification as VerCommand[]).filter(
      (c) => !options.label || c.label === options.label,
    );
    if (commands.length === 0) return null;

    const startState = task.state;
    // §6.1: VERIFYING is entered from IN_PROGRESS; a user re-run from
    // REVIEW_READY hops through IN_PROGRESS and returns to REVIEW_READY.
    if (startState === 'REVIEW_READY') this.setState(taskId, 'IN_PROGRESS');
    if (this.getTask(taskId).state === 'IN_PROGRESS') this.setState(taskId, 'VERIFYING');

    const results: VerificationRunRecord[] = [];
    try {
      const revision = await this.codeRevision(taskId);
      for (const command of commands) {
        this.recordEvent(taskId, 'verification.started', {
          label: command.label,
          initiator: options.initiator,
        });
        const run = await service.run({
          taskId,
          command,
          codeRevision: revision,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        results.push(run);
        this.recordEvent(taskId, 'verification.completed', { run: this.verificationDto(run) });
      }
    } finally {
      const current = this.getTask(taskId).state;
      if (current === 'VERIFYING') {
        this.setState(taskId, startState === 'REVIEW_READY' ? 'REVIEW_READY' : 'IN_PROGRESS');
      }
    }
    return results;
  }

  private verificationDto(run: VerificationRunRecord): Record<string, unknown> {
    return {
      id: run.id,
      label: run.label,
      state: run.state,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      cancelled: run.cancelled,
      stale: run.stale,
      superseded: run.supersededBy !== null,
      outputExcerpt: run.outputExcerpt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
  }

  verificationRuns(taskId: string): Array<Record<string, unknown>> {
    try {
      return this.contextForTask(taskId)
        .verifications.listForTask(taskId)
        .map((r) => this.verificationDto(r));
    } catch {
      return [];
    }
  }

  /** Suggestions for the composer — based on the focused (dispatch-target) project. */
  async suggestVerifications(): Promise<VerCommand[]> {
    const ws = this.workspace.current;
    if (!ws) return [];
    const context = this.contexts.forRoot({
      root: ws.canonicalPath,
      wsId: ws.id,
      isGitRepo: ws.isGitRepo,
    });
    return context.verifications.detectSuggestions();
  }

  // ---------- persistence helpers ----------

  private rowToDto(row: TaskRow): TaskDto {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      title: row.title,
      goalMd: row.goal_md,
      acceptance: JSON.parse(row.acceptance_json) as string[],
      mode: row.mode as AgentMode,
      state: row.state as TaskDto['state'],
      model: JSON.parse(row.model_json) as ModelRef,
      verification: JSON.parse(row.verification_json) as VerificationCommand[],
      archived: row.archived === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      gitBaseline: row.git_baseline_json
        ? (JSON.parse(row.git_baseline_json) as { head: string | null; branch: string | null })
        : null,
      projectName: row.project_name,
      projectPath: row.project_path,
      changedFiles: row.changed_files,
      worktree: row.worktree_json ? (JSON.parse(row.worktree_json) as TaskWorktree) : null,
    };
  }

  private getRow(taskId: string): TaskRow {
    const row = this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as TaskRow | undefined;
    if (!row) {
      throw new ProductFailure(
        productError('TASK_NOT_FOUND', { userMessage: 'The task no longer exists.' }),
      );
    }
    return row;
  }

  getTask(taskId: string): TaskDto {
    return this.rowToDto(this.getRow(taskId));
  }

  listTasks(
    filter: 'all' | 'active' | 'review' | 'done' | 'failed',
    includeArchived: boolean,
    scope: 'workspace' | 'all' = 'workspace',
  ): TaskDto[] {
    const ws = this.workspace.current;
    if (scope === 'workspace' && !ws) return [];
    const rows = (scope === 'all'
      ? this.db.prepare(`${TASK_SELECT} ORDER BY t.updated_at DESC LIMIT 300`).all()
      : this.db
          .prepare(`${TASK_SELECT} WHERE t.workspace_id = ? ORDER BY t.updated_at DESC LIMIT 300`)
          .all(ws!.id)) as unknown as TaskRow[];
    return rows
      .map((r) => this.rowToDto(r))
      .filter((t) => includeArchived || !t.archived)
      .filter((t) => {
        switch (filter) {
          case 'active':
            return (
              isRunningState(t.state as TaskState) ||
              t.state === 'READY' ||
              t.state === 'AWAITING_PLAN_APPROVAL'
            );
          case 'review':
            return t.state === 'REVIEW_READY';
          case 'done':
            return t.state === 'ACCEPTED' || t.state === 'ROLLED_BACK' || t.state === 'ARCHIVED';
          case 'failed':
            return t.state === 'FAILED' || t.state === 'INTERRUPTED' || t.state === 'CANCELLED';
          default:
            return true;
        }
      });
  }

  /**
   * Activity stream (ADR-0006): projection of the persisted event log,
   * enriched with tool durations and per-change diffstats. Read-only; used by
   * the mission-control dashboard (tail) and by session replay (full).
   */
  activity(taskId: string, tail?: number): { items: ActivityItem[]; total: number } {
    const rows = this.db
      .prepare(
        'SELECT id, sequence, type, schema_version, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY sequence LIMIT 5000',
      )
      .all(taskId) as Array<{
      id: string;
      sequence: number;
      type: string;
      schema_version: number;
      payload_json: string;
      created_at: string;
    }>;
    const events: TimelineEventDto[] = rows.map((row) => ({
      id: row.id,
      taskId,
      sequence: row.sequence,
      type: row.type,
      schemaVersion: row.schema_version,
      at: row.created_at,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
    const items = projectActivity(events);

    const calls = this.db
      .prepare('SELECT id, started_at, ended_at FROM tool_calls WHERE task_id = ?')
      .all(taskId) as Array<{ id: string; started_at: string | null; ended_at: string | null }>;
    const durationByCall = new Map<string, number | null>(
      calls.map((c) => [
        c.id,
        c.started_at && c.ended_at ? Date.parse(c.ended_at) - Date.parse(c.started_at) : null,
      ]),
    );
    const changes = this.db
      .prepare(
        'SELECT id, tool_call_id, relative_path, patch FROM file_changes WHERE task_id = ? ORDER BY created_at, id',
      )
      .all(taskId) as Array<{
      id: string;
      tool_call_id: string | null;
      relative_path: string;
      patch: string | null;
    }>;
    const changesByCall = new Map<string, typeof changes>();
    for (const change of changes) {
      if (!change.tool_call_id) continue;
      const list = changesByCall.get(change.tool_call_id) ?? [];
      list.push(change);
      changesByCall.set(change.tool_call_id, list);
    }

    for (const item of items) {
      if (!item.callId) continue;
      const duration = durationByCall.get(item.callId);
      if (duration !== undefined) item.durationMs = duration;
      const linked = changesByCall.get(item.callId);
      if (linked && linked.length > 0) {
        item.changeIds = linked.map((c) => c.id);
        let additions = 0;
        let deletions = 0;
        for (const change of linked) {
          const stats = countPatchLines(change.patch);
          additions += stats.additions;
          deletions += stats.deletions;
          if (!item.paths.includes(change.relative_path)) item.paths.push(change.relative_path);
        }
        item.diffstat = { additions, deletions };
      }
    }
    return { items: tail && tail < items.length ? items.slice(-tail) : items, total: items.length };
  }

  /** One recorded change (stored patch text) for the replay diff pane. */
  changeRecord(
    taskId: string,
    changeId: string,
  ): {
    id: string;
    taskId: string;
    path: string;
    kind: 'created' | 'modified' | 'deleted' | 'renamed';
    beforeHash: string | null;
    afterHash: string | null;
    patch: string | null;
    renameTo: string | null;
    author: 'agent' | 'user' | 'system';
    toolCallId: string | null;
    createdAt: string;
  } | null {
    const row = this.db
      .prepare(
        'SELECT id, relative_path, kind, before_hash, after_hash, patch, rename_to, author, tool_call_id, created_at FROM file_changes WHERE id = ? AND task_id = ?',
      )
      .get(changeId, taskId) as
      | {
          id: string;
          relative_path: string;
          kind: string;
          before_hash: string | null;
          after_hash: string | null;
          patch: string | null;
          rename_to: string | null;
          author: string;
          tool_call_id: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      taskId,
      path: row.relative_path,
      kind: row.kind as 'created' | 'modified' | 'deleted' | 'renamed',
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      patch: row.patch,
      renameTo: row.rename_to,
      author: row.author as 'agent' | 'user' | 'system',
      toolCallId: row.tool_call_id,
      createdAt: row.created_at,
    };
  }

  timeline(taskId: string, afterSequence: number): TimelineEventDto[] {
    const rows = this.db
      .prepare(
        'SELECT id, sequence, type, schema_version, payload_json, created_at FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000',
      )
      .all(taskId, afterSequence) as Array<{
      id: string;
      sequence: number;
      type: string;
      schema_version: number;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId,
      sequence: row.sequence,
      type: row.type,
      schemaVersion: row.schema_version,
      at: row.created_at,
      payload: JSON.parse(row.payload_json) as unknown,
    }));
  }

  /** Append an immutable task event and broadcast it (HIST-001/REL-004). */
  recordEvent(taskId: string, type: string, payload: unknown): TimelineEventDto {
    this.seedSequence(taskId);
    const sequence = this.sequences.next(`task:${taskId}`);
    const event: TimelineEventDto = {
      id: newId('evt'),
      taskId,
      sequence,
      type,
      schemaVersion: 1,
      at: new Date().toISOString(),
      payload,
    };
    this.db
      .prepare(
        'INSERT INTO task_events (id, task_id, sequence, type, schema_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(event.id, taskId, sequence, type, 1, JSON.stringify(payload ?? null), event.at);
    broadcast('task.event', { taskId, event });
    return event;
  }

  private seedSequence(taskId: string): void {
    const key = `task:${taskId}`;
    if (this.sequences.current(key) === 0) {
      const row = this.db
        .prepare('SELECT MAX(sequence) as maxSeq FROM task_events WHERE task_id = ?')
        .get(taskId) as { maxSeq: number | null };
      if (row.maxSeq) this.sequences.seed(key, row.maxSeq);
    }
  }

  private setState(taskId: string, to: TaskState, context?: Record<string, unknown>): TaskDto {
    const row = this.getRow(taskId);
    const from = row.state as TaskState;
    if (from === to) return this.rowToDto(row);
    assertTransition(from, to);
    this.db
      .prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?')
      .run(to, new Date().toISOString(), taskId);
    this.recordEvent(taskId, 'task.stateChanged', { from, to, ...context });
    broadcast('task.stateChanged', { taskId, state: to });
    const changedFiles = (
      this.db.prepare('SELECT changed_files FROM tasks WHERE id = ?').get(taskId) as
        { changed_files: number | null } | undefined
    )?.changed_files;
    for (const listener of this.stateChangeListeners) {
      try {
        listener({ taskId, from, to, title: row.title, changedFiles: changedFiles ?? null });
      } catch (e) {
        this.logger.warn('state listener failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return this.getTask(taskId);
  }

  /** Observe task state transitions (edge-triggered; used by notifications). */
  onStateChanged(
    listener: (info: {
      taskId: string;
      from: TaskState;
      to: TaskState;
      title: string;
      changedFiles: number | null;
    }) => void,
  ): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  // ---------- lifecycle ----------

  async createTask(input: CreateTaskInput): Promise<TaskDto> {
    // ADR-0009: dispatch target — explicit projectPath, else the focused workspace.
    const project = input.projectPath
      ? await this.workspaceRowForPath(input.projectPath)
      : (() => {
          const ws = this.workspace.mustActive();
          return {
            id: ws.id,
            canonicalPath: ws.canonicalPath,
            displayName: ws.displayName,
            isGitRepo: ws.isGitRepo,
          };
        })();
    const now = new Date().toISOString();
    const id = newId('task');

    // ADR-0009: isolated worktree for same-project parallel tasks.
    let worktree: TaskWorktree | null = null;
    if (input.isolation === 'worktree') {
      worktree = await this.worktrees.create(project.canonicalPath, project.id, id);
    }

    const rootForBaseline = worktree?.path ?? project.canonicalPath;
    let gitBaseline: { head: string | null; branch: string | null } | null = null;
    if (project.isGitRepo) {
      try {
        gitBaseline = await new GitService(rootForBaseline).headInfo();
      } catch {
        gitBaseline = null;
      }
    }
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, goal_md, acceptance_json, mode, state, model_json, verification_json, git_baseline_json, worktree_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project.id,
        input.title,
        input.goalMd,
        JSON.stringify(input.acceptance),
        input.mode,
        JSON.stringify(input.model),
        JSON.stringify(input.verification),
        gitBaseline ? JSON.stringify(gitBaseline) : null,
        worktree ? JSON.stringify(worktree) : null,
        now,
        now,
      );
    this.recordEvent(id, 'task.created', {
      title: input.title,
      mode: input.mode,
      model: input.model,
      acceptance: input.acceptance,
      gitBaseline,
      project: { name: project.displayName, path: project.canonicalPath },
      worktree,
    });
    this.logger.info('task created', {
      id,
      mode: input.mode,
      project: project.canonicalPath,
      worktree: worktree?.branch ?? null,
    });
    return this.getTask(id);
  }

  private runtimeKind(): RuntimeKind {
    if (process.env.PI_IDE_FORCE_MOCK === '1') return 'mock';
    const settings = this.settings.effective;
    if (settings.models.useMockRuntime) return 'mock';
    return 'pi';
  }

  /** Concurrency cap from settings (ADR-0006); 1 restores the original TASK-004 behavior. */
  private runCapacity(): number {
    const configured = this.settings.effective.agent.maxConcurrentRuns;
    return Math.max(1, Math.min(8, configured ?? 3));
  }

  /**
   * TASK-004 (as amended by ADR-0006): up to maxConcurrentRuns active runs;
   * additional starts queue FIFO and drain as slots free up.
   */
  async startTask(taskId: string, prompt?: string): Promise<{ task: TaskDto; queued: boolean }> {
    const task = this.getTask(taskId);
    if (!['READY', 'INTERRUPTED', 'REVIEW_READY', 'FAILED'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_STARTABLE', {
          userMessage: `The task cannot start from state ${task.state}.`,
        }),
      );
    }
    if (this.host.activeRunCount() + this.launching >= this.runCapacity()) {
      this.startQueue.push({ taskId, prompt });
      this.recordEvent(taskId, 'task.queued', { reason: 'all agent slots are busy' });
      return { task, queued: true };
    }
    await this.launch(taskId, prompt);
    return { task: this.getTask(taskId), queued: false };
  }

  /** Launches admitted but not yet registered with the host (capacity accounting). */
  private launching = 0;

  private async launch(taskId: string, prompt?: string): Promise<void> {
    this.launching += 1;
    try {
      await this.doLaunch(taskId, prompt);
    } finally {
      this.launching -= 1;
    }
  }

  private async doLaunch(taskId: string, prompt?: string): Promise<void> {
    const task = this.getTask(taskId);
    // ADR-0009: the task executes against its own mounted context — its
    // worktree or its project root — independent of the focused workspace.
    const context = this.contextForTask(taskId);
    const kind = this.runtimeKind();
    const model: ModelRef =
      kind === 'mock' ? { providerId: 'mock', modelId: 'mock-1' } : task.model;

    await this.host.ensure(kind);

    // Session: reuse existing ref when possible.
    let ref = this.sessionRefs.get(taskId);
    if (!ref) {
      const sessionInput: CreateSessionInput = {
        taskId,
        workspaceRoot: context.root,
        mode: task.mode,
        model,
        tools: context.gateway.catalog(task.mode),
        systemPreamble: this.buildPreamble(task, context.root),
      };
      ref = await this.host.createSession(sessionInput);
      this.sessionRefs.set(taskId, ref);
      this.db
        .prepare(
          'INSERT INTO agent_sessions (id, task_id, runtime, runtime_version, external_session_id, external_session_file, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          ref.sessionId,
          taskId,
          ref.runtimeId,
          'locked',
          ref.externalSessionId ?? null,
          ref.externalSessionFile ?? null,
          new Date().toISOString(),
        );
    }

    const runId = newId('run');
    this.runsByTask.set(taskId, runId);
    this.db
      .prepare(
        "INSERT INTO agent_runs (id, task_id, session_id, state, provider, model, thinking_level, started_at) VALUES (?, ?, ?, 'STARTING', ?, ?, ?, ?)",
      )
      .run(
        runId,
        taskId,
        ref.sessionId,
        model.providerId,
        model.modelId,
        model.thinkingLevel ?? null,
        new Date().toISOString(),
      );

    const userText = prompt ?? this.initialPrompt(task);
    this.recordEvent(taskId, 'user.message', { text: userText });
    this.setState(taskId, task.state === 'READY' ? 'EXPLORING' : 'IN_PROGRESS');

    this.host.startRun(taskId, {
      sessionRef: ref,
      runId,
      prompt: userText,
    });
  }

  private initialPrompt(task: TaskDto): string {
    const acceptance =
      task.acceptance.length > 0
        ? `\n\nAcceptance criteria:\n${task.acceptance.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
        : '\n\n(No acceptance criteria were provided.)';
    return `${task.goalMd}${acceptance}`;
  }

  private buildPreamble(task: TaskDto, root: string): string {
    const modeRules =
      task.mode === 'ask'
        ? 'You are in ASK mode: strictly read-only. You cannot modify files or run commands; if asked to, explain what you WOULD change instead.'
        : task.mode === 'edit'
          ? 'You are in EDIT mode: workspace writes and commands require user approval — a denied permission is final for that call; adapt instead of retrying it verbatim.'
          : 'You are in AUTO mode: recognized low-risk actions run automatically; higher-risk actions pause for user approval. A denial is final for that call.';
    const planRule =
      task.mode === 'ask'
        ? null
        : 'Before your FIRST file modification, call propose_plan with your step-by-step plan and wait for the decision. The user may edit the plan or request changes — follow the version returned in the tool result, and keep step statuses current with update_plan.';
    return [
      // PIVOT-008/ADR-0009: product identity — internal harness/vendor names
      // must never leak into the agent's self-description.
      'You are the Charter agent — the coding agent built into the Charter desktop app.',
      `You are working on the project at ${root}.`,
      'If asked who or what you are, answer as "the Charter agent". Never mention internal runtimes, harnesses or vendor tooling names (e.g. "pi", "Claude Code", "CLI").',
      modeRules,
      ...(planRule ? [planRule] : []),
      'Use only the provided tools. read_file returns a hash — pass it as baseHash when patching.',
      'Never claim work is complete without evidence from tools; verification results are recorded by the IDE.',
      `Task: ${task.title}`,
    ].join('\n');
  }

  async stopTask(taskId: string): Promise<TaskDto> {
    const runId = this.runsByTask.get(taskId) ?? this.host.activeRunForTask(taskId);
    if (runId) {
      this.host.abort(runId, 'user_stop');
      this.recordEvent(taskId, 'system.abortRequested', { runId });
    }
    return this.getTask(taskId);
  }

  steerOrQueue(
    taskId: string,
    text: string,
    during: 'steer' | 'followUp',
  ): 'steered' | 'queued' | 'started' {
    const runId = this.runsByTask.get(taskId);
    const task = this.getTask(taskId);
    if (runId && isRunningState(task.state as TaskState)) {
      this.recordEvent(taskId, 'user.message', { text, kind: during });
      if (during === 'steer') this.host.steer(runId, text);
      else this.host.followUp(runId, text);
      return during === 'steer' ? 'steered' : 'queued';
    }
    // Idle: start a fresh run with this text as the prompt.
    void this.startTask(taskId, text);
    return 'started';
  }

  archive(taskId: string): TaskDto {
    const task = this.getTask(taskId);
    if (['ACCEPTED', 'ROLLED_BACK', 'CANCELLED'].includes(task.state)) {
      this.setState(taskId, 'ARCHIVED');
    }
    // ADR-0009: best-effort worktree cleanup for finished isolated tasks.
    if (task.worktree && existsSync(task.worktree.path)) {
      void this.worktrees.discard(task.projectPath, task.worktree as TaskWorktree);
      this.contexts.drop(task.worktree.path);
    }
    this.db
      .prepare('UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), taskId);
    return this.getTask(taskId);
  }

  // ---------- agent event projection ----------

  private onAgentEvent(taskId: string, runId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'run.started':
        this.db.prepare("UPDATE agent_runs SET state = 'STREAMING' WHERE id = ?").run(runId);
        break;
      case 'message.delta':
        broadcast('task.stream', { taskId, runId, messageId: event.messageId, delta: event.text });
        break;
      case 'message.completed':
        this.recordEvent(taskId, 'agent.message', {
          messageId: event.message.messageId,
          text: event.message.text,
        });
        break;
      case 'plan.proposed':
      case 'plan.updated':
        this.recordEvent(
          taskId,
          event.type === 'plan.proposed' ? 'agent.planProposed' : 'agent.planUpdated',
          {
            plan: event.plan,
          },
        );
        break;
      case 'tool.proposed':
        // Gateway audit is authoritative; runtime proposals stream for live UI only.
        broadcast('task.event', {
          taskId,
          event: {
            id: newId('evt'),
            taskId,
            sequence: 0, // ephemeral (not persisted)
            type: 'agent.toolProposed',
            schemaVersion: 1,
            at: event.at,
            payload: { call: { ...event.call, input: redactObject(event.call.input) } },
          },
        });
        break;
      case 'tool.started':
      case 'tool.progress':
        break;
      case 'tool.completed':
        break; // persisted via gateway audit
      case 'usage.updated':
        this.db
          .prepare('UPDATE agent_runs SET usage_json = ? WHERE id = ?')
          .run(JSON.stringify(event.usage), runId);
        this.recordEvent(taskId, 'agent.usage', { usage: event.usage });
        break;
      case 'context.compacted':
        this.recordEvent(taskId, 'system.contextCompacted', { metadata: event.metadata });
        break;
      case 'runtime.diagnostic':
        this.recordEvent(taskId, 'system.diagnostic', { code: event.code, detail: event.detail });
        break;
      case 'run.completed': {
        this.db
          .prepare(
            "UPDATE agent_runs SET state = 'COMPLETED', stop_reason = ?, ended_at = ? WHERE id = ?",
          )
          .run(event.stopReason, new Date().toISOString(), runId);
        this.recordEvent(taskId, 'run.completed', { runId, stopReason: event.stopReason });
        void this.finalizeRun(taskId, runId);
        break;
      }
      case 'run.failed':
        this.db
          .prepare(
            "UPDATE agent_runs SET state = 'ERROR', error_json = ?, ended_at = ? WHERE id = ?",
          )
          .run(JSON.stringify(event.error), new Date().toISOString(), runId);
        this.recordEvent(taskId, 'run.failed', { runId, error: event.error });
        this.safeTransition(taskId, 'FAILED');
        break;
      case 'run.aborted': {
        this.db
          .prepare(
            "UPDATE agent_runs SET state = 'ABORTED', stop_reason = ?, ended_at = ? WHERE id = ?",
          )
          .run(event.reason, new Date().toISOString(), runId);
        this.recordEvent(taskId, 'run.aborted', { runId, reason: event.reason });
        // A plan rejection already moved the task to CANCELLED — keep it there.
        if (this.getTask(taskId).state !== 'CANCELLED') {
          this.safeTransition(taskId, 'INTERRUPTED');
        }
        break;
      }
    }
  }

  /** Best-effort transition through legal intermediate hops. */
  private safeTransition(taskId: string, to: TaskState): void {
    try {
      this.setState(taskId, to);
    } catch {
      try {
        this.setState(taskId, 'IN_PROGRESS');
        this.setState(taskId, to);
      } catch (e) {
        this.logger.warn('state transition fallback failed', {
          taskId,
          to,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  /** Emit the final report, then move to REVIEW_READY (§6.1: never auto-ACCEPTED). */
  private async finalizeRun(taskId: string, runId: string): Promise<void> {
    try {
      const task = this.getTask(taskId);
      if (task.state === 'EXPLORING') {
        // Ask flow: EXPLORING → IN_PROGRESS → REVIEW_READY (§6.1 exact hops).
        this.setState(taskId, 'IN_PROGRESS');
      }
      const report = await this.buildFinalReportData(taskId, runId, 'completed');
      // ADR-0009: record the net changed-file count — zero-change tasks get the
      // light "Answered" completion presentation.
      const changedFiles = ((report.changed as { files?: number } | undefined)?.files ?? 0) | 0;
      this.db.prepare('UPDATE tasks SET changed_files = ? WHERE id = ?').run(changedFiles, taskId);
      this.recordEvent(taskId, 'report.final', report);
      const current = this.getTask(taskId).state;
      if (current === 'VERIFYING') this.setState(taskId, 'REVIEW_READY');
      else this.safeTransition(taskId, 'REVIEW_READY');
    } catch (e) {
      this.logger.error('finalize run failed', {
        taskId,
        error: e instanceof Error ? e.message : String(e),
      });
      this.safeTransition(taskId, 'REVIEW_READY');
    }
  }

  /**
   * Final report (§13.4, M9-03): the agent's own summary is kept separate from
   * system evidence, which comes from the ChangeService, VerificationService
   * and the permission/tool audit — never from the model's claims.
   */
  private async buildFinalReportData(
    taskId: string,
    runId: string | null,
    outcome: 'completed' | 'failed' | 'interrupted',
  ): Promise<Record<string, unknown>> {
    const task = this.getTask(taskId);
    const latestRun = this.db
      .prepare('SELECT id FROM agent_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(taskId) as { id: string } | undefined;
    const effectiveRunId = runId ?? latestRun?.id ?? null;
    const usageRow = effectiveRunId
      ? (this.db
          .prepare('SELECT usage_json, provider, model FROM agent_runs WHERE id = ?')
          .get(effectiveRunId) as
          { usage_json: string | null; provider: string; model: string } | undefined)
      : undefined;
    const toolCounts = this.db
      .prepare('SELECT state, COUNT(*) as n FROM tool_calls WHERE task_id = ? GROUP BY state')
      .all(taskId) as Array<{ state: string; n: number }>;
    const deniedCount = toolCounts.find((t) => t.state === 'DENIED')?.n ?? 0;
    const failedCount = toolCounts.find((t) => t.state === 'FAILED')?.n ?? 0;

    // Agent self-description: the last visible assistant message.
    const lastMessage = this.db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'agent.message' ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId) as { payload_json: string } | undefined;
    const agentSummary = lastMessage
      ? String((JSON.parse(lastMessage.payload_json) as { text?: string }).text ?? '').slice(
          0,
          2000,
        )
      : null;

    // System evidence: net changes.
    let changed: Record<string, unknown> = { files: 0, additions: 0, deletions: 0, list: [] };
    try {
      const cs = await this.contextForTask(taskId).changes.changeSet(taskId);
      if (cs) {
        changed = {
          files: cs.files.length,
          additions: cs.totalAdditions,
          deletions: cs.totalDeletions,
          list: cs.files.map((f) => ({
            path: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          })),
        };
      }
    } catch {
      // change set unavailable (workspace closed mid-flight)
    }

    // System evidence: verification runs with stale/superseded flags (VER-005/008).
    const runs = this.verificationRuns(taskId);
    const currentRuns = runs.filter((r) => r.superseded !== true);
    const passed = currentRuns.filter((r) => r.state === 'passed' && r.stale !== true).length;
    const failed = currentRuns.filter((r) => r.state === 'failed').length;
    const unverified = task.mode !== 'ask' && runs.length === 0;

    // GIT-009: report whether HEAD moved during the task.
    let gitHeadChanged: boolean | null = null;
    try {
      const context = this.contextForTask(taskId);
      if (context.isGitRepo && task.gitBaseline) {
        const head = await new GitService(context.root).headInfo();
        gitHeadChanged = head.head !== task.gitBaseline.head;
      }
    } catch {
      gitHeadChanged = null;
    }

    const unresolvedRisks: string[] = [];
    if (deniedCount > 0) unresolvedRisks.push(`${deniedCount} tool call(s) were denied`);
    if (failedCount > 0) unresolvedRisks.push(`${failedCount} tool call(s) failed`);
    if (failed > 0) unresolvedRisks.push(`${failed} verification(s) failing`);
    if (runs.some((r) => r.stale === true))
      unresolvedRisks.push('some verification results are stale (code changed afterwards)');

    return {
      outcome,
      mode: task.mode,
      agentSummary,
      acceptance: task.acceptance,
      changed,
      verification: {
        runs,
        passed,
        failed,
        note:
          task.mode === 'ask' ? 'not applicable (ask)' : unverified ? 'UNVERIFIED_BY_USER' : null,
      },
      unverified,
      diagnosticsNote:
        'Problems counts are live workspace state; check the Problems panel before accepting (VER-009).',
      unresolvedRisks,
      toolCounts,
      model: usageRow ? { provider: usageRow.provider, model: usageRow.model } : null,
      usage: usageRow?.usage_json ? JSON.parse(usageRow.usage_json) : null,
      gitBaseline: task.gitBaseline,
      gitHeadChanged,
    };
  }

  private onRunEnded(taskId: string, runId: string): void {
    if (this.runsByTask.get(taskId) === runId) {
      this.runsByTask.delete(taskId);
    }
    this.drainQueue();
  }

  /** Start queued tasks while capacity remains (FIFO, ADR-0006). */
  private drainQueue(): void {
    while (
      this.startQueue.length > 0 &&
      this.host.activeRunCount() + this.launching < this.runCapacity()
    ) {
      const next = this.startQueue.shift()!;
      this.launching += 1; // reserve the slot synchronously to avoid over-admission
      void this.doLaunch(next.taskId, next.prompt)
        .catch((e) => {
          this.logger.error('queued task launch failed', {
            taskId: next.taskId,
            error: e instanceof Error ? e.message : String(e),
          });
        })
        .finally(() => {
          this.launching -= 1;
        });
    }
  }

  private onWorkerCrashed(taskIds: string[]): void {
    for (const taskId of taskIds) {
      this.recordEvent(taskId, 'system.workerCrashed', {
        note: 'The agent worker exited unexpectedly. No tools were replayed (REL-002).',
      });
      this.db
        .prepare(
          "UPDATE agent_runs SET state = 'ERROR_WORKER_EXIT', ended_at = ? WHERE task_id = ? AND ended_at IS NULL",
        )
        .run(new Date().toISOString(), taskId);
      this.safeTransition(taskId, 'INTERRUPTED');
      this.runsByTask.delete(taskId);
    }
  }

  private onToolLifecycle(
    taskId: string,
    call: ToolCallRequest,
    result: { ok: boolean; code: string; summary: string } | null,
  ): void {
    if (result === null) return; // start is audited by the gateway
  }

  private persistToolAudit(record: ToolAuditRecord): void {
    try {
      const exists = this.db
        .prepare('SELECT id FROM tool_calls WHERE id = ?')
        .get(record.callId) as { id: string } | undefined;
      if (!exists) {
        this.db
          .prepare(
            'INSERT INTO tool_calls (id, run_id, task_id, name, version, risk, state, input_json, created_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            record.callId,
            record.runId,
            record.taskId,
            record.name,
            record.version,
            record.risk,
            record.state,
            JSON.stringify(record.input ?? null),
            record.at,
            record.at,
          );
      } else {
        this.db
          .prepare(
            'UPDATE tool_calls SET state = ?, risk = COALESCE(?, risk), result_json = ?, ended_at = ? WHERE id = ?',
          )
          .run(
            record.state,
            record.risk,
            JSON.stringify({ ok: record.ok, summary: record.resultSummary }),
            record.at,
            record.callId,
          );
      }
      // Terminal states become timeline events.
      if (['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'TIMED_OUT'].includes(record.state)) {
        this.recordEvent(record.taskId, 'tool.call', {
          callId: record.callId,
          name: record.name,
          risk: record.risk,
          state: record.state,
          ok: record.ok,
          summary: record.resultSummary,
          input: record.input,
        });
      } else {
        // ADR-0006: live "current action" — non-terminal audit states stream as
        // ephemeral events (sequence 0, never persisted); the terminal event
        // above replaces them by callId in the activity projection.
        broadcast('task.event', {
          taskId: record.taskId,
          event: {
            id: newId('evt'),
            taskId: record.taskId,
            sequence: 0,
            type: 'tool.call',
            schemaVersion: 1,
            at: record.at,
            payload: {
              callId: record.callId,
              name: record.name,
              risk: record.risk,
              state: record.state,
              ok: null,
              summary: null,
              input: redactObject(record.input),
            },
          },
        });
      }
      // VER-008: a successful write moves the code revision — older verification
      // results become stale.
      if (record.state === 'SUCCEEDED' && WRITE_TOOL_NAMES.has(record.name)) {
        void this.codeRevision(record.taskId)
          .then((revision) => {
            if (revision) {
              this.contextForTask(record.taskId).verifications.markStale(record.taskId, revision);
            }
          })
          .catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn('tool audit persist failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * Quit-time teardown (M10/REL): resolve every pending gate BEFORE the
   * database closes, so late worker-exit abort callbacks find nothing to
   * persist. Fixes the "database is not open" crash on quit.
   */
  shutdown(): void {
    this.contexts.shutdown('app quit');
    this.cancelAllAsks('app quit');
    this.cancelAllPlanWaits('app quit');
    this.startQueue.length = 0;
  }

  /** Restart-time scan (M10 expands): mark previously-running tasks interrupted. */
  markOrphanedRunsInterrupted(): void {
    // Permission requests left PENDING by a previous process can never be
    // answered — the waiting tool call died with that process. Record the
    // cancellation in the task event log too, so the timeline's card resolves
    // instead of rendering a dead-but-actionable approval (M10/E2E-020).
    const orphaned = this.db
      .prepare(
        `SELECT p.id, p.task_id, p.risk, p.preview_json, t.name AS tool_name
         FROM permission_requests p LEFT JOIN tool_calls t ON t.id = p.tool_call_id
         WHERE p.state = 'PENDING'`,
      )
      .all() as Array<{
      id: string;
      task_id: string;
      risk: string | null;
      preview_json: string | null;
      tool_name: string | null;
    }>;
    this.db
      .prepare(
        "UPDATE permission_requests SET state = 'CANCELLED', resolved_at = ? WHERE state = 'PENDING'",
      )
      .run(new Date().toISOString());
    for (const req of orphaned) {
      let summary = '';
      try {
        summary = String(
          (JSON.parse(req.preview_json ?? '{}') as { summary?: unknown }).summary ?? '',
        );
      } catch {
        summary = '';
      }
      this.recordEvent(req.task_id, 'permission.decided', {
        requestId: req.id,
        outcome: 'cancelled',
        scope: null,
        actor: 'system',
        reason: 'The application restarted while this request was pending.',
        toolName: req.tool_name ?? 'unknown',
        risk: req.risk,
        summary,
      });
    }
    // ADR-0009: tasks are global — the restart scan covers every project.
    const rows = this.db
      .prepare(
        "SELECT id, state FROM tasks WHERE state IN ('EXPLORING','PLANNING','IN_PROGRESS','AWAITING_PERMISSION','VERIFYING')",
      )
      .all() as Array<{ id: string; state: string }>;
    for (const row of rows) {
      this.recordEvent(row.id, 'system.interruptedByRestart', {
        previousState: row.state,
        note: 'The application restarted while this task was running (INTERRUPTED_BY_RESTART).',
      });
      this.safeTransition(row.id, 'INTERRUPTED');
      this.db
        .prepare(
          "UPDATE agent_runs SET state = 'ERROR_WORKER_EXIT', ended_at = ? WHERE task_id = ? AND ended_at IS NULL",
        )
        .run(new Date().toISOString(), row.id);
    }
  }
}
