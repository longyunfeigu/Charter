import { spawnSync } from 'node:child_process';
import { newId } from '@pi-ide/foundation';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';
import { shellIntegrationSpawn, type ShellIntegrationConfig } from './shell-integration.js';

export {
  SHELL_INTEGRATION_FILES,
  shellIntegrationSpawn,
  type ShellIntegrationConfig,
  type ShellSpawnPlan,
} from './shell-integration.js';

export interface TerminalInfo {
  id: string;
  title: string;
  shell: string;
  pid: number;
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
  launch: 'shell' | 'claude' | 'codex';
}

export interface CreateTerminalOptions {
  cwd: string;
  shellPath?: string | null;
  /** Host-owned direct process launch. This is intentionally not exposed on
   * renderer IPC; orchestration uses it to avoid typing a CLI into a shell. */
  executable?: string;
  args?: string[];
  /** A directly spawned agent is known without foreground-process polling. */
  knownAgent?: 'claude' | 'codex';
  cols?: number;
  rows?: number;
  scrollback?: number;
  projectName?: string;
  projectPath?: string | null;
  contextKind?: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel?: string;
  contextTaskId?: string | null;
  launch?: 'shell' | 'claude' | 'codex';
}

export type TerminalInputSource = 'user' | 'terminal' | 'host' | 'orchestrator';

export interface TerminalContextUpdate {
  cwd: string;
  projectName: string;
  projectPath: string | null;
  contextKind: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel: string;
  contextTaskId: string | null;
}

interface Session {
  info: TerminalInfo;
  pty: IPty;
  tracker: AgentStateTracker;
  recentData: string;
  knownAgent: 'claude' | 'codex' | null;
}

// ---------- terminal environment hygiene ----------

/**
 * Ambient agent-session markers must never leak into user terminals. When the
 * app itself was launched from inside a Claude Code (or Codex) session — a dev
 * run, a CI harness, a user who starts everything from one agent shell — the
 * Electron process inherits that session's environment. A claude started in a
 * Charter terminal would then detect a nested/child agent session and change
 * behavior; the observed field failure is that nested interactive claude
 * sessions write NO transcript at all, so `claude --resume <id>` and
 * `--continue` both report "No conversation found".
 *
 * Session-scoped markers are stripped; deliberate user configuration
 * (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` auth/base-url) passes through. Anything
 * a user exports in their own shell profile is restored by the login shell
 * the PTY spawns, so stripping errs on the safe side.
 */
const AGENT_SESSION_ENV_ALLOWLIST = new Set(['CLAUDE_CONFIG_DIR']);
const AGENT_SESSION_ENV_EXACT = [
  'AI_AGENT',
  'CODEX_SANDBOX',
  // A Charter launched from one of its own terminals must issue fresh
  // per-terminal capabilities, never propagate the parent's identity.
  'CHARTER_TERM_ID',
  'CHARTER_CTL',
  'CHARTER_CTL_TOKEN',
];

export function sanitizedTerminalEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CLAUDE') && !AGENT_SESSION_ENV_ALLOWLIST.has(key)) continue;
    if (AGENT_SESSION_ENV_EXACT.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

// ---------- external agent CLI detection (ADR-0017) ----------

/** Known coding-agent CLIs; overridable via PI_IDE_EXTERNAL_CLIS (tests). */
export const DEFAULT_AGENT_CLIS = ['claude', 'codex'] as const;

/**
 * Shell titles mean the terminal is idle at a prompt; any other foreground
 * title that misses the CLI list gets the process-tree fallback. A positive
 * interpreter list (node/bun/…) proved too narrow: the native claude/codex
 * installers run version-named binaries (`~/.local/bin/claude →
 * …/versions/2.1.209`), so the kernel short name node-pty reports never
 * equals the CLI name. Boundary: a non-exec shell-script wrapper keeps a
 * shell title and is still missed — acceptable, real installers exec or are
 * shebang scripts.
 */
const KNOWN_SHELL_TITLES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ash',
  'csh',
  'tcsh',
  'ksh',
  'nu',
  'xonsh',
  'pwsh',
  'powershell',
  'cmd.exe',
  'login',
]);

/** `-zsh` (login shell), `/bin/zsh` and the session's own shell all count as idle. */
function isShellTitle(title: string, sessionShell: string): boolean {
  const name = basename(title.trim()).toLowerCase().replace(/^-/, '');
  if (KNOWN_SHELL_TITLES.has(name)) return true;
  return name === basename(sessionShell).toLowerCase().replace(/^-/, '');
}

