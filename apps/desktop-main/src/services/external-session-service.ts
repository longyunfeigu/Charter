import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { GitService } from '@pi-ide/git-service';
import type { TerminalInputSource, TerminalManager } from '@pi-ide/terminal-service';
import { openWorkspaceInfo, WorkspaceWatcher, type FsChange } from '@pi-ide/workspace-service';
import type { ChangeSet } from '@pi-ide/change-service';
import {
  formatPromptWithArtifactFeedback,
  formatPromptWithCodeContext,
  type ExternalInjectRefDto,
  type TaskDto,
  type TaskWorktreeDto,
} from '@pi-ide/ipc-contracts';
import { broadcast } from '../broadcast.js';
import type { WorkspaceHost } from './workspace-host.js';
import type { TaskService } from './task-service.js';
import { cleanTerminalText, ExternalStructuredReplayParser } from './external-replay-parser.js';
import {
  discoverCliSessionId,
  isSafeCliSessionId,
  locateCodexSession,
} from './cli-session-locator.js';
import type { ExternalLaunchIntents } from './external-launch-intents.js';
import { TypedLineTracker } from './typed-line-tracker.js';
import {
  evaluateAdapterStartup,
  type AgentRegistry,
  type AgentStartupAction,
  type AgentStartupState,
  type AgentTerminalExitAction,
} from './agent-registry.js';
import { BUILTIN_AGENT_ADAPTERS } from './agent-adapter-manifest.js';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Paths never attributed to an external session (product/tooling noise). */
const IGNORED_SEGMENTS = ['node_modules', '.git'];
const IGNORED_BASENAMES = ['.DS_Store'];
const IGNORED_PREFIXES = ['.pi-ide-chg.'];
/**
 * Third-party CLI atomic-write temp files — Claude Code writes
 * `name.tmp.<pid>.<hex>` then renames it over the target, so the temp path
 * lives for milliseconds. Accounting it turns every external write into a
 * phantom second file (live-board tile, diff badge). End-anchored and
 * shape-specific so real files that merely contain ".tmp." survive.
 */
const ATOMIC_WRITE_TMP = /\.tmp\.\d+\.[0-9a-f]+$/i;
const MAX_TERMINAL_REPLAY_BYTES = 2 * 1024 * 1024;
const TERMINAL_EVENT_CHARS = 12_000;
// Observed TUIs without an explicit busy title fall back to 1s of documentary
// output quiet. Claude/Codex window-title spinners are handled separately: OSC
// title traffic is stripped from documentary text, but remains authoritative
// until the TUI paints its non-spinning title again.
const OBSERVED_REPLY_QUIET_MS = 1_000;
const MAX_OBSERVED_TITLE_FRAGMENT_CHARS = 1_024;
/** First-prompt delivery: the TUI is treated as ready once its paint settles. */
const PROMPT_SETTLE_QUIET_MS = 600;
/** A quiet TUI gets a deadline, but startup trust gates still block delivery. */
const PROMPT_DELIVERY_DEADLINE_MS = 8_000;
/** A product-created Agent must either expose a real Composer or fail visibly. */
const PROMPT_STARTUP_TIMEOUT_MS = 120_000;
/** Submitted Composer text must provoke a TUI activity edge before it counts. */
const PROMPT_SUBMIT_ACK_TIMEOUT_MS = 8_000;
const PROMPT_SUBMIT_MAX_ATTEMPTS = 3;
/** Let delayed fs events land just after a terminal turn reports completion. */
const FILE_ATTRIBUTION_GRACE_MS = 2_000;
/** Covers one-shot `claude -p`-style commands whose prompt preceded detection. */
const INITIAL_COMMAND_ATTRIBUTION_MS = 10_000;
/**
 * The Enter must be its own PTY write: a CR in the same chunk as a bracketed
 * paste is treated by TUI paste handling as pasted text. Long first prompts
 * also take the TUI longer to ingest after bracketed-paste end, so the delay
 * scales with bytes instead of racing every prompt against one fixed timer.
 */
const PROMPT_ENTER_BASE_DELAY_MS = 250;
const PROMPT_ENTER_MAX_DELAY_MS = 3_000;
const PROMPT_ENTER_BYTES_PER_MS = 4;
/** Correlate xterm mouse-wheel reports with the TUI repaint they trigger. */
const VIEWPORT_SCROLL_REPAINT_MS = 750;
const TERMINAL_EXIT_BYTES: Record<AgentTerminalExitAction, string> = {
  interrupt: '\x03',
  eof: '\x04',
};

interface ObservedTurnPresence {
  structuredStream: boolean;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  presenceAwaitingReply: boolean;
  presenceSawOutput: boolean;
  presenceTuiBusy: boolean;
  presenceTitleBuffer: string;
}

export type ObservedTuiTitleActivity = 'busy' | 'idle';

/**
 * Claude and Codex expose their real interactive turn boundary through OSC
 * 0/2 window titles. Their working titles begin with a Braille spinner frame;
 * the idle edge is a normal title (Claude's `✳ …`, Codex's plain cwd title).
 * Return the last complete title edge in a PTY chunk so a repaint cannot make
 * a completed observed turn start again by itself.
 */
export function observedTuiTitleActivity(data: string): ObservedTuiTitleActivity | null {
  let activity: ObservedTuiTitleActivity | null = null;
  for (const match of data.matchAll(
    /(?:\u001b\]|\u009d)(?:0|2);([^\u0007\u001b\u009c]*)(?:\u0007|\u001b\\|\u009c)/g,
  )) {
    activity = /^[\u2800-\u28ff]/u.test((match[1] ?? '').trimStart()) ? 'busy' : 'idle';
  }
  return activity;
}

/** Preserve only an incomplete OSC title across arbitrary PTY chunk splits. */
function trailingObservedTuiTitleFragment(data: string): string {
  const start = Math.max(data.lastIndexOf('\u001b]'), data.lastIndexOf('\u009d'));
  if (start >= 0) {
    const candidate = data.slice(start);
    if (!/(?:\u0007|\u001b\\|\u009c)/.test(candidate)) {
      return candidate.length <= MAX_OBSERVED_TITLE_FRAGMENT_CHARS ? candidate : '';
    }
  }
  // ESC and `]` may themselves arrive in separate PTY chunks.
  return data.endsWith('\u001b') ? '\u001b' : '';
}

/** Arm the completion edge for both PTY-submitted and argv-submitted turns. */
export function beginObservedTurnPresence(state: ObservedTurnPresence): void {
  if (state.structuredStream) return;
  if (state.presenceTimer) clearTimeout(state.presenceTimer);
  state.presenceTimer = null;
  state.presenceAwaitingReply = true;
  state.presenceSawOutput = false;
  state.presenceTuiBusy = false;
  state.presenceTitleBuffer = '';
}

export function externalPromptEnterDelayMs(prompt: string): number {
  return Math.min(
    PROMPT_ENTER_MAX_DELAY_MS,
    PROMPT_ENTER_BASE_DELAY_MS +
      Math.ceil(Buffer.byteLength(prompt, 'utf8') / PROMPT_ENTER_BYTES_PER_MS),
  );
}

/**
 * Full-screen CLIs enable xterm mouse reporting. In that mode the wheel is PTY
 * input (rather than local xterm scrollback) and the CLI repaints its viewport.
 * SGR is what current Claude/Codex use; X10 keeps the guard correct for older
 * TUIs and custom external Agents.
 */
export function isTerminalViewportScrollInput(data: string): boolean {
  for (const match of data.matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/g)) {
    const button = Number(match[1]);
    if (Number.isFinite(button) && (button & 64) !== 0) return true;
  }

  let offset = data.indexOf('\x1b[M');
  while (offset >= 0) {
    const encodedButton = data.charCodeAt(offset + 3);
    if (Number.isFinite(encodedButton) && ((encodedButton - 32) & 64) !== 0) return true;
    offset = data.indexOf('\x1b[M', offset + 3);
  }
  return false;
}

/** Cursor movement/erase (or synchronized-paint mode) identifies a TUI repaint,
 * while ordinary colored output and structured JSON remain documentary output. */
