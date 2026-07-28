import { spawn } from 'node:child_process';
import { productError, ProductFailure } from '@pi-ide/foundation';

export interface CommandRunInput {
  executable: string;
  args: string[];
  /** Absolute working directory — the caller must have validated it against the workspace root. */
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  requiresShell?: boolean;
  maxOutputBytes?: number;
  /** SIGTERM → SIGKILL grace period (CMD-004). */
  graceMs?: number;
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}

export interface CommandRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const DEFAULT_MAX_OUTPUT = 512 * 1024;
const DEFAULT_GRACE_MS = 3_000;
const PARENT_WATCH_INTERVAL_SECONDS = 0.2;
/** CMD-005: children start from a curated environment, not the full parent env. */
const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
];

function minimalEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...(extra ?? {}) };
}

/** SIGKILL bypasses every main-process cleanup hook. On Unix, keep a tiny
 * detached watchdog beside each command group so parent death still tears the
 * command tree down. The fixed script receives only numeric PIDs. */
function watchParentDeath(commandPid: number): () => void {
  if (process.platform === 'win32') return () => {};
  const script = `
parent_pid="$1"
group_pid="$2"
while kill -0 "$parent_pid" 2>/dev/null && kill -0 -- "-$group_pid" 2>/dev/null; do
  sleep ${PARENT_WATCH_INTERVAL_SECONDS}
done
if ! kill -0 "$parent_pid" 2>/dev/null; then
  kill -TERM -- "-$group_pid" 2>/dev/null || true
  sleep 0.5
  kill -KILL -- "-$group_pid" 2>/dev/null || true
fi
`;
  const watchdog = spawn(
    '/bin/sh',
    ['-c', script, 'charter-command-watchdog', String(process.pid), String(commandPid)],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
  watchdog.on('error', () => {});
  watchdog.unref();
  return () => {
    if (!watchdog.pid) return;
    try {
      process.kill(-watchdog.pid, 'SIGTERM');
    } catch {
      // It normally exits on its own as soon as the command group disappears.
    }
  };
}

/**
 * Structured command execution (CMD-001): spawn(executable, args) with no shell
 * unless explicitly requested, own process group, curated env, honest timeout
 * and cancellation semantics, and capped output.
 */
export function runCommand(input: CommandRunInput, signal: AbortSignal): Promise<CommandRunResult> {
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  const startedAt = Date.now();

  const spawnArgs: { command: string; args: string[] } = input.requiresShell
    ? {
        command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        args:
          process.platform === 'win32'
            ? ['/d', '/s', '/c', [input.executable, ...input.args].join(' ')]
            : ['-c', [input.executable, ...input.args].join(' ')],
      }
    : { command: input.executable, args: input.args };

  return new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(spawnArgs.command, spawnArgs.args, {
      cwd: input.cwd,
      env: minimalEnv(input.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Own process group so the entire tree can be terminated (CMD-004).
      detached: process.platform !== 'win32',
      shell: false,
    });
    const stopParentWatchdog = child.pid ? watchParentDeath(child.pid) : () => {};

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let termTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const killTree = (sig: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') {
          if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        } else if (child.pid) {
          process.kill(-child.pid, sig);
        }
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const stopGently = (reason: 'timeout' | 'cancel') => {
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), graceMs);
    };

    const onAbort = () => stopGently('cancel');
    if (signal.aborted) queueMicrotask(onAbort);
    else signal.addEventListener('abort', onAbort, { once: true });

    termTimer = setTimeout(() => stopGently('timeout'), input.timeoutMs);

    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      input.onOutput?.(stream, text);
      const current = stream === 'stdout' ? stdout : stderr;
      const room = maxBytes - (stdout.length + stderr.length);
      if (room <= 0) {
        truncated = true;
        return;
      }
      const kept = text.length > room ? text.slice(0, room) : text;
      if (kept.length < text.length) truncated = true;
      if (stream === 'stdout') stdout = current + kept;
      else stderr = current + kept;
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const finish = (exitCode: number | null, sig: string | null) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      stopParentWatchdog();
      resolve({
        exitCode,
        signal: sig,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        truncated,
      });
    };

    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', onAbort);
      stopParentWatchdog();
      reject(
        new ProductFailure(
          productError('CMD_SPAWN_FAILED', {
            userMessage: `The command "${input.executable}" could not be started (${error.code ?? error.message}).`,
            technicalMessage: error.message,
            retryable: false,
          }),
        ),
      );
    });

    child.once('exit', (code, sig) => {
      // Give the pipes a tick to flush remaining output before resolving.
      setImmediate(() => finish(code, sig));
    });
  });
}
