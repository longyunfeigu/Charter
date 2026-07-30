import { spawnSync } from 'node:child_process';
import { newId } from '@pi-ide/foundation';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import type { IPty } from 'node-pty';
import * as nodePty from 'node-pty';
import { shellIntegrationSpawn, type ShellIntegrationConfig } from './shell-integration.js';

export {
  SHELL_INTEGRATION_FILES,
  shellIntegrationSpawn,
  type ShellIntegrationConfig,
  type ShellSpawnPlan,
} from './shell-integration.js';

/** SSH remote host coordinates for an adopted session (ADR-0047). */
export interface TerminalRemoteInfo {
  hostId: string;
  hostLabel: string;
  username: string;
  host: string;
  port: number;
}

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
  persistence: 'daemon' | 'process' | 'remote';
  /** Present only for SSH remote sessions (ADR-0047); absent for local PTYs. */
  remote?: TerminalRemoteInfo;
}

/**
 * I/O and lifecycle contract for a terminal session's transport. Local
 * terminals use the node-pty backed default ({@link PtyBackend}); SSH remote
 * sessions (ADR-0047) supply their own implementation to
 * {@link TerminalManager.adoptBackend}.
 */
export interface TerminalBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Idempotent: safe to call more than once, or on an already-dead session. */
  kill(): void;
  /** Live child processes present (close confirmation, TERM-004). A non-pty
   * backend has no local process tree and always returns false. */
  hasChildren(): boolean;
  /** Foreground process title for agent detection (ADR-0017), or null for a
   * backend with no local process to poll (SSH remote sessions). */
  processTitle(): string | null;
  onData(cb: (data: string, sequence?: number) => void): void;
  /** Replace the consumer's VT model after a persistent transport reconnect. */
  onResync?(cb: (replay: string, sequence: number) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  /** Optional display-only synthetic output (e.g. a connection-lost notice). */
  injectData?(data: string): void;
  /** A daemon-backed PTY survives disposal of the Electron host. */
  persistent?: boolean;
  /** Disconnect a persistent transport without terminating its PTY. */
  detach?(): void;
  /** Daemon-backed process ids arrive after the manager's synchronous create call. */
  processId?(): number;
  /** Keep restore metadata aligned when the terminal context changes. */
  updateMetadata?(info: TerminalInfo): void;
}

/** Options for adopting an externally-created backend as a managed terminal
 * (SSH remote sessions, ADR-0047). */
