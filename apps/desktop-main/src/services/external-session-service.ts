import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { GitService } from '@pi-ide/git-service';
import type { TerminalManager } from '@pi-ide/terminal-service';
import { openWorkspaceInfo, WorkspaceWatcher, type FsChange } from '@pi-ide/workspace-service';
import type { ChangeSet } from '@pi-ide/change-service';
import {
  formatPromptWithCodeContext,
  type CodeContextRefDto,
  type TaskWorktreeDto,
} from '@pi-ide/ipc-contracts';
import { broadcast } from '../broadcast.js';
import type { WorkspaceHost } from './workspace-host.js';
import type { TaskService } from './task-service.js';
import { cleanTerminalText, ExternalStructuredReplayParser } from './external-replay-parser.js';
import { discoverCliSessionId, isSafeCliSessionId } from './cli-session-locator.js';
import type { ExternalLaunchIntents } from './external-launch-intents.js';
import { TypedLineTracker } from './typed-line-tracker.js';

/** Paths never attributed to an external session (product/tooling noise). */
const IGNORED_SEGMENTS = ['node_modules', '.git'];
const IGNORED_BASENAMES = ['.DS_Store'];
const IGNORED_PREFIXES = ['.pi-ide-chg.'];
const MAX_TERMINAL_REPLAY_BYTES = 2 * 1024 * 1024;
const TERMINAL_EVENT_CHARS = 12_000;
// 1s of true quiet is enough: interactive TUIs animate a spinner continuously
// while working, so output only settles once the reply is really finished.
// The previous 1.8s read as "the notification lags the agent" in field use.
const OBSERVED_REPLY_QUIET_MS = 1_000;
/** First-prompt delivery: the TUI is treated as ready once its paint settles. */
const PROMPT_SETTLE_QUIET_MS = 600;
/** …and delivered regardless after this, so a quiet TUI never swallows it. */
const PROMPT_DELIVERY_DEADLINE_MS = 8_000;
/**
 * The Enter must be its own PTY write: a CR in the same chunk as a bracketed
 * paste is treated by TUI paste handling as pasted text — the exact "typed
 * but never sent" failure this path exists to prevent.
 */
const PROMPT_ENTER_DELAY_MS = 250;

function countPatchLines(patch: string | null): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch?.split('\n') ?? []) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

export function isAccountablePath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  if (parts.some((p) => IGNORED_SEGMENTS.includes(p))) return false;
  const base = parts[parts.length - 1] ?? '';
  if (IGNORED_BASENAMES.includes(base)) return false;
  if (IGNORED_PREFIXES.some((p) => base.startsWith(p))) return false;
  return true;
}

export interface ExternalSessionSnapshot {
  terminalId: string;
  taskId: string;
  cli: string;
  snapshotRef: string | null;
  status: 'active' | 'ended';
  captureGrade: 'structured' | 'observed';
  files: Array<{
    path: string;
    status: 'created' | 'modified' | 'deleted' | 'renamed';
    additions: number;
    deletions: number;
  }>;
}

interface LiveSession {
  terminalId: string;
  taskId: string;
  cli: string;
  root: string;
  /** The directory the CLI ran in — where its transcripts are keyed. */
  cwd: string;
  startedAtMs: number;
  /** CLI-native conversation id once established (stream or transcript). */
  sessionId: string | null;
  isGitRepo: boolean;
  snapshotRef: string | null;
  git: GitService | null;
  watcher: WorkspaceWatcher;
  unsubscribe: () => void;
  seen: Set<string>;
  recomputeTimer: ReturnType<typeof setTimeout> | null;
  terminalFlushTimer: ReturnType<typeof setTimeout> | null;
  terminalBuffer: string;
  terminalBytes: number;
  terminalTruncated: boolean;
  /** Presence-only heuristic for interactive TUIs without structured turns. */
  presenceTimer: ReturnType<typeof setTimeout> | null;
  presenceAwaitingReply: boolean;
  presenceSawOutput: boolean;
  /** Composer first prompt awaiting a ready TUI (product launch intent). */
  pendingPrompt: string | null;
  promptSettleTimer: ReturnType<typeof setTimeout> | null;
  promptDeadlineTimer: ReturnType<typeof setTimeout> | null;
  promptEnterTimer: ReturnType<typeof setTimeout> | null;
  /** Notification copy: the user message the current reply answers. */
  typedLine: TypedLineTracker;
  lastUserLine: string | null;
  /** >0 while the product itself writes the PTY (prompt/resume injection). */
  suppressInputCapture: number;
  /** Whether this live invocation, rather than an earlier resumed turn, exposed structured data. */
  structuredStream: boolean;
  captureGrade: 'structured' | 'observed';
  parser: ExternalStructuredReplayParser;
  lastFiles: ExternalSessionSnapshot['files'];
  /** Serializes baseline capture; watcher batches can overlap. */
  work: Promise<void>;
  ended: boolean;
}