export function isTerminalViewportRepaint(data: string): boolean {
  return (
    /\x1b\[\?2026[hl]/.test(data) || /\x1b\[(?:\d{0,4}(?:[;:]\d{0,4})*)?[ABCDEFGHJKSTdf]/.test(data)
  );
}

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
  if (ATOMIC_WRITE_TMP.test(base)) return false;
  return true;
}

const BUILTIN_STARTUP_ADAPTERS = new Map(
  BUILTIN_AGENT_ADAPTERS.map((adapter) => [adapter.id, adapter]),
);

/** Compatibility exports for recorded fixtures. Provider markers live in the
 * built-in Adapter data; these helpers contain no provider behavior. */
function builtinStartupState(cli: string, output: string): AgentStartupState {
  return evaluateAdapterStartup(
    BUILTIN_STARTUP_ADAPTERS.get(cli) ?? null,
    cleanTerminalText(output),
    bracketedPasteComposerReady(output),
  );
}

export function codexStartupTrustGateActive(output: string): boolean {
  return builtinStartupState('codex', output).trustGateActive;
}

export function codexStartupComposerReady(output: string): boolean {
  return builtinStartupState('codex', output).composerReady;
}

export function codexStartupUpdateGateActive(output: string): boolean {
  return builtinStartupState('codex', output).updateGateActive;
}

export function kimiStartupTrustGateActive(output: string): boolean {
  return builtinStartupState('kimi', output).trustGateActive;
}

export function kimiStartupComposerReady(output: string): boolean {
  return builtinStartupState('kimi', output).composerReady;
}

export function externalStartupTrustGateActive(cli: string, output: string): boolean {
  return builtinStartupState(cli, output).trustGateActive;
}

export function externalStartupComposerReady(cli: string, output: string): boolean {
  return builtinStartupState(cli, output).composerReady;
}

/**
 * Deferred prompts are sent as bracketed paste. Process detection alone is not
 * a composer-ready signal: Kimi (and occasionally Claude) is detectable while
 * its PTY is still in cooked shell mode. Writing at that point echoes
 * `^[[200~...` as ordinary input and the subsequent TUI paint discards the
 * assignment. Compare the last enable/disable edge so stale shell scrollback
 * cannot make a newly launched Agent look ready.
 */
export function bracketedPasteComposerReady(output: string): boolean {
  const enabled = output.lastIndexOf('\u001b[?2004h');
  const disabled = output.lastIndexOf('\u001b[?2004l');
  return enabled >= 0 && enabled > disabled;
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

export interface ExternalSessionReconcileResult {
  reconciled: number;
  session: ExternalSessionSnapshot;
}

export interface ExternalFleetResumeSummary {
  requested: number;
  resumed: number;
  reused: number;
  failed: Array<{ taskId: string; message: string }>;
}

export interface ExternalSessionResumeResult {
  terminalId: string;
  cli: string;
  taskId: string;
  fleet: ExternalFleetResumeSummary;
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
  /** File truth arrives from the versioned SSH Worker, not fs.watch. */
  remoteManaged: boolean;
  remoteWorkspaceKind: 'remote' | 'local';
  unsubscribe: () => void;
  seen: Set<string>;
  /** Once terminals overlap on one root, full-tree recovery becomes ambiguous. */
  sharedRoot: boolean;
  recomputeTimer: ReturnType<typeof setTimeout> | null;
  terminalFlushTimer: ReturnType<typeof setTimeout> | null;
  terminalBuffer: string;
  terminalBytes: number;
  terminalTruncated: boolean;
  /** Presence-only heuristic for interactive TUIs without structured turns. */
  presenceTimer: ReturnType<typeof setTimeout> | null;
  presenceAwaitingReply: boolean;
  presenceSawOutput: boolean;
  /** Explicit OSC title activity for full-screen Claude/Codex turns. */
  presenceTuiBusy: boolean;
  /** Bounded tail for an OSC title split across PTY data events. */
  presenceTitleBuffer: string;
  /** Filesystem observations may belong to this terminal only during a real turn. */
  fileAttributionActive: boolean;
  lastAgentActivityAtMs: number;
  fileAttributionGraceUntilMs: number;
  /** Composer first prompt awaiting a ready TUI (product launch intent). */
  pendingPrompt: string | null;
  promptSettleTimer: ReturnType<typeof setTimeout> | null;
  promptDeadlineTimer: ReturnType<typeof setTimeout> | null;
  promptEnterTimer: ReturnType<typeof setTimeout> | null;
  promptDeliveryStartedAtMs: number | null;
  promptAwaitingStart: boolean;
  promptSubmitAttempts: number;
  startupTrustGateHandled: boolean;
  startupUpdateGateHandled: boolean;
  /** Product/doorbell Enter is provisional until the TUI emits output. */
  orchestratorSubmitPending: boolean;
  /** Notification copy: the user message the current reply answers. */
  typedLine: TypedLineTracker;
  lastUserLine: string | null;
  /** >0 while the product itself writes the PTY (prompt/resume injection). */
  suppressInputCapture: number;
  /** Recent terminal-generated wheel input that may provoke a full TUI repaint. */
  viewportScrollUntilMs: number;
  /** Once the correlated repaint starts, suppress all of its split PTY chunks. */
  viewportRepaintUntilMs: number;
  /** Whether this live invocation, rather than an earlier resumed turn, exposed structured data. */
  structuredStream: boolean;
  captureGrade: 'structured' | 'observed';
  parser: ExternalStructuredReplayParser;
  lastFiles: ExternalSessionSnapshot['files'];
  /** Serializes baseline capture; watcher batches can overlap. */
  work: Promise<void>;
  ended: boolean;
}

/** Integrity-checked file version emitted by Charter's remote Worker. */
export interface RemoteExternalChange {
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  beforeHash: string | null;
  afterHash: string | null;
  beforeBase64: string | null;
  afterBase64: string | null;
  beforeMode: number | null;
  afterMode: number | null;
  /** Local-workspace bridge only: the last version Charter placed at the
   * local path. `null` means the path was absent. */
  expectedMirrorHash?: string | null;
}

interface PendingResume {
  taskId: string;
  cli: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: ProductFailure) => void;
}

export interface ExternalTurnSettledEvent {
  terminalId: string;
  taskId: string;
  status: 'ok' | 'error';
  source: 'structured' | 'observed';
}

export interface ExternalTurnStartedEvent {
  terminalId: string;
  taskId: string;
  source: 'input' | 'launch';
}

/**
 * Production commands resolve through the trusted Agent Registry manifest.
 * The provider-specific fallback below exists only for legacy callers/tests.
 * With a recorded conversation id the command targets that exact session;
 * ids are PTY-written text, so unsafe values are always treated as absent.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function externalResumeCommand(
  cli: string,
  sessionId?: string | null,
  codexHome?: string | null,
  registry?:
    | (Pick<AgentRegistry, 'resumeCommand' | 'sessionIdSafe'> &
        Partial<Pick<AgentRegistry, 'resumeArguments'>>)
    | null,
  remote = false,
): string | null {
  if (registry) {
    const id = sessionId && registry.sessionIdSafe(cli, sessionId) ? sessionId : null;
    const resolved = remote
      ? (() => {
          const args = registry.resumeArguments?.(cli, id) ?? null;
          return args ? { executable: cli, args } : null;
        })()
      : registry.resumeCommand(cli, id);
    if (!resolved) return null;
    const home = cli === 'codex' && codexHome ? `CODEX_HOME=${shellQuote(codexHome)} ` : '';
    // Registry resolution remains the availability/security gate, while the
    // command typed into the existing interactive shell stays bare so the
    // user's alias/function is honored on Resume as well as New Session.
    const command = /^[a-z0-9][a-z0-9_-]*$/i.test(cli) ? cli : shellQuote(resolved.executable);
    return `${home}${[command, ...resolved.args.map(shellQuote)].join(' ')}`;
  }
  const id = sessionId && isSafeCliSessionId(sessionId) ? sessionId : null;
  if (cli === 'claude') return id ? `claude --resume ${id}` : 'claude --continue';
  if (cli === 'codex') {
    if (!id) return null;
    const home = codexHome ? `CODEX_HOME=${shellQuote(codexHome)} ` : '';
    return `${home}codex resume ${id}`;
  }
  if (cli === 'kimi') return id ? `kimi --session ${id}` : 'kimi --continue';
  return null;
}

/**
 * ADR-0030 — the exact PTY payload for one injected context reference. File
 * refs become `@path` mentions (trailing "/" for folders, trailing space so
 * the user keeps typing); selections carry the serialized frozen snapshot.
 * Never contains a CR: injection must land in the input line unsent.
 */
export function externalInjectText(ref: ExternalInjectRefDto): string {
  if (ref.kind === 'file') return `@${ref.path}${ref.isFolder ? '/' : ''} `;
  if (ref.kind === 'selection') return `${formatPromptWithCodeContext('', [ref.code])}\n`;
  return `${formatPromptWithArtifactFeedback('', [ref.artifact])}\n`;
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

/** Xterm's submit edge is CR; LF may be unsent text inside a bracketed paste. */
export function isExternalPromptSubmit(data: string): boolean {
  const outsideBracketedPaste = data.replace(/\u001b\[200~[\s\S]*?\u001b\[201~/g, '');
  return outsideBracketedPaste.includes('\r');
}

interface FileAttributionCandidate {
  root: string;
  ended: boolean;
  fileAttributionActive: boolean;
  fileAttributionGraceUntilMs: number;
  lastAgentActivityAtMs: number;
}

/** A raw filesystem batch can belong to at most one recently active terminal turn. */
export function selectFileAttributionOwner<T extends FileAttributionCandidate>(
  sessions: Iterable<T>,
  root: string,
  now = Date.now(),
): T | null {
  const candidates = [...sessions]
    .filter(
      (session) =>
        !session.ended &&
        session.root === root &&
        (session.fileAttributionActive || session.fileAttributionGraceUntilMs >= now),
    )
    .sort((a, b) => b.lastAgentActivityAtMs - a.lastAgentActivityAtMs);
  return candidates[0] ?? null;
}

/** A full-tree fallback is only unambiguous while one external Session owns
 * the root. Shared roots may safely refresh paths already attributed by the
 * watcher, but must not discover the same new path into multiple Sessions. */
export function shouldReconcileSnapshotPath(sharedRoot: boolean, seen: boolean): boolean {
  return !sharedRoot || seen;
}

/**
 * ADR-0017 — external CLI agent sessions. Listens for agent enter/exit on user
 * terminals; on enter snapshots the project (temp-index write-tree), creates
 * the backing task and starts watcher accounting. Git-ignored paths are
 * excluded, and ambiguous root-level changes are assigned to at most one
 * active terminal turn before the existing change-set / review / byte-exact
 * rollback machinery takes over. On exit the task lands in REVIEW_READY —
 * external work is never auto-accepted.
 */
export class ExternalSessionService {
  private readonly byTerminal = new Map<string, LiveSession>();
  private readonly pendingResumes = new Map<string, PendingResume>();
  private readonly unsubscribeManager: () => void;
  private readonly unsubscribeData: () => void;
  private readonly unsubscribeInput: () => void;
  private remoteReconcile: ((taskId: string) => Promise<number>) | null = null;
  private remoteMirrorPush: ((taskId: string, paths: string[]) => Promise<void>) | null = null;
  private readonly remoteMirrorPushWork = new Map<string, Promise<void>>();
  private remoteSessionIdentity:
    | ((
        taskId: string,
        cli: string,
        options?: { allowConnect?: boolean },
      ) => Promise<string | null>)
    | null = null;
  private remoteResume:
    ((task: TaskDto) => Promise<{ terminalId: string; activate: () => void }>) | null = null;

  private registerLiveSession(session: LiveSession): void {
    const peers = [...this.byTerminal.values()].filter(
      (candidate) => !candidate.ended && candidate.root === session.root,
    );
    session.sharedRoot = peers.length > 0;
    for (const peer of peers) peer.sharedRoot = true;
    this.byTerminal.set(session.terminalId, session);
  }

  constructor(
    private readonly terminals: TerminalManager,
    private readonly tasks: TaskService,
    private readonly workspace: WorkspaceHost,
    private readonly logger: Logger,
    /** ADR-0017 amendment: product-launch intents registered by terminal.create. */
    private readonly launchIntents: ExternalLaunchIntents | null = null,
    /** Event-driven bridge for orchestration waiters; renderer broadcasts alone cannot wake tools. */
    private readonly onTurnSettled: ((event: ExternalTurnSettledEvent) => void) | null = null,
    /** Keeps the worker projection aligned with external-agent activity edges. */
    private readonly onTurnStarted: ((event: ExternalTurnStartedEvent) => void) | null = null,
    /** Persists the external task identity behind an orchestration worker. */
    private readonly onSessionBound:
      ((event: { terminalId: string; taskId: string }) => void) | null = null,
    /** Commander resumes restore their historical worker fleet as one operation. */
    private readonly onFleetResume:
      | ((event: {
          sourceTaskId: string;
          targetTaskId: string;
          commanderTerminalId: string;
        }) => Promise<ExternalFleetResumeSummary>)
      | null = null,
    /** Trusted Agent command/session policy. Provider details stay in manifests. */
    private readonly agents: AgentRegistry | null = null,
  ) {
    this.unsubscribeManager = terminals.onAgentState(({ id, agent, cwd }) => {
      if (agent) void this.onAgentEnter(id, agent, cwd);
      else void this.onAgentExit(id);
    });
    this.unsubscribeData = terminals.onDataEvent(({ id, data }) => this.onTerminalData(id, data));
    this.unsubscribeInput = terminals.onSourcedInputEvent(({ id, data, source }) => {
      // Xterm protocol replies (mouse, focus, device reports) are not user
      // composer input. A mouse wheel is tracked only long enough to identify
      // and exclude the viewport repaint it asks the external TUI to emit.
      if (source === 'terminal') {
        this.onTerminalProtocolInput(id, data);
        return;
      }
      this.onTerminalInput(id, data, source);
    });
    // Only sessions without a surviving daemon PTY are stranded. Reattached
    // terminal ids keep the same task and review baseline across app restarts.
    tasks.recoverExternalTasks(
      new Set(
        terminals
          .list()
          .filter((terminal) => terminals.persistsAcrossAppRestart(terminal.id))
          .map((terminal) => terminal.id),
      ),
    );
    // Restored backends already know their foreground process from the daemon
    // snapshot. Re-run detection after listeners are attached so the existing
    // task is rebound without waiting for a title change.
    queueMicrotask(() => terminals.pollOnce());
    // Best-effort: give ended sessions that predate session-id capture (or
    // were stranded by a quit) their conversation id so resume can target them.
    void this.backfillSessionIds();
  }

  private async backfillSessionIds(): Promise<void> {
    let recovered = 0;
    for (const task of this.tasks.externalTasksMissingSessionId()) {
      // Remote transcript discovery requires an SSH connection and may prompt
      // for trust/authentication. Never do that as a background startup side
      // effect; the explicit Resume action performs that recovery instead.
      if (this.tasks.getTask(task.taskId).external?.remote) continue;
      const sessionId = await discoverCliSessionId({
        cli: task.cli,
        connector: this.agents?.sessionIdentityConnector(task.cli) ?? undefined,
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
    return [...this.byTerminal.values()].map((session) => this.snapshot(session));
  }

  attachRemoteReconcile(reconcile: (taskId: string) => Promise<number>): void {
    this.remoteReconcile = reconcile;
  }

  attachRemoteMirrorPush(push: (taskId: string, paths: string[]) => Promise<void>): void {
    this.remoteMirrorPush = push;
  }

  attachRemoteSessionBridge(input: {
    discoverIdentity(
      taskId: string,
      cli: string,
      options?: { allowConnect?: boolean },
    ): Promise<string | null>;
    prepareResume(task: TaskDto): Promise<{ terminalId: string; activate: () => void }>;
  }): void {
    this.remoteSessionIdentity = input.discoverIdentity;
    this.remoteResume = input.prepareResume;
  }

  noteRemoteSyncFailure(taskId: string, detail: string): void {
    this.tasks.recordEvent(taskId, 'system.diagnostic', {
      code: 'REMOTE_FINAL_SYNC_FAILED',
      detail: `The SSH Agent ended before Charter could complete its final Worker sync: ${detail}`,
    });
  }

  /** Reconcile the live worktree with its entry snapshot before opening Diff.
   * The watcher remains the fast path; this closes correctness gaps when a
   * platform watcher coalesces or drops a filesystem event. */
  async reconcile(taskId: string): Promise<ExternalSessionReconcileResult> {
    const session = [...this.byTerminal.values()].find((candidate) => candidate.taskId === taskId);
    if (!session || session.ended) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'This external Session is no longer live. Resume it before refreshing Diff.',
        }),
      );
    }
    const reconciled = session.remoteManaged
      ? await (this.remoteReconcile?.(taskId) ?? Promise.resolve(0))
      : await this.reconcileSnapshotChanges(session, 'on-demand');
    await this.publish(session, 'active');
    return { reconciled, session: this.snapshot(session) };
  }

  private snapshot(session: LiveSession): ExternalSessionSnapshot {
    return {
      terminalId: session.terminalId,
      taskId: session.taskId,
      cli: session.cli,
      snapshotRef: session.snapshotRef,
      status: session.ended ? 'ended' : 'active',
      captureGrade: session.captureGrade,
      files: session.lastFiles,
    };
  }

  taskIdForTerminal(terminalId: string): string | null {
    return this.byTerminal.get(terminalId)?.taskId ?? null;
  }

  private async forceEnd(
    taskId: string,
    terminalId: string,
    cli: string,
  ): Promise<{ terminalId: string; cli: string; ended: true }> {
    const session = this.byTerminal.get(terminalId);
    const hadLiveSession = Boolean(session && session.taskId === taskId && !session.ended);
    // A force-confirmed global stop owns both sides of the transaction: remove
    // the resident PTY and durably close the task. In particular, restored
    // daemon PTYs can outlive the ExternalSessionService binding that normally
    // projects an Agent exit into the task ledger.
    this.terminals.kill(terminalId);

    if (hadLiveSession) {
      // terminal.kill emits the normal Agent-exit edge synchronously. The
      // asynchronous final reconciliation may still be running, so wait for
      // its durable task projection before reporting success.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const current = this.tasks.getTask(taskId);
        if (current.external?.status === 'ended') {
          return { terminalId, cli, ended: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const current = this.tasks.getTask(taskId);
    if (current.external?.status !== 'ended') {
      const files = session?.lastFiles ?? [];
      const captureGrade = session?.captureGrade ?? current.external?.captureGrade ?? 'observed';
      this.tasks.finishExternalSession(
        taskId,
        files.length || current.changedFiles || 0,
        captureGrade,
      );
      broadcast('external.sessionChanged', {
        taskId,
        terminalId,
        cli,
        status: 'ended',
        captureGrade,
        snapshotRef: session?.snapshotRef ?? current.external?.snapshotRef ?? null,
        files,
      });
      broadcast('terminal.agentState', { id: terminalId, agent: null, taskId });
      this.logger.info('orphaned external session force-finished', { terminalId, taskId, cli });
    }
    return { terminalId, cli, ended: true };
  }

  /** End the Agent process without closing the PTY, unless a confirmed global stop requires force. */
  async end(
    taskId: string,
    force = false,
  ): Promise<{ terminalId: string; cli: string; ended: boolean }> {
    const task = this.tasks.getTask(taskId);
    const external = task.external;
    if (!external) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'This task is not an external terminal session.',
        }),
      );
    }
    const session = this.byTerminal.get(external.terminalId);
    if (!session || session.taskId !== taskId) {
      if (force && external.status === 'active') {
        return this.forceEnd(taskId, external.terminalId, external.cli);
      }
      return {
        terminalId: external.terminalId,
        cli: external.cli,
        ended: external.status === 'ended',
      };
    }
    if (session.ended) {
      return { terminalId: external.terminalId, cli: external.cli, ended: true };
    }

    this.tasks.recordEvent(taskId, 'external.sessionEndRequested', { cli: session.cli });
    // Keep raw terminal writes host-owned, but resolve each Agent's confirmation
    // semantics from its trusted manifest. For example, Kimi requires repeated
    // presses of the same key; mixing Ctrl-C and Ctrl-D clears its confirmation.
    const exitSequence = this.agents?.terminalExitSequence(session.cli) ?? ['interrupt', 'eof'];
    for (const [index, action] of exitSequence.entries()) {
      const current = this.byTerminal.get(external.terminalId);
      if (!current || current.taskId !== taskId || current.ended) {
        return { terminalId: external.terminalId, cli: external.cli, ended: true };
      }
      this.writeProduct(current, TERMINAL_EXIT_BYTES[action]);
      if (index < exitSequence.length - 1) {
        // Process-tree detection is intentionally cached. Refresh it twice
        // after the first exit signal (the tracker requires two misses) before
        // sending a fallback EOF; otherwise that EOF can close the recovered
        // shell instead of the Agent.
        await new Promise((resolve) => setTimeout(resolve, 350));
        await this.terminals.pollOnceFresh();
        await new Promise((resolve) => setTimeout(resolve, 100));
        await this.terminals.pollOnceFresh();
      }
    }

    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const current = this.byTerminal.get(external.terminalId);
      if (!current || current.taskId !== taskId || current.ended) {
        return { terminalId: external.terminalId, cli: external.cli, ended: true };
      }
      this.terminals.pollOnce();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (force) return this.forceEnd(taskId, external.terminalId, external.cli);
    return { terminalId: external.terminalId, cli: external.cli, ended: false };
  }

  private markFileAttributionActive(session: LiveSession): void {
    session.fileAttributionActive = true;
    session.lastAgentActivityAtMs = Date.now();
    session.fileAttributionGraceUntilMs = 0;
  }

  private settleFileAttribution(session: LiveSession): void {
    session.fileAttributionActive = false;
    session.fileAttributionGraceUntilMs = Date.now() + FILE_ATTRIBUTION_GRACE_MS;
  }

  /** Raw fs events carry no pid. Attribute a root batch to at most one live, active turn. */
  private fileAttributionOwner(root: string, now = Date.now()): LiveSession | null {
    return selectFileAttributionOwner(this.byTerminal.values(), root, now);
  }

  private onTerminalData(terminalId: string, data: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session || session.ended) return;

    // Product-owned Enter is only a submission attempt. A repaint, title edge
    // or documentary byte after it is the first evidence that the Agent TUI
    // accepted the message. This is the edge consumed by durable continuation
    // delivery; without it the outbox retries instead of claiming success.
    if (session.orchestratorSubmitPending && data.length > 0) {
      session.orchestratorSubmitPending = false;
      const firstPromptAccepted = session.promptAwaitingStart;
      if (firstPromptAccepted) this.completePromptDelivery(session);
      this.startTurn(session, 'input');
    }

    // A painting TUI is a booting TUI — keep deferring the first prompt until
    // its output settles, then deliver (see armPromptDelivery).
    if (session.pendingPrompt) this.notePromptReadiness(session);

    const now = Date.now();
    const correlatedRepaint =
      !session.structuredStream &&
      (now <= session.viewportRepaintUntilMs ||
        (now <= session.viewportScrollUntilMs && isTerminalViewportRepaint(data)));
    if (correlatedRepaint) {
      // PTY recording and xterm rendering happen outside this semantic
      // observer. Dropping the correlated paint here prevents a historical
      // scroll from creating durable external.terminal events, activity
      // broadcasts and renderer timeline copies.
      session.viewportRepaintUntilMs = session.viewportScrollUntilMs;
      return;
    }

    if (session.fileAttributionActive && cleanTerminalText(data).replace(/\s/g, '')) {
      session.lastAgentActivityAtMs = now;
    }

    const parsed = session.parser.feed(session.cli, data);
    // Structured streams reveal the conversation id directly — record it the
    // moment it appears so even a crash leaves the task resumable by id.
    if (session.parser.sessionId && session.sessionId !== session.parser.sessionId) {
      session.sessionId = session.parser.sessionId;
      this.tasks.setExternalSessionId(session.taskId, session.sessionId);
    }
    if (parsed.structured && !session.structuredStream) {
      session.structuredStream = true;
      this.markFileAttributionActive(session);
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
        this.settleFileAttribution(session);
        const status = observation.status === 'error' ? 'error' : 'ok';
        this.emitTurnSettled({
          terminalId,
          taskId: session.taskId,
          status,
          source: 'structured',
        });
        broadcast('external.turn', {
          terminalId,
          taskId: session.taskId,
          label: observation.label,
          status,
          lastUserMessage: session.lastUserLine
            ? externalTitleFromPrompt(session.lastUserLine)
            : null,
        });
      }
    }

    this.noteObservedOutput(session, data);

    this.bufferTerminalText(session, parsed.terminalText);
  }

  private onTerminalProtocolInput(terminalId: string, data: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session || session.ended || !isTerminalViewportScrollInput(data)) return;
    const now = Date.now();
    const repaintAlreadyActive = now <= session.viewportRepaintUntilMs;
    session.viewportScrollUntilMs = now + VIEWPORT_SCROLL_REPAINT_MS;
    if (repaintAlreadyActive) session.viewportRepaintUntilMs = session.viewportScrollUntilMs;
  }

  /**
   * A submitted input is the only safe edge on which to arm the observed TUI
   * fallback. Startup redraws and background terminal noise therefore never
   * masquerade as completed agent output.
   */
  private onTerminalInput(terminalId: string, data: string, source: TerminalInputSource): void {
    const session = this.byTerminal.get(terminalId);
    if (!session || session.ended) return;
    // Typed-line capture (notification copy only). Product-owned writes skip
    // it: their text is known exactly and set by the writer itself.
    if (session.suppressInputCapture === 0) {
      const committed = session.typedLine.feed(data);
      if (committed) {
        session.lastUserLine = committed;
        // ADR-0030: with no product composer, the first prompt the user types
        // into the CLI is what names the session. Placeholder-guarded, so a
        // launch-intent or resumed title is never overwritten.
        try {
          const task = this.tasks.getTask(session.taskId);
          if (task.title === `${session.cli} · external session`) {
            const title = externalTitleFromPrompt(committed);
            if (title) this.tasks.setExternalTitle(session.taskId, title);
          }
        } catch {
          // A vanished task must never break the PTY input path.
        }
      }
    }
    // Xterm submits with CR. Newlines inside bracketed multi-line/context
    // pastes are still unsent input and must not make the Session look busy.
    if (!isExternalPromptSubmit(data)) return;
    if (
      source === 'orchestrator' &&
      (session.suppressInputCapture === 0 || session.promptAwaitingStart)
    ) {
      session.orchestratorSubmitPending = true;
      return;
    }
    // Trust/update chooser controls are also product-owned CR writes, but they
    // are not Agent turns. Only the first-prompt state above opts into the
    // provisional submit path.
    if (session.suppressInputCapture > 0) return;
    this.startTurn(session, 'input');
  }

  /** PTY write from the product itself — invisible to typed-line capture. */
  private writeProduct(session: LiveSession, data: string): void {
    session.suppressInputCapture += 1;
    try {
      this.terminals.write(session.terminalId, data, 'orchestrator');
    } finally {
      session.suppressInputCapture -= 1;
    }
  }

  private armObservedSettlement(session: LiveSession): void {
    if (session.presenceTimer) clearTimeout(session.presenceTimer);
    session.presenceTimer = setTimeout(() => {
      session.presenceTimer = null;
      if (
        session.ended ||
        session.structuredStream ||
        !session.presenceAwaitingReply ||
        !session.presenceSawOutput ||
        session.presenceTuiBusy
      ) {
        return;
      }
      session.presenceAwaitingReply = false;
      session.presenceSawOutput = false;
      // Terminal quiet is only a notification edge for an observed TUI. Claude
      // and Codex can think silently for tens of seconds before writing; ending
      // accounting here loses those later files. Keep the live Session as the
      // workspace owner until process exit (shared roots still pick one owner
      // by most-recent terminal activity).
      this.emitTurnSettled({
        terminalId: session.terminalId,
        taskId: session.taskId,
        status: 'ok',
        source: 'observed',
      });
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

  private noteObservedOutput(session: LiveSession, data: string): void {
    if (session.structuredStream) return;

    const titleData = `${session.presenceTitleBuffer}${data}`;
    const titleActivity = observedTuiTitleActivity(titleData);
    session.presenceTitleBuffer = trailingObservedTuiTitleFragment(titleData);

    if (titleActivity === 'busy') {
      session.presenceTuiBusy = true;
      if (session.presenceAwaitingReply) {
        // OSC titles are real agent activity even though documentary replay
        // intentionally strips them. Hold the working edge through arbitrary
        // silent reasoning/tool gaps until the TUI explicitly returns idle.
        session.presenceSawOutput = true;
        if (session.presenceTimer) clearTimeout(session.presenceTimer);
        session.presenceTimer = null;
      }
    } else if (titleActivity === 'idle' && session.presenceTuiBusy) {
      session.presenceTuiBusy = false;
      if (session.presenceAwaitingReply && session.presenceSawOutput) {
        this.armObservedSettlement(session);
      }
    }

    if (!cleanTerminalText(data).replace(/\s/g, '')) return;
    // A completed observed turn can still receive idle TUI repaints, cursor
    // updates, or focus/status traffic. Only submitted input (or launch) may
    // start a turn; output by itself must never make an idle Session work again.
    if (!session.presenceAwaitingReply) return;
    session.presenceSawOutput = true;
    if (session.presenceTuiBusy) {
      if (session.presenceTimer) clearTimeout(session.presenceTimer);
      session.presenceTimer = null;
      return;
    }
    this.armObservedSettlement(session);
  }

  private clearObservedPresence(session: LiveSession): void {
    if (session.presenceTimer) clearTimeout(session.presenceTimer);
    session.presenceTimer = null;
    session.presenceAwaitingReply = false;
    session.presenceSawOutput = false;
    session.presenceTuiBusy = false;
    session.presenceTitleBuffer = '';
  }

  private startTurn(session: LiveSession, source: ExternalTurnStartedEvent['source']): void {
    this.markFileAttributionActive(session);
    // Product-created workers can submit their first prompt through argv before
    // process detection binds the ExternalSession. In that path no PTY input
    // event exists to arm the observed-TUI quiet edge. Start every real turn
    // here (both input and launch) so an argv-first external Agent worker can
    // settle and receive a queued Mission continuation at its safe boundary.
    beginObservedTurnPresence(session);
    broadcast('external.activityStarted', {
      terminalId: session.terminalId,
      taskId: session.taskId,
    });
    try {
      this.onTurnStarted?.({
        terminalId: session.terminalId,
        taskId: session.taskId,
        source,
      });
    } catch (error) {
      this.logger.warn('external turn-started bridge failed', {
        terminalId: session.terminalId,
        taskId: session.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emitTurnSettled(event: ExternalTurnSettledEvent): void {
    try {
      this.onTurnSettled?.(event);
    } catch (error) {
      this.logger.warn('external turn-settled bridge failed', {
        terminalId: event.terminalId,
        taskId: event.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * First-prompt delivery (composer → CLI). Detection only proves the process
   * exists; the provider's real Composer paint is the readiness proof. Folder
   * trust/update choosers are handled explicitly, and post-Enter output is the
   * acknowledgement. A worker that never reaches either edge fails visibly
   * instead of remaining a living-but-empty Mission runtime forever.
   */
  private armPromptDelivery(session: LiveSession, prompt: string): void {
    session.pendingPrompt = prompt;
    session.promptDeliveryStartedAtMs = Date.now();
    session.promptAwaitingStart = false;
    session.promptSubmitAttempts = 0;
    session.startupTrustGateHandled = false;
    this.schedulePromptDeadline(session, PROMPT_DELIVERY_DEADLINE_MS);
    // An already-painted TUI (slow detection) produces no further output.
    // Adapters whose process detection regularly wins the first gate paint
    // explicitly defer this probe.
    if (!this.startupState(session.cli, '').deferInitialProbe) this.notePromptReadiness(session);
  }

  private schedulePromptDeadline(session: LiveSession, delayMs: number): void {
    if (session.promptDeadlineTimer) clearTimeout(session.promptDeadlineTimer);
    session.promptDeadlineTimer = setTimeout(() => this.deliverPendingPrompt(session), delayMs);
    session.promptDeadlineTimer.unref?.();
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
    if (this.promptDeliveryTimedOut(session)) {
      this.failPromptDelivery(session, 'The Agent did not expose a ready Composer in time.');
      return;
    }
    if (session.promptAwaitingStart) {
      this.submitPendingPrompt(session);
      return;
    }
    const recent = this.terminals.recentData(session.terminalId);
    const startup = this.startupState(session.cli, recent);
    if (startup.updateGateActive && !session.startupUpdateGateHandled) {
      // A product-launched Agent with a pending first prompt must not remain
      // parked on an optional update chooser. The Adapter owns the safe
      // navigation sequence; Charter never changes the installed CLI here.
      session.startupUpdateGateHandled = true;
      this.runStartupActions(session, startup.updateActions);
      return;
    }
    if (startup.trustGateActive) {
      if (!session.startupTrustGateHandled) {
        session.startupTrustGateHandled = true;
        this.tasks.recordEvent(session.taskId, 'external.startupGateAccepted', {
          cli: session.cli,
          kind: 'folder-trust',
        });
        // The product launch and its pending Mission prompt are the user's
        // explicit request to run this Agent in the selected workspace. The
        // provider's default affirmative choice is therefore the intended
        // startup path; importantly, the prompt itself is not typed here.
        this.writeProduct(session, '\r');
      }
      this.schedulePromptDeadline(session, PROMPT_SETTLE_QUIET_MS);
      return;
    }
    if (!startup.composerReady) {
      // Process detection, shell echo and bracketed-paste mode can all precede
      // the true Composer. Keep waiting for provider-owned ready text.
      this.schedulePromptDeadline(session, PROMPT_SETTLE_QUIET_MS);
      return;
    }
    const prompt = session.pendingPrompt;
    session.pendingPrompt = null;
    if (session.promptSettleTimer) clearTimeout(session.promptSettleTimer);
    session.promptSettleTimer = null;
    if (session.promptDeadlineTimer) clearTimeout(session.promptDeadlineTimer);
    session.promptDeadlineTimer = null;
    if (!prompt || session.ended) return;
    this.tasks.recordEvent(session.taskId, 'user.message', { text: prompt, kind: 'external' });
    session.lastUserLine = prompt;
    this.markFileAttributionActive(session);
    session.promptAwaitingStart = true;
    this.writeProduct(session, `\u001b[200~${prompt}\u001b[201~`);
    session.promptEnterTimer = setTimeout(() => {
      session.promptEnterTimer = null;
      this.submitPendingPrompt(session);
    }, externalPromptEnterDelayMs(prompt));
    session.promptEnterTimer.unref?.();
  }

  private startupState(cli: string, output: string): AgentStartupState {
    const cleaned = cleanTerminalText(output);
    const pasteReady = bracketedPasteComposerReady(output);
    return this.agents?.startupState(cli, cleaned, pasteReady) ?? builtinStartupState(cli, output);
  }

  private runStartupActions(
    session: LiveSession,
    actions: readonly AgentStartupAction[],
    index = 0,
  ): void {
    if (session.ended) return;
    const action = actions[index];
    if (!action) {
      this.schedulePromptDeadline(session, PROMPT_SETTLE_QUIET_MS);
      return;
    }
    const payload: Record<AgentStartupAction, string> = {
      up: '\u001b[A',
      down: '\u001b[B',
      right: '\u001b[C',
      left: '\u001b[D',
      enter: '\r',
    };
    this.writeProduct(session, payload[action]);
    session.promptEnterTimer = setTimeout(() => {
      session.promptEnterTimer = null;
      this.runStartupActions(session, actions, index + 1);
    }, PROMPT_ENTER_BASE_DELAY_MS);
    session.promptEnterTimer.unref?.();
  }

  private submitPendingPrompt(session: LiveSession): void {
    if (session.ended || !session.promptAwaitingStart) return;
    if (
      this.promptDeliveryTimedOut(session) ||
      session.promptSubmitAttempts >= PROMPT_SUBMIT_MAX_ATTEMPTS
    ) {
      this.failPromptDelivery(
        session,
        'The Agent Composer did not acknowledge the submitted prompt.',
      );
      return;
    }
    session.promptSubmitAttempts += 1;
    this.writeProduct(session, '\r');
    this.schedulePromptDeadline(session, PROMPT_SUBMIT_ACK_TIMEOUT_MS);
  }

  private promptDeliveryTimedOut(session: LiveSession): boolean {
    return (
      session.promptDeliveryStartedAtMs !== null &&
      Date.now() - session.promptDeliveryStartedAtMs >= PROMPT_STARTUP_TIMEOUT_MS
    );
  }

  private completePromptDelivery(session: LiveSession): void {
    session.promptAwaitingStart = false;
    session.promptDeliveryStartedAtMs = null;
    session.promptSubmitAttempts = 0;
    if (session.promptSettleTimer) clearTimeout(session.promptSettleTimer);
    session.promptSettleTimer = null;
    if (session.promptDeadlineTimer) clearTimeout(session.promptDeadlineTimer);
    session.promptDeadlineTimer = null;
    if (session.promptEnterTimer) clearTimeout(session.promptEnterTimer);
    session.promptEnterTimer = null;
  }

  private failPromptDelivery(session: LiveSession, detail: string): void {
    if (session.ended) return;
    this.tasks.recordEvent(session.taskId, 'external.promptDeliveryFailed', {
      cli: session.cli,
      detail,
      attempts: session.promptSubmitAttempts,
    });
    this.logger.warn('external first prompt delivery failed', {
      terminalId: session.terminalId,
      taskId: session.taskId,
      cli: session.cli,
      detail,
    });
    this.clearPromptDelivery(session);
    // This terminal was created for the pending prompt. Leaving an empty TUI
    // alive makes recovery renew the Mission Attempt forever, so retire it and
    // let normal runtime reconciliation surface a failed/missing Assignment.
    this.terminals.kill(session.terminalId);
  }

  private clearPromptDelivery(session: LiveSession): void {
    session.pendingPrompt = null;
    session.promptAwaitingStart = false;
    session.promptDeliveryStartedAtMs = null;
    session.promptSubmitAttempts = 0;
    session.orchestratorSubmitPending = false;
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
        this.onSessionBound?.({ terminalId, taskId: pending.taskId });
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
    const reattachedTask = this.tasks.activeExternalTaskForTerminal(terminalId);
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

    let worktree: TaskWorktreeDto | null = reattachedTask?.worktree ?? null;
    if (!worktree && terminal.contextTaskId) {
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
    const remoteManaged = Boolean(
      terminal.remote?.workerSessionId && terminal.remote.root && terminal.remote.workerVersion,
    );
    const remoteWorkspaceKind = terminal.remote?.workspaceKind ?? 'remote';
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
    let snapshotRef: string | null = reattachedTask?.external?.snapshotRef ?? null;
    if (git && !reattachedTask) {
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
    // an intent: the pre-assigned conversation id and the first prompt. A
    // composer worktree launch already has a prepared external task, so the
    // intent — rather than task presence — distinguishes it from a daemon
    // reattach. The intent remains one-shot on this detection edge.
    const intent = this.launchIntents?.consume(terminalId, cli) ?? null;
    const existingReattach = reattachedTask !== null && intent === null;

    let taskId: string;
    if (reattachedTask) {
      taskId = reattachedTask.id;
      this.tasks.recordEvent(
        taskId,
        existingReattach ? 'external.sessionReattached' : 'external.sessionLaunchConfirmed',
        existingReattach
          ? {
              cli,
              terminalId,
              note: 'Reconnected to the daemon PTY after the desktop app restarted.',
            }
          : { cli, terminalId, worktree: worktree?.path ?? null },
      );
    } else {
      try {
        const task = await this.tasks.createExternalTask({
          cli,
          terminalId,
          cwd,
          projectPath,
          worktree,
          snapshotRef,
          title: intent?.prompt ? externalTitleFromPrompt(intent.prompt) : null,
          ...(remoteManaged && remoteWorkspaceKind === 'remote'
            ? { projectDisplayName: terminal.projectName }
            : {}),
          ...(remoteManaged && terminal.remote
            ? {
                remote: {
                  hostId: terminal.remote.hostId,
                  hostLabel: terminal.remote.hostLabel,
                  root: terminal.remote.root!,
                  workerSessionId: terminal.remote.workerSessionId!,
                  workerVersion: terminal.remote.workerVersion!,
                  workspaceKind: terminal.remote.workspaceKind ?? 'remote',
                },
              }
            : {}),
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
    }

    const watcher = new WorkspaceWatcher(root);
    const session: LiveSession = {
      terminalId,
      taskId,
      cli,
      root,
      cwd,
      startedAtMs: reattachedTask ? Date.parse(reattachedTask.createdAt) : Date.now(),
      sessionId: reattachedTask?.external?.sessionId ?? null,
      isGitRepo: rootInfo.isGitRepo,
      snapshotRef,
      git,
      watcher,
      remoteManaged,
      remoteWorkspaceKind,
      unsubscribe: () => {},
      seen: new Set(),
      sharedRoot: false,
      recomputeTimer: null,
      terminalFlushTimer: null,
      terminalBuffer: '',
      terminalBytes: 0,
      terminalTruncated: false,
      presenceTimer: null,
      presenceAwaitingReply: false,
      presenceSawOutput: false,
      presenceTuiBusy: false,
      presenceTitleBuffer: '',
      // A daemon-backed reattach means the same agent turn continued while
      // the desktop was absent; a freshly prepared worktree launch has not
      // begun its first turn yet.
      fileAttributionActive: existingReattach,
      lastAgentActivityAtMs: Date.now(),
      fileAttributionGraceUntilMs: Date.now() + INITIAL_COMMAND_ATTRIBUTION_MS,
      pendingPrompt: null,
      promptSettleTimer: null,
      promptDeadlineTimer: null,
      promptEnterTimer: null,
      promptDeliveryStartedAtMs: null,
      promptAwaitingStart: false,
      promptSubmitAttempts: 0,
      startupTrustGateHandled: false,
      startupUpdateGateHandled: false,
      orchestratorSubmitPending: false,
      typedLine: new TypedLineTracker(),
      lastUserLine: null,
      suppressInputCapture: 0,
      viewportScrollUntilMs: 0,
      viewportRepaintUntilMs: 0,
      structuredStream: false,
      captureGrade: reattachedTask?.external?.captureGrade ?? 'observed',
      parser: new ExternalStructuredReplayParser(),
      lastFiles: [],
      work: Promise.resolve(),
      ended: false,
    };
    session.unsubscribe = watcher.onBatch((changes) => this.onBatch(session, changes));
    watcher.start();
    this.registerLiveSession(session);
    if (existingReattach) await this.reconcileReattachedFiles(session);
    this.onSessionBound?.({ terminalId, taskId });

    if (intent?.sessionId) {
      // Launch pre-assigned the conversation id (`claude --session-id`): the
      // task is resumable by exact id from its very first moment.
      session.sessionId = intent.sessionId;
      this.tasks.setExternalSessionId(taskId, intent.sessionId);
    }
    if (intent?.prompt) {
      if (intent.promptDelivery === 'argv') {
        // The CLI owns submission (and can safely hold the prompt behind its
        // directory-trust dialog); only account the message here.
        this.tasks.recordEvent(session.taskId, 'user.message', {
          text: intent.prompt,
          kind: 'external',
        });
        session.lastUserLine = intent.prompt;
        this.startTurn(session, 'launch');
      } else {
        this.armPromptDelivery(session, intent.prompt);
      }
    }

    // A reattached task already persisted output before shutdown. Feeding the
    // visual restore snapshot back into its ledger would duplicate old turns.
    if (!existingReattach) {
      const leadIn = this.terminals.recentData(terminalId);
      if (leadIn) this.onTerminalData(terminalId, leadIn);
    }

    broadcast('terminal.agentState', { id: terminalId, agent: cli, taskId });
    broadcast('external.sessionChanged', {
      taskId,
      terminalId,
      cli,
      status: 'active',
      captureGrade: session.captureGrade,
      snapshotRef,
      files: session.lastFiles,
    });
    this.logger.info(
      existingReattach ? 'external session reattached' : 'external session started',
      {
        terminalId,
        cli,
        taskId,
        snapshotRef,
      },
    );
  }

  /** Rebuild accounting for writes that landed while no Electron watcher was
   * alive. Both trees include tracked and untracked files, so establishing
   * the original bytes as baselines restores Review and byte-exact rollback. */
  private async reconcileSnapshotChanges(
    session: LiveSession,
    reason: 'reattach' | 'on-demand' | 'exit',
  ): Promise<number> {
    if (!session.git || !session.snapshotRef) return 0;
    let reconciled = 0;
    session.work = session.work
      .then(async () => {
        const currentTree = await session.git!.snapshotTree();
        const changed = (
          await session.git!.changedPathsBetweenTrees(session.snapshotRef!, currentTree)
        ).filter(
          (change) =>
            isAccountablePath(change.path) &&
            shouldReconcileSnapshotPath(session.sharedRoot, session.seen.has(change.path)),
        );
        if (changed.length === 0) return;
        const context = this.tasks.contextForTask(session.taskId);
        for (const change of changed) {
          const baseline = await session.git!.readTreeBlob(session.snapshotRef!, change.path);
          const record = await context.changes.reconcileExternalChange(
            session.taskId,
            change.path,
            change.kind,
            baseline,
          );
          session.seen.add(change.path);
          if (!record) continue;
          reconciled += 1;
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
            reconciliation: reason,
            ...(reason === 'reattach' ? { recoveredAfterRestart: true } : {}),
          });
        }
      })
      .catch((error) => {
        this.logger.warn('external snapshot reconciliation failed', {
          taskId: session.taskId,
          terminalId: session.terminalId,
          reason,
          error: errorMessage(error),
        });
      });
    await session.work;
    return reconciled;
  }

  private async reconcileReattachedFiles(session: LiveSession): Promise<void> {
    const reconciled = await this.reconcileSnapshotChanges(session, 'reattach');
    await this.publish(session, 'active');
    this.tasks.recordEvent(session.taskId, 'external.offlineChangesReconciled', {
      cli: session.cli,
      terminalId: session.terminalId,
      changedFiles: reconciled,
    });
    this.logger.info('external offline changes reconciled', {
      taskId: session.taskId,
      terminalId: session.terminalId,
      changedFiles: reconciled,
    });
  }

  private onBatch(session: LiveSession, changes: FsChange[]): void {
    if (session.ended) return;
    if (session.remoteManaged) {
      if (session.remoteWorkspaceKind === 'local') this.onLocalWorkspaceBatch(session, changes);
      return;
    }
    if (this.fileAttributionOwner(session.root) !== session) return;
    const candidates = changes.filter(
      (change) => !change.isDirectory && isAccountablePath(change.relativePath),
    );
    if (candidates.length === 0) return;
    session.work = session.work
      .then(async () => {
        const ignored = session.git
          ? await session.git.ignoredPaths(candidates.map((change) => change.relativePath))
          : new Set<string>();
        const fresh = candidates.filter((change) => !ignored.has(change.relativePath));
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
              { author: 'system' },
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
      })
      .catch((error) => {
        this.logger.warn('external accounting batch failed', {
          taskId: session.taskId,
          error: errorMessage(error),
        });
      });
    if (!session.recomputeTimer) {
      session.recomputeTimer = setTimeout(() => {
        session.recomputeTimer = null;
        void this.publish(session, 'active');
      }, 300);
      session.recomputeTimer.unref?.();
    }
  }

  /** Local-workspace mode is a real two-way bridge. Local editor/user writes
   * are pushed through the same expected-hash Worker apply path; its next net
   * change poll records them in the ordinary Session ledger. */
  private onLocalWorkspaceBatch(session: LiveSession, changes: FsChange[]): void {
    if (!this.remoteMirrorPush) return;
    const candidates = changes.filter(
      (change) => !change.isDirectory && isAccountablePath(change.relativePath),
    );
    if (candidates.length === 0) return;
    const previous = this.remoteMirrorPushWork.get(session.taskId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const ignored = session.git
          ? await session.git.ignoredPaths(candidates.map((change) => change.relativePath))
          : new Set<string>();
        const paths = [
          ...new Set(
            candidates.map((change) => change.relativePath).filter((path) => !ignored.has(path)),
          ),
        ];
        if (paths.length > 0) await this.remoteMirrorPush!(session.taskId, paths);
      })
      .catch((error) => {
        this.logger.warn('local-to-remote workspace sync failed', {
          taskId: session.taskId,
          error: errorMessage(error),
        });
        this.tasks.recordEvent(session.taskId, 'system.diagnostic', {
          code: 'SSH_LOCAL_WORKSPACE_SYNC_FAILED',
          detail: errorMessage(error),
        });
      })
      .finally(() => {
        if (this.remoteMirrorPushWork.get(session.taskId) === next) {
          this.remoteMirrorPushWork.delete(session.taskId);
        }
      });
    this.remoteMirrorPushWork.set(session.taskId, next);
  }

  /**
   * Materialize Worker-observed versions into the sparse local review mirror,
   * then feed the existing byte-exact ChangeService ledger. This is callable
   * after the PTY ended too, allowing a reconnect to refresh an open Review.
   */
  async ingestRemoteChanges(
    terminalId: string | null,
    taskId: string,
    changes: RemoteExternalChange[],
  ): Promise<void> {
    if (changes.length === 0) return;
    const session = terminalId ? this.byTerminal.get(terminalId) : undefined;
    if (session && session.taskId !== taskId) {
      throw new Error('Remote Worker task binding does not match the terminal Session');
    }
    const task = this.tasks.getTask(taskId);
    const external = task.external;
    if (!external?.remote) throw new Error('Task is not a managed remote Session');
    const remote = external.remote;
    const root = task.projectPath;
    const context = this.tasks.contextForTask(taskId);
    const apply = async (): Promise<void> => {
      for (const change of changes) {
        if (!isAccountablePath(change.path)) continue;
        const decode = (
          base64: string | null,
          hash: string | null,
          side: string,
        ): Buffer | null => {
          if (base64 === null) {
            if (hash !== null)
              throw new Error(`Remote ${side} hash has no bytes for ${change.path}`);
            return null;
          }
          const bytes = Buffer.from(base64, 'base64');
          const actual = createHash('sha256').update(bytes).digest('hex');
          if (actual !== hash)
            throw new Error(`Remote ${side} integrity check failed for ${change.path}`);
          return bytes;
        };
        const before = decode(change.beforeBase64, change.beforeHash, 'baseline');
        const after = decode(change.afterBase64, change.afterHash, 'current version');
        await context.changes.ensureBaselineFromBytes(
          taskId,
          change.path,
          before,
          change.beforeMode,
        );
        const absolute = join(root, ...change.path.split('/'));
        if (
          (remote.workspaceKind ?? 'remote') === 'local' &&
          change.expectedMirrorHash !== undefined
        ) {
          let actualHash: string | null = null;
          try {
            const fileStat = await stat(absolute);
            if (!fileStat.isFile()) {
              throw new Error(`Local bridge target is not a file: ${change.path}`);
            }
            actualHash = createHash('sha256')
              .update(await readFile(absolute))
              .digest('hex');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          // Retried delivery after an interrupted publish is idempotent when
          // the desired bytes already landed. Any other mismatch is a real
          // concurrent local edit and must never be overwritten silently.
          if (actualHash !== change.expectedMirrorHash && actualHash !== change.afterHash) {
            throw new ProductFailure(
              productError('SSH_LOCAL_WORKSPACE_CONFLICT', {
                userMessage: `Local file ${change.path} changed while the remote Agent was editing it. Charter paused synchronization instead of overwriting either side.`,
                retryable: true,
                context: {
                  path: change.path,
                  expectedHash: change.expectedMirrorHash,
                  actualHash,
                  remoteHash: change.afterHash,
                },
              }),
            );
          }
        }
        if (after === null) {
          await unlink(absolute).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else {
          await mkdir(dirname(absolute), { recursive: true });
          const temporary = `${absolute}.charter-remote-${process.pid}.tmp`;
          try {
            await writeFile(temporary, after);
            if (change.afterMode !== null) await chmod(temporary, change.afterMode);
            await rename(temporary, absolute);
          } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
          }
        }
        const kind = after === null ? 'deleted' : before === null ? 'created' : 'modified';
        const record = await context.changes.reconcileExternalChange(
          taskId,
          change.path,
          kind,
          before,
        );
        session?.seen.add(change.path);
        if (!record) continue;
        const stats = countPatchLines(record.patch);
        this.tasks.recordEvent(taskId, 'external.fileChanged', {
          cli: external.cli,
          captureGrade: external.captureGrade ?? 'observed',
          changeId: record.id,
          path: record.relativePath,
          kind: record.kind,
          additions: stats.additions,
          deletions: stats.deletions,
          beforeHash: record.beforeHash,
          afterHash: record.afterHash,
          source: 'remote-worker',
        });
      }
    };
    if (session) {
      session.work = session.work.then(apply);
      await session.work;
      await this.publish(session, session.ended ? 'ended' : 'active');
    } else {
      await apply();
    }
  }

  private async publish(session: LiveSession, status: 'active' | 'ended'): Promise<void> {
    try {
      await session.work;
      const context = this.tasks.contextForTask(session.taskId);
      const cs: ChangeSet = await context.changes.changeSet(session.taskId);
      const files = cs.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      const ignored = session.git
        ? await session.git.ignoredPaths(files.map((file) => file.path))
        : new Set<string>();
      session.lastFiles = files.filter((file) => !ignored.has(file.path));
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
    // A final tree comparison is the correctness boundary. fs.watch is the
    // low-latency path, but it is explicitly lossy/coalescing on every desktop
    // platform and cannot be the only source for the review ledger.
    await this.reconcileSnapshotChanges(session, 'exit');
    await this.publish(session, 'ended');
    // Establish the conversation id before the task closes into review, so a
    // later resume targets THIS session even after newer ones ran in the same
    // directory. Transcript discovery is bounded by this session's lifetime.
    if (!session.sessionId) {
      session.sessionId = session.remoteManaged
        ? await (this.remoteSessionIdentity?.(session.taskId, session.cli) ?? Promise.resolve(null))
        : await discoverCliSessionId({
            cli: session.cli,
            connector: this.agents?.sessionIdentityConnector(session.cli) ?? undefined,
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
   * User-invoked continuation of an ended external Agent TUI. The command is
   * resolved from a trusted host manifest (never renderer-controlled shell
   * text). Unsettled
   * tasks (REVIEW_READY/INTERRUPTED/FAILED) resume against the SAME task
   * baseline; a settled round (ACCEPTED/ROLLED_BACK/CANCELLED) is a closed
   * record, so the same CLI conversation continues as a NEW task on a fresh
   * entry snapshot — mirroring "a follow-up is a new task" for managed runs.
   * Detection confirms the CLI really started before this RPC succeeds.
   */
  async resume(
    taskId: string,
    requestedTerminalId?: string | null,
    options: { resumeFleet?: boolean } = {},
  ): Promise<ExternalSessionResumeResult> {
    const source = this.tasks.getTask(taskId);
    let sourceExternal = source.external;
    if (!sourceExternal) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_REQUIRED', {
          userMessage: 'This task is not an external terminal session.',
        }),
      );
    }
    const remoteManaged = Boolean(sourceExternal.remote);
    const settled = ['ACCEPTED', 'ROLLED_BACK', 'CANCELLED'].includes(source.state);
    if (remoteManaged && settled) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_NOT_RESUMABLE', {
          userMessage:
            'This historic remote Session is already closed. Start a new remote Session from Home to take a fresh Worker baseline.',
        }),
      );
    }
    if (
      remoteManaged &&
      (!sourceExternal.sessionId || !isSafeCliSessionId(sourceExternal.sessionId)) &&
      this.remoteSessionIdentity
    ) {
      const recoveredSessionId = await this.remoteSessionIdentity(taskId, sourceExternal.cli, {
        allowConnect: true,
      }).catch(() => null);
      if (recoveredSessionId && isSafeCliSessionId(recoveredSessionId)) {
        this.tasks.setExternalSessionId(taskId, recoveredSessionId);
        sourceExternal = this.tasks.getTask(taskId).external!;
      }
    }
    if (
      sourceExternal.cli === 'codex' &&
      (!sourceExternal.sessionId || !isSafeCliSessionId(sourceExternal.sessionId))
    ) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_ID_REQUIRED', {
          userMessage:
            'This Codex Session cannot be resumed safely because its conversation ID was not recorded.',
        }),
      );
    }
    const expectedCwd = sourceExternal.cwd ?? source.projectPath;
    let terminalId = requestedTerminalId ?? '';
    let activateRemote: (() => void) | undefined;
    let command: string | null;
    let codexLocation = null as Awaited<ReturnType<typeof locateCodexSession>>;

    if (remoteManaged) {
      command = externalResumeCommand(
        sourceExternal.cli,
        sourceExternal.sessionId ?? null,
        null,
        this.agents,
        true,
      );
      if (!command) {
        throw new ProductFailure(
          productError('EXTERNAL_RESUME_UNSUPPORTED', {
            userMessage: `${sourceExternal.cli} does not have a supported remote session-resume command.`,
          }),
        );
      }
      if (!this.remoteResume) {
        throw new ProductFailure(
          productError('SSH_WORKER_REQUIRED', {
            userMessage: 'The managed SSH resume service is not available.',
            retryable: true,
          }),
        );
      }
      const prepared = await this.remoteResume(source);
      terminalId = prepared.terminalId;
      activateRemote = prepared.activate;
      command = `cd -- ${shellQuote(expectedCwd)} && exec ${command}`;
    } else {
      if (!terminalId) {
        throw new ProductFailure(
          productError('TERMINAL_NOT_FOUND', {
            userMessage: 'Open a terminal for this Session and try again.',
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
      if (terminal.cwd !== expectedCwd) {
        throw new ProductFailure(
          productError('EXTERNAL_RESUME_CWD_MISMATCH', {
            userMessage: `The resume terminal must start in ${expectedCwd}.`,
          }),
        );
      }

      // Older builds could discover the host Codex Desktop rollout in
      // `.codex-app`, then later resume from the CLI's default `.codex` home.
      codexLocation =
        sourceExternal.cli === 'codex' && sourceExternal.sessionId
          ? await locateCodexSession({
              cli: 'codex',
              sessionId: sourceExternal.sessionId,
              cwd: expectedCwd,
              startedAtMs: Date.parse(source.createdAt),
              endedAtMs: Date.parse(source.updatedAt),
            })
          : null;
      command = externalResumeCommand(
        sourceExternal.cli,
        sourceExternal.sessionId ?? null,
        codexLocation?.codexHome,
        this.agents,
      );
    }
    if (!command) {
      throw new ProductFailure(
        productError('EXTERNAL_RESUME_UNSUPPORTED', {
          userMessage: `${sourceExternal.cli} does not have a supported session-resume command.`,
        }),
      );
    }
    if (codexLocation) {
      this.logger.info('codex resume home resolved', {
        taskId: source.id,
        sessionId: codexLocation.sessionId,
        codexHome: codexLocation.codexHome,
      });
    }

    let task = source;
    let external = sourceExternal;
    if (settled) {
      let snapshotRef: string | null = null;
      if (source.gitBaseline) {
        try {
          snapshotRef = await new GitService(source.projectPath).snapshotTree();
        } catch (e) {
          this.logger.warn('continuation snapshot failed; degrading to first-seen baselines', {
            terminalId,
            error: errorMessage(e),
          });
        }
      }
      task = await this.tasks.createExternalTask({
        cli: sourceExternal.cli,
        terminalId,
        cwd: expectedCwd,
        projectPath: source.projectPath,
        worktree: source.worktree && !source.worktree.missing ? source.worktree : null,
        snapshotRef,
        title: source.title,
      });
      if (
        sourceExternal.sessionId &&
        (this.agents?.sessionIdSafe(sourceExternal.cli, sourceExternal.sessionId) ??
          isSafeCliSessionId(sourceExternal.sessionId))
      ) {
        this.tasks.setExternalSessionId(task.id, sourceExternal.sessionId);
      }
      this.tasks.recordEvent(source.id, 'external.sessionContinued', {
        cli: sourceExternal.cli,
        taskId: task.id,
      });
      this.tasks.recordEvent(task.id, 'external.sessionResumedFrom', {
        cli: sourceExternal.cli,
        taskId: source.id,
        title: source.title,
      });
      task = this.tasks.getTask(task.id);
      external = task.external!;
      this.logger.info('settled external session continues as a new task', {
        fromTaskId: source.id,
        taskId: task.id,
        cli: external.cli,
      });
    }

    const resumed = await this.startResumedSession({
      task,
      external,
      terminalId,
      expectedCwd,
      command,
      ...(activateRemote ? { activateRemote } : {}),
      retireStubOnMiss: settled,
      sameTaskResume: !settled,
    });
    let fleet: ExternalFleetResumeSummary = {
      requested: 0,
      resumed: 0,
      reused: 0,
      failed: [],
    };
    if (options.resumeFleet !== false && this.onFleetResume) {
      try {
        fleet = await this.onFleetResume({
          sourceTaskId: source.id,
          targetTaskId: resumed.taskId,
          commanderTerminalId: resumed.terminalId,
        });
      } catch (error) {
        this.logger.warn('external commander resumed but fleet restoration failed', {
          sourceTaskId: source.id,
          targetTaskId: resumed.taskId,
          error: errorMessage(error),
        });
        fleet.failed.push({ taskId: source.id, message: errorMessage(error) });
      }
    }
    return { ...resumed, fleet };
  }

  /**
   * ADR-0038: adopt a DISCOVERED session (session archaeology) as a brand-new
   * external task — the same machinery as continuing a settled session, minus
   * a source task. The entry snapshot is taken at this moment: everything the
   * conversation did before adoption stays outside the ledger, honestly.
   */
  async adopt(
    input: { cli: string; sessionId: string; cwd: string; projectPath: string; title: string },
    terminalId: string,
  ): Promise<{ terminalId: string; cli: string; taskId: string }> {
    if (!(
      this.agents?.sessionIdSafe(input.cli, input.sessionId) ?? isSafeCliSessionId(input.sessionId)
    )) {
      throw new ProductFailure(
        productError('EXTERNAL_SESSION_ID_INVALID', {
          userMessage: 'That session id cannot be resumed safely.',
        }),
      );
    }
    const command = externalResumeCommand(input.cli, input.sessionId, null, this.agents);
    if (!command) {
      throw new ProductFailure(
        productError('EXTERNAL_RESUME_UNSUPPORTED', {
          userMessage: `${input.cli} does not have a supported session-resume command.`,
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
          userMessage: 'Open a terminal for this session and try again.',
        }),
      );
    }
    if (terminal.cwd !== input.cwd) {
      throw new ProductFailure(
        productError('EXTERNAL_RESUME_CWD_MISMATCH', {
          userMessage: `The resume terminal must start in ${input.cwd}.`,
        }),
      );
    }
    // Entry snapshot at adoption — the diff baseline for everything after.
    let snapshotRef: string | null = null;
    try {
      const info = await openWorkspaceInfo(input.projectPath);
      if (info.isGitRepo) snapshotRef = await new GitService(input.projectPath).snapshotTree();
    } catch (e) {
      this.logger.warn('adoption snapshot failed; degrading to first-seen baselines', {
        terminalId,
        error: errorMessage(e),
      });
    }
    let task = await this.tasks.createExternalTask({
      cli: input.cli,
      terminalId,
      cwd: input.cwd,
      projectPath: input.projectPath,
      worktree: null,
      snapshotRef,
      title: input.title,
    });
    this.tasks.setExternalSessionId(task.id, input.sessionId);
    this.tasks.recordEvent(task.id, 'external.sessionAdopted', {
      cli: input.cli,
      sessionId: input.sessionId,
      cwd: input.cwd,
    });
    task = this.tasks.getTask(task.id);
    this.logger.info('discovered external session adopted', {
      taskId: task.id,
      cli: input.cli,
      cwd: input.cwd,
    });
    return this.startResumedSession({
      task,
      external: task.external!,
      terminalId,
      expectedCwd: input.cwd,
      command,
      retireStubOnMiss: true,
      sameTaskResume: false,
    });
  }

  /** Shared tail of resume/adopt: wire the live session, inject the resume
   * command, and hold the RPC open until the CLI is really detected. */
  private async startResumedSession(input: {
    task: ReturnType<TaskService['getTask']>;
    external: NonNullable<ReturnType<TaskService['getTask']>['external']>;
    terminalId: string;
    expectedCwd: string;
    command: string;
    /** Remote terminals have no local process table; declare the independently
     * probed Agent only after the resume command has actually been written. */
    activateRemote?: () => void;
    /** Retire the freshly-minted stub task if the CLI never shows up. */
    retireStubOnMiss: boolean;
    /** Same-task resumes flip the source task active again (state-gated). */
    sameTaskResume: boolean;
  }): Promise<{ terminalId: string; cli: string; taskId: string }> {
    const { task, external, terminalId, expectedCwd, command } = input;
    const git = task.gitBaseline ? new GitService(task.projectPath) : null;
    const watcher = new WorkspaceWatcher(task.projectPath);
    const changeSet = await this.tasks.contextForTask(task.id).changes.changeSet(task.id);
    const session: LiveSession = {
      terminalId,
      taskId: task.id,
      cli: external.cli,
      root: task.projectPath,
      cwd: expectedCwd,
      startedAtMs: Date.now(),
      // Native resume continues the SAME conversation id — keep it,
      // so an immediate exit without new transcript writes stays targetable.
      sessionId:
        external.sessionId &&
        (this.agents?.sessionIdSafe(external.cli, external.sessionId) ??
          isSafeCliSessionId(external.sessionId))
          ? external.sessionId
          : null,
      isGitRepo: git !== null,
      snapshotRef: external.snapshotRef,
      git,
      watcher,
      remoteManaged: Boolean(external.remote),
      remoteWorkspaceKind: external.remote?.workspaceKind ?? 'remote',
      unsubscribe: () => {},
      seen: new Set(changeSet.files.map((file) => file.path)),
      sharedRoot: false,
      recomputeTimer: null,
      terminalFlushTimer: null,
      terminalBuffer: '',
      terminalBytes: 0,
      terminalTruncated: false,
      presenceTimer: null,
      presenceAwaitingReply: false,
      presenceSawOutput: false,
      presenceTuiBusy: false,
      presenceTitleBuffer: '',
      fileAttributionActive: false,
      lastAgentActivityAtMs: Date.now(),
      fileAttributionGraceUntilMs: Date.now() + INITIAL_COMMAND_ATTRIBUTION_MS,
      pendingPrompt: null,
      promptSettleTimer: null,
      promptDeadlineTimer: null,
      promptEnterTimer: null,
      promptDeliveryStartedAtMs: null,
      promptAwaitingStart: false,
      promptSubmitAttempts: 0,
      startupTrustGateHandled: false,
      startupUpdateGateHandled: false,
      orchestratorSubmitPending: false,
      typedLine: new TypedLineTracker(),
      lastUserLine: null,
      suppressInputCapture: 0,
      viewportScrollUntilMs: 0,
      viewportRepaintUntilMs: 0,
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
    this.registerLiveSession(session);
    // A continuation task is born active; only a same-task resume flips the
    // source task's status back (and is state-gated in the task service).
    if (input.sameTaskResume) this.tasks.resumeExternalSession(task.id, terminalId);
    broadcast('external.sessionChanged', {
      taskId: task.id,
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
        void this.onAgentExit(terminalId).finally(() => {
          // A continuation stub that never saw its CLI is pure noise — retire
          // it. Worktree-mounted stubs keep the shared mount and stay visible
          // (archive would discard the source task's worktree).
          if (input.retireStubOnMiss && !task.worktree) {
            try {
              this.tasks.archive(task.id);
            } catch (e) {
              this.logger.warn('failed to retire an undetected continuation task', {
                taskId: task.id,
                error: errorMessage(e),
              });
            }
          }
          reject(
            new ProductFailure(
              productError('EXTERNAL_RESUME_NOT_DETECTED', {
                userMessage: `${external.cli} did not start in the terminal. The task remains safe and ready for review.`,
              }),
            ),
          );
        });
      }, 12_000);
      timer.unref?.();
      this.pendingResumes.set(terminalId, {
        taskId: task.id,
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
    input.activateRemote?.();
    await detected;
    return { terminalId, cli: external.cli, taskId: task.id };
  }

  /**
   * ADR-0030 — context feeding for external sessions. Writes one reference
   * into the CLI's own input line (bracketed paste, deliberately no Enter):
   * the user watches it land, edits it, and submits with the CLI's own
   * keystroke. File refs become `@path` mentions the CLI resolves at send
   * time; selections carry their frozen bytes so a later edit can never
   * change what the user cited. The injection itself is ledgered — the
   * eventual submit stays an ordinary unmanaged keystroke.
   */
  injectContext(
    taskId: string,
    ref: ExternalInjectRefDto,
  ): { delivered: boolean; terminalId: string } {
    const task = this.tasks.getTask(taskId);
    const external = task.external;
    if (!external) {
      throw new ProductFailure(
        productError('TASK_NOT_EXTERNAL', {
          userMessage: 'This Session is not backed by an external Agent.',
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
    const prompt = externalInjectText(ref);
    this.tasks.recordEvent(taskId, 'external.contextInjected', {
      cli: session.cli,
      captureGrade: session.captureGrade,
      kind: ref.kind,
      path:
        ref.kind === 'file'
          ? ref.path
          : ref.kind === 'selection'
            ? ref.code.path
            : ref.artifact.path,
      ...(ref.kind === 'selection'
        ? {
            startLine: ref.code.startLine,
            endLine: ref.code.endLine,
            selectionHash: ref.code.selectionHash,
          }
        : {}),
      ...(ref.kind === 'artifact'
        ? {
            contentHash: ref.artifact.contentHash,
            artifactKind: ref.artifact.artifactKind,
            anchor: ref.artifact.anchor,
          }
        : {}),
    });
    // Bracketed paste with NO trailing Enter — landing in the input line
    // unsent is the whole contract of this method.
    this.writeProduct(session, `\u001b[200~${prompt}\u001b[201~`);
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
    for (const [terminalId, session] of [...this.byTerminal]) {
      if (!this.terminals.persistsAcrossAppRestart(terminalId)) {
        void this.onAgentExit(terminalId);
        continue;
      }
      if (session.terminalFlushTimer) clearTimeout(session.terminalFlushTimer);
      session.terminalFlushTimer = null;
      this.clearObservedPresence(session);
      this.clearPromptDelivery(session);
      this.flushTerminal(session);
      if (session.recomputeTimer) clearTimeout(session.recomputeTimer);
      session.recomputeTimer = null;
      session.unsubscribe();
      session.watcher.dispose();
      session.ended = true;
      this.byTerminal.delete(terminalId);
      this.logger.info('external session detached for app restart', {
        terminalId,
        taskId: session.taskId,
      });
    }
  }
}