export interface AdoptBackendOptions {
  /** Stable daemon id when reconnecting an existing local PTY. */
  id?: string;
  pid?: number;
  /** Exact VT snapshot used to seed a newly mounted renderer. */
  initialReplay?: string;
  cols?: number;
  rows?: number;
  scrollback?: number;
  title: string;
  shell?: string;
  cwd: string;
  projectName: string;
  projectPath?: string | null;
  contextKind?: 'focused' | 'recent' | 'task' | 'scratch';
  contextLabel?: string;
  contextTaskId?: string | null;
  launch?: 'shell' | 'claude' | 'codex';
  knownAgent?: 'claude' | 'codex';
  remote?: TerminalRemoteInfo;
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

/** Fully resolved spawn request passed to an optional out-of-process PTY host. */
export interface LocalTerminalBackendRequest {
  info: TerminalInfo;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollback: number;
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
  backend: TerminalBackend;
  /** Set only for PtyBackend sessions; retained so the readTitle DI seam keeps
   * its existing pty-based semantics. */
  pty?: IPty;
  tracker: AgentStateTracker;
  recentData: TerminalReplayBuffer;
  screen: HeadlessTerminal;
  knownAgent: 'claude' | 'codex' | null;
}

const TERMINAL_REPLAY_LIMIT = 64 * 1024;
const TERMINAL_REPLAY_HARD_LIMIT = 96 * 1024;

function newScreen(cols: number, rows: number, scrollback: number): HeadlessTerminal {
  return new HeadlessTerminal({
    cols: Math.max(2, cols),
    rows: Math.max(1, rows),
    scrollback: Math.max(100, Math.min(100_000, scrollback)),
    allowProposedApi: true,
  });
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let tail = bytes.subarray(bytes.byteLength - maxBytes).toString('utf8');
  if (tail.charCodeAt(0) === 0xfffd) tail = tail.slice(1);
  return tail;
}

function screenText(
  screen: HeadlessTerminal,
  maxBytes: number,
): { content: string; totalBytes: number } {
  const buffer = screen.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  const value = lines.join('\n');
  return {
    content: utf8Tail(value, maxBytes),
    totalBytes: Buffer.byteLength(value, 'utf8'),
  };
}

interface VtCharsetState {
  g0: string;
  g1: string;
  gl: 0 | 1;
}

type VtParserMode =
  | 'ground'
  | 'escape'
  | 'escape-intermediate'
  | 'csi'
  | 'osc'
  | 'osc-escape'
  | 'string'
  | 'string-escape';

interface VtParserState {
  charset: VtCharsetState;
  mode: VtParserMode;
  intermediates: string;
}

interface VtSafePoint {
  cut: number;
  charset: VtCharsetState;
}

function defaultVtCharset(): VtCharsetState {
  return { g0: 'B', g1: 'B', gl: 0 };
}

function cloneVtCharset(state: VtCharsetState): VtCharsetState {
  return { ...state };
}

function newVtParser(charset: VtCharsetState): VtParserState {
  return { charset: cloneVtCharset(charset), mode: 'ground', intermediates: '' };
}

function isUnicodeBoundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true;
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function advanceVtParser(parser: VtParserState, char: string): void {
  const code = char.charCodeAt(0);
  const isCancel = char === '\u0018' || char === '\u001a';
  const isIntermediate = code >= 0x20 && code <= 0x2f;
  const isFinal = code >= 0x30 && code <= 0x7e;

  if (parser.mode === 'osc') {
    if (char === '\u0007' || char === '\u009c') parser.mode = 'ground';
    else if (char === '\u001b') parser.mode = 'osc-escape';
    return;
  }
  if (parser.mode === 'osc-escape') {
    if (char === '\\' || char === '\u0007' || char === '\u009c') parser.mode = 'ground';
    else if (char !== '\u001b') parser.mode = 'osc';
    return;
  }
  if (parser.mode === 'string') {
    if (char === '\u009c') parser.mode = 'ground';
    else if (char === '\u001b') parser.mode = 'string-escape';
    return;
  }
  if (parser.mode === 'string-escape') {
    if (char === '\\' || char === '\u009c') parser.mode = 'ground';
    else if (char !== '\u001b') parser.mode = 'string';
    return;
  }

  if (char === '\u000e') {
    parser.charset.gl = 1;
    return;
  }
  if (char === '\u000f') {
    parser.charset.gl = 0;
    return;
  }
  if (isCancel) {
    parser.mode = 'ground';
    parser.intermediates = '';
    return;
  }
  if (char === '\u001b') {
    parser.mode = 'escape';
    parser.intermediates = '';
    return;
  }

  if (parser.mode === 'ground') {
    if (char === '\u009b') parser.mode = 'csi';
    else if (char === '\u009d') parser.mode = 'osc';
    else if (['\u0090', '\u0098', '\u009e', '\u009f'].includes(char)) parser.mode = 'string';
    return;
  }

  if (parser.mode === 'escape') {
    if (char === '[') parser.mode = 'csi';
    else if (char === ']') parser.mode = 'osc';
    else if (['P', 'X', '^', '_'].includes(char)) parser.mode = 'string';
    else if (isIntermediate) {
      parser.mode = 'escape-intermediate';
      parser.intermediates = char;
    } else if (isFinal) {
      if (char === 'c') parser.charset = defaultVtCharset();
      parser.mode = 'ground';
    }
    return;
  }

  if (parser.mode === 'escape-intermediate') {
    if (isIntermediate) {
      parser.intermediates += char;
    } else if (isFinal) {
      if (parser.intermediates === '(') parser.charset.g0 = char;
      else if (parser.intermediates === ')') parser.charset.g1 = char;
      parser.mode = 'ground';
      parser.intermediates = '';
    }
    return;
  }

  if (parser.mode === 'csi' && code >= 0x40 && code <= 0x7e) {
    parser.mode = 'ground';
  }
}

function scanVtCut(
  value: string,
  charsetAtStart: VtCharsetState,
  minimumCut: number,
): {
  after: VtSafePoint | null;
  before: VtSafePoint;
  endParser: VtParserState;
} {
  const parser = newVtParser(charsetAtStart);
  let before: VtSafePoint = { cut: 0, charset: cloneVtCharset(charsetAtStart) };
  for (let index = 0; index < value.length; index += 1) {
    advanceVtParser(parser, value[index]!);
    const cut = index + 1;
    if (parser.mode !== 'ground' || !isUnicodeBoundary(value, cut)) continue;
    const point = { cut, charset: cloneVtCharset(parser.charset) };
    if (cut >= minimumCut) return { after: point, before, endParser: parser };
    before = point;
  }
  return { after: null, before, endParser: parser };
}

function vtReplayPrefix(state: VtCharsetState): string {
  let prefix = '';
  if (state.g0 !== 'B') prefix += `\u001b(${state.g0}`;
  if (state.g1 !== 'B') prefix += `\u001b)${state.g1}`;
  if (state.gl === 1) prefix += '\u000e';
  return prefix;
}

/** A bounded raw PTY tail whose replay always starts at a complete VT sequence. */
class TerminalReplayBuffer {
  private value = '';
  private charsetAtStart = defaultVtCharset();
  private discarding: VtParserState | null = null;

