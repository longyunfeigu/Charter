import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { GitService } from '@pi-ide/git-service';
import type { SshWorkerStatus, TaskDto } from '@pi-ide/ipc-contracts';
import type { ExecResult, SftpSession } from '@pi-ide/ssh-service';
import type { AppPaths } from '../app-paths.js';
import { shellSingleQuote } from './ssh-terminal-bridge.js';
import type { ExternalSessionService, RemoteExternalChange } from './external-session-service.js';

const WORKER_PROTOCOL = 1;
const WORKER_VERSION = '1.2.0';
const POLL_INTERVAL_MS = 1_000;
const MAX_REMOTE_ENTRIES = 20_000;
const MAX_LOCAL_SEED_BYTES = 256 * 1024 * 1024;
const MAX_LOCAL_SEED_FILE_BYTES = 32 * 1024 * 1024;
const LOCAL_SEED_EXCLUDED_DIRS = new Set(['.git', '.charter', 'node_modules']);
const LOCAL_SEED_UPLOAD_CONCURRENCY = 4;
const HASH_RE = /^[a-f0-9]{64}$/;

interface WorkerHello {
  ok: true;
  protocol: number;
  version: string;
  sha256: string;
  capabilities: string[];
}

interface WorkerStart {
  ok: true;
  sessionId: string;
  root: string;
  baselineKind: 'git' | 'files';
  baselineRef: string | null;
}

type WorkerChange = RemoteExternalChange;

interface WorkerChanges {
  ok: true;
  sessionId: string;
  root: string;
  entries: WorkerChange[];
}

interface WorkerApply {
  ok: true;
  sessionId: string;
  applied: Array<{ path: string; hash: string | null }>;
}

interface WorkerDiscovery {
  ok: true;
  sessionId: string;
  cli: string;
  cliSessionId: string | null;
}

interface ManagedRemoteSession {
  terminalId: string | null;
  taskId: string | null;
  hostId: string;
  hostLabel: string;
  root: string;
  mirrorRoot: string;
  workspaceKind: 'remote' | 'local';
  /** Only sparse mirrors under AppPaths.remoteMirrorsDir are product-owned. */
  ownsMirrorRoot: boolean;
  workerSessionId: string;
  workerVersion: string;
  nodePath: string;
  workerPath: string;
  baselineKind: 'git' | 'files' | null;
  baselineRef: string | null;
  lastNet: Map<string, WorkerChange>;
  expectedHashes: Map<string, string | null>;
  /** Last version Charter wrote into a canonical local workspace. Used to
   * reject concurrent local edits instead of silently overwriting them. */
  mirrorExpectedHashes: Map<string, string | null>;
  modes: Map<string, number | null>;
  /** Durable ledger paths that must be inspected once after main-process recovery. */
  recoverPaths: string[];
  timer: ReturnType<typeof setInterval> | null;
  /** All Worker change/apply calls share one queue so polling cannot race a
   * protected local-to-remote write. */
  sync: Promise<number>;
  disposed: boolean;
}

export interface BeginRemoteWorkerSession {
  terminalId: string;
  hostId: string;
  hostLabel: string;
  /** Existing server-side workspace (remote mode). */
  root?: string;
  /** Canonical local workspace bridged into an isolated remote copy. */
  localProjectPath?: string;
}

interface RemoteWorkerDeps {
  exec(hostId: string, command: string, input?: string): Promise<ExecResult>;
  probeNode(hostId: string): Promise<{ found: boolean; path: string | null }>;
  openSftp(hostId: string): Promise<SftpSession>;
  bundlePath: string;
  paths: AppPaths;
  logger: Logger;
  isConnected?(hostId: string): boolean;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

interface LocalSeedFile {
  path: string;
  stagedPath: string;
  hash: string;
  mode: number;
  size: number;
}

interface LocalSeed {
  canonicalRoot: string;
  stagingRoot: string;
  directories: string[];
  files: LocalSeedFile[];
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await fn(values[index]!);
    }
  });
  await Promise.all(workers);
}

/** Freeze one bounded, symlink-free local snapshot before upload. Git projects
 * send tracked + non-ignored untracked files; ignored secrets and dependency
 * trees do not leave the Mac implicitly. Non-Git folders use the Worker's
 * documented common-directory exclusions. */
