import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { errorMessage, type Logger } from '@pi-ide/foundation';

/**
 * Preview-gate port detection (ADR-0022). Read-only: enumerate loopback TCP
 * listeners and keep only processes whose cwd lives inside the task's own tree
 * (worktree or project root). The gate never starts a server, and a dev server
 * in the main tree can never appear inside a worktree task's gate.
 */

export interface DetectedPort {
  port: number;
  pid: number;
  command: string;
}

interface LsofListener {
  pid: number;
  command: string;
  port: number;
}

/** Bind addresses reachable via http://localhost:<port>. Explicit LAN-only binds are excluded. */
const LOOPBACK_OR_ANY = new Set(['127.0.0.1', 'localhost', '::1', '*', '::', '0.0.0.0']);

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` machine output. */
export function parseLsofListeners(stdout: string): LsofListener[] {
  const out: LsofListener[] = [];
  let pid = 0;
  let command = '';
  for (const raw of stdout.split('\n')) {
    if (raw.length < 2) continue;
    const tag = raw[0];
    const value = raw.slice(1);
    if (tag === 'p') {
      pid = Number.parseInt(value, 10) || 0;
      command = '';
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n' && pid > 0) {
      // Forms: 127.0.0.1:5173  *:5173  [::1]:5173  192.168.1.5:8080
      const idx = value.lastIndexOf(':');
      if (idx <= 0) continue;
      const host = value.slice(0, idx).replace(/^\[|\]$/g, '');
      const port = Number.parseInt(value.slice(idx + 1), 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (!LOOPBACK_OR_ANY.has(host)) continue;
      out.push({ pid, command, port });
    }
  }
  return out;
}

/** Parse `lsof -a -p <pids> -d cwd -Fpn` into pid → cwd. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid = 0;
  for (const raw of stdout.split('\n')) {
    if (raw.length < 2) continue;
    const tag = raw[0];
    const value = raw.slice(1);
    if (tag === 'p') pid = Number.parseInt(value, 10) || 0;
    else if (tag === 'n' && pid > 0) map.set(pid, value);
  }
  return map;
}

/** cwd is the root itself or anything below it (both sides realpath-normalized). */
export function cwdInsideRoot(cwd: string, realRoot: string): boolean {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // Process may have exited between the two lsof calls; compare as reported.
  }
  return real === realRoot || real.startsWith(realRoot + sep);
}

/** Attribute listeners to a root via per-pid cwd; dedupe (pid, port); sort by port. */
export function attributeListeners(
  listeners: LsofListener[],
  cwds: Map<number, string>,
  realRoot: string,
): DetectedPort[] {
  const seen = new Set<string>();
  const out: DetectedPort[] = [];
  for (const l of listeners) {
    const cwd = cwds.get(l.pid);
    if (!cwd || !cwdInsideRoot(cwd, realRoot)) continue;
    const key = `${l.pid}:${l.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port: l.port, pid: l.pid, command: l.command.slice(0, 60) });
  }
  return out.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** Scripts that mark a project as "web-ish" — the Preview tab shows an empty
 * state instead of hiding when one exists (ADR-0022 tab-visibility rule).
 * Order matters: the first present script becomes the one-click dev command. */
const WEB_SCRIPTS = ['dev', 'serve', 'preview', 'start'];

async function readScripts(root: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

export async function isWebishRoot(root: string): Promise<boolean> {
  const scripts = await readScripts(root);
  return WEB_SCRIPTS.some((s) => typeof scripts[s] === 'string');
}

/** ADR-0022 am.1: the project's own dev command (`npm run dev` …), used by the
 * gate's one-click start — typed into a task terminal, never gate-owned. */
export async function devCommandForRoot(root: string): Promise<string | null> {
  const scripts = await readScripts(root);
  const name = WEB_SCRIPTS.find((s) => typeof scripts[s] === 'string');
  return name ? `npm run ${name}` : null;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits non-zero when a filter matches nothing — empty is a result.
      resolve(typeof stdout === 'string' ? stdout : '');
    });
  });
}

export class PreviewService {
  constructor(private readonly logger: Logger) {}

  /** All loopback listeners whose process cwd is inside `root`. Failures are
   * an empty list (the UI shows the honest empty state), never a throw. */
  async detectPorts(root: string): Promise<DetectedPort[]> {
    let realRoot = root;
    try {
      realRoot = realpathSync(root);
    } catch {
      return [];
    }
    try {
      const listenOut = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
      const listeners = parseLsofListeners(listenOut);
      if (listeners.length === 0) return [];
      const pids = [...new Set(listeners.map((l) => l.pid))].join(',');
      const cwdOut = await run('lsof', ['-a', '-p', pids, '-d', 'cwd', '-Fpn']);
      return attributeListeners(listeners, parseLsofCwds(cwdOut), realRoot);
    } catch (e) {
      this.logger.warn('preview port detection failed', {
        error: errorMessage(e),
      });
      return [];
    }
  }
}
