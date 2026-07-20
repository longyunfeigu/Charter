import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { applyPatch as applyUnifiedPatch, createTwoFilesPatch, structuredPatch } from 'diff';
import {
  errorMessage,
  detectBinary,
  newId,
  productError,
  ProductFailure,
} from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import type { DocumentSnapshot, DocumentStore } from '@pi-ide/document-service';
import { BlobStore } from './blob-store.js';
import { parseHunks, reverseHunkPatchText } from './review.js';

export interface FileBaseline {
  taskId: string;
  relativePath: string;
  existed: boolean;
  blobHash: string | null;
  mode: number | null;
  size: number;
  capturedAt: string;
}

export type ChangeKind = 'created' | 'modified' | 'deleted' | 'renamed';

export interface FileChangeRecord {
  id: string;
  taskId: string;
  toolCallId: string | null;
  relativePath: string;
  kind: ChangeKind;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string | null;
  renameTo: string | null;
  author: 'agent' | 'user' | 'system';
  createdAt: string;
}

export interface ChangeRepo {
  getBaseline(taskId: string, relativePath: string): FileBaseline | null;
  saveBaseline(baseline: FileBaseline): void;
  baselinesFor(taskId: string): FileBaseline[];
  recordChange(change: FileChangeRecord): void;
  changesFor(taskId: string): FileChangeRecord[];
}

export class InMemoryChangeRepo implements ChangeRepo {
  private baselines = new Map<string, FileBaseline>();
  private changes: FileChangeRecord[] = [];

  getBaseline(taskId: string, relativePath: string): FileBaseline | null {
    return this.baselines.get(`${taskId}${relativePath}`) ?? null;
  }
  saveBaseline(baseline: FileBaseline): void {
    this.baselines.set(`${baseline.taskId}${baseline.relativePath}`, baseline);
  }
  baselinesFor(taskId: string): FileBaseline[] {
    return [...this.baselines.values()].filter((b) => b.taskId === taskId);
  }
  recordChange(change: FileChangeRecord): void {
    this.changes.push(change);
  }
  changesFor(taskId: string): FileChangeRecord[] {
    return this.changes.filter((c) => c.taskId === taskId);
  }
}

export interface ChangeSetFile {
  path: string;
  status: ChangeKind;
  renamedFrom: string | null;
  binary: boolean;
  diff: string | null;
  additions: number;
  deletions: number;
  baselineHash: string | null;
  currentHash: string | null;
}

export interface ChangeSet {
  taskId: string;
  files: ChangeSetFile[];
  totalAdditions: number;
  totalDeletions: number;
}

export interface RollbackConflict {
  path: string;
  reason: string;
  currentHash: string | null;
  expectedHash: string | null;
}

export interface RollbackReport {
  ok: boolean;
  restored: string[];
  verified: Array<{ path: string; ok: boolean; detail?: string }>;
  conflictsOverridden: string[];
}

export interface ChangeServiceOptions {
  root: string;
  blobs: BlobStore;
  repo: ChangeRepo;
  documents: DocumentStore;
  /** Notifies the host when a task write updated an already-open document. */
  onDidWriteOpenDocument?: (document: DocumentSnapshot) => void;
}