async function stageLocalWorkspace(projectPath: string): Promise<LocalSeed> {
  const canonicalRoot = await realpath(projectPath);
  const rootStat = await stat(canonicalRoot);
  if (!rootStat.isDirectory()) throw new Error('The selected local workspace is not a directory');
  const stagingRoot = await mkdtemp(join(tmpdir(), 'charter-remote-seed-'));
  const directories = new Set<string>();
  const sourcePaths: string[] = [];
  try {
    const git = new GitService(canonicalRoot);
    const detected = await git.detect();
    if (detected.isRepo && detected.root === canonicalRoot) {
      sourcePaths.push(...(await git.listWorktreeFiles()));
    } else {
      const walk = async (absolute: string, prefix: string): Promise<void> => {
        const entries = await readdir(absolute, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (!safeRelativePath(relativePath)) {
            throw new Error(`The local workspace contains an unsupported path: ${relativePath}`);
          }
          const child = join(absolute, entry.name);
          if (entry.isDirectory()) {
            if (LOCAL_SEED_EXCLUDED_DIRS.has(entry.name)) continue;
            directories.add(relativePath);
            await walk(child, relativePath);
          } else if (entry.isFile()) {
            sourcePaths.push(relativePath);
          }
        }
      };
      await walk(canonicalRoot, '');
    }

    const uniquePaths = [...new Set(sourcePaths)].sort();
    if (uniquePaths.length > MAX_REMOTE_ENTRIES) {
      throw new Error(`The local workspace exceeds ${MAX_REMOTE_ENTRIES} synchronized files`);
    }
    const files: LocalSeedFile[] = [];
    let totalBytes = 0;
    for (const path of uniquePaths) {
      if (!safeRelativePath(path)) throw new Error(`Unsafe local workspace path: ${path}`);
      const source = resolve(canonicalRoot, ...path.split('/'));
      const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
      if (!source.startsWith(rootPrefix)) throw new Error(`Local workspace path escaped: ${path}`);
      let sourceStat;
      try {
        sourceStat = await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      // Git can list symlinks and submodules. The remote protected-write
      // contract deliberately does not manufacture or follow either.
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) continue;
      if (sourceStat.size > MAX_LOCAL_SEED_FILE_BYTES) {
        throw new Error(`Local file exceeds 32 MiB: ${path}`);
      }
      totalBytes += sourceStat.size;
      if (totalBytes > MAX_LOCAL_SEED_BYTES) {
        throw new Error('The synchronized local workspace exceeds 256 MiB');
      }
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) {
        let current = '';
        for (const part of parent.split('/')) {
          current = current ? `${current}/${part}` : part;
          directories.add(current);
        }
      }
      const stagedPath = resolve(stagingRoot, ...path.split('/'));
      await mkdir(dirname(stagedPath), { recursive: true });
      await copyFile(source, stagedPath);
      const mode = sourceStat.mode & 0o777;
      await chmod(stagedPath, mode);
      const bytes = await readFile(stagedPath);
      files.push({ path, stagedPath, hash: sha256(bytes), mode, size: bytes.length });
    }
    return {
      canonicalRoot,
      stagingRoot,
      directories: [...directories].sort(
        (left, right) =>
          left.split('/').length - right.split('/').length || left.localeCompare(right),
      ),
      files,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parseWorkerJson<T extends { ok: true }>(result: ExecResult, operation: string): T {
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let parsed: unknown = null;
  for (const line of lines.reverse()) {
    try {
      parsed = JSON.parse(line);
      break;
    } catch {
      // Login shells and server banners are ignored; the last JSON reply wins.
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${operation} returned no valid Worker response (${result.stderr.trim()})`);
  }
  const record = parsed as { ok?: unknown; error?: unknown; conflicts?: unknown };
  if (result.code !== 0 || record.ok !== true) {
    const message = typeof record.error === 'string' ? record.error : result.stderr.trim();
    throw new ProductFailure(
      productError('SSH_WORKER_FAILED', {
        userMessage: message || `${operation} failed on the remote server.`,
        retryable: true,
        context: Array.isArray(record.conflicts) ? { conflicts: record.conflicts } : undefined,
      }),
    );
  }
  return parsed as T;
}

/**
 * Owns the managed SSH change plane. The interactive Agent still gets a real
 * SSH PTY; this service adds the versioned baseline/change/apply protocol that
 * makes the terminal a reviewable Charter Session rather than a blind shell.
 */
export class RemoteWorkerService {
  private external: ExternalSessionService | null = null;
  private taskLookup: ((taskId: string) => TaskDto) | null = null;
  private changedPathLookup:
    ((taskId: string) => Promise<Array<{ path: string; currentHash: string | null }>>) | null =
    null;
  private readonly byTerminal = new Map<string, ManagedRemoteSession>();
  private readonly byTask = new Map<string, ManagedRemoteSession>();
  private expectedBundleHash: string | null = null;
  private closed = false;

  constructor(private readonly deps: RemoteWorkerDeps) {}

  attachExternalSessions(service: ExternalSessionService): void {
    this.external = service;
  }

  attachTaskLookup(lookup: (taskId: string) => TaskDto): void {
    this.taskLookup = lookup;
  }

  attachChangedPathLookup(
    lookup: (taskId: string) => Promise<Array<{ path: string; currentHash: string | null }>>,
  ): void {
    this.changedPathLookup = lookup;
  }

  private async bundleHash(): Promise<string> {
    if (this.expectedBundleHash) return this.expectedBundleHash;
    if (!existsSync(this.deps.bundlePath)) {
      throw new Error(`Bundled remote Worker is missing: ${this.deps.bundlePath}`);
    }
    this.expectedBundleHash = sha256(await readFile(this.deps.bundlePath));
    return this.expectedBundleHash;
  }

  private async remotePaths(hostId: string): Promise<{ home: string; workerPath: string }> {
    const sftp = await this.deps.openSftp(hostId);
    try {
      // SFTP has no shell, so `~` expansion is server-specific. The protocol's
      // initial directory is the authenticated user's home and realpath('.')
      // is portable across OpenSSH and the in-process test server.
      const home = await sftp.realpath('.');
      return { home, workerPath: `${home}/.charter/worker/bin/remote-session-worker.cjs` };
    } finally {
      sftp.close();
    }
  }

  private command(nodePath: string, workerPath: string, command: string, args = ''): string {
    return `${shellSingleQuote(nodePath)} ${shellSingleQuote(workerPath)} ${command}${args}`;
  }

  async status(hostId: string): Promise<SshWorkerStatus> {
    const node = await this.deps.probeNode(hostId);
    if (!node.found || !node.path?.startsWith('/')) {
      return {
        state: 'unsupported',
        version: null,
        protocol: null,
        message:
          'Node.js was not found in the remote login environment. Install Node.js 18 or newer before installing Charter Worker.',
        installPath: null,
        nodePath: null,
      };
    }
    const nodeVersionResult = await this.deps.exec(
      hostId,
      `${shellSingleQuote(node.path)} -p ${shellSingleQuote('process.versions.node')}`,
    );
    const nodeVersion = nodeVersionResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^\d+\.\d+\.\d+/.test(line));
    if (nodeVersionResult.code !== 0 || !nodeVersion || Number(nodeVersion.split('.')[0]) < 18) {
      return {
        state: 'unsupported',
        version: null,
        protocol: null,
        message: `Charter Worker requires Node.js 18 or newer on this server${nodeVersion ? ` (found ${nodeVersion})` : ''}.`,
        installPath: null,
        nodePath: node.path,
      };
    }
    let paths: { home: string; workerPath: string };
    try {
      paths = await this.remotePaths(hostId);
    } catch (error) {
      return {
        state: 'error',
        version: null,
        protocol: null,
        message: `Could not resolve the remote home folder: ${errorMessage(error)}`,
        installPath: null,
        nodePath: node.path,
      };
    }
    const sftp = await this.deps.openSftp(hostId);
    try {
      await sftp.stat(paths.workerPath);
    } catch {
      sftp.close();
      return {
        state: 'missing',
        version: null,
        protocol: null,
        message: 'Charter Worker is not installed on this server.',
        installPath: paths.workerPath,
        nodePath: node.path,
      };
    }
    sftp.close();
    try {
      const result = await this.deps.exec(
        hostId,
        this.command(node.path, paths.workerPath, 'hello'),
      );
      const hello = parseWorkerJson<WorkerHello>(result, 'Worker handshake');
      const expectedHash = await this.bundleHash();
      const ready =
        hello.protocol === WORKER_PROTOCOL &&
        hello.version === WORKER_VERSION &&
        hello.sha256 === expectedHash;
      return {
        state: ready ? 'ready' : 'outdated',
        version: hello.version,
        protocol: hello.protocol,
        message: ready
          ? 'Charter Worker is ready. Remote Diff, Review and rollback are protected.'
          : 'The installed Worker does not match this Charter build and must be updated.',
        installPath: paths.workerPath,
        nodePath: node.path,
      };
    } catch (error) {
      return {
        state: 'outdated',
        version: null,
        protocol: null,
        message: `The installed Worker could not complete a trusted handshake: ${errorMessage(error)}`,
        installPath: paths.workerPath,
        nodePath: node.path,
      };
    }
  }

  async install(hostId: string): Promise<SshWorkerStatus> {
    const node = await this.deps.probeNode(hostId);
    if (!node.found || !node.path?.startsWith('/')) {
      return await this.status(hostId);
    }
    await this.bundleHash();
    const { workerPath } = await this.remotePaths(hostId);
    const binDir = workerPath.slice(0, workerPath.lastIndexOf('/'));
    const tempPath = `${workerPath}.tmp-${randomUUID().slice(0, 8)}`;
    const mkdirResult = await this.deps.exec(
      hostId,
      `umask 077; mkdir -p -- ${shellSingleQuote(binDir)}`,
    );
    if (mkdirResult.code !== 0) {
      throw new Error(mkdirResult.stderr || 'Could not create the remote Worker directory');
    }
    const sftp = await this.deps.openSftp(hostId);
    try {
      await sftp.upload(this.deps.bundlePath, tempPath);
    } finally {
      sftp.close();
    }
    try {
      const activate = await this.deps.exec(
        hostId,
        `chmod 700 -- ${shellSingleQuote(tempPath)} && mv -f -- ${shellSingleQuote(tempPath)} ${shellSingleQuote(workerPath)}`,
      );
      if (activate.code !== 0) throw new Error(activate.stderr || 'Could not activate Worker');
    } catch (error) {
      const cleanup = await this.deps.openSftp(hostId).catch(() => null);
      if (cleanup) {
        await cleanup.delete(tempPath).catch(() => {});
        cleanup.close();
      }
      throw error;
    }
    const verified = await this.status(hostId);
    if (verified.state !== 'ready') {
      throw new ProductFailure(
        productError('SSH_WORKER_VERIFY_FAILED', {
          userMessage: verified.message,
          retryable: true,
        }),
      );
    }
    return verified;
  }

  private async uploadLocalSeed(
    hostId: string,
    remoteRoot: string,
    seed: LocalSeed,
  ): Promise<void> {
    const create = await this.deps.exec(
      hostId,
      `umask 077; mkdir -p -- ${shellSingleQuote(remoteRoot)}`,
    );
    if (create.code !== 0) {
      throw new Error(create.stderr || 'Could not create the isolated remote workspace');
    }
    const sftp = await this.deps.openSftp(hostId);
    try {
      for (const path of seed.directories) {
        await sftp.mkdir(`${remoteRoot}/${path}`).catch(async () => {
          const existing = await sftp.stat(`${remoteRoot}/${path}`);
          if (existing.type !== 'dir') throw new Error(`Remote seed path is not a folder: ${path}`);
        });
      }
      await mapWithConcurrency(seed.files, LOCAL_SEED_UPLOAD_CONCURRENCY, async (file) => {
        const destination = `${remoteRoot}/${file.path}`;
        await sftp.upload(file.stagedPath, destination);
        await sftp.chmod(destination, file.mode);
      });
    } finally {
      sftp.close();
    }
  }

  /** Best-effort cleanup for a seed that failed before Worker state owned it.
   * The root is a generated, exact path; symlinked directories are unlinked
   * and never traversed. */
  private async removeRemoteTree(hostId: string, remoteRoot: string): Promise<void> {
    const sftp = await this.deps.openSftp(hostId);
    const removeDir = async (path: string): Promise<void> => {
      const entries = await sftp.list(path);
      for (const entry of entries) {
        const child = `${path}/${entry.name}`;
        if (entry.type === 'dir' && !entry.symlink) await removeDir(child);
        else await sftp.delete(child);
      }
      await sftp.rmdir(path);
    };
    try {
      await removeDir(remoteRoot);
    } finally {
      sftp.close();
    }
  }

  async begin(input: BeginRemoteWorkerSession): Promise<ManagedRemoteSession> {
    if (Boolean(input.root) === Boolean(input.localProjectPath)) {
      throw new Error('Choose exactly one remote Session workspace mode');
    }
    const status = await this.status(input.hostId);
    if (status.state !== 'ready' || !status.nodePath || !status.installPath) {
      throw new ProductFailure(
        productError('SSH_WORKER_REQUIRED', {
          userMessage:
            status.state === 'missing' || status.state === 'outdated'
              ? 'Install or update Charter Worker on this server before starting a managed Agent Session.'
              : status.message,
          retryable: true,
        }),
      );
    }
    const workerSessionId = `rws_${randomUUID().replaceAll('-', '')}`;
    const workspaceKind = input.localProjectPath ? 'local' : 'remote';
    let seed: LocalSeed | null = null;
    let root = input.root ?? '';
    let mirrorRoot = join(this.deps.paths.remoteMirrorsDir, input.hostId, workerSessionId);
    let remoteSeedCreated = false;
    if (input.localProjectPath) {
      seed = await stageLocalWorkspace(input.localProjectPath);
      mirrorRoot = seed.canonicalRoot;
      const { home } = await this.remotePaths(input.hostId);
      root = `${home}/.charter/workspaces/${workerSessionId}`;
    } else {
      await mkdir(mirrorRoot, { recursive: true });
    }
    let started: WorkerStart | null = null;
    try {
      if (seed) {
        // Upload may fail after creating only part of the generated tree.
        // Mark ownership before it starts so that path is still reclaimed.
        remoteSeedCreated = true;
        await this.uploadLocalSeed(input.hostId, root, seed);
      }
      const result = await this.deps.exec(
        input.hostId,
        this.command(
          status.nodePath,
          status.installPath,
          'start',
          ` --session ${shellSingleQuote(workerSessionId)} --root ${shellSingleQuote(root)} --workspace ${shellSingleQuote(workspaceKind)}`,
        ),
      );
      started = parseWorkerJson<WorkerStart>(result, 'Worker baseline');
      if (
        started.sessionId !== workerSessionId ||
        typeof started.root !== 'string' ||
        !started.root.startsWith('/') ||
        started.root.length > 4096 ||
        !['git', 'files'].includes(started.baselineKind) ||
        (started.baselineRef !== null && typeof started.baselineRef !== 'string')
      ) {
        throw new Error('Worker returned invalid baseline metadata');
      }
    } catch (error) {
      await this.deps
        .exec(
          input.hostId,
          this.command(
            status.nodePath,
            status.installPath,
            'destroy',
            ` --session ${shellSingleQuote(workerSessionId)}`,
          ),
        )
        .catch(() => null);
      if (remoteSeedCreated) {
        await this.removeRemoteTree(input.hostId, root).catch(() => undefined);
      }
      if (workspaceKind === 'remote') {
        await rm(mirrorRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      if (seed) {
        await rm(seed.stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    if (!started) throw new Error('Worker baseline was not created');
    const seedHashes = new Map(seed?.files.map((file) => [file.path, file.hash]) ?? []);
    const session: ManagedRemoteSession = {
      terminalId: input.terminalId,
      taskId: null,
      hostId: input.hostId,
      hostLabel: input.hostLabel,
      root: started.root,
      mirrorRoot,
      workspaceKind,
      ownsMirrorRoot: workspaceKind === 'remote',
      workerSessionId,
      workerVersion: status.version ?? WORKER_VERSION,
      nodePath: status.nodePath,
      workerPath: status.installPath,
      baselineKind: started.baselineKind,
      baselineRef: started.baselineRef,
      lastNet: new Map(),
      expectedHashes: new Map(seedHashes),
      mirrorExpectedHashes: new Map(seedHashes),
      modes: new Map(),
      recoverPaths: [],
      timer: null,
      sync: Promise.resolve(0),
      disposed: false,
    };
    this.byTerminal.set(input.terminalId, session);
    return session;
  }

  bindTask(terminalId: string, taskId: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session) return;
    session.taskId = taskId;
    this.byTask.set(taskId, session);
    if (!session.timer) {
      session.timer = setInterval(
        () =>
          void this.syncSession(session).catch((error) => {
            this.deps.logger.warn('remote Worker poll failed', {
              taskId: session.taskId,
              error: errorMessage(error),
            });
          }),
        POLL_INTERVAL_MS,
      );
      session.timer.unref?.();
    }
    void this.syncSession(session).catch((error) => {
      this.deps.logger.warn('initial remote Worker sync failed', {
        taskId,
        error: errorMessage(error),
      });
    });
  }

  private validateChanges(response: WorkerChanges, session: ManagedRemoteSession): WorkerChange[] {
    if (
      response.sessionId !== session.workerSessionId ||
      response.root !== session.root ||
      !Array.isArray(response.entries) ||
      response.entries.length > MAX_REMOTE_ENTRIES
    ) {
      throw new Error('Worker returned invalid session change metadata');
    }
    return response.entries.map((entry) => {
      if (
        !safeRelativePath(entry.path) ||
        !['created', 'modified', 'deleted'].includes(entry.kind) ||
        (entry.beforeHash !== null && !HASH_RE.test(entry.beforeHash)) ||
        (entry.afterHash !== null && !HASH_RE.test(entry.afterHash)) ||
        (entry.beforeBase64 !== null && typeof entry.beforeBase64 !== 'string') ||
        (entry.afterBase64 !== null && typeof entry.afterBase64 !== 'string') ||
        (entry.beforeMode !== null &&
          (!Number.isInteger(entry.beforeMode) ||
            entry.beforeMode < 0 ||
            entry.beforeMode > 0o777)) ||
        (entry.afterMode !== null &&
          (!Number.isInteger(entry.afterMode) || entry.afterMode < 0 || entry.afterMode > 0o777))
      ) {
        throw new Error(`Worker returned an invalid changed path: ${String(entry.path)}`);
      }
      return entry;
    });
  }

  async beforeTerminalExit(terminalId: string): Promise<void> {
    const session = this.byTerminal.get(terminalId);
    if (!session) return;
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    let finalSyncError: unknown = null;
    await this.syncSession(session).catch((error) => {
      finalSyncError = error;
      this.deps.logger.warn('remote final sync failed', {
        terminalId,
        taskId: session.taskId,
        error: errorMessage(error),
      });
      if (session.taskId) {
        this.external?.noteRemoteSyncFailure(session.taskId, errorMessage(error));
      }
    });
    await this.deps
      .exec(
        session.hostId,
        this.command(
          session.nodePath,
          session.workerPath,
          'stop',
          ` --session ${shellSingleQuote(session.workerSessionId)}`,
        ),
      )
      .catch(() => null);
    session.disposed = true;
    this.byTerminal.delete(terminalId);
    if (session.terminalId === terminalId) session.terminalId = null;
    if (finalSyncError) throw finalSyncError;
  }

  private syncSession(session: ManagedRemoteSession, forceCurrent = false): Promise<number> {
    const next = session.sync
      .catch(() => 0)
      .then(async () => {
        if (!session.taskId || !this.external) return 0;
        let deliveredCount = 0;
        if (session.recoverPaths.length > 0) {
          const paths = session.recoverPaths;
          session.recoverPaths = [];
          const inspectedResult = await this.deps.exec(
            session.hostId,
            this.command(
              session.nodePath,
              session.workerPath,
              'inspect',
              ` --session ${shellSingleQuote(session.workerSessionId)}`,
            ),
            JSON.stringify({ paths }),
          );
          const inspected = this.validateChanges(
            parseWorkerJson<WorkerChanges>(inspectedResult, 'Remote recovery inspection'),
            session,
          );
          const inspectedForMirror = inspected.map((entry) =>
            session.workspaceKind === 'local'
              ? {
                  ...entry,
                  expectedMirrorHash: session.mirrorExpectedHashes.has(entry.path)
                    ? session.mirrorExpectedHashes.get(entry.path)
                    : entry.beforeHash,
                }
              : entry,
          );
          await this.external.ingestRemoteChanges(
            session.terminalId,
            session.taskId,
            inspectedForMirror,
          );
          // Publish remote expectations only after the local materialization
          // succeeds. On a local/remote conflict, protected writes therefore
          // retain the pre-conflict expected hash and neither side can silently
          // overwrite the other on the next watcher event.
          for (const entry of inspected) {
            session.expectedHashes.set(entry.path, entry.afterHash);
            session.modes.set(entry.path, entry.afterMode ?? entry.beforeMode);
          }
          if (session.workspaceKind === 'local') {
            for (const entry of inspected) {
              session.mirrorExpectedHashes.set(entry.path, entry.afterHash);
            }
          }
          deliveredCount += inspected.length;
        }
        const result = await this.deps.exec(
          session.hostId,
          this.command(
            session.nodePath,
            session.workerPath,
            'changes',
            ` --session ${shellSingleQuote(session.workerSessionId)}`,
          ),
        );
        const response = parseWorkerJson<WorkerChanges>(result, 'Remote change sync');
        const current = this.validateChanges(response, session);
        const currentMap = new Map(current.map((entry) => [entry.path, entry]));
        const restored: WorkerChange[] = [];
        for (const [path, previous] of session.lastNet) {
          if (currentMap.has(path)) continue;
          restored.push({
            path,
            kind: previous.beforeHash === null ? 'deleted' : 'modified',
            beforeHash: previous.beforeHash,
            afterHash: previous.beforeHash,
            beforeBase64: previous.beforeBase64,
            afterBase64: previous.beforeBase64,
            beforeMode: previous.beforeMode,
            afterMode: previous.beforeMode,
          });
        }
        // Polling returns the complete net diff from the entry baseline. Only
        // materialize entries whose current version changed; explicit Review
        // reconciliation passes forceCurrent to repair any provisional mirror
        // mutation after a failed expected-hash apply.
        const changed = forceCurrent
          ? current
          : current.filter((entry) => {
              const previous = session.lastNet.get(entry.path);
              return (
                !previous ||
                previous.beforeHash !== entry.beforeHash ||
                previous.afterHash !== entry.afterHash ||
                previous.beforeMode !== entry.beforeMode ||
                previous.afterMode !== entry.afterMode
              );
            });
        const delivered = [...changed, ...restored];
        const deliveredForMirror = delivered.map((entry) =>
          session.workspaceKind === 'local'
            ? {
                ...entry,
                expectedMirrorHash: session.mirrorExpectedHashes.has(entry.path)
                  ? session.mirrorExpectedHashes.get(entry.path)
                  : entry.beforeHash,
              }
            : entry,
        );
        await this.external.ingestRemoteChanges(
          session.terminalId,
          session.taskId,
          deliveredForMirror,
        );
        for (const entry of delivered) {
          session.expectedHashes.set(entry.path, entry.afterHash);
          session.modes.set(entry.path, entry.afterMode ?? entry.beforeMode);
        }
        if (session.workspaceKind === 'local') {
          for (const entry of delivered) {
            session.mirrorExpectedHashes.set(entry.path, entry.afterHash);
          }
        }
        session.lastNet = currentMap;
        return deliveredCount + delivered.length;
      });
    session.sync = next;
    return next;
  }

  private async recover(
    taskId: string,
    taskSnapshot?: TaskDto,
  ): Promise<ManagedRemoteSession | null> {
    if (this.closed) return null;
    const existing = this.byTask.get(taskId);
    if (existing) return existing;
    const task = taskSnapshot ?? this.taskLookup?.(taskId);
    const external = task?.external;
    const remote = external?.remote;
    if (!task || !external || !remote) return null;
    const status = await this.status(remote.hostId);
    if (status.state !== 'ready' || !status.nodePath || !status.installPath) {
      throw new ProductFailure(
        productError('SSH_WORKER_REQUIRED', {
          userMessage: `Reconnect ${remote.hostLabel} and update Charter Worker before changing this remote Review.`,
          retryable: true,
        }),
      );
    }
    const recoverStates = this.changedPathLookup ? await this.changedPathLookup(taskId) : [];
    const workspaceKind = remote.workspaceKind ?? 'remote';
    const session: ManagedRemoteSession = {
      terminalId: null,
      taskId,
      hostId: remote.hostId,
      hostLabel: remote.hostLabel,
      root: remote.root,
      mirrorRoot: task.projectPath,
      workspaceKind,
      ownsMirrorRoot: workspaceKind === 'remote',
      workerSessionId: remote.workerSessionId,
      workerVersion: remote.workerVersion,
      nodePath: status.nodePath,
      workerPath: status.installPath,
      baselineKind: null,
      baselineRef: external.snapshotRef,
      lastNet: new Map(),
      expectedHashes: new Map(),
      mirrorExpectedHashes:
        workspaceKind === 'local'
          ? new Map(recoverStates.map((entry) => [entry.path, entry.currentHash]))
          : new Map(),
      modes: new Map(),
      recoverPaths: [...new Set(recoverStates.map((entry) => entry.path).filter(safeRelativePath))],
      timer: null,
      sync: Promise.resolve(0),
      disposed: true,
    };
    this.byTask.set(taskId, session);
    return session;
  }

  async syncTask(taskId: string): Promise<number> {
    const session = (await this.recover(taskId)) ?? null;
    return session ? await this.syncSession(session, true) : 0;
  }

  /** Reattach a new SSH PTY to the same durable Worker baseline. */
  async attachTerminal(taskId: string, terminalId: string): Promise<ManagedRemoteSession> {
    const session = await this.recover(taskId);
    if (!session) throw new Error('Remote Worker task was not found');
    await this.syncSession(session, true);
    if (session.terminalId) this.byTerminal.delete(session.terminalId);
    session.terminalId = terminalId;
    session.disposed = false;
    this.byTerminal.set(terminalId, session);
    if (!session.timer) {
      session.timer = setInterval(
        () =>
          void this.syncSession(session).catch((error) => {
            this.deps.logger.warn('resumed remote Worker poll failed', {
              taskId,
              error: errorMessage(error),
            });
          }),
        POLL_INTERVAL_MS,
      );
      session.timer.unref?.();
    }
    return session;
  }

  detachTerminal(terminalId: string): void {
    const session = this.byTerminal.get(terminalId);
    if (!session) return;
    this.byTerminal.delete(terminalId);
    if (session.terminalId === terminalId) session.terminalId = null;
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    session.disposed = true;
  }

  /** Cleanup for a launch that failed before a Task could own the baseline. */
  async abandonTerminal(terminalId: string): Promise<void> {
    const session = this.byTerminal.get(terminalId);
    if (!session) return;
    if (session.taskId) {
      this.detachTerminal(terminalId);
      return;
    }
    this.detachTerminal(terminalId);
    await this.deps
      .exec(
        session.hostId,
        this.command(
          session.nodePath,
          session.workerPath,
          'destroy',
          ` --session ${shellSingleQuote(session.workerSessionId)}`,
        ),
      )
      .catch(() => null);
    if (session.ownsMirrorRoot) {
      await rm(session.mirrorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async discoverCliSession(
    taskId: string,
    cli: string,
    options: { allowConnect?: boolean } = {},
  ): Promise<string | null> {
    // Automatic exit bookkeeping must never resurrect a transport the user
    // explicitly disconnected (or one being torn down with the app).
    const task = this.taskLookup?.(taskId);
    const hostId = task?.external?.remote?.hostId;
    if (
      this.closed ||
      (!options.allowConnect && hostId && this.deps.isConnected && !this.deps.isConnected(hostId))
    ) {
      return null;
    }
    const session = await this.recover(taskId);
    if (!session || !['claude', 'codex', 'kimi'].includes(cli)) return null;
    const result = await this.deps.exec(
      session.hostId,
      this.command(
        session.nodePath,
        session.workerPath,
        'discover',
        ` --session ${shellSingleQuote(session.workerSessionId)} --cli ${shellSingleQuote(cli)}`,
      ),
    );
    const response = parseWorkerJson<WorkerDiscovery>(result, 'Remote Agent session discovery');
    return response.sessionId === session.workerSessionId &&
      response.cli === cli &&
      typeof response.cliSessionId === 'string' &&
      /^(?:session_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        response.cliSessionId,
      )
      ? response.cliSessionId
      : null;
  }

  /** Deleting a Charter Session also removes its retained remote baseline. */
  async destroyTask(taskId: string, taskSnapshot?: TaskDto): Promise<void> {
    const task = taskSnapshot ?? this.taskLookup?.(taskId);
    if (!task?.external?.remote) return;
    let session: ManagedRemoteSession | null = null;
    try {
      session = await this.recover(taskId, task);
    } catch (error) {
      if ((task.external.remote.workspaceKind ?? 'remote') === 'remote') {
        await rm(task.projectPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
    if (!session) return;
    if (session.timer) clearInterval(session.timer);
    if (session.terminalId) this.byTerminal.delete(session.terminalId);
    this.byTask.delete(taskId);
    await this.deps
      .exec(
        session.hostId,
        this.command(
          session.nodePath,
          session.workerPath,
          'destroy',
          ` --session ${shellSingleQuote(session.workerSessionId)}`,
        ),
      )
      .catch((error) => {
        this.deps.logger.warn('remote Worker cleanup failed', {
          taskId,
          error: errorMessage(error),
        });
        return null;
      });
    if (session.ownsMirrorRoot) {
      await rm(session.mirrorRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async pushMirrorPaths(taskId: string, paths: string[]): Promise<void> {
    const session = await this.recover(taskId);
    if (!session || paths.length === 0) return;
    const requested = [...new Set(paths)];
    const operation = session.sync
      .catch(() => 0)
      .then(async () => {
        await this.applyMirrorPaths(session, requested);
        return 0;
      });
    session.sync = operation;
    await operation;
  }

  private async applyMirrorPaths(session: ManagedRemoteSession, paths: string[]): Promise<void> {
    const unique = [...new Set(paths)];
    for (const path of unique) {
      if (!safeRelativePath(path)) throw new Error(`Unsafe remote review path: ${path}`);
    }
    const entries = await Promise.all(
      unique.map(async (path) => {
        const absolute = resolve(session.mirrorRoot, ...path.split('/'));
        const prefix = session.mirrorRoot.endsWith(sep)
          ? session.mirrorRoot
          : `${session.mirrorRoot}${sep}`;
        if (!absolute.startsWith(prefix))
          throw new Error(`Review path escaped its mirror: ${path}`);
        let bytes: Buffer | null = null;
        let mode = session.modes.get(path) ?? 0o644;
        try {
          const fileStat = await stat(absolute);
          if (!fileStat.isFile()) throw new Error(`Review target is not a file: ${path}`);
          bytes = await readFile(absolute);
          mode = fileStat.mode & 0o777;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return {
          path,
          expectedHash: session.expectedHashes.get(path) ?? null,
          dataBase64: bytes?.toString('base64') ?? null,
          mode,
        };
      }),
    );
    const result = await this.deps.exec(
      session.hostId,
      this.command(
        session.nodePath,
        session.workerPath,
        'apply',
        ` --session ${shellSingleQuote(session.workerSessionId)}`,
      ),
      JSON.stringify({ entries }),
    );
    const applied = parseWorkerJson<WorkerApply>(result, 'Remote review apply');
    const appliedPaths = Array.isArray(applied.applied)
      ? new Set(applied.applied.map((entry) => entry.path))
      : new Set<string>();
    if (
      applied.sessionId !== session.workerSessionId ||
      !Array.isArray(applied.applied) ||
      applied.applied.length !== unique.length ||
      appliedPaths.size !== unique.length ||
      unique.some((path) => !appliedPaths.has(path)) ||
      applied.applied.some(
        (entry) =>
          !safeRelativePath(entry.path) ||
          (entry.hash !== null && (typeof entry.hash !== 'string' || !HASH_RE.test(entry.hash))),
      )
    ) {
      throw new Error('Worker returned invalid protected-write metadata');
    }
    for (const entry of applied.applied) {
      session.expectedHashes.set(entry.path, entry.hash);
      if (session.workspaceKind === 'local') {
        session.mirrorExpectedHashes.set(entry.path, entry.hash);
      }
    }
  }

  sessionForTerminal(terminalId: string): ManagedRemoteSession | null {
    return this.byTerminal.get(terminalId) ?? null;
  }

  dispose(): void {
    this.closed = true;
    for (const session of this.byTask.values()) {
      if (session.timer) clearInterval(session.timer);
      session.timer = null;
    }
    this.byTask.clear();
    this.byTerminal.clear();
  }
}