function basename(p: string): string {
  const clean = p.split('\\').join('/');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

/**
 * Build the shell-native command used by host-owned working-context changes.
 * The renderer submits only a project/task/scratch identity; the resolved path
 * is quoted here, next to the PTY, so it can never become renderer-authored
 * shell text.
 */
export function terminalCwdCommand(shell: string, cwd: string): string {
  const name = basename(shell).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') {
    return `cd /d "${cwd.replaceAll('"', '""')}"`;
  }
  if (name === 'pwsh' || name === 'powershell' || name === 'powershell.exe') {
    return `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}'`;
  }
  return `cd -- '${cwd.replaceAll("'", "'\\''")}'`;
}

/** `claude` / `/usr/local/bin/claude` → 'claude'; anything else → null. */
export function titleMatchesAgent(title: string, clis: readonly string[]): string | null {
  const name = basename(title.trim()).toLowerCase();
  return clis.find((c) => c === name) ?? null;
}

/** Matches `node /path/to/claude …` style command lines (argv basename scan). */
export function commandMatchesAgent(command: string, clis: readonly string[]): string | null {
  for (const token of command.trim().split(/\s+/).slice(0, 4)) {
    const name = basename(token).toLowerCase();
    const hit = clis.find((c) => c === name);
    if (hit) return hit;
  }
  return null;
}

export interface AgentStateChange {
  /** CLI name while inside an agent session, null when back at the shell. */
  agent: string | null;
}

/**
 * Debounced enter/exit tracking for one PTY. Entering an agent session fires
 * immediately; leaving needs `exitGrace` consecutive non-agent samples so the
 * brief shell flashes between a TUI's child processes don't end the session.
 */
export class AgentStateTracker {
  private current: string | null = null;
  private missStreak = 0;

  constructor(private readonly exitGrace = 2) {}

  get agent(): string | null {
    return this.current;
  }

  update(match: string | null): AgentStateChange | null {
    if (match) {
      this.missStreak = 0;
      if (this.current !== match) {
        this.current = match;
        return { agent: match };
      }
      return null;
    }
    if (this.current === null) return null;
    this.missStreak += 1;
    if (this.missStreak >= this.exitGrace) {
      this.current = null;
      this.missStreak = 0;
      return { agent: null };
    }
    return null;
  }
}

/** One row of a `ps -ax` snapshot. */
export interface ProcessTableEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** One `ps -ax` snapshot; null when it cannot be read (win32, ps failure). */
export function readProcessTable(): ProcessTableEntry[] | null {
  if (process.platform === 'win32') return null;
  try {
    const result = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,command='], { timeout: 2000 });
    if (result.status !== 0) return null;
    const entries: ProcessTableEntry[] = [];
    for (const line of result.stdout.toString().split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      entries.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] ?? '' });
    }
    return entries;
  } catch {
    return null;
  }
}

/** Walks a process table below `rootPid` looking for an agent CLI (argv basenames). */
export function findAgentInTable(
  entries: readonly ProcessTableEntry[],
  rootPid: number,
  clis: readonly string[],
): string | null {
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry);
    children.set(entry.ppid, list);
  }
  const queue = [...(children.get(rootPid) ?? [])];
  let guard = 0;
  while (queue.length > 0 && guard < 256) {
    guard += 1;
    const entry = queue.shift()!;
    const hit = commandMatchesAgent(entry.command, clis);
    if (hit) return hit;
    queue.push(...(children.get(entry.pid) ?? []));
  }
  return null;
}

export interface TerminalManagerOptions {
  /** Agent CLI names to detect (ADR-0017); default claude/codex. */
  agentClis?: readonly string[];
  /** Foreground-process poll interval; 0 disables polling (tests drive pollOnce). */
  agentPollMs?: number;
  /** ADR-0021: resolved at spawn time so a settings flip applies to the next terminal. */
  shellIntegration?: () => ShellIntegrationConfig | null;
  /** DI seams for deterministic tests. */
  readTitle?: (session: { pty: IPty }) => string;
  readProcessTable?: () => ProcessTableEntry[] | null;
  /** Host-issued per-terminal capabilities (ADR-0044). Values are resolved
   * after the id exists and before the PTY is spawned; callers must never
   * persist the token returned here. */
  envForTerminal?: (id: string) => Record<string, string>;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

/** True when the shell has live child processes (used for close confirmation, TERM-004). */
export function hasChildProcesses(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    const result = spawnSync('pgrep', ['-P', String(pid)], { timeout: 2000 });
    return result.status === 0 && result.stdout.toString().trim().length > 0;
  } catch {
    return false;
  }
}