  append(data: string): void {
    if (!data) return;
    if (this.discarding) {
      let retainedAt = -1;
      for (let index = 0; index < data.length; index += 1) {
        advanceVtParser(this.discarding, data[index]!);
        const cut = index + 1;
        if (this.discarding.mode === 'ground' && isUnicodeBoundary(data, cut)) {
          retainedAt = cut;
          this.charsetAtStart = cloneVtCharset(this.discarding.charset);
          this.discarding = null;
          break;
        }
      }
      if (this.discarding) return;
      data = data.slice(retainedAt);
      if (!data) return;
    }

    this.value += data;
    if (this.value.length <= TERMINAL_REPLAY_LIMIT) return;

    const scan = scanVtCut(
      this.value,
      this.charsetAtStart,
      this.value.length - TERMINAL_REPLAY_LIMIT,
    );
    const safe = scan.after ?? scan.before;
    if (this.value.length - safe.cut > TERMINAL_REPLAY_HARD_LIMIT) {
      this.value = '';
      this.discarding = scan.endParser;
      return;
    }
    this.value = this.value.slice(safe.cut);
    this.charsetAtStart = safe.charset;
  }

  replay(): string {
    if (this.discarding) return '';
    return `${vtReplayPrefix(this.charsetAtStart)}${this.value}`;
  }

  replace(replay: string): void {
    this.value = '';
    this.charsetAtStart = defaultVtCharset();
    this.discarding = null;
    this.append(replay);
  }
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
  // Codex Desktop sets this to its private `.codex-app` store. A Codex CLI
  // launched inside Charter must use the user's CLI home instead; a deliberate
  // shell-profile export is restored when the login shell starts.
  'CODEX_HOME',
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
    // Codex Desktop exports several session-scoped CODEX_* values in addition
    // to CODEX_HOME. A login shell restores any deliberate user configuration.
    if (key.startsWith('CODEX_')) continue;
    if (AGENT_SESSION_ENV_EXACT.includes(key)) continue;
    out[key] = value;
  }
  // A desktop terminal must not inherit color-disable flags from the process
  // that launched the app. Login-shell startup files can still opt out again.
  delete out.NO_COLOR;
  if (out.FORCE_COLOR === '0') delete out.FORCE_COLOR;
  if (out.CLICOLOR === '0') delete out.CLICOLOR;
  return out;
}

