import { execFile } from 'node:child_process';
import { promises as fs, realpathSync, type Dirent } from 'node:fs';
import { request } from 'node:http';
import { join, relative, sep } from 'node:path';
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

export interface StaticPreviewSite {
  /** Root-relative HTML entry, always slash-normalized for display. */
  entryPath: string;
  /** Root-relative directory passed to the static server (`.` for the root). */
  directory: string;
}

export interface PreviewLaunch {
  webish: boolean;
  command: string | null;
  kind: 'package' | 'static' | null;
  staticEntry: string | null;
}

interface LsofListener {
  pid: number;
  command: string;
  port: number;
}

/** Bind addresses reachable via http://localhost:<port>. Explicit LAN-only binds are excluded. */
const LOOPBACK_OR_ANY = new Set(['127.0.0.1', 'localhost', '::1', '*', '::', '0.0.0.0']);
const PREVIEW_PROBE_BYTES = 8 * 1024;
const PREVIEW_PROBE_TIMEOUT_MS = 900;
const STATIC_SCAN_MAX_DEPTH = 4;
const STATIC_SCAN_MAX_DIRECTORIES = 600;
const STATIC_SCAN_IGNORED = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  'node_modules',
  'coverage',
]);

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

interface PreviewProbeResponse {
  statusCode: number;
  contentType: string;
  location: string | null;
  bodyPrefix: string;
}

/** Live web is for rendered pages, not arbitrary JSON/control APIs that happen
 * to listen from the project cwd (for example the Claude browser bridge). */
export function isRenderablePreviewResponse(response: PreviewProbeResponse): boolean {
  const mime = response.contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return true;
  if (mime) return false;
  const prefix = response.bodyPrefix
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/.test(prefix);
}

function requestPreview(
  hostname: '127.0.0.1' | '::1',
  port: number,
  path: string,
): Promise<PreviewProbeResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PreviewProbeResponse | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = request(
      {
        hostname,
        port,
        path,
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9',
          Range: `bytes=0-${PREVIEW_PROBE_BYTES - 1}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        const complete = (): void => {
          const contentType = Array.isArray(res.headers['content-type'])
            ? (res.headers['content-type'][0] ?? '')
            : (res.headers['content-type'] ?? '');
          const rawLocation = res.headers.location;
          finish({
            statusCode: res.statusCode ?? 0,
            contentType,
            location: Array.isArray(rawLocation) ? (rawLocation[0] ?? null) : (rawLocation ?? null),
            bodyPrefix: Buffer.concat(chunks, length).toString('utf8'),
          });
        };
        res.on('data', (chunk: Buffer) => {
          if (length >= PREVIEW_PROBE_BYTES) return;
          const remaining = PREVIEW_PROBE_BYTES - length;
          const piece = chunk.subarray(0, remaining);
          chunks.push(piece);
          length += piece.length;
          if (length >= PREVIEW_PROBE_BYTES) {
            complete();
            res.destroy();
          }
        });
        res.on('end', complete);
        res.on('error', () => finish(null));
      },
    );
    req.setTimeout(PREVIEW_PROBE_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => finish(null));
    req.end();
  });
}

async function probePreviewHost(
  hostname: '127.0.0.1' | '::1',
  port: number,
  path = '/',
  redirects = 0,
): Promise<boolean | null> {
  const response = await requestPreview(hostname, port, path);
  if (!response) return null;
  if (
    response.statusCode >= 300 &&
    response.statusCode < 400 &&
    response.location &&
    redirects < 3
  ) {
    try {
      const baseHost = hostname === '::1' ? '[::1]' : hostname;
      const next = new URL(response.location, `http://${baseHost}:${port}/`);
      const nextPort = Number(next.port || 80);
      if (
        next.protocol === 'http:' &&
        (next.hostname === 'localhost' ||
          next.hostname === '127.0.0.1' ||
          next.hostname === '[::1]' ||
          next.hostname === '::1') &&
        nextPort === port
      ) {
        return probePreviewHost(hostname, port, `${next.pathname}${next.search}`, redirects + 1);
      }
    } catch {
      return false;
    }
  }
  return isRenderablePreviewResponse(response);
}