interface PendingResume {
  taskId: string;
  cli: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: ProductFailure) => void;
}

/**
 * Only known CLIs get a host-written command; custom detected programs stay
 * review-only. With a recorded conversation id the command targets that exact
 * session; without one it degrades to the CLI's most-recent flag (correct only
 * when this task's session really was the directory's latest — the id is the
 * fix for multi-session directories). Ids are PTY-written text: anything but
 * an exact UUID is treated as absent.
 */
export function externalResumeCommand(cli: string, sessionId?: string | null): string | null {
  const id = sessionId && isSafeCliSessionId(sessionId) ? sessionId : null;
  if (cli === 'claude') return id ? `claude --resume ${id}` : 'claude --continue';
  if (cli === 'codex') return id ? `codex resume ${id}` : 'codex resume --last';
  return null;
}

/**
 * External sessions are named by the user's own first message (like Pi
 * sessions), not by a conversation id. First non-empty line, ≤64 chars.
 */
export function externalTitleFromPrompt(prompt: string): string | null {
  const firstLine =
    prompt
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ');
  if (!cleaned) return null;
  return cleaned.length <= 64 ? cleaned : `${cleaned.slice(0, 61)}…`;
}

/**
 * ADR-0017 — external CLI agent sessions. Listens for agent enter/exit on user
 * terminals; on enter snapshots the project (temp-index write-tree), creates
 * the backing task and starts watcher accounting: every touched path gets a
 * baseline from the snapshot blob, so the existing change-set / review /
 * byte-exact rollback machinery works unchanged. On exit the task lands in
 * REVIEW_READY — external work is never auto-accepted.
 */
export class ExternalSessionService {
  private readonly byTerminal = new Map<string, LiveSession>();
  private readonly pendingResumes = new Map<string, PendingResume>();
  private readonly unsubscribeManager: () => void;
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeInput: () => void;

  constructor(
    private readonly terminals: TerminalManager,
    private readonly tasks: TaskService,
    private readonly workspace: WorkspaceHost,
    private readonly logger: Logger,
    /** ADR-0017 amendment: product-launch intents registered by terminal.create. */
    private readonly launchIntents: ExternalLaunchIntents | null = null,
  ) {
    this.unsubscribeManager = terminals.onAgentState(({ id, agent, cwd }) => {
      if (agent) void this.onAgentEnter(id, agent, cwd);
      else void this.onAgentExit(id);
    });
    this.unsubscribeData = terminals.onDataEvent(({ id, data }) => this.onTerminalData(id, data));
    this.unsubscribeInput = terminals.onInputEvent(({ id, data }) =>
      this.onTerminalInput(id, data),
    );
    // App-quit strandings: close them out into review on startup.
    tasks.recoverExternalTasks();
    // Best-effort: give ended sessions that predate session-id capture (or
    // were stranded by a quit) their conversation id so resume can target them.
    void this.backfillSessionIds();
  }

  private async backfillSessionIds(): Promise<void> {
    let recovered = 0;
    for (const task of this.tasks.externalTasksMissingSessionId()) {
      const sessionId = await discoverCliSessionId({
        cli: task.cli,
        cwd: task.cwd,
        startedAtMs: task.createdAtMs,
        endedAtMs: task.updatedAtMs,
      });
      if (!sessionId) continue;
      try {
        this.tasks.setExternalSessionId(task.taskId, sessionId);
        recovered += 1;
      } catch {
        // task raced away (archived/deleted) — backfill stays best-effort
      }
    }
    if (recovered > 0) {
      this.logger.info('external session ids backfilled', { count: recovered });
    }
  }

  /** Active sessions for renderer state restore. */
  list(): ExternalSessionSnapshot[] {
    return [...this.byTerminal.values()].map((s) => ({
      terminalId: s.terminalId,
      taskId: s.taskId,
      cli: s.cli,
      snapshotRef: s.snapshotRef,
      status: s.ended ? 'ended' : 'active',
      captureGrade: s.captureGrade,
      files: s.lastFiles,
    }));
  }

