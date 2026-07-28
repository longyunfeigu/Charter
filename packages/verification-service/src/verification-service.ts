import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { newId, redactText } from '@pi-ide/foundation';
import { resolveInsideRoot } from '@pi-ide/workspace-service';
import { runCommand } from '@pi-ide/tool-gateway';
import type { BlobStore } from '@pi-ide/change-service';

export interface VerificationCommand {
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export type VerificationState = 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled';

export interface VerificationRunRecord {
  id: string;
  taskId: string;
  label: string;
  command: VerificationCommand;
  codeRevision: string | null;
  state: VerificationState;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  stale: boolean;
  supersededBy: string | null;
  outputRef: string | null;
  outputExcerpt: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface VerificationRepo {
  insert(run: VerificationRunRecord): void;
  update(run: VerificationRunRecord): void;
  listForTask(taskId: string): VerificationRunRecord[];
  markSuperseded(taskId: string, label: string, byRunId: string): void;
  markStale(taskId: string, currentRevision: string): void;
  markAllStale(taskId: string): void;
}

const EXCERPT_LIMIT = 2000;
const SUGGESTED_SCRIPTS = ['test', 'lint', 'typecheck', 'check', 'build'];

export interface VerificationServiceOptions {
  root: string;
  repo: VerificationRepo;
  blobs: BlobStore;
  /** SIGTERM→SIGKILL grace; tests shrink it. */
  graceMs?: number;
}

/**
 * Runs and records verification commands (VER-001..008): every run keeps its
 * exit code, timing and output; re-runs supersede (never overwrite) earlier
 * records; code changes mark old results stale.
 */
export class VerificationService {
  private readonly root: string;
  private readonly repo: VerificationRepo;
  private readonly blobs: BlobStore;
  private readonly graceMs: number | undefined;

  constructor(options: VerificationServiceOptions) {
    this.root = options.root;
    this.repo = options.repo;
    this.blobs = options.blobs;
    this.graceMs = options.graceMs;
  }

  /** VER-002: suggest verification commands from project metadata (shown, never auto-run). */
  async detectSuggestions(): Promise<VerificationCommand[]> {
    const suggestions: VerificationCommand[] = [];
    try {
      const raw = await fs.readFile(join(this.root, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
      for (const name of SUGGESTED_SCRIPTS) {
        if (pkg.scripts?.[name]) {
          suggestions.push({
            label: name === 'test' ? 'npm test' : `npm run ${name}`,
            executable: 'npm',
            args: name === 'test' ? ['test'] : ['run', name],
            cwd: '',
            timeoutMs: 300_000,
          });
        }
      }
    } catch {
      // no package.json — nothing to suggest (python detection can extend here)
    }
    return suggestions;
  }

  listForTask(taskId: string): VerificationRunRecord[] {
    return this.repo.listForTask(taskId);
  }

  /** VER-008: results recorded against an older code revision become stale. */
  markStale(taskId: string, currentRevision: string): void {
    this.repo.markStale(taskId, currentRevision);
  }

  /** A rollback invalidates evidence for the pre-rollback workspace, even if a revision repeats. */
  markAllStale(taskId: string): void {
    this.repo.markAllStale(taskId);
  }

  async run(input: {
    taskId: string;
    command: VerificationCommand;
    codeRevision: string | null;
    signal?: AbortSignal;
  }): Promise<VerificationRunRecord> {
    const startedAt = new Date().toISOString();
    const record: VerificationRunRecord = {
      id: newId('ver'),
      taskId: input.taskId,
      label: input.command.label,
      command: input.command,
      codeRevision: input.codeRevision,
      state: 'running',
      exitCode: null,
      timedOut: false,
      cancelled: false,
      stale: false,
      supersededBy: null,
      outputRef: null,
      outputExcerpt: '',
      startedAt,
      endedAt: null,
      createdAt: startedAt,
    };
    this.repo.insert(record);

    try {
      const cwdAbs = await resolveInsideRoot(this.root, input.command.cwd || '.');
      const result = await runCommand(
        {
          executable: input.command.executable,
          args: input.command.args,
          cwd: cwdAbs,
          timeoutMs: input.command.timeoutMs,
          ...(this.graceMs !== undefined ? { graceMs: this.graceMs } : {}),
        },
        input.signal ?? new AbortController().signal,
      );
      const output = redactText(`${result.stdout}\n${result.stderr}`.trim());
      const { hash } = await this.blobs.put(Buffer.from(output, 'utf8'));
      record.outputRef = hash;
      record.outputExcerpt = output.slice(0, EXCERPT_LIMIT);
      record.exitCode = result.exitCode;
      record.timedOut = result.timedOut;
      record.cancelled = result.cancelled;
      record.state = result.cancelled
        ? 'cancelled'
        : result.timedOut
          ? 'timeout'
          : result.exitCode === 0
            ? 'passed'
            : 'failed';
    } catch (e) {
      record.state = input.signal?.aborted ? 'cancelled' : 'failed';
      record.cancelled = input.signal?.aborted ?? false;
      record.outputExcerpt = e instanceof Error ? e.message.slice(0, EXCERPT_LIMIT) : String(e);
    }
    record.endedAt = new Date().toISOString();
    this.repo.update(record);
    // VER-005: earlier runs with the same label are superseded, never deleted.
    this.repo.markSuperseded(input.taskId, input.command.label, record.id);
    return record;
  }
}

/** In-memory repo for tests. */
export interface MemoryVerificationRepo extends VerificationRepo {
  rows: VerificationRunRecord[];
}

export function createMemoryVerificationRepo(): MemoryVerificationRepo {
  const rows: VerificationRunRecord[] = [];
  return {
    rows,
    insert: (run) => {
      rows.push({ ...run });
    },
    update: (run) => {
      const index = rows.findIndex((r) => r.id === run.id);
      if (index >= 0) rows[index] = { ...run };
    },
    listForTask: (taskId) => rows.filter((r) => r.taskId === taskId).map((r) => ({ ...r })),
    markSuperseded: (taskId, label, byRunId) => {
      for (const row of rows) {
        if (row.taskId === taskId && row.label === label && row.id !== byRunId) {
          row.supersededBy = row.supersededBy ?? byRunId;
        }
      }
    },
    markStale: (taskId, currentRevision) => {
      for (const row of rows) {
        if (
          row.taskId === taskId &&
          row.codeRevision !== null &&
          row.codeRevision !== currentRevision
        ) {
          row.stale = true;
        }
      }
    },
    markAllStale: (taskId) => {
      for (const row of rows) {
        if (row.taskId === taskId) row.stale = true;
      }
    },
  };
}