/** User terminal sessions (separate security domain from agent commands, TERM-005). */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly dataListeners = new Set<(info: { id: string; data: string }) => void>();
  private readonly inputListeners = new Set<(info: { id: string; data: string }) => void>();
  private readonly sourcedInputListeners = new Set<
    (info: { id: string; data: string; source: TerminalInputSource }) => void
  >();
  private readonly exitListeners = new Set<(info: { id: string; exitCode: number }) => void>();
  private readonly agentListeners = new Set<
    (info: { id: string; agent: string | null; cwd: string }) => void
  >();
  private readonly agentClis: readonly string[];
  private readonly readTitle: (session: { pty: IPty }) => string;
  private readonly readTable: () => ProcessTableEntry[] | null;
  private readonly shellIntegration: (() => ShellIntegrationConfig | null) | null;
  private readonly envForTerminal: ((id: string) => Record<string, string>) | null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, exitCode: number) => void,
    options: TerminalManagerOptions = {},
  ) {
    this.agentClis =
      options.agentClis ??
      (process.env.PI_IDE_EXTERNAL_CLIS
        ? process.env.PI_IDE_EXTERNAL_CLIS.split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : DEFAULT_AGENT_CLIS);
    this.readTitle = options.readTitle ?? ((s) => s.pty.process);
    this.readTable = options.readProcessTable ?? readProcessTable;
    this.shellIntegration = options.shellIntegration ?? null;
    this.envForTerminal = options.envForTerminal ?? null;
    const pollMs = options.agentPollMs ?? 700;
    if (pollMs > 0) {
      this.pollTimer = setInterval(() => this.pollOnce(), pollMs);
      this.pollTimer.unref?.();
    }
  }

  /** ADR-0017: subscribe to agent-session enter/exit per terminal. */
  onAgentState(
    listener: (info: { id: string; agent: string | null; cwd: string }) => void,
  ): () => void {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  /**
   * Subscribe to the exact PTY stream. The renderer still receives the
   * original callback; this second fan-out lets accountable external-agent
   * sessions persist a bounded replay without coupling TerminalManager to the
   * task database.
   */
  onDataEvent(listener: (info: { id: string; data: string }) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /**
   * Subscribe to bytes sent into a PTY. External interactive agents use the
   * Enter edge to arm observed-grade reply presence without interpreting or
   * persisting the user's input here.
   */
  onInputEvent(listener: (info: { id: string; data: string }) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  /** Source-aware input stream. User keystrokes are distinct from host and
   * orchestrator writes so local takeover always wins (ADR-0044). */
  onSourcedInputEvent(
    listener: (info: { id: string; data: string; source: TerminalInputSource }) => void,
  ): () => void {
    this.sourcedInputListeners.add(listener);
    return () => this.sourcedInputListeners.delete(listener);
  }

  onExitEvent(listener: (info: { id: string; exitCode: number }) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emitData(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (session) session.recentData = `${session.recentData}${data}`.slice(-64 * 1024);
    this.onData(id, data);
    for (const listener of this.dataListeners) listener({ id, data });
  }

  /** Current agent CLI running in a terminal, if any. */
  agentFor(id: string): string | null {
    return this.sessions.get(id)?.tracker.agent ?? null;
  }

  /** Small in-memory lead-in so session detection cannot miss fast JSON init events. */
  recentData(id: string): string {
    return this.sessions.get(id)?.recentData ?? '';
  }

  /** One detection sample across all sessions (interval-driven; public for tests). */
  pollOnce(): void {
    // The `ps` snapshot is shared by every session that needs the fallback —
    // at most one subprocess per tick regardless of terminal count.
    let table: ProcessTableEntry[] | null | undefined;
    for (const session of this.sessions.values()) {
      // A host-owned direct launch remains the known agent until its root PTY
      // exits. Polling its child processes can only downgrade that certainty.
      if (session.knownAgent) continue;
      let match: string | null = null;
      try {
        const title = this.readTitle(session);
        match = titleMatchesAgent(title, this.agentClis);
        if (!match && !isShellTitle(title, session.info.shell)) {
          // Unrecognized foreground program: an interpreter (node/bun), a
          // version-named installer binary, a wrapper script… the argv of
          // the tree below the shell is the reliable signal.
          if (table === undefined) table = this.readTable();
          if (table) match = findAgentInTable(table, session.info.pid, this.agentClis);
        }
      } catch {
        match = null; // a dying pty reads as "no agent"
      }
      const change = session.tracker.update(match);
      if (change) {
        for (const listener of this.agentListeners) {
          listener({ id: session.info.id, agent: change.agent, cwd: session.info.cwd });
        }
      }
    }
  }

  create(options: CreateTerminalOptions): TerminalInfo {
    const shell = options.shellPath || defaultShell();
    const executable = options.executable ?? shell;
    const id = newId('term');
    const terminalEnv = this.envForTerminal?.(id) ?? {};
    // ADR-0021: known shells get OSC 133 marks injected; anything else spawns
    // exactly as before (plan is empty), preserving TERM-003 diagnosability.
    const plan = options.executable
      ? { args: options.args ?? [], env: {} }
      : shellIntegrationSpawn(shell, this.shellIntegration?.() ?? null);
    const pty = nodePty.spawn(executable, plan.args, {
      name: 'xterm-256color',
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      cwd: options.cwd,
      env: {
        ...sanitizedTerminalEnv(process.env),
        ...plan.env,
        ...terminalEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as Record<string, string>,
    });
    const info: TerminalInfo = {
      id,
      title: executable.split('/').pop() ?? executable,
      shell: executable,
      pid: pty.pid,
      cwd: options.cwd,
      projectName: options.projectName ?? basename(options.cwd),
      projectPath: options.projectPath ?? null,
      contextKind: options.contextKind ?? 'focused',
      contextLabel: options.contextLabel ?? options.projectName ?? basename(options.cwd),
      contextTaskId: options.contextTaskId ?? null,
      launch: options.launch ?? 'shell',
    };
    const tracker = new AgentStateTracker();
    if (options.knownAgent) tracker.update(options.knownAgent);
    const session: Session = {
      info,
      pty,
      tracker,
      recentData: '',
      knownAgent: options.knownAgent ?? null,
    };
    pty.onData((data) => this.emitData(id, data));
    pty.onExit(({ exitCode }) => {
      const liveSession = this.sessions.get(id);
      this.sessions.delete(id);
      this.fireAgentExitIfActive(id, liveSession);
      this.onExit(id, exitCode);
      for (const listener of this.exitListeners) listener({ id, exitCode });
    });
    this.sessions.set(id, session);
    if (options.knownAgent) {
      queueMicrotask(() => {
        if (this.sessions.get(id) !== session) return;
        for (const listener of this.agentListeners) {
          listener({ id, agent: options.knownAgent!, cwd: info.cwd });
        }
      });
    }
    return info;
  }

  write(id: string, data: string, source: TerminalInputSource = 'host'): void {
    const session = this.sessions.get(id);
    if (!session) return;
    for (const listener of this.inputListeners) listener({ id, data });
    for (const listener of this.sourcedInputListeners) listener({ id, data, source });
    session.pty.write(data);
  }

  /** Retarget an idle persistent PTY without replacing its scrollback/session. */
  changeContext(id: string, context: TerminalContextUpdate): TerminalInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.pty.write(`${terminalCwdCommand(session.info.shell, context.cwd)}\r`);
    Object.assign(session.info, context);
    return { ...session.info };
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
    try {
      this.sessions.get(id)?.pty.resize(cols, rows);
    } catch {
      // resizing a dying pty is harmless
    }
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  hasRunningChildren(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return hasChildProcesses(session.info.pid);
  }

  /** A killed/exited terminal ends its agent session too (ADR-0017). */
  private fireAgentExitIfActive(id: string, session: Session | undefined): void {
    if (!session || session.tracker.agent === null) return;
    for (const listener of this.agentListeners) {
      listener({ id, agent: null, cwd: session.info.cwd });
    }
  }

  /** Graceful kill with process-tree escalation (CMD-004/TERM-004). */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.fireAgentExitIfActive(id, session);
    const pid = session.info.pid;
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    if (process.platform !== 'win32') {
      // Escalate to the whole process group if anything survives the HUP.
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // group already gone — expected on the happy path
        }
      }, 1500).unref();
    }
    this.sessions.delete(id);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.disposeAll();
    this.dataListeners.clear();
    this.inputListeners.clear();
    this.sourcedInputListeners.clear();
    this.exitListeners.clear();
    this.agentListeners.clear();
  }
}