  private onTerminalData(terminalId: string, data: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session || session.ended) return;

    // A painting TUI is a booting TUI — keep deferring the first prompt until
    // its output settles, then deliver (see armPromptDelivery).
    if (session.pendingPrompt) this.notePromptReadiness(session);

    const parsed = session.parser.feed(session.cli, data);
    // Structured streams reveal the conversation id directly — record it the
    // moment it appears so even a crash leaves the task resumable by id.
    if (session.parser.sessionId && session.sessionId !== session.parser.sessionId) {
      session.sessionId = session.parser.sessionId;
      this.tasks.setExternalSessionId(session.taskId, session.sessionId);
    }
    if (parsed.structured && !session.structuredStream) {
      session.structuredStream = true;
      this.clearObservedPresence(session);
      if (session.captureGrade !== 'structured') {
        session.captureGrade = 'structured';
        this.tasks.updateExternalCaptureGrade(session.taskId, 'structured');
        this.tasks.recordEvent(session.taskId, 'external.observation', {
          cli: session.cli,
          captureGrade: 'structured',
          kind: 'state',
          label: `${session.cli} structured event stream detected`,
          detail:
            'Tool calls, results and provider lifecycle events can now be replayed semantically.',
          status: 'ok',
          evidenceKinds: ['tool', 'result'],
        });
        void this.publish(session, 'active');
      }
    }
    for (const observation of parsed.observations) {
      this.tasks.recordEvent(session.taskId, 'external.observation', {
        cli: session.cli,
        captureGrade: session.captureGrade,
        ...observation,
      });
      // ADR-0021: structured turn boundaries (Codex turn.completed / Claude
      // result) become terminal blocks. Observed-grade sessions never get
      // fabricated turns — their enter/exit edges are the only block marks.
      if (observation.kind === 'report' && observation.evidenceKinds.includes('result')) {
        broadcast('external.turn', {
          terminalId,
          taskId: session.taskId,
          label: observation.label,
          status: observation.status === 'error' ? 'error' : 'ok',
          lastUserMessage: session.lastUserLine
            ? externalTitleFromPrompt(session.lastUserLine)
            : null,
        });
      }
    }

    this.noteObservedOutput(session, data);