function sha(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function chgError(
  code: string,
  userMessage: string,
  context?: Record<string, unknown>,
  retryable?: boolean,
): ProductFailure {
  return new ProductFailure(
    productError(code, { userMessage, context, ...(retryable !== undefined ? { retryable } : {}) }),
  );
}

/**
 * All task writes flow through here (spec §5.4): baselines before first touch,
 * base-hash verified patches, net change-set projection and byte-exact rollback.
 */
export class ChangeService {
  private readonly root: string;
  private readonly blobs: BlobStore;
  private readonly repo: ChangeRepo;
  private readonly documents: DocumentStore;
  private readonly onDidWriteOpenDocument?: (document: DocumentSnapshot) => void;

  constructor(options: ChangeServiceOptions) {
    this.root = options.root;
    this.blobs = options.blobs;
    this.repo = options.repo;
    this.documents = options.documents;
    this.onDidWriteOpenDocument = options.onDidWriteOpenDocument;
  }

  /** CHG-001: capture the pre-task state of a file exactly once per task. */
  async ensureBaseline(taskId: string, relativePath: string): Promise<FileBaseline> {
    const existing = this.repo.getBaseline(taskId, relativePath);
    if (existing) return existing;

    const abs = await resolveInsideRoot(this.root, relativePath);
    let baseline: FileBaseline;
    try {
      const stat = await fs.stat(abs);
      const bytes = await fs.readFile(abs);
      const { hash } = await this.blobs.put(bytes);
      baseline = {
        taskId,
        relativePath,
        existed: true,
        blobHash: hash,
        mode: stat.mode & 0o7777,
        size: bytes.length,
        capturedAt: new Date().toISOString(),
      };
    } catch {
      baseline = {
        taskId,
        relativePath,
        existed: false,
        blobHash: null,
        mode: null,
        size: 0,
        capturedAt: new Date().toISOString(),
      };
    }
    this.repo.saveBaseline(baseline);
    return baseline;
  }

  /**
   * ADR-0017: capture a baseline from PROVIDED bytes (an external session's
   * entry snapshot) instead of the current disk state — the watcher only
   * learns about external writes after they landed, so "read the file now"
   * would capture post-write content and break diffs and rollback.
   * `bytes: null` records an honest "did not exist" baseline.
   */
  async ensureBaselineFromBytes(
    taskId: string,
    relativePath: string,
    bytes: Buffer | null,
  ): Promise<FileBaseline> {
    const existing = this.repo.getBaseline(taskId, relativePath);
    if (existing) return existing;
    await resolveInsideRoot(this.root, relativePath);
    let baseline: FileBaseline;
    if (bytes === null) {
      baseline = {
        taskId,
        relativePath,
        existed: false,
        blobHash: null,
        mode: null,
        size: 0,
        capturedAt: new Date().toISOString(),
      };
    } else {
      const { hash } = await this.blobs.put(bytes);
      baseline = {
        taskId,
        relativePath,
        existed: true,
        blobHash: hash,
        mode: null,
        size: bytes.length,
        capturedAt: new Date().toISOString(),
      };
    }
    this.repo.saveBaseline(baseline);
    return baseline;
  }

  /**
   * ADR-0017 replay evidence: snapshot an externally-observed write after it
   * lands. Each observation is chained to the previous observed hash, not
   * merely the task baseline, so a scrubber can reconstruct intermediate
   * versions instead of showing only the final net diff.
   */
  async recordExternalChange(
    taskId: string,
    relativePath: string,
    kind: Exclude<ChangeKind, 'renamed'>,
  ): Promise<FileChangeRecord> {
    const history = this.repo
      .changesFor(taskId)
      .filter((change) => change.relativePath === relativePath);
    const previous = history.at(-1);
    const beforeHash = previous
      ? previous.afterHash
      : (this.repo.getBaseline(taskId, relativePath)?.blobHash ?? null);
    const beforeBytes = beforeHash ? await this.blobs.get(beforeHash) : null;

    let afterBytes: Buffer | null = null;
    if (kind !== 'deleted') {
      const abs = await resolveInsideRoot(this.root, relativePath);
      afterBytes = await fs.readFile(abs).catch(() => null);
    }
    const afterHash = afterBytes ? (await this.blobs.put(afterBytes)).hash : null;

    let patch: string | null = null;
    if (!(beforeBytes && detectBinary(beforeBytes)) && !(afterBytes && detectBinary(afterBytes))) {
      patch = createTwoFilesPatch(
        relativePath,
        relativePath,
        beforeBytes?.toString('utf8') ?? '',
        afterBytes?.toString('utf8') ?? '',
        '',
        '',
      );
    }

    const record: FileChangeRecord = {
      id: newId('chg'),
      taskId,
      toolCallId: null,
      relativePath,
      kind,
      beforeHash,
      afterHash,
      patch,
      renameTo: null,
      author: 'agent',
      createdAt: new Date().toISOString(),
    };
    this.repo.recordChange(record);
    return record;
  }

  /** Write content through the document store when open, else atomically to disk. */
  private async writeThrough(relativePath: string, content: string): Promise<void> {
    if (this.documents.isOpen(relativePath)) {
      this.documents.updateBuffer(relativePath, content);
      try {
        const document = await this.documents.save(relativePath);
        this.onDidWriteOpenDocument?.(document);
      } catch (e) {
        if (e instanceof ProductFailure && e.error.code === 'DOC_SAVE_CONFLICT') {
          throw chgError(
            'CHG_VERSION_CONFLICT',
            'The file changed on disk while the change was being applied. Nothing was overwritten.',
            { relativePath },
          );
        }
        throw e;
      }
      return;
    }
    await this.writeBytes(relativePath, Buffer.from(content, 'utf8'), null);
  }

  private async writeBytes(
    relativePath: string,
    bytes: Buffer,
    mode: number | null,
  ): Promise<void> {
    const abs = await resolveInsideRoot(this.root, relativePath);
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.pi-ide-chg.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, bytes);
    if (mode !== null) await fs.chmod(tmp, mode);
    else {
      try {
        const prev = await fs.stat(abs);
        await fs.chmod(tmp, prev.mode & 0o7777);
      } catch {
        // new file: default mode
      }
    }
    await fs.rename(tmp, abs);
  }

  /** CHG-002/003: base-hash verified patch application against logical content. */
  async applyPatch(
    taskId: string,
    toolCallId: string | null,
    input: { path: string; patch: string; baseHash: string; reason: string },
  ): Promise<{ afterHash: string; additions: number; deletions: number }> {
    await resolveInsideRoot(this.root, input.path);
    await this.ensureBaseline(taskId, input.path);

    const current = await this.documents.readLogical(input.path).catch(() => null);
    if (!current) {
      throw chgError('CHG_TARGET_MISSING', 'The file to patch does not exist.', {
        path: input.path,
      });
    }
    if (current.binary) {
      throw chgError('CHG_BINARY', 'Binary files cannot be patched (CHG-014).', {
        path: input.path,
      });
    }
    if (input.baseHash !== current.hash) {
      throw chgError(
        'CHG_VERSION_CONFLICT',
        'The file changed since it was read; the patch was rejected to protect newer edits. Re-read the file to get its current hash before patching again.',
        { path: input.path, expected: input.baseHash, actual: current.hash },
        true,
      );
    }

    const next = applyUnifiedPatch(current.content, input.patch);
    if (next === false) {
      throw chgError(
        'CHG_PATCH_FAILED',
        'The patch does not apply to the current content.',
        { path: input.path },
        true,
      );
    }

    await this.writeThrough(input.path, next);
    const afterHash = sha(next);
    await this.blobs.put(Buffer.from(next, 'utf8'));
    const stored = createTwoFilesPatch(input.path, input.path, current.content, next, '', '');
    const stats = countDiff(stored);
    this.repo.recordChange({
      id: newId('chg'),
      taskId,
      toolCallId,
      relativePath: input.path,
      kind: 'modified',
      beforeHash: current.hash,
      afterHash,
      patch: stored,
      renameTo: null,
      author: 'agent',
      createdAt: new Date().toISOString(),
    });
    return { afterHash, additions: stats.additions, deletions: stats.deletions };
  }

  /** Direct full-content write (used by hunk accept/reject and matrix ops). */
  async writeFileDirect(
    taskId: string,
    toolCallId: string | null,
    input: { path: string; content: Buffer; author?: 'agent' | 'user' | 'system' },
  ): Promise<{ afterHash: string }> {
    await this.ensureBaseline(taskId, input.path);
    const before = await this.documents.readLogical(input.path).catch(() => null);
    await this.writeBytes(input.path, input.content, null);
    if (this.documents.isOpen(input.path)) {
      await this.documents.handleExternalChange(input.path);
    }
    const afterHash = sha(input.content);
    await this.blobs.put(input.content);
    this.repo.recordChange({
      id: newId('chg'),
      taskId,
      toolCallId,
      relativePath: input.path,
      kind: before ? 'modified' : 'created',
      beforeHash: before?.hash ?? null,
      afterHash,
      patch: null,
      renameTo: null,
      author: input.author ?? 'agent',
      createdAt: new Date().toISOString(),
    });
    return { afterHash };
  }

  async createFile(
    taskId: string,
    toolCallId: string | null,
    input: { path: string; content: string },
  ): Promise<{ afterHash: string }> {
    const abs = await resolveInsideRoot(this.root, input.path);
    const exists = await fs.access(abs).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw chgError(
        'CHG_ALREADY_EXISTS',
        'The file already exists; create_file will not overwrite.',
        {
          path: input.path,
        },
      );
    }
    await this.ensureBaseline(taskId, input.path); // records existed=false
    await fs.mkdir(dirname(abs), { recursive: true });
    await this.writeBytes(input.path, Buffer.from(input.content, 'utf8'), null);
    const afterHash = sha(input.content);
    await this.blobs.put(Buffer.from(input.content, 'utf8'));
    this.repo.recordChange({
      id: newId('chg'),
      taskId,
      toolCallId,
      relativePath: input.path,
      kind: 'created',
      beforeHash: null,
      afterHash,
      patch: createTwoFilesPatch(input.path, input.path, '', input.content, '', ''),
      renameTo: null,
      author: 'agent',
      createdAt: new Date().toISOString(),
    });
    return { afterHash };
  }

  async deleteFile(
    taskId: string,
    toolCallId: string | null,
    input: { path: string },
  ): Promise<void> {
    const abs = await resolveInsideRoot(this.root, input.path);
    const baseline = await this.ensureBaseline(taskId, input.path);
    const current = await this.documents.readLogical(input.path).catch(() => null);
    if (!current) {
      throw chgError('CHG_TARGET_MISSING', 'The file to delete does not exist.', {
        path: input.path,
      });
    }
    // Snapshot the latest bytes too (they may differ from the baseline).
    const bytes = await fs.readFile(abs);
    await this.blobs.put(bytes);
    await fs.rm(abs);
    if (this.documents.isOpen(input.path)) {
      await this.documents.handleExternalChange(input.path);
    }
    this.repo.recordChange({
      id: newId('chg'),
      taskId,
      toolCallId,
      relativePath: input.path,
      kind: 'deleted',
      beforeHash: sha(bytes),
      afterHash: null,
      patch: null,
      renameTo: null,
      author: 'agent',
      createdAt: new Date().toISOString(),
    });
    void baseline;
  }

  async renameFile(
    taskId: string,
    toolCallId: string | null,
    input: { from: string; to: string },
  ): Promise<void> {
    const absFrom = await resolveInsideRoot(this.root, input.from);
    const absTo = await resolveInsideRoot(this.root, input.to);
    const targetExists = await fs.access(absTo).then(
      () => true,
      () => false,
    );
    if (targetExists) {
      throw chgError('CHG_ALREADY_EXISTS', 'The rename target already exists; nothing was moved.', {
        path: input.to,
      });
    }
    await this.ensureBaseline(taskId, input.from);
    await this.ensureBaseline(taskId, input.to);
    const bytes = await fs.readFile(absFrom);
    await this.blobs.put(bytes);
    await fs.mkdir(dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
    this.repo.recordChange({
      id: newId('chg'),
      taskId,
      toolCallId,
      relativePath: input.from,
      kind: 'renamed',
      beforeHash: sha(bytes),
      afterHash: sha(bytes),
      patch: null,
      renameTo: input.to,
      author: 'agent',
      createdAt: new Date().toISOString(),
    });
  }

  /** CHG-005: net changes — baseline vs current logical content per touched path. */
  async changeSet(taskId: string): Promise<ChangeSet> {
    const baselines = this.repo.baselinesFor(taskId);
    const renames = this.repo.changesFor(taskId).filter((c) => c.kind === 'renamed') as Array<
      FileChangeRecord & { renameTo: string }
    >;
    const files: ChangeSetFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const baseline of baselines) {
      const path = baseline.relativePath;
      const baselineBytes = baseline.blobHash ? await this.blobs.get(baseline.blobHash) : null;
      const current = await this.documents.readLogical(path).catch(() => null);
      const currentExists = current !== null;
      const baselineExisted = baseline.existed;

      const renamedTo = renames.find((r) => r.relativePath === path)?.renameTo ?? null;
      const renamedFrom = renames.find((r) => r.renameTo === path)?.relativePath ?? null;

      if (!baselineExisted && !currentExists) continue;
      const baselineText = baselineBytes ? stripBom(baselineBytes.toString('utf8')) : '';
      const baselineIsBinary = baselineBytes ? detectBinary(baselineBytes) : false;
      const currentHash = current?.hash ?? null;
      const baselineHash = baselineBytes ? sha(stripBom(baselineBytes.toString('utf8'))) : null;

      let status: ChangeKind;
      if (!baselineExisted && currentExists) status = renamedFrom ? 'renamed' : 'created';
      else if (baselineExisted && !currentExists) {
        if (renamedTo) continue; // represented by the destination entry
        status = 'deleted';
      } else if (baselineHash !== currentHash) status = 'modified';
      else continue; // unchanged net state

      const binary = baselineIsBinary || (current?.binary ?? false);
      let diff: string | null = null;
      let additions = 0;
      let deletions = 0;
      if (!binary) {
        diff = createTwoFilesPatch(
          renamedFrom ?? path,
          path,
          status === 'created' ? '' : baselineText,
          status === 'deleted' ? '' : (current?.content ?? ''),
          '',
          '',
        );
        const stats = countDiff(diff);
        additions = stats.additions;
        deletions = stats.deletions;
      }
      totalAdditions += additions;
      totalDeletions += deletions;
      files.push({
        path,
        status,
        renamedFrom,
        binary,
        diff,
        additions,
        deletions,
        baselineHash: baseline.blobHash,
        currentHash,
      });
    }

    files.sort((a, b) => a.path.localeCompare(b.path));
    return { taskId, files, totalAdditions, totalDeletions };
  }

  /**
   * Review presentation (ADR-0013): both sides of one file's net change —
   * the task baseline snapshot and the current logical content. Returns null
   * when the path was never touched by the task.
   */
  async fileContents(
    taskId: string,
    path: string,
  ): Promise<{ baseline: string | null; current: string | null; binary: boolean } | null> {
    const baselines = this.repo.baselinesFor(taskId);
    const renames = this.repo.changesFor(taskId).filter((c) => c.kind === 'renamed') as Array<
      FileChangeRecord & { renameTo: string }
    >;
    const renamedFrom = renames.find((r) => r.renameTo === path)?.relativePath ?? null;
    const baseline =
      baselines.find((b) => b.relativePath === path) ??
      (renamedFrom ? baselines.find((b) => b.relativePath === renamedFrom) : undefined);
    if (!baseline) return null;
    const baselineBytes = baseline.blobHash
      ? await this.blobs.get(baseline.blobHash).catch(() => null)
      : null;
    const current = await this.documents.readLogical(path).catch(() => null);
    const binary =
      (baselineBytes ? detectBinary(baselineBytes) : false) || (current?.binary ?? false);
    return {
      baseline: baseline.existed && baselineBytes ? stripBom(baselineBytes.toString('utf8')) : null,
      current: current && !current.binary ? current.content : null,
      binary,
    };
  }

  /** CHG-010: classify every touched path before rollback. */
  async rollbackPreflight(taskId: string): Promise<{
    safe: string[];
    alreadyBaseline: string[];
    conflicts: RollbackConflict[];
  }> {
    const baselines = this.repo.baselinesFor(taskId);
    const expected = this.expectedPostTaskState(taskId);
    const safe: string[] = [];
    const alreadyBaseline: string[] = [];
    const conflicts: RollbackConflict[] = [];

    for (const baseline of baselines) {
      const path = baseline.relativePath;
      const abs = await resolveInsideRoot(this.root, path);
      let currentHash: string | null = null;
      try {
        currentHash = sha(await fs.readFile(abs));
      } catch {
        currentHash = null;
      }
      const baselineHash = baseline.existed ? baseline.blobHash : null;
      if (currentHash === baselineHash) {
        alreadyBaseline.push(path);
        continue;
      }
      const expectedState = expected.get(path);
      const expectedHash = expectedState === undefined ? currentHash : expectedState;
      if (currentHash === expectedHash) {
        safe.push(path);
      } else {
        conflicts.push({
          path,
          reason:
            currentHash === null
              ? 'The file was deleted outside this task after the task changed it.'
              : 'The file was modified outside this task after the task changed it.',
          currentHash,
          expectedHash,
        });
      }
    }
    return { safe, alreadyBaseline, conflicts };
  }

  /** Fold the change log into the state the task believes it left on disk. */
  private expectedPostTaskState(taskId: string): Map<string, string | null> {
    const expected = new Map<string, string | null>();
    for (const change of this.repo.changesFor(taskId)) {
      switch (change.kind) {
        case 'created':
        case 'modified':
          expected.set(change.relativePath, change.afterHash);
          break;
        case 'deleted':
          expected.set(change.relativePath, null);
          break;
        case 'renamed':
          expected.set(change.relativePath, null);
          if (change.renameTo) expected.set(change.renameTo, change.afterHash);
          break;
      }
    }
    return expected;
  }

  /** CHG-009/012: byte-exact restore of every touched path to its baseline. */
  async rollback(taskId: string, options: { force?: boolean } = {}): Promise<RollbackReport> {
    const preflight = await this.rollbackPreflight(taskId);
    if (preflight.conflicts.length > 0 && !options.force) {
      throw new ProductFailure(
        productError('CHG_ROLLBACK_CONFLICT', {
          userMessage:
            'Some files were changed outside this task after the agent touched them. Review the conflicts — rollback will not overwrite them silently.',
          context: { conflicts: preflight.conflicts },
        }),
      );
    }

    const baselines = this.repo.baselinesFor(taskId);
    const restored: string[] = [];
    const verified: Array<{ path: string; ok: boolean; detail?: string }> = [];

    for (const baseline of baselines) {
      const path = baseline.relativePath;
      const abs = await resolveInsideRoot(this.root, path);
      try {
        if (baseline.existed) {
          const bytes = await this.blobs.get(baseline.blobHash!);
          if (!bytes) {
            verified.push({ path, ok: false, detail: 'baseline blob missing' });
            continue;
          }
          await this.writeBytes(path, bytes, baseline.mode);
          restored.push(path);
          const roundTrip = await fs.readFile(abs);
          const modeOk =
            baseline.mode === null ||
            ((await fs.stat(abs)).mode & 0o7777) === (baseline.mode & 0o7777);
          verified.push({
            path,
            ok: sha(roundTrip) === baseline.blobHash && modeOk,
            ...(sha(roundTrip) !== baseline.blobHash ? { detail: 'content mismatch' } : {}),
          });
        } else {
          await fs.rm(abs, { force: true });
          restored.push(path);
          const stillThere = await fs.access(abs).then(
            () => true,
            () => false,
          );
          verified.push({
            path,
            ok: !stillThere,
            ...(stillThere ? { detail: 'file still exists' } : {}),
          });
        }
        if (this.documents.isOpen(path)) {
          await this.documents.handleExternalChange(path);
        }
      } catch (e) {
        verified.push({ path, ok: false, detail: errorMessage(e) });
      }
    }

    const ok = verified.every((v) => v.ok);
    if (!ok) {
      // Snapshots stay in the blob store for manual recovery (CHG-012).
      return {
        ok,
        restored,
        verified,
        conflictsOverridden: preflight.conflicts.map((c) => c.path),
      };
    }
    return { ok, restored, verified, conflictsOverridden: preflight.conflicts.map((c) => c.path) };
  }

  /**
   * ADR-0032 (per-turn rollback): byte-exact restore of specific paths to
   * recorded prior hashes. Preflight per path: the current content must match
   * the recorded post-turn hash — anything else changed outside the turn and
   * conflicts (never overwritten silently). Blob-backed, same guarantees as
   * the full rollback.
   */
  async rollbackToStates(
    targets: Array<{ path: string; toHash: string | null; expectedCurrentHash: string | null }>,
    options: { force?: boolean } = {},
  ): Promise<{
    ok: boolean;
    restored: string[];
    verified: Array<{ path: string; ok: boolean; detail?: string }>;
    conflicts: RollbackConflict[];
  }> {
    const conflicts: RollbackConflict[] = [];
    for (const target of targets) {
      const abs = await resolveInsideRoot(this.root, target.path);
      let currentHash: string | null = null;
      try {
        currentHash = sha(await fs.readFile(abs));
      } catch {
        currentHash = null;
      }
      if (currentHash === target.toHash) continue; // already at the boundary
      if (currentHash !== target.expectedCurrentHash) {
        conflicts.push({
          path: target.path,
          reason:
            currentHash === null
              ? 'The file was deleted outside this turn after the turn changed it.'
              : 'The file was modified outside this turn after the turn changed it.',
          currentHash,
          expectedHash: target.expectedCurrentHash,
        });
      }
    }
    if (conflicts.length > 0 && !options.force) {
      return { ok: false, restored: [], verified: [], conflicts };
    }

    const restored: string[] = [];
    const verified: Array<{ path: string; ok: boolean; detail?: string }> = [];
    for (const target of targets) {
      const abs = await resolveInsideRoot(this.root, target.path);
      try {
        let currentHash: string | null = null;
        try {
          currentHash = sha(await fs.readFile(abs));
        } catch {
          currentHash = null;
        }
        if (currentHash === target.toHash) {
          verified.push({ path: target.path, ok: true });
          continue;
        }
        if (target.toHash === null) {
          await fs.rm(abs, { force: true });
          restored.push(target.path);
          const stillThere = await fs.access(abs).then(
            () => true,
            () => false,
          );
          verified.push({
            path: target.path,
            ok: !stillThere,
            ...(stillThere ? { detail: 'file still exists' } : {}),
          });
        } else {
          const bytes = await this.blobs.get(target.toHash);
          if (!bytes) {
            verified.push({ path: target.path, ok: false, detail: 'turn-boundary blob missing' });
            continue;
          }
          await this.writeBytes(target.path, bytes, null);
          restored.push(target.path);
          const roundTrip = await fs.readFile(abs);
          verified.push({
            path: target.path,
            ok: sha(roundTrip) === target.toHash,
            ...(sha(roundTrip) !== target.toHash ? { detail: 'content mismatch' } : {}),
          });
        }
        if (this.documents.isOpen(target.path)) {
          await this.documents.handleExternalChange(target.path);
        }
      } catch (e) {
        verified.push({ path: target.path, ok: false, detail: errorMessage(e) });
      }
    }
    return { ok: verified.every((v) => v.ok), restored, verified, conflicts };
  }

  /** CHG-008: reverse-apply exactly one hunk of a file's net diff. Fails closed on staleness. */
  async rejectHunk(
    taskId: string,
    toolCallId: string | null,
    input: { path: string; hunkKey: string; expectedCurrentHash: string },
  ): Promise<{ afterHash: string }> {
    const current = await this.documents.readLogical(input.path).catch(() => null);
    if (!current) {
      throw chgError('CHG_TARGET_MISSING', 'The file under review no longer exists.', {
        path: input.path,
      });
    }
    if (current.binary) {
      throw chgError('CHG_BINARY', 'Binary files cannot be reviewed per hunk.', {
        path: input.path,
      });
    }
    if (current.hash !== input.expectedCurrentHash) {
      throw chgError(
        'CHG_REVIEW_STALE',
        'The file changed since the review was rendered. Nothing was overwritten — refresh the review.',
        { path: input.path },
        true,
      );
    }
    const baseline = this.repo.getBaseline(taskId, input.path);
    if (!baseline) {
      throw chgError('CHG_NO_BASELINE', 'This file was not changed by the task.', {
        path: input.path,
      });
    }
    const baselineBytes = baseline.blobHash ? await this.blobs.get(baseline.blobHash) : null;
    const baselineText =
      baseline.existed && baselineBytes ? stripBom(baselineBytes.toString('utf8')) : '';
    const diff = createTwoFilesPatch(input.path, input.path, baselineText, current.content, '', '');
    const hunk = parseHunks(diff).find((h) => h.key === input.hunkKey);
    if (!hunk) {
      throw chgError(
        'CHG_REVIEW_STALE',
        'That change block no longer exists in the current diff. Refresh the review.',
        { path: input.path, hunkKey: input.hunkKey },
        true,
      );
    }
    const next = applyUnifiedPatch(current.content, reverseHunkPatchText(input.path, hunk));
    if (next === false) {
      throw chgError(
        'CHG_REVIEW_STALE',
        'The change block could not be undone cleanly against the current content.',
        { path: input.path, hunkKey: input.hunkKey },
        true,
      );
    }
    return this.writeFileDirect(taskId, toolCallId, {
      path: input.path,
      content: Buffer.from(next, 'utf8'),
      author: 'user',
    });
  }

  /** Restore one file to its task baseline (file-level review reject). */
  async revertFile(
    taskId: string,
    toolCallId: string | null,
    input: { path: string; expectedCurrentHash?: string },
  ): Promise<{ kind: 'restored' | 'removed' | 'noop' }> {
    const baseline = this.repo.getBaseline(taskId, input.path);
    if (!baseline) {
      throw chgError('CHG_NO_BASELINE', 'This file was not changed by the task.', {
        path: input.path,
      });
    }
    const abs = await resolveInsideRoot(this.root, input.path);
    const logical = await this.documents.readLogical(input.path).catch(() => null);
    if (input.expectedCurrentHash !== undefined && logical?.hash !== input.expectedCurrentHash) {
      throw chgError(
        'CHG_REVIEW_STALE',
        'The file changed since the review was rendered. Nothing was overwritten — refresh the review.',
        { path: input.path },
        true,
      );
    }

    if (baseline.existed) {
      const bytes = await this.blobs.get(baseline.blobHash!);
      if (!bytes) {
        throw chgError('CHG_BLOB_MISSING', 'The baseline snapshot is missing for this file.', {
          path: input.path,
        });
      }
      let beforeHash: string | null = null;
      try {
        beforeHash = sha(await fs.readFile(abs));
      } catch {
        beforeHash = null;
      }
      if (beforeHash === baseline.blobHash) return { kind: 'noop' };
      await this.writeBytes(input.path, bytes, baseline.mode);
      if (this.documents.isOpen(input.path)) {
        await this.documents.handleExternalChange(input.path);
      }
      this.repo.recordChange({
        id: newId('chg'),
        taskId,
        toolCallId,
        relativePath: input.path,
        kind: beforeHash === null ? 'created' : 'modified',
        beforeHash,
        afterHash: baseline.blobHash,
        patch: null,
        renameTo: null,
        author: 'user',
        createdAt: new Date().toISOString(),
      });
      return { kind: 'restored' };
    }

    // Baseline did not exist: reverting means removing what the task created.
    let existingBytes: Buffer | null = null;
    try {
      existingBytes = await fs.readFile(abs);
    } catch {
      existingBytes = null;
    }
    if (existingBytes !== null) {
      await this.blobs.put(existingBytes); // keep a recovery snapshot
      await fs.rm(abs);
      if (this.documents.isOpen(input.path)) {
        await this.documents.handleExternalChange(input.path);
      }
      this.repo.recordChange({
        id: newId('chg'),
        taskId,
        toolCallId,
        relativePath: input.path,
        kind: 'deleted',
        beforeHash: sha(existingBytes),
        afterHash: null,
        patch: null,
        renameTo: null,
        author: 'user',
        createdAt: new Date().toISOString(),
      });
    }
    return { kind: 'removed' };
  }
}

function countDiff(unified: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of unified.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export { structuredPatch };
