import {
  createSequenceAllocator,
  detectBinary,
  errorMessage,
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
  PriorConversationContext,
  PromptImage,
  RuntimeSessionRef,
  TaskPlan,
  ToolCallRequest,
} from '@pi-ide/agent-contract';
import type { OrchestrationCallerContext } from '@pi-ide/orchestration-domain';
import type {
  ActivityItem,
  AskUserPromptDto,
  ChangeSetDto,
  ChangeSetFileDto,
  CodeContextRefDto,
  ArtifactFeedbackRefDto,
  PermissionCardDto,
  PlanEditDto,
  PrDraftDto,
  PreviewElementContextDto,
  PreviewRectDto,
  TaskDto,
  TimelineEventDto,
  TurnDto,
  VerificationCommand,
} from '@pi-ide/ipc-contracts';
import {
  AgentIdSchema,
  fileRefsForEventPayload,
  formatPromptWithCodeContext,
  formatPromptWithArtifactFeedback,
  formatPromptWithFileContext,
  projectActivity,
  type FileContextRefDto,
} from '@pi-ide/ipc-contracts';
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
  type OrchestrationToolServices,
  type VerificationGate,
} from '@pi-ide/tool-gateway';
import { parseHunks, type ChangeSet } from '@pi-ide/change-service';
import type {
  VerificationCommand as VerCommand,
  VerificationRunRecord,
} from '@pi-ide/verification-service';
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { GitService } from '@pi-ide/git-service';
import { openWorkspaceInfo } from '@pi-ide/workspace-service';
import type { AgentHost, RuntimeKind } from './agent-host.js';
import type { SkillUsageEvent } from './skill-usage.js';
import type { WorkspaceHost } from './workspace-host.js';
import type { SettingsService } from './settings-service.js';
import type { TerminalControlService } from './terminal-control-service.js';
import type { SkillStore } from './skill-store.js';
import { workspaceDataDir, type AppPaths } from '../app-paths.js';
import { ProjectContexts, type ProjectContext } from './project-contexts.js';
import { WorktreeService, type TaskWorktree } from './worktree-service.js';
import { buildPrCommands, buildPrDraft } from './pr-draft.js';
import { buildExternalSessionIndex, type ExternalSessionRow } from './external-session-index.js';
import { broadcast } from '../broadcast.js';
import { CHARTER_ORCHESTRATION_PREAMBLE } from './orchestration-manual.js';

/** ADR-0022: preview-feedback metadata recorded on the user.message event. */
export interface PreviewFeedbackMeta {
  pngPath: string;
  pageUrl: string;
  rect: PreviewRectDto;
  /** Small data-URL thumbnail for timeline rendering (no extra read channel). */
  thumbDataUrl: string;
  /** am.2: CSS selector from the element picker (marquee selections have none). */
  selector?: string;
  /** Context+ semantic locator; absent for drawn regions. */
  elementContext?: PreviewElementContextDto;
  /** The user's note verbatim — the Room leads with it. */
  note?: string;
}

/** Extra payload riding a run launch (preview feedback from REVIEW_READY). */
interface LaunchExtras {
  images?: PromptImage[];
  previewMeta?: PreviewFeedbackMeta;
  /** Frozen source snapshots selected by the user for this turn. */
  codeRefs?: CodeContextRefDto[];
  /** ADR-0024: file / folder / image references attached to this turn. */
  fileRefs?: FileContextRefDto[];
  /** Semantic feedback pinned to immutable artifact versions. */
  artifactRefs?: ArtifactFeedbackRefDto[];
}

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

export function completionDisposition(input: {
  projectedChangedFiles: number;
  successfulWrite: boolean;
  failedWrite: boolean;
  diskChangedFiles: number | null;
}): 'answered' | 'review' | 'failed' {
  if (input.projectedChangedFiles > 0) return 'review';
  if (input.failedWrite) return 'failed';
  if (!input.successfulWrite) return 'answered';
  // A failed disk reconciliation is not proof of zero changes. Fail closed so
  // a durable successful write can never be presented as a chat-only answer.
  return input.diskChangedFiles === 0 ? 'answered' : 'review';
}

export interface WriteAuditDisposition {
  name: string;
  state: string;
  inputJson: string;
}

function writeAuditTargets(row: WriteAuditDisposition): Set<string> {
  try {
    const input = JSON.parse(row.inputJson) as { path?: unknown; from?: unknown; to?: unknown };
    return new Set(
      [input.path, input.from, input.to].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      ),
    );
  } catch {
    return new Set();
  }
}

/** A failed write is unresolved until a later successful write touches the
 * same target. This preserves fail-closed reporting without mislabelling the
 * normal stale-read → re-read → successful retry path. */
export function unresolvedFailedWriteCount(rows: WriteAuditDisposition[]): number {
  const targets = rows.map(writeAuditTargets);
  let unresolved = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.state !== 'FAILED') continue;
    const failedTargets = targets[index]!;
    const recovered = rows.slice(index + 1).some((later, offset) => {
      if (later.state !== 'SUCCEEDED') return false;
      const laterTargets = targets[index + offset + 1]!;
      if (failedTargets.size === 0 || laterTargets.size === 0) return false;
      return [...failedTargets].some((target) => laterTargets.has(target));
    });
    if (!recovered) unresolved += 1;
  }
  return unresolved;
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
  /** Optional command run once inside a fresh worktree (deps, codegen…). */
  worktreeSetup?: string;
  /** Existing task conversations to snapshot as untrusted background context. */
  conversationRefTaskIds?: string[];
}

export interface HistoricalOrchestrationWorker {
  terminalId: string;
  workerTaskId: string | null;
  launch: string;
  root: string;
  projectPath: string;
  title: string;
  idempotencyKey?: string | null;
}

/** One still-live terminal relationship projected from the durable event ledger. */
export interface HistoricalLiveOrchestrationWorker extends HistoricalOrchestrationWorker {
  commanderTaskId: string;
  commanderTerminalId: string | null;
  /** The latest durable turn edge lets a recovered rail resume its activity signal. */
  turnPending: boolean;
}

export interface HistoricalOrchestrationEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Every worker task ever bound below one commander. Unlike the resumable fleet
 * projection, completed/killed workers stay in this list: their files remain
 * part of the commander's delivered result and therefore belong in its Diff.
 */
export function projectHistoricalOrchestrationTaskIds(
  events: readonly HistoricalOrchestrationEvent[],
): string[] {
  const taskIds = new Set<string>();
  for (const event of events) {
    if (
      event.type !== 'orchestration.workerCreated' &&
      event.type !== 'orchestration.workerBound'
    ) {
      continue;
    }
    const workerTaskId = event.payload.workerTaskId;
    if (typeof workerTaskId === 'string' && workerTaskId.length > 0) taskIds.add(workerTaskId);
  }
  return [...taskIds];
}