    this.bufferTerminalText(session, parsed.terminalText);
  }

  /**
   * A submitted input is the only safe edge on which to arm the observed TUI
   * fallback. Startup redraws and background terminal noise therefore never
   * masquerade as completed agent output.
   */
  private onTerminalInput(terminalId: string, data: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session || session.ended) return;
    // Typed-line capture (notification copy only). Product-owned writes skip
    // it: their text is known exactly and set by the writer itself.
    if (session.suppressInputCapture === 0) {
      const committed = session.typedLine.feed(data);
      if (committed) session.lastUserLine = committed;
    }
    if (session.structuredStream) return;
    if (!/[\r\n]/.test(data)) return;
    if (session.presenceTimer) clearTimeout(session.presenceTimer);
    session.presenceTimer = null;
    session.presenceAwaitingReply = true;
    session.presenceSawOutput = false;
  }

  /** PTY write from the product itself — invisible to typed-line capture. */
  private writeProduct(session: LiveSession, data: string): void {
    session.suppressInputCapture += 1;
    try {
      this.terminals.write(session.terminalId, data);
    } finally {
      session.suppressInputCapture -= 1;
    }
  }

  private noteObservedOutput(session: LiveSession, data: string): void {
    if (
      session.structuredStream ||
      !session.presenceAwaitingReply ||
      !cleanTerminalText(data).replace(/\s/g, '')
    ) {
      return;
    }
    session.presenceSawOutput = true;
    if (session.presenceTimer) clearTimeout(session.presenceTimer);
    session.presenceTimer = setTimeout(() => {
      session.presenceTimer = null;
      if (
        session.ended ||
        session.structuredStream ||
        !session.presenceAwaitingReply ||
        !session.presenceSawOutput
      ) {
        return;
      }
      session.presenceAwaitingReply = false;
      session.presenceSawOutput = false;
      broadcast('external.activitySettled', {
        terminalId: session.terminalId,
        taskId: session.taskId,
        quietMs: OBSERVED_REPLY_QUIET_MS,
        lastUserMessage: session.lastUserLine
          ? externalTitleFromPrompt(session.lastUserLine)
          : null,
      });
    }, OBSERVED_REPLY_QUIET_MS);
    session.presenceTimer.unref?.();
  }

  private clearObservedPresence(session: LiveSession): void {
    if (session.presenceTimer) clearTimeout(session.presenceTimer);
    session.presenceTimer = null;
    session.presenceAwaitingReply = false;
    session.presenceSawOutput = false;
  }

  /**
   * First-prompt delivery (composer → CLI). Detection only proves the process
   * exists; the TUI becomes paste-ready around its first paint. Deliver once
   * post-enter output has been quiet for a moment, with a hard deadline so a
   * TUI that never paints still receives the prompt instead of dropping it.
   */
  private armPromptDelivery(session: LiveSession, prompt: string): void {
    session.pendingPrompt = prompt;
    session.promptDeadlineTimer = setTimeout(
      () => this.deliverPendingPrompt(session),
      PROMPT_DELIVERY_DEADLINE_MS,
    );
    session.promptDeadlineTimer.unref?.();
    // An already-painted TUI (slow detection) produces no further output —
    // seed one settle window instead of waiting for the deadline.
    this.notePromptReadiness(session);
  }

  private notePromptReadiness(session: LiveSession): void {
    if (session.promptSettleTimer) clearTimeout(session.promptSettleTimer);
    session.promptSettleTimer = setTimeout(
      () => this.deliverPendingPrompt(session),
      PROMPT_SETTLE_QUIET_MS,
    );
    session.promptSettleTimer.unref?.();
  }

  private deliverPendingPrompt(session: LiveSession): void {
    const prompt = session.pendingPrompt;
    session.pendingPrompt = null;
    if (session.promptSettleTimer) clearTimeout(session.promptSettleTimer);
    session.promptSettleTimer = null;
    if (session.promptDeadlineTimer) clearTimeout(session.promptDeadlineTimer);
    session.promptDeadlineTimer = null;
    if (!prompt || session.ended) return;
    this.tasks.recordEvent(session.taskId, 'user.message', { text: prompt, kind: 'external' });
    session.lastUserLine = prompt;
    this.writeProduct(session, `\u001b[200~${prompt}\u001b[201~`);
    session.promptEnterTimer = setTimeout(() => {
      session.promptEnterTimer = null;
      if (!session.ended) this.writeProduct(session, '\r');
    }, PROMPT_ENTER_DELAY_MS);
    session.promptEnterTimer.unref?.();
  }

  private clearPromptDelivery(session: LiveSession): void {
    session.pendingPrompt = null;
    if (session.promptSettleTimer) clearTimeout(session.promptSettleTimer);
    session.promptSettleTimer = null;
    if (session.promptDeadlineTimer) clearTimeout(session.promptDeadlineTimer);
    session.promptDeadlineTimer = null;
    if (session.promptEnterTimer) clearTimeout(session.promptEnterTimer);
    session.promptEnterTimer = null;
  }

  private bufferTerminalText(session: LiveSession, cleaned: string): void {
    if (session.terminalBytes >= MAX_TERMINAL_REPLAY_BYTES) {
      this.noteTerminalTruncation(session);
      return;
    }
    if (!cleaned.trim()) return;
    const remaining = MAX_TERMINAL_REPLAY_BYTES - session.terminalBytes;
    const bytes = Buffer.from(cleaned, 'utf8');
    const accepted =
      bytes.length <= remaining ? cleaned : bytes.subarray(0, remaining).toString('utf8');
    session.terminalBytes += Buffer.byteLength(accepted);
    session.terminalBuffer += accepted;
    if (session.terminalBuffer.length >= TERMINAL_EVENT_CHARS) {
      this.flushTerminal(session);
    } else if (!session.terminalFlushTimer) {
      session.terminalFlushTimer = setTimeout(() => {
        session.terminalFlushTimer = null;
        this.flushTerminal(session);
      }, 750);
      session.terminalFlushTimer.unref?.();
    }
    if (bytes.length > remaining) this.noteTerminalTruncation(session);
  }

  private noteTerminalTruncation(session: LiveSession): void {
    if (session.terminalTruncated) return;
    session.terminalTruncated = true;
    this.tasks.recordEvent(session.taskId, 'external.observation', {
      cli: session.cli,
      captureGrade: session.captureGrade,
      kind: 'system',
      label: 'Terminal replay reached its 2 MB safety limit',
      detail: 'File versions and structured events continue to be recorded.',
      status: 'warn',
      evidenceKinds: ['terminal'],
    });
  }

  private flushTerminal(session: LiveSession): void {
    if (!session.terminalBuffer) return;
    const body = session.terminalBuffer;
    session.terminalBuffer = '';
    this.tasks.recordEvent(session.taskId, 'external.terminal', {
      cli: session.cli,
      captureGrade: session.captureGrade,
      text: body,
    });
  }

  private async onAgentEnter(terminalId: string, cli: string, cwd: string): Promise<void> {
    const pending = this.pendingResumes.get(terminalId);
    if (pending && pending.cli === cli) {
      clearTimeout(pending.timer);
      this.pendingResumes.delete(terminalId);
      const session = this.byTerminal.get(terminalId);
      if (session) {
        broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId: pending.taskId });
        this.logger.info('external session resumed', {
          terminalId,
          cli,
          taskId: pending.taskId,
        });
        pending.resolve();
        return;
      }
    }
    // A stale session on this terminal (previous CLI still open) ends first.
    if (this.byTerminal.has(terminalId)) await this.onAgentExit(terminalId);

    const terminal = this.terminals.list().find((item) => item.id === terminalId);
    const focused = this.workspace.current;
    // vNext terminals carry their server-resolved owner. The focused workspace
    // is only a backward-compatible fallback for sessions created before the
    // metadata existed; it is no longer the accounting boundary.
    const projectPath =
      terminal?.projectPath ??
      (focused && (cwd === focused.canonicalPath || cwd.startsWith(focused.canonicalPath + '/'))
        ? focused.canonicalPath
        : null);
    if (!terminal || !projectPath) {
      // Scratch has no project accounting by design. Detection still decorates
      // the terminal but never claims snapshot/watcher coverage.
      broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId: null });
      this.logger.info('external session without project accounting', {
        terminalId,
        cli,
        cwd,
      });
      return;
    }

    let worktree: TaskWorktreeDto | null = null;
    if (terminal.contextTaskId) {
      try {
        const ownerTask = this.tasks.getTask(terminal.contextTaskId);
        if (ownerTask.worktree && !ownerTask.worktree.missing && ownerTask.worktree.path === cwd) {
          worktree = ownerTask.worktree;
        }
      } catch {
        worktree = null;
      }
    }
    const root = worktree?.path ?? projectPath;
    let rootInfo;
    try {
      rootInfo = await openWorkspaceInfo(root);
    } catch (error) {
      broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId: null });
      this.logger.warn('external session context disappeared before accounting', {
        terminalId,
        root,
        error: errorMessage(error),
      });
      return;
    }
    const git = rootInfo.isGitRepo ? new GitService(root) : null;
    let snapshotRef: string | null = null;
    if (git) {
      try {
        snapshotRef = await git.snapshotTree();
      } catch (e) {
        this.logger.warn('external session snapshot failed; degrading to first-seen baselines', {
          terminalId,
          error: errorMessage(e),
        });
      }
    }

    // Product-launched sessions (composer / New Terminal presets) arrive with
    // an intent: the pre-assigned conversation id and the first prompt. The
    // intent is one-shot — consumed here, on the detection edge it was for.
    const intent = this.launchIntents?.consume(terminalId, cli) ?? null;

    let taskId: string;
    try {
      const task = await this.tasks.createExternalTask({
        cli,
        terminalId,
        cwd,
        projectPath,
        worktree,
        snapshotRef,
        title: intent?.prompt ? externalTitleFromPrompt(intent.prompt) : null,
      });
      taskId = task.id;
    } catch (e) {
      this.logger.warn('external session task creation failed', {
        terminalId,
        error: errorMessage(e),
      });
      broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId: null });
      return;
    }

    const watcher = new WorkspaceWatcher(root);
    const session: LiveSession = {
      terminalId,
      taskId,
      cli,
      root,
      cwd,
      startedAtMs: Date.now(),
      sessionId: null,
      isGitRepo: rootInfo.isGitRepo,
      snapshotRef,
      git,
      watcher,
      unsubscribe: () => {},
      seen: new Set(),
      recomputeTimer: null,
      terminalFlushTimer: null,
      terminalBuffer: '',
      terminalBytes: 0,
      terminalTruncated: false,
      presenceTimer: null,
      presenceAwaitingReply: false,
      presenceSawOutput: false,
      pendingPrompt: null,
      promptSettleTimer: null,
      promptDeadlineTimer: null,
      promptEnterTimer: null,
      typedLine: new TypedLineTracker(),
      lastUserLine: null,
      suppressInputCapture: 0,
      structuredStream: false,
      captureGrade: 'observed',
      parser: new ExternalStructuredReplayParser(),
      lastFiles: [],
      work: Promise.resolve(),
      ended: false,
    };
    session.unsubscribe = watcher.onBatch((changes) => this.onBatch(session, changes));
    watcher.start();
    this.byTerminal.set(terminalId, session);
    const leadIn = this.terminals.recentData(terminalId);
    if (leadIn) this.onTerminalData(terminalId, leadIn);

    if (intent?.sessionId) {
      // Launch pre-assigned the conversation id (`claude --session-id`): the
      // task is resumable by exact id from its very first moment.
      session.sessionId = intent.sessionId;
      this.tasks.setExternalSessionId(taskId, intent.sessionId);
    }
    if (intent?.prompt) this.armPromptDelivery(session, intent.prompt);

    broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId });
    broadcast('external.sessionChanged', {
      taskId,
      terminalId,
      cli,
      status: 'active',
      captureGrade: session.captureGrade,
      snapshotRef,
      files: [],
    });
    this.logger.info('external session started', { terminalId, cli, taskId, snapshotRef });
  }

  private onBatch(session: LiveSession, changes: FsChange[]): void {
    if (session.ended) return;
    const fresh = changes.filter((c) => !c.isDirectory && isAccountablePath(c.relativePath));
    if (fresh.length === 0) return;
    session.work = session.work.then(async () => {
      const context = this.tasks.contextForTask(session.taskId);
      for (const change of fresh) {
        try {
          if (!session.seen.has(change.relativePath)) {
            session.seen.add(change.relativePath);
            if (session.git && session.snapshotRef) {
              const bytes = await session.git.readTreeBlob(
                session.snapshotRef,
                change.relativePath,
              );
              await context.changes.ensureBaselineFromBytes(
                session.taskId,
                change.relativePath,
                bytes,
              );
            } else {
              // Non-git degradation (ADR-0017): first-seen content is the baseline.
              await context.changes.ensureBaseline(session.taskId, change.relativePath);
            }
          }
          const record = await context.changes.recordExternalChange(
            session.taskId,
            change.relativePath,
            change.kind,
          );
          const stats = countPatchLines(record.patch);
          this.tasks.recordEvent(session.taskId, 'external.fileChanged', {
            cli: session.cli,
            captureGrade: session.captureGrade,
            changeId: record.id,
            path: record.relativePath,
            kind: record.kind,
            additions: stats.additions,
            deletions: stats.deletions,
            beforeHash: record.beforeHash,
            afterHash: record.afterHash,
          });
        } catch (e) {
          this.logger.warn('external accounting skipped a path', {
            taskId: session.taskId,
            path: change.relativePath,
            error: errorMessage(e),
          });
        }
      }
    });
    if (!session.recomputeTimer) {
      session.recomputeTimer = setTimeout(() => {
        session.recomputeTimer = null;
        void this.publish(session, 'active');
      }, 300);
      session.recomputeTimer.unref?.();
    }
  }

  private async publish(session: LiveSession, status: 'active' | 'ended'): Promise<void> {
    try {
      await session.work;
      const context = this.tasks.contextForTask(session.taskId);
      const cs: ChangeSet = await context.changes.changeSet(session.taskId);
      session.lastFiles = cs.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      broadcast('external.sessionChanged', {
        taskId: session.taskId,
        terminalId: session.terminalId,
        cli: session.cli,
        status,
        captureGrade: session.captureGrade,
        snapshotRef: session.snapshotRef,
        files: session.lastFiles,
      });
    } catch (e) {
      this.logger.warn('external session publish failed', {
        taskId: session.taskId,
        error: errorMessage(e),
      });
    }
  }

  private async onAgentExit(terminalId: string): Promise<void> {
    const session = this.byTerminal.get(terminalId);
    if (!session) {
      broadcast('terminal.agentState', { id: terminalId, agent: null, taskId: null });
      return;
    }
    // Complete a final partial line through the same structured-data filter.
    this.onTerminalData(terminalId, '\n');
    session.ended = true;
    if (session.terminalFlushTimer) clearTimeout(session.terminalFlushTimer);
    session.terminalFlushTimer = null;
    this.clearObservedPresence(session);
    this.clearPromptDelivery(session);
    this.flushTerminal(session);
    if (session.recomputeTimer) clearTimeout(session.recomputeTimer);
    session.recomputeTimer = null;
    session.unsubscribe();
    session.watcher.dispose();
    this.byTerminal.delete(terminalId);
    await this.publish(session, 'ended');
    // Establish the conversation id before the task closes into review, so a
    // later resume targets THIS session even after newer ones ran in the same
    // directory. Transcript discovery is bounded by this session's lifetime.
    if (!session.sessionId) {
      session.sessionId = await discoverCliSessionId({
        cli: session.cli,
        cwd: session.cwd,
        startedAtMs: session.startedAtMs,
        endedAtMs: Date.now(),
      });
    }
    try {
      if (session.sessionId) this.tasks.setExternalSessionId(session.taskId, session.sessionId);
      this.tasks.finishExternalSession(
        session.taskId,
        session.lastFiles.length,
        session.captureGrade,
      );
    } catch (e) {
      this.logger.warn('external session finish failed', {
        taskId: session.taskId,
        error: errorMessage(e),
      });
    }
    broadcast('terminal.agentState', { id: terminalId, agent: null, taskId: session.taskId });
    this.logger.info('external session ended', {
      terminalId,
      taskId: session.taskId,
      changedFiles: session.lastFiles.length,
    });
  }

  /**
   * User-invoked continuation of an ended Claude/Codex TUI. The command is a
   * fixed product mapping (never renderer-controlled shell text). Accounting
   * resumes against the SAME task baseline; detection confirms the CLI really
   * started before this RPC succeeds.
   */
  async resume(taskId: string, terminalId: string): Promise<{ terminalId: string; cli: string }> {
    const task = this.tasks.getTask(taskId);
    const external = task.external;
    if (!external) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'This task is not an external terminal session.',
        }),
      );
    }
    const command = externalResumeCommand(external.cli, external.sessionId ?? null);
    if (!command) {
      throw new ProductFailure(
        productError('EXTERNAL_RESUME_UNSUPPORTED', {
          userMessage: `${external.cli} does not have a supported session-resume command.`,
        }),
      );
    }
    if (this.byTerminal.has(terminalId) || this.pendingResumes.has(terminalId)) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_ACTIVE', {
          userMessage: `This terminal already has an active external session.`,
        }),
      );
    }
    const terminal = this.terminals.list().find((item) => item.id === terminalId);
    if (!terminal) {
      throw new ProductFailure(
        productError('TERMINAL_NOT_FOUND', {
          userMessage:
            'The original terminal is no longer available. Open a new terminal and try again.',
        }),
      );
    }
    const expectedCwd = external.cwd ?? task.projectPath;
    if (terminal.cwd !== expectedCwd) {
      throw new ProductFailure(
        productError('EXTERNAL_RESUME_CWD_MISMATCH', {
          userMessage: `The resume terminal must start in ${expectedCwd}.`,
        }),
      );
    }

    const git = task.gitBaseline ? new GitService(task.projectPath) : null;
    const watcher = new WorkspaceWatcher(task.projectPath);
    const changeSet = await this.tasks.contextForTask(taskId).changes.changeSet(taskId);
    const session: LiveSession = {
      terminalId,
      taskId,
      cli: external.cli,
      root: task.projectPath,
      cwd: expectedCwd,
      startedAtMs: Date.now(),
      // `claude --resume <id>` continues the SAME conversation id — keep it,
      // so an immediate exit without new transcript writes stays targetable.
      // Codex resume ids are rediscovered from the rollout at next end.
      sessionId:
        external.cli === 'claude' && external.sessionId && isSafeCliSessionId(external.sessionId)
          ? external.sessionId
          : null,
      isGitRepo: git !== null,
      snapshotRef: external.snapshotRef,
      git,
      watcher,
      unsubscribe: () => {},
      seen: new Set(),
      recomputeTimer: null,
      terminalFlushTimer: null,
      terminalBuffer: '',
      terminalBytes: 0,
      terminalTruncated: false,
      presenceTimer: null,
      presenceAwaitingReply: false,
      presenceSawOutput: false,
      pendingPrompt: null,
      promptSettleTimer: null,
      promptDeadlineTimer: null,
      promptEnterTimer: null,
      typedLine: new TypedLineTracker(),
      lastUserLine: null,
      suppressInputCapture: 0,
      structuredStream: false,
      captureGrade: external.captureGrade === 'structured' ? 'structured' : 'observed',
      parser: new ExternalStructuredReplayParser(),
      lastFiles: changeSet.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
      work: Promise.resolve(),
      ended: false,
    };
    session.unsubscribe = watcher.onBatch((changes) => this.onBatch(session, changes));
    watcher.start();
    this.byTerminal.set(terminalId, session);
    this.tasks.resumeExternalSession(taskId, terminalId);
    broadcast('external.sessionChanged', {
      taskId,
      terminalId,
      cli: external.cli,
      status: 'active',
      captureGrade: session.captureGrade,
      snapshotRef: external.snapshotRef,
      files: session.lastFiles,
    });

    const detected = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResumes.delete(terminalId);
        void this.onAgentExit(terminalId).finally(() =>
          reject(
            new ProductFailure(
              productError('EXTERNAL_RESUME_NOT_DETECTED', {
                userMessage: `${external.cli} did not start in the terminal. The task remains safe and ready for review.`,
              }),
            ),
          ),
        );
      }, 12_000);
      timer.unref?.();
      this.pendingResumes.set(terminalId, {
        taskId,
        cli: external.cli,
        timer,
        resolve,
        reject,
      });
    });

    // Fresh shells can discard keystrokes during startup; the short delay is
    // harmless for an existing prompt and makes restart recovery reliable.
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    const resuming = this.byTerminal.get(terminalId);
    if (resuming) this.writeProduct(resuming, `${command}\r`);
    else this.terminals.write(terminalId, `${command}\r`);
    await detected;
    return { terminalId, cli: external.cli };
  }

  /**
   * Product-owned continuation path for Claude/Codex. The renderer sends
   * structured refs; the main process validates them through IPC, serializes
   * the exact snapshots, writes the owning PTY, and records the same refs in
   * the Session ledger.
   */
  sendMessage(
    taskId: string,
    text: string,
    codeRefs: CodeContextRefDto[],
  ): { delivered: boolean; terminalId: string } {
    const task = this.tasks.getTask(taskId);
    const external = task.external;
    if (!external) {
      throw new ProductFailure(
        productError('TASK_NOT_EXTERNAL', {
          userMessage: 'This Session is not backed by Claude or Codex.',
        }),
      );
    }
    const session = this.byTerminal.get(external.terminalId);
    if (!session || session.taskId !== taskId || session.ended || external.status !== 'active') {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_ENDED', {
          userMessage: `Resume the ${external.cli} Session before sending more context.`,
        }),
      );
    }
    const prompt = formatPromptWithCodeContext(text, codeRefs);
    this.tasks.recordEvent(taskId, 'user.message', {
      text,
      kind: 'external',
      ...(codeRefs.length > 0 ? { codeRefs } : {}),
    });
    // A session that never got a composer prompt keeps its placeholder title
    // until the first product-path message names it.
    if (task.title === `${external.cli} · external session`) {
      const title = externalTitleFromPrompt(text);
      if (title) this.tasks.setExternalTitle(taskId, title);
    }
    session.lastUserLine = text;
    this.writeProduct(session, `\u001b[200~${prompt}\u001b[201~`);
    // Enter as its own write — a CR inside the paste chunk reads as pasted
    // text to TUI paste handling and leaves the message sitting unsent.
    const enterTimer = setTimeout(() => {
      if (!session.ended) this.writeProduct(session, '\r');
    }, PROMPT_ENTER_DELAY_MS);
    enterTimer.unref?.();
    return { delivered: true, terminalId: external.terminalId };
  }

  dispose(): void {
    this.unsubscribeManager();
    this.unsubscribeData();
    this.unsubscribeInput();
    for (const pending of this.pendingResumes.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ProductFailure(
          productError('CANCELLED', { userMessage: 'The app closed before the session resumed.' }),
        ),
      );
    }
    this.pendingResumes.clear();
    for (const [terminalId] of [...this.byTerminal]) {
      void this.onAgentExit(terminalId);
    }
  }
}