async function isPreviewablePort(port: number): Promise<boolean> {
  const ipv4 = await probePreviewHost('127.0.0.1', port);
  if (ipv4 !== null) return ipv4;
  return (await probePreviewHost('::1', port)) ?? false;
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

function slashPath(path: string): string {
  return path.split(sep).join('/');
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/**
 * Find a small standalone site without traversing dependency/build caches.
 * Root index.html always wins; otherwise the most recently edited candidate
 * is the best signal for the app the current Session just produced.
 */
export async function discoverStaticPreview(root: string): Promise<StaticPreviewSite | null> {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const queue: Array<{ absolute: string; depth: number }> = [{ absolute: realRoot, depth: 0 }];
  const candidates: Array<StaticPreviewSite & { depth: number; modifiedAt: number }> = [];
  let visited = 0;

  while (queue.length > 0 && visited < STATIC_SCAN_MAX_DIRECTORIES) {
    const current = queue.shift()!;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    const index = entries.find(
      (entry) => entry.isFile() && entry.name.toLowerCase() === 'index.html',
    );
    if (index) {
      const absoluteEntry = join(current.absolute, index.name);
      const relativeEntry = slashPath(relative(realRoot, absoluteEntry));
      const relativeDirectory = slashPath(relative(realRoot, current.absolute)) || '.';
      const modifiedAt = await fs
        .stat(absoluteEntry)
        .then((stat) => stat.mtimeMs)
        .catch(() => 0);
      candidates.push({
        entryPath: relativeEntry,
        directory: relativeDirectory,
        depth: current.depth,
        modifiedAt,
      });
    }
    if (current.depth >= STATIC_SCAN_MAX_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (STATIC_SCAN_IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
      queue.push({ absolute: join(current.absolute, entry.name), depth: current.depth + 1 });
    }
  }

  candidates.sort(
    (a, b) =>
      Number(a.directory !== '.') - Number(b.directory !== '.') ||
      b.modifiedAt - a.modifiedAt ||
      a.depth - b.depth ||
      a.entryPath.localeCompare(b.entryPath),
  );
  const selected = candidates[0];
  return selected ? { entryPath: selected.entryPath, directory: selected.directory } : null;
}

export async function previewLaunchForRoot(root: string): Promise<PreviewLaunch> {
  const scripts = await readScripts(root);
  const script = WEB_SCRIPTS.find((name) => typeof scripts[name] === 'string');
  if (script) {
    return {
      webish: true,
      command: `npm run ${script}`,
      kind: 'package',
      staticEntry: null,
    };
  }
  const staticSite = await discoverStaticPreview(root);
  if (!staticSite) return { webish: false, command: null, kind: null, staticEntry: null };
  return {
    webish: true,
    command: `python3 -m http.server 0 --bind 127.0.0.1 --directory ${shellQuote(staticSite.directory)}`,
    kind: 'static',
    staticEntry: staticSite.entryPath,
  };
}

export async function isWebishRoot(root: string): Promise<boolean> {
  return (await previewLaunchForRoot(root)).webish;
}

/** ADR-0022 am.1: the project's own dev command (`npm run dev` …), used by the
 * gate's one-click start — typed into a task terminal, never gate-owned. */
export async function devCommandForRoot(root: string): Promise<string | null> {
  return (await previewLaunchForRoot(root)).command;
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
  private readonly launchCache = new Map<
    string,
    { expiresAt: number; value: Promise<PreviewLaunch> }
  >();

  constructor(private readonly logger: Logger) {}

  /** Coalesce the rail, badge and review-gate probes into one bounded tree scan. */
  launchForRoot(root: string): Promise<PreviewLaunch> {
    const now = Date.now();
    const cached = this.launchCache.get(root);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = previewLaunchForRoot(root).catch((error) => {
      this.logger.warn('preview launch discovery failed', { root, error: errorMessage(error) });
      return {
        webish: false,
        command: null,
        kind: null,
        staticEntry: null,
      } satisfies PreviewLaunch;
    });
    this.launchCache.set(root, { expiresAt: now + 3_000, value });
    return value;
  }

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
      const attributed = attributeListeners(listeners, parseLsofCwds(cwdOut), realRoot);
      const previewable = await Promise.all(
        attributed.map(async (listener) => ({
          listener,
          previewable: await isPreviewablePort(listener.port),
        })),
      );
      return previewable.filter((row) => row.previewable).map((row) => row.listener);
    } catch (e) {
      this.logger.warn('preview port detection failed', {
        error: errorMessage(e),
      });
      return [];
    }
  }
}
