#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Charter's remote change-plane worker. It intentionally uses Node built-ins
 * only so the exact bundled file can be uploaded and integrity-checked without
 * installing npm packages on the server.
 */
const WORKER_VERSION = '1.2.0';
const PROTOCOL_VERSION = 1;
const MAX_FILES = 20_000;
const MAX_BASELINE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const SESSION_RE = /^[a-zA-Z0-9_-]{8,120}$/;
const EXCLUDED_DIRS = new Set(['.git', '.charter', 'node_modules']);
const HOME_EXCLUDED_DIRS = new Set([
  '.cache',
  '.claude',
  '.codex',
  '.config',
  '.local',
  '.npm',
  '.nvm',
  '.ssh',
]);

type ChangeKind = 'created' | 'modified' | 'deleted';

interface FileMeta {
  hash: string;
  size: number;
  mode: number;
}

interface WorkerState {
  protocol: number;
  sessionId: string;
  root: string;
  kind: 'git' | 'files';
  createdAt: string;
  workspaceKind?: 'remote' | 'local';
  baselineTree?: string;
  baseline?: Record<string, FileMeta>;
}

interface ChangeEntry {
  path: string;
  kind: ChangeKind;
  beforeHash: string | null;
  afterHash: string | null;
  beforeBase64: string | null;
  afterBase64: string | null;
  beforeMode: number | null;
  afterMode: number | null;
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reply(payload: Record<string, unknown>): never {
  writeFileSync(1, `${JSON.stringify({ ok: true, ...payload })}\n`);
  process.exit(0);
}

function fail(message: string, details: Record<string, unknown> = {}): never {
  writeFileSync(1, `${JSON.stringify({ ok: false, error: message, ...details })}\n`);
  process.exit(1);
}

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) fail(`Missing --${name}`);
  return value;
}

function sessionId(): string {
  const value = arg('session');
  if (!SESSION_RE.test(value)) fail('Invalid session id');
  return value;
}

function stateRoot(): string {
  const configured = process.env.CHARTER_WORKER_STATE;
  return configured ? resolve(configured) : join(homedir(), '.charter', 'worker', 'state');
}

function sessionDir(id: string): string {
  return join(stateRoot(), id);
}

function stateFile(id: string): string {
  return join(sessionDir(id), 'session.json');
}