/** Select the earliest task baseline for each path and project one net result. */
export function mergeReviewChangeSets(
  taskId: string,
  changeSets: readonly ChangeSet[],
  baselineOwners: ReadonlyMap<string, string>,
): ChangeSet {
  const files = new Map<string, ChangeSet['files'][number]>();
  for (const changeSet of changeSets) {
    for (const file of changeSet.files) {
      const owner = baselineOwners.get(file.path);
      if (owner && owner !== changeSet.taskId) continue;
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  const ordered = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    taskId,
    files: ordered,
    totalAdditions: ordered.reduce((total, file) => total + file.additions, 0),
    totalDeletions: ordered.reduce((total, file) => total + file.deletions, 0),
  };
}

interface HistoricalExternalTask {
  taskId: string;
  title: string;
  projectPath: string;
  external: NonNullable<TaskDto['external']>;
}

/** Fold the durable orchestration ledger into the fleet that should follow a resume. */
export function projectHistoricalOrchestrationFleet(
  events: HistoricalOrchestrationEvent[],
  externalTasks: HistoricalExternalTask[],
  fallbackRoot: string,
): HistoricalOrchestrationWorker[] {
  const externalByTerminal = new Map<string, HistoricalExternalTask>();
  const externalByTaskId = new Map<string, HistoricalExternalTask>();
  for (const task of externalTasks) {
    externalByTaskId.set(task.taskId, task);
    if (!externalByTerminal.has(task.external.terminalId)) {
      externalByTerminal.set(task.external.terminalId, task);
    }
  }
  const workers = new Map<
    string,
    {
      terminalId: string;
      workerTaskId: string | null;
      launch: string;
      root: string | null;
      title: string | null;
      idempotencyKey: string | null;
    }
  >();
  for (const event of events) {
    const terminalId =
      typeof event.payload.terminalId === 'string' ? event.payload.terminalId : null;
    if (!terminalId) continue;
    if (event.type === 'orchestration.workerCreated') {
      const launch = event.payload.launch;
      if (typeof launch !== 'string' || !AgentIdSchema.safeParse(launch).success) continue;
      workers.set(terminalId, {
        terminalId,
        workerTaskId:
          typeof event.payload.workerTaskId === 'string' ? event.payload.workerTaskId : null,
        launch,
        root: typeof event.payload.root === 'string' ? event.payload.root : null,
        title: typeof event.payload.title === 'string' ? event.payload.title : null,
        idempotencyKey:
          typeof event.payload.idempotencyKey === 'string' ? event.payload.idempotencyKey : null,
      });
    } else if (event.type === 'orchestration.workerBound') {
      const worker = workers.get(terminalId);
      if (worker && typeof event.payload.workerTaskId === 'string') {
        worker.workerTaskId = event.payload.workerTaskId;
      }
    } else if (event.type === 'orchestration.workerKilled') {
      workers.delete(terminalId);
    }
  }
  return [...workers.values()].map((worker) => {
    const externalTask =
      (worker.workerTaskId ? externalByTaskId.get(worker.workerTaskId) : null) ??
      externalByTerminal.get(worker.terminalId);
    return {
      terminalId: worker.terminalId,
      workerTaskId: worker.workerTaskId ?? externalTask?.taskId ?? null,
      launch: worker.launch,
      root: worker.root ?? externalTask?.external.cwd ?? fallbackRoot,
      projectPath: externalTask?.projectPath ?? fallbackRoot,
      title: worker.title ?? externalTask?.title ?? `${worker.launch} worker`,
      ...(worker.idempotencyKey ? { idempotencyKey: worker.idempotencyKey } : {}),
    };
  });
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
  external_json: string | null;
  project_path: string;
  project_name: string;
}

const TASK_SELECT =
  'SELECT t.*, w.canonical_path AS project_path, w.display_name AS project_name FROM tasks t JOIN workspaces w ON w.id = t.workspace_id';

/**
 * Task engine (spec §6): persistence-backed state machine, immutable event log,
 * run orchestration against the AgentHost, tool audit projection.
 */
/** ADR-0028: project-memory hooks (injected post-construction, optional). */
export interface TaskMemoryHooks {
  /** <project_rules> block for a managed run's preamble; null when empty. */
  projectRulesBlock(taskId: string): string | null;
  /** A review correction happened (request-fix steer / plan change request). */
  captureCorrection(input: {
    taskId: string;
    kind: 'request-fix' | 'plan-changes';
    text: string;
  }): void;
}

export class TaskService {
  private readonly sequences = createSequenceAllocator();
  private readonly sessionRefs = new Map<string, RuntimeSessionRef>();
  private readonly runsByTask = new Map<string, string>();
  private readonly orchestrationByTask = new Map<string, OrchestrationCallerContext>();
  private readonly startQueue: Array<{
    taskId: string;
    prompt: string | undefined;
    extras?: LaunchExtras;
  }> = [];
  /** Per-root agent contexts (ADR-0009) — tasks execute against these, never "the open workspace". */
  private readonly contexts: ProjectContexts;
  private readonly worktrees: WorktreeService;
  /** Pending permission request → owning context (routes decisions). */
  private readonly requestContext = new Map<string, ProjectContext>();
  /** Open ask_user questions waiting for an answer, keyed by callId. */
  private readonly pendingAsks = new Map<
    string,
    {
      prompt: AskUserPromptDto;
      resumeState: 'EXPLORING' | 'PLANNING' | 'IN_PROGRESS';
      resolve: (answer: string) => void;
      cleanup: () => void;
    }
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
      mode: string;
    }) => void
  >();

  /** ADR-0022: replay receipt hash for the PR draft (injected post-construction). */
  private receiptProvider: ((taskId: string) => string | null) | null = null;

  /** ADR-0028: project memory (injected post-construction; absent in some tests). */
  private memory: TaskMemoryHooks | null = null;
  private readonly unsubscribeOrchestrationSettings: () => void;

  constructor(
    private readonly db: SqlDatabase,
    private readonly host: AgentHost,
    private readonly workspace: WorkspaceHost,
    private readonly settings: SettingsService,
    private readonly skills: SkillStore,
    private readonly appPaths: AppPaths,
    private readonly logger: Logger,
    private readonly terminalControl?: TerminalControlService,
  ) {
    const paths = appPaths;
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
            const task = this.getTask(taskId);
            // External CLI tasks use the gateway only through the authenticated
            // control door. They need the regular approval engine, not Ask
            // mode's absolute read-only boundary.
            return task.external ? 'edit' : task.mode;
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
        // ADR-0015: load_skill resolves enabled skills at call time, so
        // Settings toggles apply to running sessions immediately.
        skills: () => this.skills.enabledSkills(),
      },
      logger,
      terminalControl
        ? {
            control: terminalControl,
            callerTerminalForCall: (callId) => terminalControl.callerTerminalForCall(callId),
          }
        : undefined,
    );
    this.unsubscribeOrchestrationSettings = settings.onChange((state) => {
      this.contexts.syncTerminalTools(state.effective.orchestration.enabled);
      this.contexts.syncOrchestrationTools(state.effective.orchestration.enabled);
    });
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

  gatewayForTask(taskId: string): ToolGateway | null {
    try {
      return this.contextForTask(taskId).gateway;
    } catch {
      return null;
    }
  }

  attachOrchestrationTools(services: OrchestrationToolServices | null): void {
    this.contexts.configureOrchestrationTools(services);
  }

  async createOrchestratedTask(
    input: CreateTaskInput,
    caller: OrchestrationCallerContext,
    launch?: { attemptId: string; idempotencyKey: string },
  ): Promise<{ taskId: string; queued: boolean }> {
    if (launch) {
      const existing = this.db
        .prepare(
          `SELECT task_id FROM task_events
           WHERE type = 'orchestration.attemptBound'
             AND json_extract(payload_json, '$.attemptId') = ?
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(launch.attemptId) as { task_id: string } | undefined;
      if (existing) {
        const task = this.getTask(existing.task_id);
        this.orchestrationByTask.set(task.id, caller);
        if (['READY', 'IDLE', 'INTERRUPTED', 'FAILED'].includes(task.state)) {
          const started = await this.startTask(task.id);
          return { taskId: task.id, queued: started.queued };
        }
        return { taskId: task.id, queued: task.state === 'READY' };
      }
    }
    const task = await this.createTask(input);
    this.orchestrationByTask.set(task.id, caller);
    if (launch) {
      this.recordEvent(task.id, 'orchestration.attemptBound', launch);
    }
    try {
      const started = await this.startTask(task.id);
      return { taskId: task.id, queued: started.queued };
    } catch (error) {
      this.orchestrationByTask.delete(task.id);
      throw error;
    }
  }

  async steerOrchestratedTask(taskId: string, text: string): Promise<void> {
    const runId = this.runsByTask.get(taskId) ?? this.host.activeRunForTask(taskId);
    if (runId) {
      this.host.steer(runId, text);
      return;
    }
    await this.startTask(taskId, text);
  }

  /** The authenticated external control door has no managed runtime run, but
   * tool_calls requires one for the same durable audit/permission pipeline. */
  ensureTerminalControlRun(taskId: string, terminalId: string): string {
    this.getTask(taskId);
    const runId = `terminal:${terminalId}`;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_runs
          (id, task_id, state, provider, model, started_at)
         VALUES (?, ?, 'STREAMING', 'external', 'terminal-control', ?)`,
      )
      .run(runId, taskId, new Date().toISOString());
    return runId;
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
    const currentState = this.getTask(prompt.taskId).state;
    const resumeState =
      currentState === 'EXPLORING' || currentState === 'PLANNING' ? currentState : 'IN_PROGRESS';
    if (currentState !== 'AWAITING_USER') this.safeTransition(prompt.taskId, 'AWAITING_USER');
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
        resumeState,
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
    const hasAnotherQuestion = [...this.pendingAsks.values()].some(
      (pending) => pending.prompt.taskId === entry.prompt.taskId,
    );
    if (!hasAnotherQuestion && this.getTask(entry.prompt.taskId).state === 'AWAITING_USER') {
      this.setState(entry.prompt.taskId, entry.resumeState);
    }
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

    if (task.mode === 'auto' || task.mode === 'full') {
      // §5.2/§19.3 default: Auto/Full approve the plan automatically and keep going.
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
    codeRefs?: CodeContextRefDto[];
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
      const reason = (input.reason ?? '').trim() || 'Please revise the plan.';
      const feedback = formatPromptWithCodeContext(reason, input.codeRefs ?? []);
      // ADR-0028: plan pushback is a decision-grade correction too.
      if (input.reason?.trim()) {
        this.memory?.captureCorrection({
          taskId: input.taskId,
          kind: 'plan-changes',
          text: input.reason.trim(),
        });
      }
      this.planRecords.set(input.taskId, {
        plan: record.plan,
        status: 'none',
        version: record.version,
      });
      this.recordEvent(input.taskId, 'user.planDecision', {
        decision: 'changes_requested',
        auto: false,
        edited: false,
        reason,
        ...(input.codeRefs?.length ? { codeRefs: input.codeRefs } : {}),
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
    // ADR-0032: rejecting a plan settles the turn back to the conversation —
    // the Session stays open for a different ask.
    if (task.state === 'AWAITING_PLAN_APPROVAL') this.setState(input.taskId, 'IDLE');
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
          error: errorMessage(e),
        });
      }
    }
  }

  // ---------- review projection and decisions (M8-05, CHG-005/007/008) ----------

  /** ADR-0014 (PIVOT-034): current logical content of one file in the task's
   * mount for the in-room read-only peek. Reads through the context's document
   * facade (path boundary enforced; live editor buffer when focused; the
   * worktree when the task is isolated). Missing/binary/oversized files return
   * honest flags instead of errors — the peek renders them as quiet notes. */
  async peekFile(
    taskId: string,
    path: string,
  ): Promise<{
    content: string | null;
    binary: boolean;
    missing: boolean;
    truncated: boolean;
    sizeBytes: number;
    fromBuffer: boolean;
  }> {
    const context = this.contextForTask(taskId);
    const MAX_PEEK_CHARS = 1_000_000;
    try {
      const read = await context.documents.readLogical(path);
      if (read.binary) {
        return {
          content: null,
          binary: true,
          missing: false,
          truncated: false,
          sizeBytes: read.sizeBytes,
          fromBuffer: false,
        };
      }
      const truncated = read.content.length > MAX_PEEK_CHARS;
      return {
        content: truncated ? read.content.slice(0, MAX_PEEK_CHARS) : read.content,
        binary: false,
        missing: false,
        truncated,
        sizeBytes: read.sizeBytes,
        fromBuffer: read.fromBuffer,
      };
    } catch {
      // Unreadable = not on disk (deleted, renamed away) or outside the mount.
      return {
        content: null,
        binary: false,
        missing: true,
        truncated: false,
        sizeBytes: 0,
        fromBuffer: false,
      };
    }
  }

  /** Net change set with hunks and review-state projection for the Review page. */
  /** ADR-0013: both sides of one file for the review diff editor. */
  async reviewFileContents(
    taskId: string,
    path: string,
  ): Promise<{ baseline: string | null; current: string | null; binary: boolean }> {
    const scope = this.reviewScope(taskId);
    const ownerTaskId = scope.baselineOwners.get(path) ?? taskId;
    const result = await this.contextForTask(ownerTaskId).changes.fileContents(ownerTaskId, path);
    return result ?? { baseline: null, current: null, binary: false };
  }

  /**
   * A commander Session owns the outcome produced by every terminal worker it
   * launched, including workers that have already exited. Keep aggregation on
   * the same physical mount so an isolated worktree can never leak changes
   * from the main tree (or vice versa).
   */
  private reviewScope(taskId: string): {
    taskIds: string[];
    baselineOwners: Map<string, string>;
  } {
    const commander = this.getTask(taskId);
    const mount = commander.worktree?.path ?? commander.projectPath;
    const taskIds: string[] = [];
    const seen = new Set<string>();
    const queue = [taskId];

    while (queue.length > 0) {
      const currentTaskId = queue.shift()!;
      if (seen.has(currentTaskId)) continue;
      let current: TaskDto;
      try {
        current = this.getTask(currentTaskId);
      } catch {
        continue;
      }
      if ((current.worktree?.path ?? current.projectPath) !== mount) continue;
      seen.add(currentTaskId);
      taskIds.push(currentTaskId);

      const rows = this.db
        .prepare(
          "SELECT type, payload_json FROM task_events WHERE task_id = ? AND type IN ('orchestration.workerCreated','orchestration.workerBound') ORDER BY sequence",
        )
        .all(currentTaskId) as Array<{ type: string; payload_json: string }>;
      const events = rows.flatMap((row): HistoricalOrchestrationEvent[] => {
        try {
          const payload = JSON.parse(row.payload_json) as unknown;
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
          return [{ type: row.type, payload: payload as Record<string, unknown> }];
        } catch {
          return [];
        }
      });
      queue.push(...projectHistoricalOrchestrationTaskIds(events));
    }

    const baselineOwners = new Map<string, string>();
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => '?').join(',');
      const rows = this.db
        .prepare(
          `SELECT task_id, relative_path
           FROM file_baselines
           WHERE task_id IN (${placeholders})
           ORDER BY captured_at, rowid`,
        )
        .all(...taskIds) as Array<{ task_id: string; relative_path: string }>;
      for (const row of rows) {
        if (!baselineOwners.has(row.relative_path)) {
          baselineOwners.set(row.relative_path, row.task_id);
        }
      }
    }
    return { taskIds, baselineOwners };
  }

  private async projectedReviewChangeSet(taskId: string): Promise<{
    changeSet: ChangeSet;
    taskIds: string[];
    baselineOwners: Map<string, string>;
  }> {
    const scope = this.reviewScope(taskId);
    const read = async (fromDisk: boolean): Promise<ChangeSet[]> =>
      await Promise.all(
        scope.taskIds.map((scopedTaskId) => {
          const changes = this.contextForTask(scopedTaskId).changes;
          return fromDisk
            ? changes.changeSetFromDisk(scopedTaskId)
            : changes.changeSet(scopedTaskId);
        }),
      );
    let changeSet = mergeReviewChangeSets(taskId, await read(false), scope.baselineOwners);
    if (
      changeSet.files.length === 0 &&
      scope.taskIds.some((scopedTaskId) => (this.getTask(scopedTaskId).changedFiles ?? 0) > 0)
    ) {
      const durable = mergeReviewChangeSets(taskId, await read(true), scope.baselineOwners);
      if (durable.files.length > 0) changeSet = durable;
    }
    return { changeSet, ...scope };
  }

  async changeSetForReview(taskId: string): Promise<ChangeSetDto> {
    const { changeSet: cs } = await this.projectedReviewChangeSet(taskId);
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
    const scope = this.reviewScope(input.taskId);
    const ownerTaskId = scope.baselineOwners.get(input.path) ?? input.taskId;
    const changes = this.contextForTask(ownerTaskId).changes;
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
          await changes.rejectHunk(ownerTaskId, null, {
            path: input.path,
            hunkKey: input.hunkKey,
            expectedCurrentHash: input.expectedCurrentHash,
          });
        } else {
          await changes.revertFile(ownerTaskId, null, {
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

  /** ADR-0032: accepting settles the pending turn(s) and returns the Session
   * to IDLE — the conversation continues. Worktree merge-back moved to
   * archive time (the tree must survive later turns). Not a git commit. */
  private latestFinalReportOutcome(taskId: string): string | null {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'report.final' ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as { outcome?: unknown };
      return typeof payload.outcome === 'string' ? payload.outcome : null;
    } catch {
      // Malformed evidence must never silently weaken an acceptance gate.
      return 'failed';
    }
  }

  private unresolvedFailedWritesForRun(runId: string): number {
    const rows = this.db
      .prepare(
        `SELECT name, state, input_json AS inputJson
         FROM tool_calls
         WHERE run_id = ?
           AND name IN ('apply_patch','create_file','delete_file','rename_file')
         ORDER BY COALESCE(ended_at, created_at), rowid`,
      )
      .all(runId) as unknown as WriteAuditDisposition[];
    return unresolvedFailedWriteCount(rows);
  }

  async acceptTask(
    taskId: string,
    options: {
      confirmUnverified?: boolean;
      confirmConflicts?: boolean;
      /** Who accepted — 'user' (default) or 'system:full-auto' (ADR-0012). */
      actor?: string;
      /** Settle only this turn (rail turn-list action); default: all pending. */
      runId?: string;
    } = {},
  ): Promise<{
    task: TaskDto;
    status: 'accepted' | 'conflicts';
    conflicts?: Array<{ path: string; reason: string }>;
    /** ADR-0022: evidence-ledger PR draft (git projects only; never pushed). */
    prDraft?: PrDraftDto | null;
  }> {
    const task = this.getTask(taskId);
    // ADR-0032: REVIEW_READY settles the fresh turn; IDLE lets the rail turn
    // list settle an earlier pending turn while the conversation is at rest.
    if (!['REVIEW_READY', 'IDLE'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_REVIEWABLE', {
          userMessage: `Only a settled or review-ready Session can accept (current: ${task.state}).`,
        }),
      );
    }
    const context = this.contextForTask(taskId);
    // Captured at accept: the PR draft's change list must describe exactly
    // the workspace state this settlement confirmed (ADR-0022).
    const { changeSet: changeSetAtAccept } = await this.projectedReviewChangeSet(taskId);
    const unsettledRun = options.runId
      ? this.db
          .prepare(
            'SELECT id FROM agent_runs WHERE task_id = ? AND id = ? AND review_state IS NULL LIMIT 1',
          )
          .get(taskId, options.runId)
      : this.db
          .prepare(
            'SELECT id FROM agent_runs WHERE task_id = ? AND ended_at IS NOT NULL AND review_state IS NULL LIMIT 1',
          )
          .get(taskId);
    // Answer-only turns settle automatically. Accepting them has no domain
    // meaning, and a repeated accept on an idle Session must be idempotent.
    if (
      (task.state === 'IDLE' && !unsettledRun) ||
      (changeSetAtAccept.files.length === 0 && task.changedFiles === 0)
    ) {
      return { task, status: 'accepted', prDraft: null };
    }
    // VER-007/E2E-018: every accept entry point shares this trust boundary.
    // Missing, failed, cancelled, timed-out, running, or stale current checks
    // all need a second explicit confirmation. Superseded failures are history
    // and do not block once their replacement passed against current code.
    const verificationRuns = context.verifications.listForTask(taskId);
    const currentVerificationRuns = verificationRuns.filter((run) => run.supersededBy === null);
    const configuredLabels = new Set(task.verification.map((command) => command.label));
    const currentLabels = new Set(currentVerificationRuns.map((run) => run.label));
    const missingConfiguredChecks = [...configuredLabels].filter(
      (label) => !currentLabels.has(label),
    );
    const failedChecks = currentVerificationRuns.filter(
      (run) => run.state !== 'passed' && run.state !== 'running',
    );
    const pendingChecks = currentVerificationRuns.filter((run) => run.state === 'running');
    const staleChecks = currentVerificationRuns.filter((run) => run.stale);
    const hasRealChanges = changeSetAtAccept.files.length > 0;
    const latestRequestFailed = this.latestFinalReportOutcome(taskId) === 'failed';
    const needsEvidenceConfirmation =
      task.mode !== 'ask' &&
      hasRealChanges &&
      (latestRequestFailed ||
        currentVerificationRuns.length === 0 ||
        missingConfiguredChecks.length > 0 ||
        failedChecks.length > 0 ||
        pendingChecks.length > 0 ||
        staleChecks.length > 0);
    if (needsEvidenceConfirmation && !options.confirmUnverified) {
      const userMessage = latestRequestFailed
        ? 'The latest request did not complete because a file action failed. Accept the existing changes without that requested fix?'
        : failedChecks.length > 0
          ? `${failedChecks.length} current verification check${failedChecks.length === 1 ? '' : 's'} failed or stopped. Accept the changes despite failed checks?`
          : staleChecks.length > 0
            ? `${staleChecks.length} current verification result${staleChecks.length === 1 ? ' is' : 's are'} stale because the code changed. Accept without fresh verification?`
            : pendingChecks.length > 0
              ? 'Verification is still running. Accept before it finishes?'
              : missingConfiguredChecks.length > 0
                ? `${missingConfiguredChecks.length} configured verification check${missingConfiguredChecks.length === 1 ? ' has' : 's have'} not run. Accept the unverified changes anyway?`
                : 'No verification was run for this task. Accept the unverified changes anyway?';
      throw new ProductFailure(
        productError('ACCEPT_NEEDS_CONFIRM', {
          userMessage,
          retryable: true,
        }),
      );
    }

    // §6.1: acceptance requires a final report; it is recorded when the run completes.
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
    const unverifiedConfirmed =
      needsEvidenceConfirmation &&
      currentVerificationRuns.length === 0 &&
      options.confirmUnverified === true;
    // ADR-0032: settle the turn ledger. Accepting confirms the current
    // workspace state, so by default every finished-but-unsettled run settles.
    const reviewState = options.actor === 'system:full-auto' ? 'auto_accepted' : 'accepted';
    const settledRunIds = this.settleRuns(taskId, reviewState, options.runId);
    this.recordEvent(taskId, 'task.accepted', {
      at: new Date().toISOString(),
      actor: options.actor ?? 'user',
      unverifiedConfirmed,
      executionFailureConfirmed: latestRequestFailed && options.confirmUnverified === true,
      settledRunIds,
    });
    const accepted = this.setState(taskId, 'IDLE');
    // ADR-0022: PR draft — an export of the evidence, generated for git
    // projects with real changes. Failure to draft never fails the accept.
    let prDraft: PrDraftDto | null = null;
    try {
      prDraft = await this.generatePrDraft(accepted, changeSetAtAccept, verificationRuns, {
        unverifiedConfirmed,
      });
    } catch (e) {
      this.logger.warn('pr draft generation failed', {
        taskId,
        error: errorMessage(e),
      });
    }
    return { task: accepted, status: 'accepted', prDraft };
  }

  /** ADR-0032: mark finished, unsettled runs with their settlement. Returns
   * the settled run ids (newest last). A runId narrows to that turn only. */
  private settleRuns(
    taskId: string,
    reviewState: 'accepted' | 'auto_accepted' | 'rolled_back' | 'answered',
    runId?: string,
  ): string[] {
    const rows = runId
      ? (this.db
          .prepare(
            'SELECT id FROM agent_runs WHERE task_id = ? AND id = ? AND review_state IS NULL',
          )
          .all(taskId, runId) as Array<{ id: string }>)
      : (this.db
          .prepare(
            'SELECT id FROM agent_runs WHERE task_id = ? AND ended_at IS NOT NULL AND review_state IS NULL ORDER BY started_at',
          )
          .all(taskId) as Array<{ id: string }>);
    const now = new Date().toISOString();
    const update = this.db.prepare(
      'UPDATE agent_runs SET review_state = ?, reviewed_at = ? WHERE id = ?',
    );
    for (const row of rows) update.run(reviewState, now, row.id);
    return rows.map((row) => row.id);
  }

  /** ADR-0022: build + persist the PR draft (body file under the workspace's
   * attachments dir) and record it on the ledger. Null for non-git projects
   * and answer-only tasks. The app never runs any of the commands (GIT-007). */
  private async generatePrDraft(
    task: TaskDto,
    changeSet: ChangeSet,
    verificationRuns: VerificationRunRecord[],
    flags: { unverifiedConfirmed: boolean },
  ): Promise<PrDraftDto | null> {
    if (changeSet.files.length === 0) return null;
    if (!existsSync(join(task.projectPath, '.git'))) return null;
    const receiptSha256 = this.receiptProvider ? this.receiptProvider(task.id) : null;
    const draft = buildPrDraft({
      taskId: task.id,
      title: task.title,
      goalMd: task.goalMd,
      acceptance: task.acceptance,
      worktreeBranch: task.worktree?.branch ?? null,
      files: changeSet.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        ...(f.renamedFrom ? { renamedFrom: f.renamedFrom } : {}),
      })),
      verification: verificationRuns,
      receiptSha256,
      unverifiedConfirmed: flags.unverifiedConfirmed,
      acceptedAt: new Date().toISOString(),
    });
    const dir = join(workspaceDataDir(this.appPaths, task.workspaceId), 'attachments', task.id);
    await fsp.mkdir(dir, { recursive: true });
    const bodyPath = join(dir, 'pr-draft.md');
    const tmp = `${bodyPath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, draft.body, 'utf8');
    await fsp.rename(tmp, bodyPath);
    const commands = buildPrCommands({
      branch: draft.branch,
      title: draft.title,
      files: changeSet.files,
      bodyPath,
    });
    const dto: PrDraftDto = {
      branch: draft.branch,
      title: draft.title,
      body: draft.body,
      commands,
      bodyPath,
      receiptSha256,
    };
    this.recordEvent(task.id, 'task.prDraft', dto);
    return dto;
  }

  /** ADR-0022: latest stored PR draft (null when none was generated). */
  prDraftFor(taskId: string): PrDraftDto | null {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'task.prDraft' ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as PrDraftDto;
    } catch {
      return null;
    }
  }

  /** ADR-0022: inject the replay receipt hasher (wired after ReplayService exists). */
  setReceiptProvider(provider: (taskId: string) => string | null): void {
    this.receiptProvider = provider;
  }

  /** ADR-0028: inject project-memory hooks (preamble rules + correction capture). */
  attachMemoryHooks(hooks: TaskMemoryHooks): void {
    this.memory = hooks;
  }

  /** ADR-0024: the task's context-attachment directory (outside any workspace
   * or worktree — imported images never touch the project tree). */
  attachmentsDir(taskId: string): string {
    const task = this.getTask(taskId);
    return join(workspaceDataDir(this.appPaths, task.workspaceId), 'attachments', taskId);
  }

  /** ADR-0022: persist a preview-feedback screenshot outside any workspace or
   * worktree (change accounting and merge-back must stay byte-identical). */
  async savePreviewShot(taskId: string, png: Buffer): Promise<string> {
    const task = this.getTask(taskId);
    const dir = join(workspaceDataDir(this.appPaths, task.workspaceId), 'attachments', taskId);
    await fsp.mkdir(dir, { recursive: true });
    const name = `preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`;
    const absPath = join(dir, name);
    const tmp = `${absPath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, png);
    await fsp.rename(tmp, absPath);
    return absPath;
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
    // ADR-0012: post-accept rollback — snapshots survive settlement, so a
    // plain Session can still be restored. A merged worktree task cannot (its
    // worktree — the change-record root — was discarded on merge; historic
    // ACCEPTED rows only).
    if (task.state === 'ACCEPTED' && task.worktree) {
      throw new ProductFailure(
        productError('TASK_NOT_ROLLBACKABLE', {
          userMessage:
            'This task ran in a worktree that was merged and discarded on accept — restore from git instead.',
        }),
      );
    }
    if (!['REVIEW_READY', 'IDLE', 'INTERRUPTED', 'FAILED', 'ACCEPTED'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_ROLLBACKABLE', {
          userMessage: `The task cannot be rolled back from state ${task.state}.`,
        }),
      );
    }
    // ADR-0009: a worktree task never touched the main tree — full rollback is
    // discarding the worktree (byte-exact by construction). ADR-0032: with the
    // tree gone the conversation has no working context left — archive it.
    if (task.worktree) {
      const context = this.contextForTask(taskId);
      context.verifications.markAllStale(taskId);
      await this.worktrees.discard(task.projectPath, task.worktree as TaskWorktree);
      this.contexts.drop(context.root);
      this.settleRuns(taskId, 'rolled_back');
      this.recordEvent(taskId, 'task.rolledBack', {
        ok: true,
        restored: [],
        discardedWorktree: true,
        conflictsOverridden: [],
        failed: [],
      });
      const rolledBack = this.setState(taskId, 'ROLLED_BACK');
      this.db
        .prepare('UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), taskId);
      return {
        status: 'ok',
        task: rolledBack,
        restored: [],
      };
    }
    const context = this.contextForTask(taskId);
    const projected = await this.projectedReviewChangeSet(taskId);
    if (projected.taskIds.length > 1) {
      const changes = this.contextForTask(taskId).changes;
      const targets = projected.changeSet.files.map((file) => ({
        path: file.path,
        toHash: file.baselineHash,
        expectedCurrentHash: file.currentHash,
      }));
      const result = await changes.rollbackToStates(targets, {
        force: options.force ?? false,
      });
      if (result.conflicts.length > 0 && !options.force) {
        this.recordEvent(taskId, 'rollback.blocked', {
          conflicts: result.conflicts.map((conflict) => ({
            path: conflict.path,
            reason: conflict.reason,
          })),
        });
        return {
          status: 'conflicts',
          task: this.getTask(taskId),
          conflicts: result.conflicts.map((conflict) => ({
            path: conflict.path,
            reason: conflict.reason,
          })),
        };
      }
      this.settleRuns(taskId, 'rolled_back');
      this.recordEvent(taskId, 'task.rolledBack', {
        ok: result.ok,
        restored: result.restored,
        conflictsOverridden: result.conflicts.map((conflict) => conflict.path),
        failed: result.verified.filter((verification) => !verification.ok),
        aggregatedTaskIds: projected.taskIds,
      });
      if (!result.ok) {
        throw new ProductFailure(
          productError('CHG_ROLLBACK_INCOMPLETE', {
            userMessage:
              'Some files could not be restored; snapshots are kept for manual recovery. See the timeline for details.',
            context: { failed: result.verified.filter((verification) => !verification.ok) },
          }),
        );
      }
      context.verifications.markAllStale(taskId);
      return { status: 'ok', task: this.safeSettleToIdle(taskId), restored: result.restored };
    }
    const changes = context.changes;
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
    // ADR-0032: the rollback settles every unsettled turn; the Session stays
    // a live conversation on its restored workspace.
    this.settleRuns(taskId, 'rolled_back');
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
    this.contextForTask(taskId).verifications.markAllStale(taskId);
    return { status: 'ok', task: this.safeSettleToIdle(taskId), restored: report.restored };
  }

  /**
   * ADR-0032 (P2): roll back exactly one turn — newest settled turn only, so
   * the ledger unwinds in order and never leaves holes. Restores every path
   * the turn's agent tool calls touched to its recorded state at the turn
   * boundary (byte-exact from the blob store); user review edits and other
   * turns are untouched. Conflicts (files changed outside the turn since)
   * stop it unless forced.
   */
  async rollbackTurn(
    taskId: string,
    runId: string,
    options: { force?: boolean } = {},
  ): Promise<
    | { status: 'ok'; task: TaskDto; restored: string[] }
    | { status: 'conflicts'; task: TaskDto; conflicts: Array<{ path: string; reason: string }> }
  > {
    const task = this.getTask(taskId);
    if (!['REVIEW_READY', 'IDLE'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_ROLLBACKABLE', {
          userMessage: `A turn cannot be rolled back while the Session is ${task.state}.`,
        }),
      );
    }
    // Newest-first: the latest finished, not-already-rolled-back run.
    const latest = this.db
      .prepare(
        "SELECT id, review_state FROM agent_runs WHERE task_id = ? AND ended_at IS NOT NULL AND (review_state IS NULL OR review_state != 'rolled_back') ORDER BY started_at DESC LIMIT 1",
      )
      .get(taskId) as { id: string; review_state: string | null } | undefined;
    if (!latest || latest.id !== runId) {
      throw new ProductFailure(
        productError('TURN_NOT_LATEST', {
          userMessage:
            'Only the newest settled turn can be rolled back — turns unwind newest-first.',
        }),
      );
    }
    const changes = this.db
      .prepare(
        'SELECT fc.relative_path, fc.kind, fc.before_hash, fc.after_hash, fc.rename_to FROM file_changes fc JOIN tool_calls tc ON tc.id = fc.tool_call_id WHERE tc.run_id = ? ORDER BY fc.created_at, fc.id',
      )
      .all(runId) as Array<{
      relative_path: string;
      kind: string;
      before_hash: string | null;
      after_hash: string | null;
      rename_to: string | null;
    }>;

    // Fold the turn's change log: first-seen = the boundary state to restore,
    // last-written = the state the disk should still be in (conflict guard).
    const beforeState = new Map<string, string | null>();
    const afterState = new Map<string, string | null>();
    const firstSeen = (path: string, before: string | null): void => {
      if (!beforeState.has(path)) beforeState.set(path, before);
    };
    for (const change of changes) {
      switch (change.kind) {
        case 'created':
          firstSeen(change.relative_path, null);
          afterState.set(change.relative_path, change.after_hash);
          break;
        case 'deleted':
          firstSeen(change.relative_path, change.before_hash);
          afterState.set(change.relative_path, null);
          break;
        case 'renamed':
          firstSeen(change.relative_path, change.before_hash);
          afterState.set(change.relative_path, null);
          if (change.rename_to) {
            firstSeen(change.rename_to, null);
            afterState.set(change.rename_to, change.after_hash);
          }
          break;
        default:
          firstSeen(change.relative_path, change.before_hash);
          afterState.set(change.relative_path, change.after_hash);
      }
    }
    const targets = [...beforeState.entries()].map(([path, toHash]) => ({
      path,
      toHash,
      expectedCurrentHash: afterState.get(path) ?? null,
    }));

    if (targets.length > 0) {
      const result = await this.contextForTask(taskId).changes.rollbackToStates(targets, {
        force: options.force ?? false,
      });
      if (result.conflicts.length > 0 && !(options.force ?? false)) {
        this.recordEvent(taskId, 'rollback.blocked', {
          runId,
          conflicts: result.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
        });
        return {
          status: 'conflicts',
          task: this.getTask(taskId),
          conflicts: result.conflicts.map((c) => ({ path: c.path, reason: c.reason })),
        };
      }
      if (!result.ok) {
        throw new ProductFailure(
          productError('CHG_ROLLBACK_INCOMPLETE', {
            userMessage:
              'Some files could not be restored to the turn boundary; snapshots are kept for manual recovery.',
            context: { failed: result.verified.filter((v) => !v.ok) },
          }),
        );
      }
      this.settleRuns(taskId, 'rolled_back', runId);
      this.recordEvent(taskId, 'turn.rolledBack', {
        runId,
        restored: result.restored,
        conflictsOverridden: result.conflicts.map((c) => c.path),
      });
      const revision = await this.codeRevision(taskId);
      if (revision) this.contextForTask(taskId).verifications.markStale(taskId, revision);
      return { status: 'ok', task: this.safeSettleToIdle(taskId), restored: result.restored };
    }
    // A chat-only turn: nothing on disk — settling the ledger is the rollback.
    this.settleRuns(taskId, 'rolled_back', runId);
    this.recordEvent(taskId, 'turn.rolledBack', { runId, restored: [], conflictsOverridden: [] });
    return { status: 'ok', task: this.safeSettleToIdle(taskId), restored: [] };
  }

  /** ADR-0032: land on IDLE from any settle-eligible state (historic ACCEPTED
   * rows route through ROLLED_BACK semantics — they stay terminal). */
  private safeSettleToIdle(taskId: string): TaskDto {
    const state = this.getTask(taskId).state;
    if (state === 'IDLE') return this.getTask(taskId);
    if (state === 'ACCEPTED') return this.setState(taskId, 'ROLLED_BACK');
    try {
      return this.setState(taskId, 'IDLE');
    } catch {
      // Historic states without an IDLE edge keep their legacy exit.
      return this.setState(taskId, 'ROLLED_BACK');
    }
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
      const { changeSet: cs } = await this.projectedReviewChangeSet(taskId);
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

  /**
   * Agent-touched file marks for tree/tab decorations (ADR-0013 amendment):
   * derived from the product's own change records, so they work without git.
   * Rolled-back/cancelled/archived tasks drop out; worktree tasks count only
   * once merged (ACCEPTED) — before that the main tree is untouched.
   */
  agentFileMarks(): Array<{ path: string; mark: 'A' | 'M' | 'D' | 'R' }> {
    const ws = this.workspace.current;
    if (!ws) return [];
    const rows = this.db
      .prepare(
        `SELECT fc.relative_path AS path, fc.kind AS kind, fc.rename_to AS renameTo,
                fb.existed AS existed
         FROM file_changes fc
         JOIN tasks t ON t.id = fc.task_id
         LEFT JOIN file_baselines fb
           ON fb.task_id = fc.task_id AND fb.relative_path = fc.relative_path
         WHERE t.workspace_id = ?
           AND t.archived = 0
           AND t.state NOT IN ('ROLLED_BACK', 'CANCELLED')
           AND (t.worktree_json IS NULL OR t.state = 'ACCEPTED')
         ORDER BY fc.created_at ASC`,
      )
      .all(ws.id) as Array<{
      path: string;
      kind: string;
      renameTo: string | null;
      existed: number | null;
    }>;
    const marks = new Map<string, 'A' | 'M' | 'D' | 'R'>();
    for (const row of rows) {
      if (row.kind === 'deleted') {
        marks.set(row.path, 'D');
      } else if (row.kind === 'renamed' && row.renameTo) {
        marks.set(row.renameTo, 'R');
        marks.set(row.path, 'D');
      } else if (row.kind === 'created') {
        marks.set(row.path, 'A');
      } else {
        // modified — but a file the task itself created stays A.
        const current = marks.get(row.path);
        marks.set(row.path, current === 'A' || row.existed === 0 ? 'A' : 'M');
      }
    }
    return [...marks.entries()].map(([path, mark]) => ({ path, mark }));
  }

  /** Suggested worktree setup command from the project's lockfiles (ADR-0009 am.2). */
  async suggestWorktreeSetup(): Promise<string | null> {
    const ws = this.workspace.current;
    if (!ws) return null;
    const { promises: fsp } = await import('node:fs');
    const { join } = await import('node:path');
    const has = async (name: string): Promise<boolean> =>
      Boolean(await fsp.stat(join(ws.canonicalPath, name)).catch(() => null));
    if (await has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
    if (await has('bun.lockb')) return 'bun install';
    if (await has('yarn.lock')) return 'yarn install --frozen-lockfile';
    if (await has('package-lock.json')) return 'npm ci';
    if (await has('package.json')) return 'npm install';
    if (await has('uv.lock')) return 'uv sync';
    if (await has('requirements.txt')) return 'pip install -r requirements.txt';
    if (await has('Cargo.toml')) return 'cargo fetch';
    if (await has('go.mod')) return 'go mod download';
    return null;
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
      worktree: row.worktree_json
        ? (() => {
            const wt = JSON.parse(row.worktree_json!) as TaskWorktree;
            // Missing = deleted externally; the room degrades honestly (ADR-0009 am.2).
            return { ...wt, missing: !existsSync(wt.path) };
          })()
        : null,
      external: row.external_json
        ? (() => {
            // Defensive read-side normalization: a single legacy row with an
            // out-of-vocabulary status must never invalidate a whole
            // task.list response (migration 7 repairs stored rows; this
            // guards restored backups and future drift the same way).
            const external = JSON.parse(row.external_json!) as NonNullable<TaskDto['external']>;
            if (external.status !== 'active' && external.status !== 'ended') {
              return { ...external, status: 'ended' as const };
            }
            return external;
          })()
        : null,
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

  /** Rename any managed or external Session and notify every open renderer. */
  renameTask(taskId: string, title: string): TaskDto {
    const row = this.getRow(taskId);
    const cleaned = title.trim();
    if (!cleaned || cleaned.length > 300) {
      throw new ProductFailure(
        productError('TASK_TITLE_INVALID', {
          userMessage: 'Session names must contain between 1 and 300 characters.',
        }),
      );
    }
    if (row.title === cleaned) return this.rowToDto(row);
    this.db
      .prepare('UPDATE tasks SET title = ?, updated_at = ? WHERE id = ?')
      .run(cleaned, new Date().toISOString(), taskId);
    const task = this.getTask(taskId);
    broadcast('task.stateChanged', { taskId, state: task.state, task });
    this.terminalControl?.publishSnapshot();
    return task;
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
  activity(
    taskId: string,
    tail?: number,
    /** Row cap. The dashboard default stays bounded; Replay V3 passes a
     * higher cap so a 10k-event session projects completely (am.8). */
    cap = 5_000,
  ): { items: ActivityItem[]; total: number } {
    const rows = this.db
      .prepare(
        'SELECT id, sequence, type, schema_version, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY sequence LIMIT ?',
      )
      .all(taskId, cap) as Array<{
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

  /** Content evidence for one replay frame. Hashes remain authoritative; text
   * is returned only when both sides are non-binary. */
  async changeEvidence(
    taskId: string,
    changeId: string,
  ): Promise<{
    beforeText: string | null;
    afterText: string | null;
    binary: boolean;
  } | null> {
    const record = this.changeRecord(taskId, changeId);
    if (!record) return null;
    const blobs = this.contextForTask(taskId).blobs;
    const before = record.beforeHash ? await blobs.get(record.beforeHash) : null;
    const after = record.afterHash ? await blobs.get(record.afterHash) : null;
    const binary = Boolean((before && detectBinary(before)) || (after && detectBinary(after)));
    return {
      beforeText: before && !binary ? before.toString('utf8') : null,
      afterText: after && !binary ? after.toString('utf8') : null,
      binary,
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
    // The renderer needs the whole projection on the state edge. Sending only
    // `state` left changedFiles/updatedAt/external metadata behind until a
    // follow-up list RPC completed, which made Session badges appear stale.
    const task = this.getTask(taskId);
    broadcast('task.stateChanged', { taskId, state: to, task });
    for (const listener of this.stateChangeListeners) {
      try {
        listener({
          taskId,
          from,
          to,
          title: task.title,
          changedFiles: task.changedFiles,
          mode: task.mode,
        });
      } catch (e) {
        this.logger.warn('state listener failed', {
          error: errorMessage(e),
        });
      }
    }
    return task;
  }

  /** Observe task state transitions (edge-triggered; used by notifications). */
  onStateChanged(
    listener: (info: {
      taskId: string;
      from: TaskState;
      to: TaskState;
      title: string;
      changedFiles: number | null;
      mode: string;
    }) => void,
  ): () => void {
    this.stateChangeListeners.add(listener);
    return () => this.stateChangeListeners.delete(listener);
  }

  // ---------- lifecycle ----------

  /** Capture only completed, user-visible turns plus the source task's current
   * net diff. Internal reasoning, tools and system events never cross this
   * boundary. The snapshot makes queued starts deterministic. */
  private async capturePriorConversations(
    taskIds: string[] | undefined,
  ): Promise<PriorConversationContext[]> {
    const uniqueIds = [...new Set(taskIds ?? [])];
    if (uniqueIds.length > 3) {
      throw new ProductFailure(
        productError('TASK_CONTEXT_REFERENCE_LIMIT', {
          userMessage: 'You can reference up to 3 conversations in one task.',
        }),
      );
    }

    return Promise.all(
      uniqueIds.map(async (sourceTaskId): Promise<PriorConversationContext> => {
        const source = this.getTask(sourceTaskId);
        if (source.external) {
          throw new ProductFailure(
            productError('TASK_CONTEXT_REFERENCE_UNSUPPORTED', {
              userMessage: `“${source.title}” is an external terminal session and has no captured agent conversation.`,
            }),
          );
        }

        const rows = this.db
          .prepare(
            "SELECT type, payload_json, created_at FROM task_events WHERE task_id = ? AND type IN ('user.message', 'agent.message') ORDER BY sequence",
          )
          .all(sourceTaskId) as Array<{
          type: 'user.message' | 'agent.message';
          payload_json: string;
          created_at: string;
        }>;
        const turns = rows.flatMap((row) => {
          const payload = JSON.parse(row.payload_json) as { text?: unknown };
          const text = typeof payload.text === 'string' ? payload.text : '';
          if (!text.trim()) return [];
          return [
            {
              role: row.type === 'user.message' ? ('user' as const) : ('assistant' as const),
              text,
              at: row.created_at,
            },
          ];
        });
        if (turns.length === 0) {
          throw new ProductFailure(
            productError('TASK_CONTEXT_REFERENCE_EMPTY', {
              userMessage: `“${source.title}” does not have a completed conversation to reference yet.`,
            }),
          );
        }

        let latestDiff: string | null = null;
        try {
          const changeSet = await this.contextForTask(sourceTaskId).changes.changeSet(sourceTaskId);
          const patches = changeSet.files.flatMap((file) =>
            file.diff && file.diff.trim().length > 0 ? [file.diff] : [],
          );
          if (patches.length > 0) latestDiff = patches.join('\n');
        } catch (error) {
          // Conversation text is still valid if an old worktree/diff is no
          // longer readable. Keep the reference and record the omission.
          this.logger.warn('referenced task diff unavailable', {
            sourceTaskId,
            error: errorMessage(error),
          });
        }

        return {
          sourceTaskId,
          title: source.title,
          projectName: source.projectName,
          projectPath: source.projectPath,
          turns,
          latestDiff,
          capturedAt: new Date().toISOString(),
        };
      }),
    );
  }

  private savePriorConversations(taskId: string, contexts: PriorConversationContext[]): void {
    const insert = this.db.prepare(
      `INSERT INTO task_conversation_references
       (task_id, position, source_task_id, source_title, source_project_name, source_project_path, turns_json, latest_diff, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    contexts.forEach((context, position) => {
      insert.run(
        taskId,
        position,
        context.sourceTaskId,
        context.title,
        context.projectName,
        context.projectPath,
        JSON.stringify(context.turns),
        context.latestDiff,
        context.capturedAt,
      );
    });
  }

  private priorConversations(taskId: string): PriorConversationContext[] {
    const rows = this.db
      .prepare(
        `SELECT source_task_id, source_title, source_project_name, source_project_path,
                turns_json, latest_diff, captured_at
         FROM task_conversation_references WHERE task_id = ? ORDER BY position`,
      )
      .all(taskId) as Array<{
      source_task_id: string;
      source_title: string;
      source_project_name: string;
      source_project_path: string;
      turns_json: string;
      latest_diff: string | null;
      captured_at: string;
    }>;
    return rows.map((row) => ({
      sourceTaskId: row.source_task_id,
      title: row.source_title,
      projectName: row.source_project_name,
      projectPath: row.source_project_path,
      turns: JSON.parse(row.turns_json) as PriorConversationContext['turns'],
      latestDiff: row.latest_diff,
      capturedAt: row.captured_at,
    }));
  }

  async createTask(input: CreateTaskInput): Promise<TaskDto> {
    const priorConversations = await this.capturePriorConversations(input.conversationRefTaskIds);
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
    let setupResult: import('./worktree-service.js').WorktreeSetupResult | null = null;
    if (input.isolation === 'worktree') {
      worktree = await this.worktrees.create(project.canonicalPath, project.id, id, input.title);
      // Optional supply step (ADR-0009 am.2): a fresh checkout has no deps or
      // gitignored config — run the user's setup command before the agent starts.
      const setupCommand = input.worktreeSetup?.trim();
      if (setupCommand) {
        setupResult = await this.worktrees.runSetup(worktree.path, setupCommand);
        if (!setupResult.ok) {
          await this.worktrees.discard(project.canonicalPath, worktree);
          throw new ProductFailure(
            productError('WT_SETUP_FAILED', {
              userMessage: `Worktree setup failed (${setupCommand}): ${setupResult.outputTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`,
              retryable: true,
            }),
          );
        }
      }
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
    this.db.transaction(() => {
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
      this.savePriorConversations(id, priorConversations);
    });
    this.recordEvent(id, 'task.created', {
      title: input.title,
      mode: input.mode,
      model: input.model,
      acceptance: input.acceptance,
      gitBaseline,
      project: { name: project.displayName, path: project.canonicalPath },
      worktree,
      conversationRefs: priorConversations.map((context) => ({
        taskId: context.sourceTaskId,
        title: context.title,
        projectName: context.projectName,
        turnCount: context.turns.length,
        hasDiff: context.latestDiff !== null,
      })),
    });
    if (setupResult) {
      this.recordEvent(id, 'worktree.setup', { ...setupResult });
    }
    this.logger.info('task created', {
      id,
      mode: input.mode,
      project: project.canonicalPath,
      worktree: worktree?.branch ?? null,
    });
    return this.getTask(id);
  }

  // ---------- external CLI sessions (ADR-0017) ----------

  /** Durable projection of the worker fleet attached to one commander task. */
  orchestrationFleetForTask(taskId: string): HistoricalOrchestrationWorker[] {
    const commander = this.getTask(taskId);
    const rows = this.db
      .prepare(
        "SELECT type, payload_json FROM task_events WHERE task_id = ? AND type IN ('orchestration.workerCreated','orchestration.workerBound','orchestration.workerKilled') ORDER BY sequence",
      )
      .all(taskId) as Array<{ type: string; payload_json: string }>;
    const events = rows.flatMap((row): HistoricalOrchestrationEvent[] => {
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
        return [{ type: row.type, payload: payload as Record<string, unknown> }];
      } catch {
        return [];
      }
    });
    const externalRows = this.db
      .prepare(`${TASK_SELECT} WHERE t.external_json IS NOT NULL ORDER BY t.updated_at DESC`)
      .all() as unknown as TaskRow[];
    const externalTasks = externalRows.flatMap((row): HistoricalExternalTask[] => {
      const task = this.rowToDto(row);
      if (!task.external) return [];
      return [
        {
          taskId: task.id,
          title: task.title,
          projectPath: task.projectPath,
          external: task.external,
        },
      ];
    });
    return projectHistoricalOrchestrationFleet(events, externalTasks, commander.projectPath);
  }

  /**
   * Rebuild the current parent-child edge for daemon-backed PTYs after main
   * process restart. Event sequences are task-local, so insertion order is
   * used to resolve a worker that was later moved to another commander.
   */
  liveOrchestrationWorkers(liveTerminalIds: Iterable<string>): HistoricalLiveOrchestrationWorker[] {
    const liveIds = new Set(liveTerminalIds);
    if (liveIds.size === 0) return [];

    const taskRows = this.db.prepare(TASK_SELECT).all() as unknown as TaskRow[];
    const tasks = taskRows.map((row) => this.rowToDto(row));
    const projectPathByTask = new Map(tasks.map((task) => [task.id, task.projectPath]));
    const externalTasks = tasks.flatMap((task): HistoricalExternalTask[] => {
      if (!task.external) return [];
      return [
        {
          taskId: task.id,
          title: task.title,
          projectPath: task.projectPath,
          external: task.external,
        },
      ];
    });
    const externalByTaskId = new Map(externalTasks.map((task) => [task.taskId, task]));
    const externalByTerminal = new Map<string, HistoricalExternalTask>();
    for (const task of externalTasks) {
      if (!externalByTerminal.has(task.external.terminalId)) {
        externalByTerminal.set(task.external.terminalId, task);
      }
    }

    const rows = this.db
      .prepare(
        "SELECT rowid, task_id, type, payload_json FROM task_events WHERE type IN ('orchestration.workerCreated','orchestration.workerBound','orchestration.workerKilled','orchestration.workerTurnStarted','orchestration.workerTurnSettled','orchestration.workerExited') ORDER BY created_at, rowid",
      )
      .all() as Array<{ rowid: number; task_id: string; type: string; payload_json: string }>;
    const workers = new Map<
      string,
      {
        commanderTaskId: string;
        commanderTerminalId: string | null;
        workerTaskId: string | null;
        terminalId: string;
        launch: string;
        root: string | null;
        title: string | null;
        idempotencyKey: string | null;
        turnPending: boolean;
      }
    >();
    for (const row of rows) {
      let payload: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(row.payload_json) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed historical events must not block the remaining fleet.
      }
      const terminalId = typeof payload?.terminalId === 'string' ? payload.terminalId : null;
      if (!terminalId) continue;
      if (row.type === 'orchestration.workerCreated') {
        const launch = payload?.launch;
        if (typeof launch !== 'string' || !AgentIdSchema.safeParse(launch).success) continue;
        workers.set(terminalId, {
          commanderTaskId: row.task_id,
          commanderTerminalId:
            typeof payload?.commanderTerminalId === 'string' ? payload.commanderTerminalId : null,
          workerTaskId: typeof payload?.workerTaskId === 'string' ? payload.workerTaskId : null,
          terminalId,
          launch,
          root: typeof payload?.root === 'string' ? payload.root : null,
          title: typeof payload?.title === 'string' ? payload.title : null,
          idempotencyKey:
            typeof payload?.idempotencyKey === 'string' ? payload.idempotencyKey : null,
          turnPending: false,
        });
      } else if (row.type === 'orchestration.workerBound') {
        const worker = workers.get(terminalId);
        if (
          worker &&
          worker.commanderTaskId === row.task_id &&
          typeof payload?.workerTaskId === 'string'
        ) {
          worker.workerTaskId = payload.workerTaskId;
        }
      } else if (row.type === 'orchestration.workerKilled') {
        const worker = workers.get(terminalId);
        if (worker?.commanderTaskId === row.task_id) workers.delete(terminalId);
      } else if (row.type === 'orchestration.workerTurnStarted') {
        const worker = workers.get(terminalId);
        if (worker?.commanderTaskId === row.task_id) worker.turnPending = true;
      } else if (
        row.type === 'orchestration.workerTurnSettled' ||
        row.type === 'orchestration.workerExited'
      ) {
        const worker = workers.get(terminalId);
        if (worker?.commanderTaskId === row.task_id) worker.turnPending = false;
      }
    }

    return [...workers.values()].flatMap((worker): HistoricalLiveOrchestrationWorker[] => {
      if (!liveIds.has(worker.terminalId)) return [];
      const externalTask =
        (worker.workerTaskId ? externalByTaskId.get(worker.workerTaskId) : null) ??
        externalByTerminal.get(worker.terminalId);
      const commanderExternal = externalByTaskId.get(worker.commanderTaskId);
      const fallbackRoot = projectPathByTask.get(worker.commanderTaskId) ?? '';
      return [
        {
          commanderTaskId: worker.commanderTaskId,
          commanderTerminalId:
            worker.commanderTerminalId ?? commanderExternal?.external.terminalId ?? null,
          terminalId: worker.terminalId,
          workerTaskId: worker.workerTaskId ?? externalTask?.taskId ?? null,
          launch: worker.launch,
          root: worker.root ?? externalTask?.external.cwd ?? fallbackRoot,
          projectPath: externalTask?.projectPath ?? fallbackRoot,
          title: worker.title ?? externalTask?.title ?? `${worker.launch} worker`,
          ...(worker.idempotencyKey ? { idempotencyKey: worker.idempotencyKey } : {}),
          turnPending: worker.turnPending,
        },
      ];
    });
  }

  /** Create the task row backing an external CLI agent session. */
  async createExternalTask(input: {
    cli: string;
    terminalId: string;
    cwd: string;
    projectPath: string;
    /** Preserve an originating task worktree so accounting stays on that mount. */
    worktree?: TaskWorktree | null;
    /** Create a fresh task-owned worktree before the visible CLI starts. */
    isolation?: 'none' | 'worktree';
    /** Optional dependency/codegen setup for a newly-created worktree. */
    worktreeSetup?: string;
    /** Omitted means capture the entry snapshot here; null means no snapshot. */
    snapshotRef?: string | null;
    /** The user's first message names the session; null keeps the placeholder. */
    title?: string | null;
  }): Promise<TaskDto> {
    const project = await this.workspaceRowForPath(input.projectPath);
    const now = new Date().toISOString();
    const id = newId('task');
    const title = input.title?.trim() || `${input.cli} · external session`;
    let worktree = input.worktree ?? null;
    let setupResult: import('./worktree-service.js').WorktreeSetupResult | null = null;
    if (!worktree && input.isolation === 'worktree') {
      worktree = await this.worktrees.create(project.canonicalPath, project.id, id, title);
      const setupCommand = input.worktreeSetup?.trim();
      if (setupCommand) {
        setupResult = await this.worktrees.runSetup(worktree.path, setupCommand);
        if (!setupResult.ok) {
          await this.worktrees.discard(project.canonicalPath, worktree);
          throw new ProductFailure(
            productError('WT_SETUP_FAILED', {
              userMessage: `Worktree setup failed (${setupCommand}): ${setupResult.outputTail.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 200)}`,
              retryable: true,
            }),
          );
        }
      }
    }
    const accountingRoot = worktree?.path ?? project.canonicalPath;
    const cwd = worktree?.path ?? input.cwd;
    let gitBaseline: { head: string | null; branch: string | null } | null = null;
    let snapshotRef = input.snapshotRef;
    if (project.isGitRepo) {
      try {
        const git = new GitService(accountingRoot);
        gitBaseline = await git.headInfo();
        if (snapshotRef === undefined) snapshotRef = await git.snapshotTree();
      } catch {
        gitBaseline = null;
        if (snapshotRef === undefined) snapshotRef = null;
      }
    }
    if (snapshotRef === undefined) snapshotRef = null;
    const external = {
      cli: input.cli,
      terminalId: input.terminalId,
      cwd,
      snapshotRef,
      status: 'active' as const,
      captureGrade: 'observed' as const,
      sessionId: null,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, goal_md, acceptance_json, mode, state, model_json, verification_json, git_baseline_json, worktree_json, external_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ask', 'READY', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project.id,
        title,
        `External \`${input.cli}\` session in an embedded terminal (unmanaged — outside the Tool Gateway). Changes are tracked by the workspace watcher against the entry snapshot.`,
        JSON.stringify([]),
        JSON.stringify({ providerId: 'external', modelId: input.cli }),
        JSON.stringify([]),
        gitBaseline ? JSON.stringify(gitBaseline) : null,
        worktree ? JSON.stringify(worktree) : null,
        JSON.stringify(external),
        now,
        now,
      );
    this.recordEvent(id, 'task.created', {
      title,
      mode: 'ask',
      model: { providerId: 'external', modelId: input.cli },
      acceptance: [],
      gitBaseline,
      project: { name: project.displayName, path: project.canonicalPath },
      worktree,
      external,
    });
    this.recordEvent(id, 'external.sessionStarted', {
      cli: input.cli,
      terminalId: input.terminalId,
      snapshotRef,
    });
    if (setupResult) this.recordEvent(id, 'worktree.setup', { ...setupResult });
    this.hopStates(id, ['EXPLORING', 'IN_PROGRESS']);
    this.logger.info('external session task created', {
      id,
      cli: input.cli,
      project: project.canonicalPath,
      worktree: worktree?.path ?? null,
      snapshot: snapshotRef,
    });
    return this.getTask(id);
  }

  /** Bind a prepared external task to the PTY created for it. Preparation is
   * intentionally separate so the worktree exists before TerminalManager
   * chooses the CLI cwd, while the actual launch remains one IPC operation. */
  bindExternalTaskTerminal(taskId: string, terminalId: string): TaskDto {
    const row = this.getRow(taskId);
    const external = row.external_json
      ? (JSON.parse(row.external_json) as NonNullable<TaskDto['external']>)
      : null;
    if (!external || external.status !== 'active') {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'The prepared external Session is no longer available.',
        }),
      );
    }
    this.db
      .prepare('UPDATE tasks SET external_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...external, terminalId }), new Date().toISOString(), taskId);
    this.recordEvent(taskId, 'external.sessionTerminalBound', {
      cli: external.cli,
      terminalId,
    });
    return this.getTask(taskId);
  }

  /** Best-effort cleanup when PTY creation fails after worktree preparation. */
  async abortPreparedExternalTask(taskId: string): Promise<void> {
    try {
      this.finishExternalSession(taskId, 0);
      // Preparation/setup may have touched the fresh checkout. A failed PTY
      // launch must discard those bytes, never merge them into the project.
      await this.rollbackTask(taskId);
      await this.deleteTask(taskId);
    } catch (error) {
      this.logger.warn('prepared external Session cleanup failed', {
        taskId,
        error: errorMessage(error),
      });
    }
  }

  /** External session ended: freeze the count, land in REVIEW_READY (never auto-accept). */
  finishExternalSession(
    taskId: string,
    changedFiles: number,
    captureGrade?: 'structured' | 'observed',
  ): TaskDto {
    const row = this.getRow(taskId);
    const external = row.external_json
      ? (JSON.parse(row.external_json) as NonNullable<TaskDto['external']>)
      : null;
    if (external && external.status !== 'ended') {
      this.db
        .prepare(
          'UPDATE tasks SET external_json = ?, changed_files = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify({
            ...external,
            status: 'ended',
            captureGrade: captureGrade ?? external.captureGrade ?? 'observed',
          }),
          changedFiles,
          new Date().toISOString(),
          taskId,
        );
      this.recordEvent(taskId, 'external.sessionEnded', {
        cli: external.cli,
        changedFiles,
        captureGrade: captureGrade ?? external.captureGrade ?? 'observed',
      });
    }
    const task = this.getTask(taskId);
    // On restart, markOrphanedRunsInterrupted runs before the external-session
    // sweep. External CLIs never resume through AgentHost, so their stranded
    // task must still close into review instead of exposing the generic,
    // guaranteed-to-fail task.start recovery action.
    if (['IN_PROGRESS', 'INTERRUPTED', 'FAILED'].includes(task.state)) {
      return this.setState(taskId, 'REVIEW_READY');
    }
    return task;
  }

  /**
   * Record the CLI-native conversation id (ADR-0017 amendment): resume can
   * then target this exact session instead of the directory's most recent.
   */
  setExternalSessionId(taskId: string, sessionId: string): void {
    const row = this.getRow(taskId);
    const external = row.external_json
      ? (JSON.parse(row.external_json) as NonNullable<TaskDto['external']>)
      : null;
    if (!external || external.sessionId === sessionId) return;
    this.db
      .prepare('UPDATE tasks SET external_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...external, sessionId }), new Date().toISOString(), taskId);
    this.recordEvent(taskId, 'external.observation', {
      cli: external.cli,
      captureGrade: external.captureGrade ?? 'observed',
      kind: 'state',
      label: 'Conversation id recorded',
      detail: `Resume targets this exact ${external.cli} session (${sessionId}).`,
      status: 'ok',
      evidenceKinds: ['result'],
    });
  }

  /**
   * ADR-0038: every CLI conversation id Charter already owns, lowercased,
   * mapped to its task. Archaeology dedupes against this so a session started
   * inside a product terminal is never re-listed as "discovered". A session id
   * recorded on several tasks (resumes) resolves to the live task, never an
   * archived duplicate — the fold in external-session-index.ts owns that rule.
   */
  externalSessionIndex(): Map<string, string> {
    const rows = this.db
      .prepare(
        'SELECT id, external_json, archived, updated_at FROM tasks WHERE external_json IS NOT NULL',
      )
      .all() as ExternalSessionRow[];
    return buildExternalSessionIndex(rows);
  }

  /** External transcripts explicitly removed from Charter. The source files
   * remain owned by their external Agent, but archaeology must not resurrect them as
   * new untracked Sessions after Charter's task ledger has been deleted. */
  deletedExternalSessionKeys(): Set<string> {
    const rows = this.db
      .prepare('SELECT cli, session_id FROM deleted_external_sessions')
      .all() as Array<{ cli: string; session_id: string }>;
    return new Set(rows.map((row) => `${row.cli}:${row.session_id.toLowerCase()}`));
  }

  /** Active task identity for a daemon PTY that survived an Electron restart. */
  activeExternalTaskForTerminal(terminalId: string): TaskDto | null {
    const rows = this.db
      .prepare(`${TASK_SELECT} WHERE t.external_json IS NOT NULL ORDER BY t.updated_at DESC`)
      .all() as unknown as TaskRow[];
    for (const row of rows) {
      const external = JSON.parse(row.external_json!) as NonNullable<TaskDto['external']>;
      if (external.status === 'active' && external.terminalId === terminalId) {
        return this.rowToDto(row);
      }
    }
    return null;
  }

  /**
   * Name an external session after its first user message. The row-refresh
   * broadcast reuses task.stateChanged (the renderer's generic task upsert
   * channel); the state itself is unchanged.
   */
  setExternalTitle(taskId: string, title: string): void {
    const row = this.getRow(taskId);
    const cleaned = title.trim();
    if (!row.external_json || !cleaned || row.title === cleaned) return;
    this.renameTask(taskId, cleaned);
  }

  /** The most recent user-authored request in a Session. Mission promotion
   * uses this instead of the external task's accounting placeholder so the
   * durable team inherits the actual outcome the Agent just understood. */
  latestUserMessage(taskId: string): string | null {
    this.getTask(taskId);
    const row = this.db
      .prepare(
        "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'user.message' ORDER BY sequence DESC LIMIT 1",
      )
      .get(taskId) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload_json) as { text?: unknown };
      return typeof payload.text === 'string' && payload.text.trim() ? payload.text.trim() : null;
    } catch {
      return null;
    }
  }

  /**
   * Ended claude/codex tasks without a conversation id (predate capture, or
   * stranded by a quit) — candidates for startup transcript backfill. Bounded
   * to recent work: older sessions resume via the legacy most-recent flag.
   */
  externalTasksMissingSessionId(): Array<{
    taskId: string;
    cli: string;
    cwd: string;
    createdAtMs: number;
    updatedAtMs: number;
  }> {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(`${TASK_SELECT} WHERE t.external_json IS NOT NULL AND t.updated_at >= ?`)
      .all(cutoff) as unknown as TaskRow[];
    const out: Array<{
      taskId: string;
      cli: string;
      cwd: string;
      createdAtMs: number;
      updatedAtMs: number;
    }> = [];
    for (const row of rows) {
      const external = JSON.parse(row.external_json!) as NonNullable<TaskDto['external']>;
      if (external.sessionId) continue;
      if (external.status !== 'ended') continue;
      if (!AgentIdSchema.safeParse(external.cli).success) continue;
      out.push({
        taskId: row.id,
        cli: external.cli,
        cwd: external.cwd ?? row.project_path,
        createdAtMs: Date.parse(row.created_at),
        updatedAtMs: Date.parse(row.updated_at),
      });
    }
    return out;
  }

  /** Promote an external task once a provider JSON stream is positively observed. */
  updateExternalCaptureGrade(taskId: string, captureGrade: 'structured' | 'observed'): void {
    const row = this.getRow(taskId);
    const external = row.external_json
      ? (JSON.parse(row.external_json) as NonNullable<TaskDto['external']>)
      : null;
    if (!external || external.captureGrade === captureGrade) return;
    this.db
      .prepare('UPDATE tasks SET external_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...external, captureGrade }), new Date().toISOString(), taskId);
  }

  /** Re-open an ended external CLI session in a terminal, keeping one Task baseline. */
  resumeExternalSession(taskId: string, terminalId: string): TaskDto {
    const row = this.getRow(taskId);
    const external = row.external_json
      ? (JSON.parse(row.external_json) as NonNullable<TaskDto['external']>)
      : null;
    if (!external) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'This task is not an external terminal session.',
        }),
      );
    }
    const task = this.getTask(taskId);
    // ADR-0032: a settled (IDLE) external Session is a live conversation —
    // it resumes against the SAME task baseline like the unsettled trio.
    if (!['REVIEW_READY', 'IDLE', 'INTERRUPTED', 'FAILED'].includes(task.state)) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_NOT_RESUMABLE', {
          userMessage: `The ${external.cli} session cannot resume from ${task.state}.`,
        }),
      );
    }
    const resumed = { ...external, terminalId, status: 'active' as const };
    this.db
      .prepare('UPDATE tasks SET external_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(resumed), new Date().toISOString(), taskId);
    this.recordEvent(taskId, 'external.sessionResuming', {
      cli: external.cli,
      terminalId,
      strategy: external.sessionId ? 'session-id' : 'manifest-fallback',
      captureGrade: external.captureGrade ?? 'observed',
    });
    return this.setState(taskId, 'IN_PROGRESS');
  }

  /** ADR-0017: sweep external tasks stranded mid-session by an app quit. */
  recoverExternalTasks(liveTerminalIds: ReadonlySet<string> = new Set()): void {
    const rows = this.db
      .prepare(`${TASK_SELECT} WHERE t.external_json IS NOT NULL`)
      .all() as unknown as TaskRow[];
    for (const row of rows) {
      const external = JSON.parse(row.external_json!) as NonNullable<TaskDto['external']>;
      if (external.status === 'active' && liveTerminalIds.has(external.terminalId)) continue;
      // Older builds could persist a split-brain row: process tracking had
      // already written external.status=ended, then generic orphan recovery
      // projected the Task itself as INTERRUPTED. Normalize both active
      // orphans and those historical ended/incomplete rows on every startup.
      const needsRecovery =
        external.status === 'active' ||
        (external.status === 'ended' &&
          ['IN_PROGRESS', 'INTERRUPTED', 'FAILED'].includes(row.state));
      if (!needsRecovery) continue;
      try {
        this.finishExternalSession(row.id, row.changed_files ?? 0);
        this.logger.info('external session recovered to review', { taskId: row.id });
      } catch (e) {
        this.logger.warn('external session recovery failed', {
          taskId: row.id,
          error: errorMessage(e),
        });
      }
    }
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
  async startTask(
    taskId: string,
    prompt?: string,
    extras?: LaunchExtras,
  ): Promise<{ task: TaskDto; queued: boolean }> {
    const task = this.getTask(taskId);
    // ADR-0017: external sessions run in their terminal, never on the agent host.
    if (task.external) {
      throw new ProductFailure(
        productError('TASK_EXTERNAL', {
          userMessage: `This task is an external ${task.external.cli} session — talk to it in its terminal instead.`,
        }),
      );
    }
    if (!['READY', 'IDLE', 'INTERRUPTED', 'REVIEW_READY', 'FAILED'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_NOT_STARTABLE', {
          userMessage: `The task cannot start from state ${task.state}.`,
        }),
      );
    }
    if (this.host.activeRunCount() + this.launching >= this.runCapacity()) {
      this.startQueue.push({ taskId, prompt, ...(extras ? { extras } : {}) });
      this.recordEvent(taskId, 'task.queued', { reason: 'all agent slots are busy' });
      return { task, queued: true };
    }
    await this.launch(taskId, prompt, extras);
    return { task: this.getTask(taskId), queued: false };
  }

  /** Launches admitted but not yet registered with the host (capacity accounting). */
  private launching = 0;

  private async launch(taskId: string, prompt?: string, extras?: LaunchExtras): Promise<void> {
    this.launching += 1;
    try {
      await this.doLaunch(taskId, prompt, extras);
    } finally {
      this.launching -= 1;
    }
  }

  private async doLaunch(taskId: string, prompt?: string, extras?: LaunchExtras): Promise<void> {
    const task = this.getTask(taskId);
    // ADR-0009: the task executes against its own mounted context — its
    // worktree or its project root — independent of the focused workspace.
    const context = this.contextForTask(taskId);
    const kind = this.runtimeKind();
    // Mock runs force a mock model only when the task was created against a
    // real provider — a task already on a mock model keeps it (ADR-0016 lets
    // replies pick mock-2, and the run record must stay honest).
    const model: ModelRef =
      kind === 'mock' && task.model.providerId !== 'mock'
        ? { providerId: 'mock', modelId: 'mock-1' }
        : task.model;

    await this.host.ensure(kind);

    // Session: reuse existing ref when possible.
    let ref = this.sessionRefs.get(taskId);
    if (ref) {
      // ADR-0016: sessions outlive runs with their creation-time model —
      // re-assert the task's current model so a reply-time override survives
      // the idle restart. A session the worker lost is recreated below.
      try {
        await this.host.setSessionModel(ref.sessionId, model);
      } catch (e) {
        this.logger.warn('session model re-assert failed; recreating session', {
          taskId,
          error: errorMessage(e),
        });
        this.sessionRefs.delete(taskId);
        ref = undefined;
      }
    }
    let createdSession = false;
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
      createdSession = true;
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

    const initialTurn = prompt === undefined;
    const userText = prompt ?? task.goalMd;
    const runtimeText = prompt ?? this.initialPrompt(task);
    const priorConversations = this.priorConversations(taskId);
    this.recordEvent(taskId, 'user.message', {
      text: userText,
      // Acceptance criteria are system/task context. Keep them attached to the
      // event for presentation without making them look like words the user
      // typed into the conversation.
      ...(initialTurn ? { acceptance: task.acceptance } : {}),
      conversationRefs: priorConversations.map((context) => ({
        taskId: context.sourceTaskId,
        title: context.title,
        projectName: context.projectName,
        turnCount: context.turns.length,
        hasDiff: context.latestDiff !== null,
      })),
      ...(extras?.previewMeta ? { preview: extras.previewMeta } : {}),
      ...(extras?.codeRefs?.length ? { codeRefs: extras.codeRefs } : {}),
      ...(extras?.fileRefs?.length ? { fileRefs: fileRefsForEventPayload(extras.fileRefs) } : {}),
      ...(extras?.artifactRefs?.length ? { artifactRefs: extras.artifactRefs } : {}),
    });
    this.setState(taskId, task.state === 'READY' ? 'EXPLORING' : 'IN_PROGRESS');

    const refreshedSkills = createdSession ? '' : this.skills.preambleBlock();
    // ADR-0028: reused sessions keep their original preamble, so rules
    // distilled since then would be invisible — refresh them per run too.
    const refreshedRules = createdSession ? null : (this.memory?.projectRulesBlock(taskId) ?? null);
    // ADR-0037: explicit `/skill:` runs bypass load_skill — ledger them here.
    const expandedCommand = this.skills.expandCommandDetailed(runtimeText);
    this.recordSkillInvocation(expandedCommand.skill, taskId);
    this.host.startRun(
      taskId,
      {
        sessionRef: ref,
        runId,
        // ADR-0015: a leading `/skill:name` expands to the skill's instructions
        // (the timeline keeps the user's original text above).
        // Reused runtime sessions keep their original system preamble. Refresh
        // the derived skill catalog on each later run so linked-source changes
        // are visible without recreating the conversation session.
        prompt: [
          ...(refreshedSkills
            ? [`<skill_catalog_refresh>\n${refreshedSkills}\n</skill_catalog_refresh>`]
            : []),
          ...(refreshedRules ? [refreshedRules] : []),
          formatPromptWithArtifactFeedback(
            formatPromptWithFileContext(
              formatPromptWithCodeContext(expandedCommand.text, extras?.codeRefs ?? []),
              extras?.fileRefs ?? [],
            ),
            extras?.artifactRefs ?? [],
          ),
        ].join('\n\n'),
        ...(extras?.images?.length ? { images: extras.images } : {}),
        priorConversations,
      },
      this.orchestrationByTask.get(taskId) ?? null,
    );
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
          : task.mode === 'full'
            ? 'You are in FULL AUTO mode: your actions run without user approval and the result is applied automatically when you finish. Work carefully and verify your changes — nobody reviews them before they land. Product-forbidden actions are still blocked; a denial is final for that call.'
            : 'You are in AUTO mode: recognized low-risk actions run automatically; higher-risk actions pause for user approval. A denial is final for that call.';
    const planRule =
      task.mode === 'ask'
        ? null
        : 'Before your FIRST file modification, call propose_plan with your step-by-step plan and wait for the decision. The user may edit the plan or request changes — follow the version returned in the tool result, and keep step statuses current with update_plan.';
    const skillsBlock = this.skills.preambleBlock();
    // ADR-0028: distilled project rules ride every managed run (never throws;
    // reads the project's current .charter/rules.md and records the injection).
    const rulesBlock = this.memory?.projectRulesBlock(task.id) ?? null;
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
      ...(this.settings.effective.orchestration.enabled ? [CHARTER_ORCHESTRATION_PREAMBLE] : []),
      // ADR-0015: enabled, model-invocable skills (loading goes through the
      // audited load_skill tool; explicit-only skills stay out of this list).
      ...(skillsBlock ? [skillsBlock] : []),
      ...(rulesBlock ? [rulesBlock] : []),
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

  async steerOrQueue(
    taskId: string,
    text: string,
    during: 'steer' | 'followUp',
    model?: ModelRef,
    /** ADR-0022: preview-gate feedback — screenshot for the model + event meta. */
    attachments?: LaunchExtras,
  ): Promise<'steered' | 'queued' | 'started'> {
    // ADR-0016: a reply may re-point the task's model/effort for the next turn.
    // Applied BEFORE the message so a failed switch rejects the send loudly.
    if (model) await this.applyModelOverride(taskId, model);
    // ADR-0028: a review request-fix (steer carrying review-origin code refs)
    // is a decision-grade correction — capture it as a rule candidate.
    if (text.trim().length > 0 && attachments?.codeRefs?.some((ref) => ref.origin === 'review')) {
      this.memory?.captureCorrection({ taskId, kind: 'request-fix', text });
    }
    const runId = this.runsByTask.get(taskId);
    const task = this.getTask(taskId);
    if (runId && isRunningState(task.state as TaskState)) {
      this.recordEvent(taskId, 'user.message', {
        text,
        kind: during,
        ...(attachments?.previewMeta ? { preview: attachments.previewMeta } : {}),
        ...(attachments?.codeRefs?.length ? { codeRefs: attachments.codeRefs } : {}),
        ...(attachments?.fileRefs?.length
          ? { fileRefs: fileRefsForEventPayload(attachments.fileRefs) }
          : {}),
        ...(attachments?.artifactRefs?.length ? { artifactRefs: attachments.artifactRefs } : {}),
      });
      // ADR-0019: active-session replies also receive the current linked
      // catalog; explicit commands are expanded from the same live revision.
      const currentSkills = this.skills.preambleBlock();
      // ADR-0028: rules distilled mid-run reach the very next turn.
      const currentRules = this.memory?.projectRulesBlock(taskId) ?? null;
      // ADR-0037: explicit `/skill:` replies bypass load_skill — ledger them.
      const expandedCommand = this.skills.expandCommandDetailed(text);
      this.recordSkillInvocation(expandedCommand.skill, taskId);
      const expanded = [
        ...(currentSkills
          ? [`<skill_catalog_refresh>\n${currentSkills}\n</skill_catalog_refresh>`]
          : []),
        ...(currentRules ? [currentRules] : []),
        formatPromptWithArtifactFeedback(
          formatPromptWithFileContext(
            formatPromptWithCodeContext(expandedCommand.text, attachments?.codeRefs ?? []),
            attachments?.fileRefs ?? [],
          ),
          attachments?.artifactRefs ?? [],
        ),
      ].join('\n\n');
      if (during === 'steer') this.host.steer(runId, expanded, attachments?.images);
      else this.host.followUp(runId, expanded, attachments?.images);
      return during === 'steer' ? 'steered' : 'queued';
    }
    // ADR-0032: only archived (and historic terminal) Sessions refuse
    // messages; IDLE is the settled conversation waiting for the next one.
    if (!['READY', 'IDLE', 'INTERRUPTED', 'REVIEW_READY', 'FAILED'].includes(task.state)) {
      throw new ProductFailure(
        productError('TASK_CLOSED', {
          userMessage:
            'This Session is closed (archived) — start a new Session and reference it with @ instead.',
        }),
      );
    }
    // Idle: start a fresh run with this text as the prompt. Failures must not
    // vanish (a swallowed rejection here read as "typing does nothing").
    void this.startTask(taskId, text, attachments).catch((e) => {
      this.logger.warn('reply-start failed', {
        taskId,
        error: errorMessage(e),
      });
      this.attention(taskId, 'Your reply could not start a run — open the task and retry.');
    });
    return 'started';
  }

  /**
   * ADR-0016: persist a reply-time model/effort override and apply it to the
   * live session. The task record always names the model that serves the NEXT
   * turn. The runtime switch happens first — if it fails, nothing is persisted
   * and the reply is rejected, so no text is ever sent on the wrong model.
   */
  private async applyModelOverride(taskId: string, model: ModelRef): Promise<void> {
    const current = this.getTask(taskId).model;
    if (
      current.providerId === model.providerId &&
      current.modelId === model.modelId &&
      (current.thinkingLevel ?? null) === (model.thinkingLevel ?? null)
    ) {
      return;
    }
    const ref = this.sessionRefs.get(taskId);
    if (ref && !this.host.alive) {
      // The session died with the worker; the next launch recreates it.
      this.sessionRefs.delete(taskId);
    } else if (ref) {
      try {
        await this.host.setSessionModel(ref.sessionId, model);
      } catch (e) {
        if (e instanceof ProductFailure && e.error.code === 'AG_SESSION_NOT_FOUND') {
          // Restarted worker no longer knows the session: drop the stale ref —
          // the next launch recreates the session with the new model.
          this.sessionRefs.delete(taskId);
        } else {
          throw e;
        }
      }
    }
    this.db
      .prepare('UPDATE tasks SET model_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(model), new Date().toISOString(), taskId);
    this.recordEvent(taskId, 'task.modelChanged', { model, note: 'applies from the next turn' });
    this.logger.info('task model overridden', {
      taskId,
      provider: model.providerId,
      model: model.modelId,
      effort: model.thinkingLevel ?? null,
    });
  }

  /** ADR-0032: archive is the Session's only close. Worktree merge-back moved
   * here from accept — the tree must survive earlier turns, so its net
   * changes reach the main tree exactly once, when the conversation ends. */
  async archive(
    taskId: string,
    options: { confirmConflicts?: boolean } = {},
  ): Promise<
    | { status: 'archived'; task: TaskDto }
    | { status: 'conflicts'; task: TaskDto; conflicts: Array<{ path: string; reason: string }> }
  > {
    const task = this.getTask(taskId);
    if (isRunningState(task.state as TaskState)) {
      throw new ProductFailure(
        productError('TASK_RUNNING', {
          userMessage: 'Stop the running turn before archiving this Session.',
        }),
      );
    }
    if (task.worktree && existsSync(task.worktree.path)) {
      const context = this.contextForTask(taskId);
      const cs = await context.changes.changeSet(taskId);
      if (cs.files.length > 0) {
        const conflicts = await this.worktrees.mergeBackPreflight(task.projectPath, cs);
        if (conflicts.length > 0 && !options.confirmConflicts) {
          this.recordEvent(taskId, 'merge.blocked', { conflicts });
          return { status: 'conflicts', task: this.getTask(taskId), conflicts };
        }
        const { merged } = await this.worktrees.mergeBack(task.projectPath, context.root, cs);
        this.recordEvent(taskId, 'task.mergedBack', {
          files: merged,
          branch: task.worktree.branch,
          conflictsOverridden: conflicts.map((c) => c.path),
        });
      }
      await this.worktrees.discard(task.projectPath, task.worktree as TaskWorktree);
      this.contexts.drop(context.root);
    }
    if (task.state !== 'ARCHIVED') {
      try {
        this.setState(taskId, 'ARCHIVED');
      } catch {
        // States without an ARCHIVED edge (READY/DRAFT…) keep their state;
        // the archived flag below still closes the Session.
      }
    }
    this.db
      .prepare('UPDATE tasks SET archived = 1, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), taskId);
    return { status: 'archived', task: this.getTask(taskId) };
  }

  /** Permanently remove one settled Session and its complete Charter ledger.
   * Project files are never touched. A dirty isolated worktree must first be
   * archived (merge back) or rolled back so a compact rail action cannot
   * silently destroy unmerged work. */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (isRunningState(task.state as TaskState) || task.external?.status === 'active') {
      throw new ProductFailure(
        productError('TASK_RUNNING', {
          userMessage: 'Stop the running Session before deleting it.',
        }),
      );
    }

    let worktree: TaskWorktree | null = null;
    let worktreeRoot: string | null = null;
    if (task.worktree && existsSync(task.worktree.path)) {
      const context = this.contextForTask(taskId);
      const changes = await context.changes.changeSet(taskId);
      if (changes.files.length > 0) {
        throw new ProductFailure(
          productError('TASK_DELETE_UNMERGED_CHANGES', {
            userMessage:
              'This Session still has unmerged worktree changes. Archive it to keep the changes, or roll them back before deleting.',
          }),
        );
      }
      worktree = task.worktree as TaskWorktree;
      worktreeRoot = context.root;
    }

    const externalSessionId = task.external?.sessionId?.toLowerCase() ?? null;
    const externalCli = task.external?.cli ?? null;
    this.db.transaction(() => {
      if (externalSessionId && externalCli && AgentIdSchema.safeParse(externalCli).success) {
        this.db
          .prepare(
            `INSERT INTO deleted_external_sessions (cli, session_id, deleted_at)
             VALUES (?, ?, ?)
             ON CONFLICT(cli, session_id) DO UPDATE SET deleted_at = excluded.deleted_at`,
          )
          .run(externalCli, externalSessionId, new Date().toISOString());
      }

      const statements: Array<{ sql: string; params?: string[] }> = [
        {
          sql: `DELETE FROM permission_decisions
                WHERE task_id = ?
                   OR request_id IN (SELECT id FROM permission_requests WHERE task_id = ?)`,
          params: [taskId, taskId],
        },
        { sql: 'DELETE FROM permission_requests WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM file_changes WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM file_baselines WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM verification_runs WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM tool_calls WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM agent_runs WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM agent_sessions WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM task_events WHERE task_id = ?', params: [taskId] },
        {
          sql: 'DELETE FROM task_conversation_references WHERE task_id = ? OR source_task_id = ?',
          params: [taskId, taskId],
        },
        { sql: 'DELETE FROM memory_rule_injections WHERE task_id = ?', params: [taskId] },
        { sql: 'DELETE FROM skill_invocations WHERE task_id = ?', params: [taskId] },
        {
          sql: 'UPDATE memory_rule_stats SET source_task_id = NULL, source_label = NULL WHERE source_task_id = ?',
          params: [taskId],
        },
        { sql: 'DELETE FROM tasks WHERE id = ?', params: [taskId] },
      ];
      for (const statement of statements) {
        this.db.prepare(statement.sql).run(...(statement.params ?? []));
      }
    });

    this.sessionRefs.delete(taskId);
    this.runsByTask.delete(taskId);
    this.orchestrationByTask.delete(taskId);
    this.planRecords.delete(taskId);
    for (let index = this.startQueue.length - 1; index >= 0; index -= 1) {
      if (this.startQueue[index]?.taskId === taskId) this.startQueue.splice(index, 1);
    }

    if (worktree) {
      try {
        await this.worktrees.discard(task.projectPath, worktree);
      } catch (error) {
        // The Session is already gone. Startup orphan sweeping will retry the
        // filesystem cleanup, so surface this only in diagnostics.
        this.logger.warn('deleted Session left a clean worktree for orphan cleanup', {
          taskId,
          error: errorMessage(error),
        });
      }
      if (worktreeRoot) this.contexts.drop(worktreeRoot);
    }

    broadcast('task.deleted', { taskId });
    this.logger.info('Session permanently deleted', {
      taskId,
      externalTranscriptSuppressed: Boolean(externalSessionId && externalCli),
    });
  }

  /** ADR-0032: the Session's turn ledger — one row per agent run with its
   * settlement, prompt excerpt and per-turn change stats (derived from the
   * run → tool_calls → file_changes chain; verification by time window). */
  turns(taskId: string): TurnDto[] {
    this.getTask(taskId); // TASK_NOT_FOUND for unknown ids
    const runs = this.db
      .prepare(
        'SELECT id, state, model, started_at, ended_at, review_state, reviewed_at FROM agent_runs WHERE task_id = ? ORDER BY started_at, id',
      )
      .all(taskId) as Array<{
      id: string;
      state: string;
      model: string | null;
      started_at: string;
      ended_at: string | null;
      review_state: string | null;
      reviewed_at: string | null;
    }>;
    const promptStmt = this.db.prepare(
      "SELECT payload_json FROM task_events WHERE task_id = ? AND type = 'user.message' AND created_at >= ? AND (? IS NULL OR created_at < ?) ORDER BY sequence LIMIT 1",
    );
    const changesStmt = this.db.prepare(
      'SELECT fc.relative_path, fc.patch FROM file_changes fc JOIN tool_calls tc ON tc.id = fc.tool_call_id WHERE tc.run_id = ?',
    );
    const verificationStmt = this.db.prepare(
      "SELECT state, COUNT(*) AS n FROM verification_runs WHERE task_id = ? AND created_at >= ? AND (? IS NULL OR created_at < ?) AND state IN ('passed','failed','timeout') GROUP BY state",
    );
    return runs.map((run, index) => {
      const nextStart = runs[index + 1]?.started_at ?? null;
      const promptRow = promptStmt.get(taskId, run.started_at, nextStart, nextStart) as
        { payload_json: string } | undefined;
      let prompt = '';
      if (promptRow) {
        try {
          const payload = JSON.parse(promptRow.payload_json) as { text?: string };
          prompt = (payload.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        } catch {
          /* keep empty */
        }
      }
      const changeRows = changesStmt.all(run.id) as Array<{
        relative_path: string;
        patch: string | null;
      }>;
      const paths = new Set<string>();
      let additions = 0;
      let deletions = 0;
      for (const change of changeRows) {
        paths.add(change.relative_path);
        const stats = countPatchLines(change.patch);
        additions += stats.additions;
        deletions += stats.deletions;
      }
      const verificationRows = verificationStmt.all(
        taskId,
        run.started_at,
        nextStart,
        nextStart,
      ) as Array<{ state: string; n: number }>;
      const passed = verificationRows.find((row) => row.state === 'passed')?.n ?? 0;
      const failed = verificationRows
        .filter((row) => row.state === 'failed' || row.state === 'timeout')
        .reduce((sum, row) => sum + row.n, 0);
      const reviewState = (run.review_state ?? 'pending') as TurnDto['reviewState'];
      return {
        runId: run.id,
        index: index + 1,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        runState: run.state,
        reviewState,
        reviewedAt: run.reviewed_at,
        prompt,
        model: run.model,
        changedFiles: paths.size,
        additions,
        deletions,
        verification: passed + failed > 0 ? { passed, failed } : null,
      };
    });
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
      // ADR-0011: thinking is presentation-only — streamed live, persisted as a
      // collapsed timeline block, excluded from reports/evidence. A settings
      // switch drops it entirely.
      case 'thinking.delta':
        if (this.settings.effective.agent.showThinking) {
          broadcast('task.streamThinking', {
            taskId,
            runId,
            messageId: event.messageId,
            delta: event.text,
          });
        }
        break;
      case 'thinking.completed':
        if (this.settings.effective.agent.showThinking && event.text.trim().length > 0) {
          this.recordEvent(taskId, 'agent.thinking', {
            messageId: event.messageId,
            text: event.text,
            durationMs: event.durationMs,
          });
        }
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
        // A plan rejection already settled the turn (IDLE, ADR-0032; CANCELLED
        // on historic rows) — keep the settled state.
        if (!['CANCELLED', 'IDLE'].includes(this.getTask(taskId).state)) {
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
          error: errorMessage(e),
        });
      }
    }
  }

  /** Emit the final report, then settle or park the turn (§6.1 as amended by
   * ADR-0032): change-making turns go to REVIEW_READY (never auto-ACCEPTED
   * outside Full mode); zero-change turns settle as `answered` straight back
   * to the IDLE conversation — a chat reply needs no review gate. */
  private async finalizeRun(taskId: string, runId: string): Promise<void> {
    try {
      const task = this.getTask(taskId);
      if (task.state === 'EXPLORING') {
        // Ask flow: EXPLORING → IN_PROGRESS → … (§6.1 exact hops).
        this.setState(taskId, 'IN_PROGRESS');
      }
      const successfulWrite = this.db
        .prepare(
          `SELECT 1 AS found FROM tool_calls
           WHERE run_id = ? AND state = 'SUCCEEDED'
             AND name IN ('apply_patch','create_file','delete_file','rename_file')
           LIMIT 1`,
        )
        .get(runId) as { found: number } | undefined;
      const failedWriteCount = this.unresolvedFailedWritesForRun(runId);
      // Make the final report and the state transition observe the same current
      // verification truth. The audit callback also invalidates asynchronously,
      // but completion must not race that background projection.
      if (successfulWrite) {
        const revision = await this.codeRevision(taskId);
        if (revision) this.contextForTask(taskId).verifications.markStale(taskId, revision);
      }
      const reportOutcome = failedWriteCount > 0 ? 'failed' : 'completed';
      const report = await this.buildFinalReportData(taskId, runId, reportOutcome);
      // ADR-0009: record the net changed-file count — zero-change turns get the
      // light "Answered" settlement.
      let changedFiles = ((report.changed as { files?: number } | undefined)?.files ?? 0) | 0;
      let diskChangedFiles: number | null = null;
      if (changedFiles === 0 && (successfulWrite || failedWriteCount > 0)) {
        try {
          const durable = await this.contextForTask(taskId).changes.changeSetFromDisk(taskId);
          diskChangedFiles = durable.files.length;
          if (durable.files.length > 0) {
            report.changed = {
              files: durable.files.length,
              additions: durable.totalAdditions,
              deletions: durable.totalDeletions,
              list: durable.files.map((file) => ({
                path: file.path,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
              })),
            };
            changedFiles = durable.files.length;
          }
        } catch {
          // The disposition below fails closed when reconciliation is unavailable.
        }
      }
      this.db.prepare('UPDATE tasks SET changed_files = ? WHERE id = ?').run(changedFiles, taskId);
      if (failedWriteCount > 0) {
        this.recordEvent(taskId, 'system.diagnostic', {
          code: 'RUN_WRITE_FAILED',
          detail: `Latest request did not complete: ${failedWriteCount} file action${failedWriteCount === 1 ? '' : 's'} failed. The Agent's message is an unverified narrative; use the recorded tool result and Diff as the source of truth.`,
        });
      }
      this.recordEvent(taskId, 'report.final', report);
      // ADR-0032: nothing to review — settle this turn as answered and keep
      // the conversation open. Earlier unsettled turns keep their pending
      // review (visible in the rail turn list).
      const disposition = completionDisposition({
        projectedChangedFiles: changedFiles,
        successfulWrite: successfulWrite !== undefined,
        failedWrite: failedWriteCount > 0,
        diskChangedFiles,
      });
      if (disposition === 'failed') {
        this.safeTransition(taskId, 'FAILED');
        return;
      }
      if (disposition === 'answered') {
        this.settleRuns(taskId, 'answered', runId);
        this.safeTransition(taskId, 'IDLE');
        return;
      }
      const current = this.getTask(taskId).state;
      if (current === 'VERIFYING') this.setState(taskId, 'REVIEW_READY');
      else this.safeTransition(taskId, 'REVIEW_READY');
      // ADR-0012: Full autonomy applies the result automatically — with honest
      // fallbacks. Verification failures and merge conflicts keep the task in
      // REVIEW_READY for a human.
      if (task.mode === 'full' && this.getTask(taskId).state === 'REVIEW_READY') {
        await this.autoAcceptFullTask(taskId);
      }
    } catch (e) {
      this.logger.error('finalize run failed', {
        taskId,
        error: errorMessage(e),
      });
      this.safeTransition(taskId, 'REVIEW_READY');
    }
  }

  /** Full mode (ADR-0012): auto-accept unless the evidence says stop. */
  private async autoAcceptFullTask(taskId: string): Promise<void> {
    try {
      if (this.latestFinalReportOutcome(taskId) === 'failed') {
        this.recordEvent(taskId, 'system.diagnostic', {
          code: 'AUTO_APPLY_SKIPPED',
          detail: 'Auto-apply paused: the latest request contains a failed file action.',
        });
        this.attention(taskId, 'Auto-apply paused: a file action failed — review the changes.');
        return;
      }
      const context = this.contextForTask(taskId);
      const runs = context.verifications.listForTask(taskId);
      const failed = runs.filter((r) => r.state === 'failed' || r.state === 'timeout');
      if (failed.length > 0) {
        this.recordEvent(taskId, 'system.diagnostic', {
          code: 'AUTO_APPLY_SKIPPED',
          detail: `Auto-apply paused: ${failed.length} verification run(s) failed — review the changes.`,
        });
        this.attention(taskId, 'Auto-apply paused: verification failed — review the changes.');
        return;
      }
      const result = await this.acceptTask(taskId, {
        confirmUnverified: true,
        actor: 'system:full-auto',
      });
      if (result.status === 'conflicts') {
        // merge.blocked already recorded by acceptTask.
        this.attention(
          taskId,
          'Auto-apply paused: the project changed during the task — resolve the merge.',
        );
      }
    } catch (e) {
      this.logger.warn('full-auto accept failed; task stays in review', {
        taskId,
        error: errorMessage(e),
      });
      this.attention(taskId, 'Auto-apply failed — review the changes.');
    }
  }

  /** Ad-hoc attention ping (full-mode fallbacks) — wired to notifications. */
  private attention(taskId: string, body: string): void {
    const task = this.getTask(taskId);
    for (const listener of this.attentionListeners) {
      try {
        listener({ taskId, title: task.title, body });
      } catch {
        /* observer failures never break the engine */
      }
    }
  }

  private readonly attentionListeners = new Set<
    (info: { taskId: string; title: string; body: string }) => void
  >();

  /** Observe ad-hoc attention pings (ADR-0012 full-mode fallbacks). */
  onAttention(
    listener: (info: { taskId: string; title: string; body: string }) => void,
  ): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
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
    const toolCounts = effectiveRunId
      ? (this.db
          .prepare('SELECT state, COUNT(*) as n FROM tool_calls WHERE run_id = ? GROUP BY state')
          .all(effectiveRunId) as Array<{ state: string; n: number }>)
      : (this.db
          .prepare('SELECT state, COUNT(*) as n FROM tool_calls WHERE task_id = ? GROUP BY state')
          .all(taskId) as Array<{ state: string; n: number }>);
    const deniedCount = toolCounts.find((t) => t.state === 'DENIED')?.n ?? 0;
    const failedCount = toolCounts.find((t) => t.state === 'FAILED')?.n ?? 0;
    const failedWriteCount = effectiveRunId ? this.unresolvedFailedWritesForRun(effectiveRunId) : 0;
    const failedWriteTotal = effectiveRunId
      ? (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM tool_calls
               WHERE run_id = ? AND state = 'FAILED'
                 AND name IN ('apply_patch','create_file','delete_file','rename_file')`,
            )
            .get(effectiveRunId) as { count: number }
        ).count
      : 0;

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
    if (failedWriteCount > 0) {
      unresolvedRisks.push(
        `${failedWriteCount} file action${failedWriteCount === 1 ? '' : 's'} failed in the latest request`,
      );
    }
    if (failedCount > failedWriteTotal) {
      const otherFailedCount = failedCount - failedWriteTotal;
      unresolvedRisks.push(
        `${otherFailedCount} other tool action${otherFailedCount === 1 ? '' : 's'} failed`,
      );
    }
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
      execution: {
        failedToolCalls: failedCount,
        failedWriteCalls: failedWriteCount,
        recoveredWriteFailures: Math.max(0, failedWriteTotal - failedWriteCount),
      },
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
      void this.doLaunch(next.taskId, next.prompt, next.extras)
        .catch((e) => {
          this.logger.error('queued task launch failed', {
            taskId: next.taskId,
            error: errorMessage(e),
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

  /**
   * ADR-0037: explicit `/skill:name` expansions never reach the tool gateway,
   * so they get their own append-only ledger row. Failure is non-fatal — the
   * run must not care whether its usage statistic landed.
   */
  private recordSkillInvocation(skill: string | null, taskId: string): void {
    if (!skill) return;
    try {
      this.db
        .prepare('INSERT INTO skill_invocations (skill, kind, task_id, at) VALUES (?, ?, ?, ?)')
        .run(skill, 'explicit', taskId, new Date().toISOString());
    } catch (e) {
      this.logger.warn('skill invocation ledger write failed', {
        skill,
        error: errorMessage(e),
      });
    }
  }

  /**
   * ADR-0037: per-skill invocation events for Settings → Skills. Model loads
   * come from the tool audit (load_skill), explicit runs from the ledger
   * above; both keyed by the runtime name recorded at call time. Returns raw
   * events — the skills.usage handler merges them with external CLI events
   * and aggregates per consumer (ADR-0040).
   */
  skillUsageEvents(windowDays: number): SkillUsageEvent[] {
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const events: SkillUsageEvent[] = [];
    const toolRows = this.db
      .prepare(
        "SELECT input_json, created_at FROM tool_calls WHERE name = 'load_skill' AND state = 'SUCCEEDED' AND created_at >= ?",
      )
      .all(since) as Array<{ input_json: string; created_at: string }>;
    for (const row of toolRows) {
      try {
        const input = JSON.parse(row.input_json) as { name?: unknown; file?: unknown };
        if (typeof input.name !== 'string') continue;
        // Bundled-reference follow-ups belong to the same use: only the
        // primary SKILL.md load counts as one invocation.
        if (typeof input.file === 'string' && input.file !== 'SKILL.md') continue;
        events.push({ skill: input.name, at: row.created_at });
      } catch {
        // A malformed audit row loses one count, never the whole panel.
      }
    }
    const explicitRows = this.db
      .prepare('SELECT skill, at FROM skill_invocations WHERE at >= ?')
      .all(since) as Array<{ skill: string; at: string }>;
    for (const row of explicitRows) events.push({ skill: row.skill, at: row.at });
    return events;
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
        error: errorMessage(e),
      });
    }
  }

  /**
   * Quit-time teardown (M10/REL): resolve every pending gate BEFORE the
   * database closes, so late worker-exit abort callbacks find nothing to
   * persist. Fixes the "database is not open" crash on quit.
   */
  shutdown(): void {
    this.unsubscribeOrchestrationSettings();
    this.contexts.shutdown('app quit');
    this.cancelAllAsks('app quit');
    this.cancelAllPlanWaits('app quit');
    this.startQueue.length = 0;
  }

  /**
   * ADR-0009 am.2: startup hygiene — worktree directories whose task is
   * finished (accepted/rolled back/cancelled/archived) or deleted have no
   * further use; failed/interrupted tasks keep theirs for resume/review.
   */
  async sweepWorktreeOrphans(): Promise<void> {
    const keepStates = new Set([
      'READY',
      'EXPLORING',
      'PLANNING',
      'AWAITING_PLAN_APPROVAL',
      'IN_PROGRESS',
      'AWAITING_USER',
      'AWAITING_PERMISSION',
      'VERIFYING',
      'REVIEW_READY',
      'INTERRUPTED',
      'FAILED',
    ]);
    const rows = this.db
      .prepare('SELECT id, state, workspace_id FROM tasks WHERE worktree_json IS NOT NULL')
      .all() as Array<{ id: string; state: string; workspace_id: string }>;
    const keep = new Set(rows.filter((r) => keepStates.has(r.state)).map((r) => r.id));
    const wsRows = this.db.prepare('SELECT id, canonical_path FROM workspaces').all() as Array<{
      id: string;
      canonical_path: string;
    }>;
    const roots = new Map(wsRows.map((r) => [r.id, r.canonical_path]));
    await this.worktrees.sweepOrphans(roots, keep).catch((e) => {
      this.logger.warn('worktree orphan sweep failed', {
        error: errorMessage(e),
      });
    });
  }

  /** Restart-time scan (M10 expands): mark previously-running tasks interrupted. */
  markOrphanedRunsInterrupted(liveExternalTerminalIds: ReadonlySet<string> = new Set()): void {
    const interruptedAt = new Date().toISOString();
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
      .run(interruptedAt);
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
    // Verification commands are main-process children. A prior process cannot
    // still own a trustworthy result, so reconcile the durable ledger before
    // projecting interrupted tasks. The parent-death watchdog separately
    // guarantees that the corresponding process group is terminated.
    const interruptedVerifications = this.db
      .prepare(
        "SELECT task_id, COUNT(*) AS count FROM verification_runs WHERE state = 'running' AND ended_at IS NULL GROUP BY task_id",
      )
      .all() as Array<{ task_id: string; count: number }>;
    const interruptedVerificationCount = new Map(
      interruptedVerifications.map((entry) => [entry.task_id, entry.count]),
    );
    this.db
      .prepare(
        `UPDATE verification_runs
         SET state = 'cancelled', cancelled = 1, timed_out = 0, ended_at = ?,
             output_excerpt = CASE
               WHEN COALESCE(output_excerpt, '') = '' THEN ?
               ELSE output_excerpt || char(10) || ?
             END
         WHERE state = 'running' AND ended_at IS NULL`,
      )
      .run(
        interruptedAt,
        'The application exited before verification finished. This result is cancelled and is not trusted.',
        'The application exited before verification finished. This result is cancelled and is not trusted.',
      );
    // ADR-0009: tasks are global — the restart scan covers every project.
    const rows = this.db
      .prepare(
        "SELECT id, state, external_json FROM tasks WHERE state IN ('EXPLORING','PLANNING','IN_PROGRESS','AWAITING_USER','AWAITING_PERMISSION','VERIFYING')",
      )
      .all() as Array<{ id: string; state: string; external_json: string | null }>;
    for (const row of rows) {
      if (row.external_json) {
        const external = JSON.parse(row.external_json) as NonNullable<TaskDto['external']>;
        if (external.status === 'active' && liveExternalTerminalIds.has(external.terminalId)) {
          continue;
        }
      }
      this.recordEvent(row.id, 'system.interruptedByRestart', {
        previousState: row.state,
        note: 'The application restarted while this task was running. No action was replayed.',
        cancelledVerificationRuns: interruptedVerificationCount.get(row.id) ?? 0,
      });
      this.safeTransition(row.id, 'INTERRUPTED');
      this.db
        .prepare(
          "UPDATE agent_runs SET state = 'ERROR_WORKER_EXIT', ended_at = ? WHERE task_id = ? AND ended_at IS NULL",
        )
        .run(interruptedAt, row.id);
    }
  }
}