/** Advertise the color, Unicode-grid and OSC 8 capabilities xterm actually
 * provides. Agent TUIs use these flags to enable linked file paths and rich
 * Markdown output instead of falling back to plain text. */
export function terminalPresentationEnv(
  env: Record<string, string | undefined>,
  appVersion = process.env.CHARTER_APP_VERSION ?? '0.0.0-dev',
): Record<string, string> {
  return {
    ...sanitizedTerminalEnv(env),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Charter',
    TERM_PROGRAM_VERSION: appVersion,
    // supports-hyperlinks allowlists known terminal names. Charter uses xterm's
    // OSC 8 implementation, so explicitly advertise what the renderer handles.
    FORCE_HYPERLINK: '1',
  } as Record<string, string>;
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
  /** DI seams for deterministic tests. Default reads the foreground title from
   * the session backend; pty sessions still expose the raw pty for overrides. */
  readTitle?: (session: { backend: TerminalBackend; pty?: IPty }) => string;
  readProcessTable?: () => ProcessTableEntry[] | null;
  /** Host-issued per-terminal capabilities (ADR-0044). Values are resolved
   * after the id exists and before the PTY is spawned; callers must never
   * persist the token returned here. */
  envForTerminal?: (id: string) => Record<string, string>;
  /** When present, local PTYs live behind this transport instead of Electron Main. */
  createLocalBackend?: (request: LocalTerminalBackendRequest) => {
    backend: TerminalBackend;
    pid: number;
  };
  /** Exact VT repaint used only when a persistent backend reconnects. */
  onResync?: (id: string, replay: string, sequence: number) => void;
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

/**
 * Default backend: a node-pty child process. Owns the graceful-kill with
 * process-group escalation (CMD-004/TERM-004) so the manager stays transport
 * agnostic across local and SSH remote sessions (ADR-0047).
 */
class PtyBackend implements TerminalBackend {
  constructor(private readonly pty: IPty) {}

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty.resize(cols, rows);
    } catch {
      // resizing a dying pty is harmless
    }
  }

  kill(): void {
    const pid = this.pty.pid;
    try {
      this.pty.kill();
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
  }

  hasChildren(): boolean {
    return hasChildProcesses(this.pty.pid);
  }

  processTitle(): string | null {
    return this.pty.process;
  }

  onData(cb: (data: string) => void): void {
    this.pty.onData(cb);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.pty.onExit(({ exitCode }) => cb(exitCode));
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
  private readonly readTitle: (session: { backend: TerminalBackend; pty?: IPty }) => string;
  private readonly readTable: () => ProcessTableEntry[] | null;
  private readonly shellIntegration: (() => ShellIntegrationConfig | null) | null;
  private readonly envForTerminal: ((id: string) => Record<string, string>) | null;
  private readonly createLocalBackend:
    ((request: LocalTerminalBackendRequest) => { backend: TerminalBackend; pid: number }) | null;
  private readonly onResync: ((id: string, replay: string, sequence: number) => void) | null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onData: (id: string, data: string, sequence?: number) => void,
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
    this.readTitle = options.readTitle ?? ((s) => s.backend.processTitle() ?? '');
    this.readTable = options.readProcessTable ?? readProcessTable;
    this.shellIntegration = options.shellIntegration ?? null;
    this.envForTerminal = options.envForTerminal ?? null;
    this.createLocalBackend = options.createLocalBackend ?? null;
    this.onResync = options.onResync ?? null;
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

  private emitData(id: string, data: string, sequence?: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.recentData.append(data);
      session.screen.write(data);
    }
    this.onData(id, data, sequence);
    for (const listener of this.dataListeners) listener({ id, data });
  }

  /** Current agent CLI running in a terminal, if any. */
  agentFor(id: string): string | null {
    return this.sessions.get(id)?.tracker.agent ?? null;
  }

  /** Small in-memory lead-in so session detection cannot miss fast JSON init events. */
  recentData(id: string): string {
    return this.sessions.get(id)?.recentData.replay() ?? '';
  }

  /** Plain text from the live VT model. Unlike ANSI stripping, this applies
   * cursor movement, erasure, alternate-screen and DEC line-drawing state. */
  async screenText(
    id: string,
    maxBytes: number,
  ): Promise<{ content: string; totalBytes: number } | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    await new Promise<void>((resolve) => session.screen.write('', resolve));
    return screenText(session.screen, maxBytes);
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
        // A backend with no local foreground process (an SSH remote session,
        // ADR-0047) has nothing to poll; agent detection does not apply. Kept
        // inside the try so a dying pty's throwing title read stays "no agent".
        if (session.backend.processTitle() === null) continue;
        const title = this.readTitle(session);
        match = titleMatchesAgent(title, this.agentClis);
        if (!match && !isShellTitle(title, session.info.shell)) {
          // Unrecognized foreground program: an interpreter (node/bun), a
          // version-named installer binary, a wrapper script… the argv of
          // the tree below the shell is the reliable signal.
          if (table === undefined) table = this.readTable();
          const pid = session.backend.processId?.() ?? session.info.pid;
          if (table && pid > 0) match = findAgentInTable(table, pid, this.agentClis);
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
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    const env = {
      ...terminalPresentationEnv(process.env),
      ...plan.env,
      ...terminalEnv,
    } as Record<string, string>;
    const info: TerminalInfo = {
      id,
      title: executable.split('/').pop() ?? executable,
      shell: executable,
      pid: -1,
      cwd: options.cwd,
      projectName: options.projectName ?? basename(options.cwd),
      projectPath: options.projectPath ?? null,
      contextKind: options.contextKind ?? 'focused',
      contextLabel: options.contextLabel ?? options.projectName ?? basename(options.cwd),
      contextTaskId: options.contextTaskId ?? null,
      launch: options.launch ?? 'shell',
      persistence: this.createLocalBackend ? 'daemon' : 'process',
    };
    if (this.createLocalBackend) {
      const scrollback = options.scrollback ?? 5000;
      const created = this.createLocalBackend({
        info,
        executable,
        args: plan.args,
        cwd: options.cwd,
        env,
        cols,
        rows,
        scrollback,
      });
      info.pid = created.pid;
      return this.registerSession(
        id,
        info,
        created.backend,
        options.knownAgent ?? null,
        undefined,
        cols,
        rows,
        scrollback,
      );
    }
    const pty = nodePty.spawn(executable, plan.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: options.cwd,
      env,
    });
    info.pid = pty.pid;
    // The pty is retained on the Session for the readTitle DI seam.
    return this.registerSession(
      id,
      info,
      new PtyBackend(pty),
      options.knownAgent ?? null,
      pty,
      cols,
      rows,
      options.scrollback ?? 5000,
    );
  }

  /**
   * Adopt an externally-created backend (an SSH remote session, ADR-0047) as a
   * managed terminal. Data and exit fan out exactly like a local PTY; pid is -1
   * because there is no local process behind the session.
   */
  adoptBackend(backend: TerminalBackend, options: AdoptBackendOptions): TerminalInfo {
    const id = options.id ?? newId('term');
    const info: TerminalInfo = {
      id,
      title: options.title,
      shell: options.shell ?? options.title,
      pid: options.pid ?? -1,
      cwd: options.cwd,
      projectName: options.projectName,
      projectPath: options.projectPath ?? null,
      contextKind: options.contextKind ?? 'focused',
      contextLabel: options.contextLabel ?? options.projectName,
      contextTaskId: options.contextTaskId ?? null,
      launch: options.launch ?? 'shell',
      persistence: backend.persistent ? 'daemon' : options.remote ? 'remote' : 'process',
      remote: options.remote,
    };
    const registered = this.registerSession(
      id,
      info,
      backend,
      options.knownAgent ?? null,
      undefined,
      options.cols ?? 80,
      options.rows ?? 24,
      options.scrollback ?? 5000,
    );
    if (options.initialReplay) {
      const session = this.sessions.get(id);
      session?.recentData.append(options.initialReplay);
      session?.screen.write(options.initialReplay);
    }
    return registered;
  }

  /**
   * Wire a backend into a live session: data/exit fan-out and the immediate
   * knownAgent notification, shared by {@link create} and {@link adoptBackend}.
   * `pty` is set only for PtyBackend sessions (readTitle DI seam).
   */
  private registerSession(
    id: string,
    info: TerminalInfo,
    backend: TerminalBackend,
    knownAgent: 'claude' | 'codex' | null,
    pty?: IPty,
    cols = 80,
    rows = 24,
    scrollback = 5000,
  ): TerminalInfo {
    const tracker = new AgentStateTracker();
    if (knownAgent) tracker.update(knownAgent);
    const session: Session = {
      info,
      backend,
      pty,
      tracker,
      recentData: new TerminalReplayBuffer(),
      screen: newScreen(cols, rows, scrollback),
      knownAgent,
    };
    backend.onData((data, sequence) => this.emitData(id, data, sequence));
    backend.onResync?.((replay, sequence) => {
      const liveSession = this.sessions.get(id);
      if (!liveSession) return;
      liveSession.recentData.replace(replay);
      const replacement = newScreen(
        liveSession.screen.cols,
        liveSession.screen.rows,
        liveSession.screen.options.scrollback ?? scrollback,
      );
      replacement.write(replay);
      liveSession.screen.dispose();
      liveSession.screen = replacement;
      this.onResync?.(id, replay, sequence);
    });
    backend.onExit((exitCode) => {
      const liveSession = this.sessions.get(id);
      this.sessions.delete(id);
      liveSession?.screen.dispose();
      this.fireAgentExitIfActive(id, liveSession);
      this.onExit(id, exitCode);
      for (const listener of this.exitListeners) listener({ id, exitCode });
    });
    this.sessions.set(id, session);
    if (knownAgent) {
      queueMicrotask(() => {
        if (this.sessions.get(id) !== session) return;
        for (const listener of this.agentListeners) {
          listener({ id, agent: knownAgent, cwd: info.cwd });
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
    session.backend.write(data);
  }

  /**
   * Surface display-only synthetic output in a session's stream — a
   * connection-lost notice on an SSH remote session (ADR-0047), for example.
   * Routed through the same data fan-out as real backend output so scrollback
   * and replay stay consistent; it never reaches the backend's write path.
   */
  injectData(id: string, data: string): void {
    if (!this.sessions.has(id)) return;
    this.emitData(id, data);
  }

  /** Retarget an idle persistent PTY without replacing its scrollback/session. */
  changeContext(id: string, context: TerminalContextUpdate): TerminalInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.backend.write(`${terminalCwdCommand(session.info.shell, context.cwd)}\r`);
    Object.assign(session.info, context);
    session.backend.updateMetadata?.(session.info);
    return { ...session.info };
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
    const session = this.sessions.get(id);
    session?.backend.resize(cols, rows);
    session?.screen.resize(cols, rows);
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => ({
      ...s.info,
      pid: s.backend.processId?.() ?? s.info.pid,
    }));
  }

  /** Whether this PTY is owned by a process that outlives Electron Main. */
  persistsAcrossAppRestart(id: string): boolean {
    return this.sessions.get(id)?.backend.persistent === true;
  }

  hasRunningChildren(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    return session.backend.hasChildren();
  }

  /** A killed/exited terminal ends its agent session too (ADR-0017). */
  private fireAgentExitIfActive(id: string, session: Session | undefined): void {
    if (!session || session.tracker.agent === null) return;
    for (const listener of this.agentListeners) {
      listener({ id, agent: null, cwd: session.info.cwd });
    }
  }

  /** Graceful kill; the backend owns any process-tree escalation (CMD-004/TERM-004). */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.fireAgentExitIfActive(id, session);
    this.sessions.delete(id);
    session.screen.dispose();
    session.backend.kill();
  }

  disposeAll(): void {
    for (const [id, session] of [...this.sessions]) {
      if (session.backend.persistent) {
        session.backend.detach?.();
        session.screen.dispose();
        this.sessions.delete(id);
      } else {
        this.kill(id);
      }
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