function loadState(id: string): WorkerState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(id), 'utf8')) as WorkerState;
    if (parsed.protocol !== PROTOCOL_VERSION || parsed.sessionId !== id) {
      fail('Worker session metadata is incompatible');
    }
    parsed.root = realpathSync(parsed.root);
    return parsed;
  } catch (error) {
    fail(`Worker session was not found: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function saveState(state: WorkerState): void {
  const dir = sessionDir(state.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.session-${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temp, stateFile(state.sessionId));
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: null,
    maxBuffer: MAX_RESPONSE_BYTES + 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim();
    throw new Error(stderr || result.error?.message || `${command} exited ${result.status}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function gitRoot(root: string): string | null {
  try {
    const top = run('git', ['-C', root, 'rev-parse', '--show-toplevel']).toString('utf8').trim();
    return realpathSync(top) === root ? top : null;
  } catch {
    return null;
  }
}

function gitSnapshot(root: string): string {
  const temp = mkdtempSync(join(tmpdir(), 'charter-worker-index-'));
  const index = join(temp, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    run('git', ['-C', root, 'read-tree', '--empty'], { env });
    // Exclude Charter's own state when the selected root is the user's home.
    run('git', ['-C', root, 'add', '-A', '--', '.', ':(exclude).charter/worker/**'], { env });
    return run('git', ['-C', root, 'write-tree'], { env }).toString('utf8').trim();
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function gitBlob(root: string, tree: string, path: string): Buffer | null {
  const result = spawnSync('git', ['-C', root, 'cat-file', 'blob', `${tree}:${path}`], {
    encoding: null,
    maxBuffer: MAX_FILE_BYTES + 1024,
  });
  if (result.status !== 0) return null;
  const bytes = result.stdout ?? Buffer.alloc(0);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`File exceeds 32 MiB: ${path}`);
  return bytes;
}

function gitFileMode(root: string, tree: string, path: string): number | null {
  const output = run('git', ['-C', root, 'ls-tree', '-z', tree, '--', path]).toString('utf8');
  const tab = output.indexOf('\t');
  if (tab < 0) return null;
  const raw = output.slice(0, tab).split(' ', 1)[0];
  if (raw === '100755') return 0o755;
  if (raw?.startsWith('100')) return 0o644;
  // Symlinks and gitlinks are reviewable as bytes, but the protected write
  // path deliberately refuses to follow or manufacture them.
  return null;
}

function gitChanges(state: WorkerState): ChangeEntry[] {
  const baselineTree = state.baselineTree;
  if (!baselineTree) throw new Error('Git baseline is missing');
  const currentTree = gitSnapshot(state.root);
  const raw = run('git', [
    '-C',
    state.root,
    'diff-tree',
    '-r',
    '--no-commit-id',
    '--name-status',
    '-z',
    '--no-renames',
    baselineTree,
    currentTree,
  ]);
  const parts = raw.toString('utf8').split('\0');
  const entries: ChangeEntry[] = [];
  let responseBytes = 0;
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index] ?? '';
    const path = parts[index + 1] ?? '';
    if (!path) continue;
    const kind: ChangeKind = status.startsWith('A')
      ? 'created'
      : status.startsWith('D')
        ? 'deleted'
        : 'modified';
    const before = kind === 'created' ? null : gitBlob(state.root, baselineTree, path);
    const after = kind === 'deleted' ? null : gitBlob(state.root, currentTree, path);
    responseBytes += (before?.length ?? 0) + (after?.length ?? 0);
    if (responseBytes > MAX_RESPONSE_BYTES) {
      throw new Error('Changed file payload exceeds the 128 MiB session limit');
    }
    entries.push({
      path,
      kind,
      beforeHash: before ? sha(before) : null,
      afterHash: after ? sha(after) : null,
      beforeBase64: before?.toString('base64') ?? null,
      afterBase64: after?.toString('base64') ?? null,
      beforeMode: kind === 'created' ? null : gitFileMode(state.root, baselineTree, path),
      afterMode: kind === 'deleted' ? null : gitFileMode(state.root, currentTree, path),
    });
  }
  return entries;
}

function isRootHome(root: string): boolean {
  try {
    return realpathSync(homedir()) === root;
  } catch {
    return false;
  }
}

function scanFiles(root: string): Record<string, FileMeta> {
  const output: Record<string, FileMeta> = {};
  const homeRoot = isRootHome(root);
  let count = 0;
  let bytes = 0;
  const walk = (absolute: string, prefix: string): void => {
    const entries = readdirSync(absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        (EXCLUDED_DIRS.has(entry.name) || (homeRoot && HOME_EXCLUDED_DIRS.has(entry.name)))
      ) {
        continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        walk(child, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(child);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File exceeds 32 MiB: ${rel}`);
      count += 1;
      bytes += stat.size;
      if (count > MAX_FILES) throw new Error(`Project exceeds ${MAX_FILES} files`);
      if (bytes > MAX_BASELINE_BYTES) throw new Error('Project baseline exceeds 256 MiB');
      const content = readFileSync(child);
      output[rel] = { hash: sha(content), size: content.length, mode: stat.mode & 0o777 };
    }
  };
  walk(root, '');
  return output;
}

function baselineBlobPath(id: string, hash: string): string {
  return join(sessionDir(id), 'blobs', hash);
}

function readBaselineBlob(id: string, path: string, meta: FileMeta): Buffer {
  const bytes = readFileSync(baselineBlobPath(id, meta.hash));
  if (sha(bytes) !== meta.hash) throw new Error(`Entry baseline integrity failed: ${path}`);
  return bytes;
}

function captureFileBaseline(root: string, id: string, manifest: Record<string, FileMeta>): void {
  const blobDir = join(sessionDir(id), 'blobs');
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  for (const [path, meta] of Object.entries(manifest)) {
    const destination = baselineBlobPath(id, meta.hash);
    try {
      lstatSync(destination);
      continue;
    } catch {
      // first file with this content owns the blob
    }
    const content = readFileSync(join(root, ...path.split('/')));
    if (sha(content) !== meta.hash) {
      throw new Error(`File changed while the entry baseline was captured: ${path}`);
    }
    writeFileSync(destination, content, { mode: 0o600 });
  }
}

function fileChanges(state: WorkerState): ChangeEntry[] {
  const baseline = state.baseline ?? {};
  const current = scanFiles(state.root);
  const paths = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const entries: ChangeEntry[] = [];
  let responseBytes = 0;
  for (const path of paths) {
    const beforeMeta = baseline[path];
    const afterMeta = current[path];
    if (beforeMeta?.hash === afterMeta?.hash) continue;
    const kind: ChangeKind = !beforeMeta ? 'created' : !afterMeta ? 'deleted' : 'modified';
    const before = beforeMeta ? readBaselineBlob(state.sessionId, path, beforeMeta) : null;
    const after = afterMeta ? readFileSync(join(state.root, ...path.split('/'))) : null;
    if (after && sha(after) !== afterMeta!.hash) {
      throw new Error(`File changed while remote changes were inspected: ${path}`);
    }
    responseBytes += (before?.length ?? 0) + (after?.length ?? 0);
    if (responseBytes > MAX_RESPONSE_BYTES) {
      throw new Error('Changed file payload exceeds the 128 MiB session limit');
    }
    entries.push({
      path,
      kind,
      beforeHash: beforeMeta?.hash ?? null,
      afterHash: afterMeta?.hash ?? null,
      beforeBase64: before?.toString('base64') ?? null,
      afterBase64: after?.toString('base64') ?? null,
      beforeMode: beforeMeta?.mode ?? null,
      afterMode: afterMeta?.mode ?? null,
    });
  }
  return entries;
}

function validateRelativePath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0')) {
    throw new Error('Invalid relative path');
  }
  if (isAbsolute(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  return path;
}

function safeAbsolute(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split('/'));
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!target.startsWith(rootPrefix))
    throw new Error(`Path escapes the working folder: ${relativePath}`);
  let cursor = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]!);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlink paths are not writable: ${relativePath}`);
      if (index < parts.length - 1 && !stat.isDirectory()) {
        throw new Error(`Parent is not a directory: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function currentHash(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const bytes = readFileSync(path);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`File exceeds 32 MiB: ${path}`);
    return sha(bytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function readStdin(): string {
  const chunks: Buffer[] = [];
  let total = 0;
  const input = readFileSync(0);
  total += input.length;
  chunks.push(input);
  if (total > MAX_RESPONSE_BYTES) throw new Error('Apply payload exceeds 128 MiB');
  return Buffer.concat(chunks).toString('utf8');
}

function applyChanges(state: WorkerState): {
  applied: Array<{ path: string; hash: string | null }>;
} {
  const payload = JSON.parse(readStdin()) as {
    entries?: Array<{
      path?: unknown;
      expectedHash?: unknown;
      dataBase64?: unknown;
      mode?: unknown;
    }>;
  };
  if (!Array.isArray(payload.entries) || payload.entries.length > MAX_FILES) {
    throw new Error('Apply entries are missing or exceed the file limit');
  }
  const prepared = payload.entries.map((entry) => {
    const path = validateRelativePath(entry.path);
    const expectedHash = entry.expectedHash;
    if (
      expectedHash !== null &&
      (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash))
    ) {
      throw new Error(`Invalid expected hash: ${path}`);
    }
    const data =
      entry.dataBase64 === null
        ? null
        : typeof entry.dataBase64 === 'string'
          ? Buffer.from(entry.dataBase64, 'base64')
          : (() => {
              throw new Error(`Invalid file payload: ${path}`);
            })();
    if (data && data.length > MAX_FILE_BYTES) throw new Error(`File exceeds 32 MiB: ${path}`);
    const mode = typeof entry.mode === 'number' ? entry.mode & 0o777 : 0o644;
    const absolute = safeAbsolute(state.root, path);
    return { path, absolute, expectedHash, data, mode };
  });
  const conflicts = prepared.flatMap((entry) => {
    const actualHash = currentHash(entry.absolute);
    return actualHash === entry.expectedHash
      ? []
      : [{ path: entry.path, expectedHash: entry.expectedHash, actualHash }];
  });
  if (conflicts.length > 0) {
    fail(
      'Remote files changed after the last sync. Refresh Diff before applying review decisions.',
      {
        conflicts,
      },
    );
  }
  const applied: Array<{ path: string; hash: string | null }> = [];
  for (const entry of prepared) {
    if (entry.data === null) {
      try {
        unlinkSync(entry.absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      applied.push({ path: entry.path, hash: null });
      continue;
    }
    mkdirSync(dirname(entry.absolute), { recursive: true, mode: 0o755 });
    // Re-check after creating missing parents so a raced symlink is rejected.
    safeAbsolute(state.root, entry.path);
    const temp = join(
      dirname(entry.absolute),
      `.${basename(entry.absolute)}.charter-${process.pid}.tmp`,
    );
    try {
      writeFileSync(temp, entry.data, { mode: entry.mode });
      renameSync(temp, entry.absolute);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Preserve the original protected-write failure.
      }
      throw error;
    }
    applied.push({ path: entry.path, hash: sha(entry.data) });
  }
  return { applied };
}

/** Return both baseline and current bytes for durable paths even when their
 * net diff is now empty. This is what lets a restarted desktop remove stale
 * mirror entries after a remote file was restored to the entry baseline. */
function inspectPaths(state: WorkerState): ChangeEntry[] {
  const payload = JSON.parse(readStdin()) as { paths?: unknown };
  if (!Array.isArray(payload.paths) || payload.paths.length > MAX_FILES) {
    throw new Error('Inspect paths are missing or exceed the file limit');
  }
  const paths = [...new Set(payload.paths.map(validateRelativePath))].sort();
  const currentTree = state.kind === 'git' ? gitSnapshot(state.root) : null;
  let responseBytes = 0;
  return paths.map((path) => {
    let before: Buffer | null;
    let after: Buffer | null;
    let beforeMode: number | null = null;
    let afterMode: number | null = null;
    if (state.kind === 'git') {
      before = gitBlob(state.root, state.baselineTree!, path);
      after = gitBlob(state.root, currentTree!, path);
      beforeMode = before === null ? null : gitFileMode(state.root, state.baselineTree!, path);
      afterMode = after === null ? null : gitFileMode(state.root, currentTree!, path);
    } else {
      const beforeMeta = state.baseline?.[path];
      before = beforeMeta ? readBaselineBlob(state.sessionId, path, beforeMeta) : null;
      beforeMode = beforeMeta?.mode ?? null;
      const absolute = safeAbsolute(state.root, path);
      try {
        const info = lstatSync(absolute);
        if (!info.isFile() || info.isSymbolicLink()) after = null;
        else {
          if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds 32 MiB: ${path}`);
          after = readFileSync(absolute);
          afterMode = info.mode & 0o777;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        after = null;
      }
    }
    responseBytes += (before?.length ?? 0) + (after?.length ?? 0);
    if (responseBytes > MAX_RESPONSE_BYTES) {
      throw new Error('Inspected file payload exceeds the 128 MiB session limit');
    }
    return {
      path,
      kind: before === null ? 'created' : after === null ? 'deleted' : 'modified',
      beforeHash: before === null ? null : sha(before),
      afterHash: after === null ? null : sha(after),
      beforeBase64: before?.toString('base64') ?? null,
      afterBase64: after?.toString('base64') ?? null,
      beforeMode,
      afterMode,
    };
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIMI_SESSION_RE = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const SESSION_START_SLACK_MS = 60_000;
const SESSION_END_SLACK_MS = 120_000;

function boundedRead(path: string, maxBytes: number, tail = false): string {
  const info = statSync(path);
  const length = Math.min(info.size, maxBytes);
  if (length <= 0) return '';
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.allocUnsafe(length);
    const count = readSync(fd, bytes, 0, length, tail ? Math.max(0, info.size - length) : 0);
    let text = bytes.subarray(0, count).toString('utf8');
    if (tail && info.size > length) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    return text;
  } finally {
    closeSync(fd);
  }
}

function inSessionWindow(timeMs: number, state: WorkerState, endedAtMs: number): boolean {
  const startedAtMs = Date.parse(state.createdAt);
  return (
    Number.isFinite(startedAtMs) &&
    Number.isFinite(timeMs) &&
    timeMs >= startedAtMs - SESSION_START_SLACK_MS &&
    timeMs <= endedAtMs + SESSION_END_SLACK_MS
  );
}

function discoverClaudeSession(state: WorkerState, endedAtMs: number): string | null {
  const dir = join(homedir(), '.claude', 'projects', state.root.replace(/[^a-zA-Z0-9]/g, '-'));
  let best: { id: string; mtimeMs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!UUID_RE.test(id)) continue;
    const mtimeMs = statSync(join(dir, name)).mtimeMs;
    if (!inSessionWindow(mtimeMs, state, endedAtMs)) continue;
    if (!best || mtimeMs > best.mtimeMs) best = { id, mtimeMs };
  }
  return best?.id ?? null;
}

function sessionDayKeys(startedAtMs: number, endedAtMs: number): string[] {
  const day = 24 * 60 * 60 * 1000;
  const keys: string[] = [];
  for (let time = startedAtMs - day; time <= endedAtMs + day && keys.length < 16; time += day) {
    const date = new Date(time);
    const key = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function discoverCodexSession(state: WorkerState, endedAtMs: number): string | null {
  const startedAtMs = Date.parse(state.createdAt);
  const candidates: Array<{ id: string; distance: number; mtimeMs: number }> = [];
  for (const key of sessionDayKeys(startedAtMs, endedAtMs)) {
    const dir = join(homedir(), '.codex', 'sessions', key);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = CODEX_ROLLOUT_RE.exec(name);
      if (!match?.[1]) continue;
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (!inSessionWindow(info.mtimeMs, state, endedAtMs)) continue;
        const firstLine = boundedRead(path, 256 * 1024).split('\n', 1)[0] ?? '';
        const entry = JSON.parse(firstLine) as {
          type?: unknown;
          timestamp?: unknown;
          payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
        };
        const id = typeof entry.payload?.id === 'string' ? entry.payload.id.toLowerCase() : '';
        const cwd = typeof entry.payload?.cwd === 'string' ? resolve(entry.payload.cwd) : '';
        const timestamp = entry.payload?.timestamp ?? entry.timestamp;
        const createdAtMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
        if (
          entry.type !== 'session_meta' ||
          !UUID_RE.test(id) ||
          id !== match[1].toLowerCase() ||
          cwd !== state.root ||
          !inSessionWindow(createdAtMs, state, endedAtMs)
        ) {
          continue;
        }
        candidates.push({
          id,
          distance: Math.abs(createdAtMs - startedAtMs),
          mtimeMs: info.mtimeMs,
        });
      } catch {
        // Malformed or raced transcript — skip.
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
}

function discoverKimiSession(state: WorkerState, endedAtMs: number): string | null {
  const dataHome = process.env.KIMI_CODE_HOME
    ? resolve(process.env.KIMI_CODE_HOME)
    : join(homedir(), '.kimi-code');
  const sessionsRoot = resolve(dataHome, 'sessions');
  const candidates: Array<{ id: string; mtimeMs: number }> = [];
  const index = boundedRead(join(dataHome, 'session_index.jsonl'), 4 * 1024 * 1024, true);
  for (const line of index.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        sessionId?: unknown;
        sessionDir?: unknown;
        workDir?: unknown;
      };
      if (
        typeof entry.sessionId !== 'string' ||
        !KIMI_SESSION_RE.test(entry.sessionId) ||
        typeof entry.sessionDir !== 'string' ||
        typeof entry.workDir !== 'string' ||
        resolve(entry.workDir) !== state.root
      ) {
        continue;
      }
      const dir = resolve(entry.sessionDir);
      const rel = relative(sessionsRoot, dir);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || basename(dir) !== entry.sessionId) {
        continue;
      }
      const mtimeMs = statSync(join(dir, 'state.json')).mtimeMs;
      if (inSessionWindow(mtimeMs, state, endedAtMs)) {
        candidates.push({ id: entry.sessionId, mtimeMs });
      }
    } catch {
      // Malformed or raced session entry — skip.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.id ?? null;
}

function discoverSession(state: WorkerState, cli: string): string | null {
  const endedAtMs = Date.now();
  try {
    if (cli === 'claude') return discoverClaudeSession(state, endedAtMs);
    if (cli === 'codex') return discoverCodexSession(state, endedAtMs);
    if (cli === 'kimi') return discoverKimiSession(state, endedAtMs);
  } catch {
    // Transcript discovery is best effort; no id is safer than guessing.
  }
  return null;
}

function main(): void {
  const command = process.argv[2] ?? '';
  if (command === 'hello') {
    const bytes = readFileSync(process.argv[1]!);
    reply({
      protocol: PROTOCOL_VERSION,
      version: WORKER_VERSION,
      sha256: sha(bytes),
      capabilities: [
        'baseline',
        'changes',
        'inspect',
        'apply',
        'conflict-check',
        'session-discovery',
        'local-workspace-bridge',
      ],
    });
  }
  if (command === 'start') {
    const id = sessionId();
    const requestedRoot = arg('root');
    const root = realpathSync(resolve(requestedRoot));
    const workspaceKind = arg('workspace');
    if (workspaceKind !== 'remote' && workspaceKind !== 'local') {
      fail('Invalid workspace kind');
    }
    if (workspaceKind === 'local') {
      const expectedRoot = realpathSync(join(homedir(), '.charter', 'workspaces', id));
      if (root !== expectedRoot) fail('Isolated local-workspace root does not match the session');
    }
    if (!statSync(root).isDirectory()) fail('Remote working folder is not a directory');
    rmSync(sessionDir(id), { recursive: true, force: true });
    mkdirSync(sessionDir(id), { recursive: true, mode: 0o700 });
    const git = gitRoot(root);
    const state: WorkerState = {
      protocol: PROTOCOL_VERSION,
      sessionId: id,
      root,
      kind: git ? 'git' : 'files',
      createdAt: new Date().toISOString(),
      workspaceKind,
    };
    let gitRefCreated = false;
    try {
      if (git) {
        state.baselineTree = gitSnapshot(root);
        // Keep the otherwise-unreachable tree alive across git gc while Review is open.
        run('git', ['-C', root, 'update-ref', `refs/charter/worker/${id}`, state.baselineTree]);
        gitRefCreated = true;
      } else {
        state.baseline = scanFiles(root);
        captureFileBaseline(root, id, state.baseline);
      }
      saveState(state);
    } catch (error) {
      if (gitRefCreated) {
        try {
          run('git', ['-C', root, 'update-ref', '-d', `refs/charter/worker/${id}`]);
        } catch {
          // Preserve the original baseline error.
        }
      }
      rmSync(sessionDir(id), { recursive: true, force: true });
      throw error;
    }
    reply({
      sessionId: id,
      root,
      baselineKind: state.kind,
      baselineRef: state.baselineTree ?? null,
      fileCount: state.baseline ? Object.keys(state.baseline).length : null,
    });
  }
  if (command === 'changes') {
    const state = loadState(sessionId());
    const entries = state.kind === 'git' ? gitChanges(state) : fileChanges(state);
    reply({ sessionId: state.sessionId, root: state.root, entries });
  }
  if (command === 'inspect') {
    const state = loadState(sessionId());
    reply({ sessionId: state.sessionId, root: state.root, entries: inspectPaths(state) });
  }
  if (command === 'apply') {
    const state = loadState(sessionId());
    reply({ sessionId: state.sessionId, ...applyChanges(state) });
  }
  if (command === 'stop') {
    const state = loadState(sessionId());
    reply({ sessionId: state.sessionId, retainedForReview: true });
  }
  if (command === 'discover') {
    const state = loadState(sessionId());
    const cli = arg('cli');
    if (!['claude', 'codex', 'kimi'].includes(cli)) fail('Unsupported Agent CLI');
    reply({ sessionId: state.sessionId, cli, cliSessionId: discoverSession(state, cli) });
  }
  if (command === 'destroy') {
    const id = sessionId();
    const state = loadState(id);
    if (state.kind === 'git') {
      try {
        run('git', ['-C', state.root, 'update-ref', '-d', `refs/charter/worker/${id}`]);
      } catch {
        // The project may have been removed; local Worker state is still safe to delete.
      }
    }
    if (state.workspaceKind === 'local') {
      const expectedRoot = realpathSync(join(homedir(), '.charter', 'workspaces', id));
      if (state.root !== expectedRoot) {
        fail('Refusing to remove a non-session workspace root');
      }
      rmSync(state.root, { recursive: true, force: true });
    }
    rmSync(sessionDir(id), { recursive: true, force: true });
    reply({ sessionId: id, destroyed: true });
  }
  fail('Unknown worker command');
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
