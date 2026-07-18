import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from '@pi-ide/foundation';
import type { SqlDatabase } from '@pi-ide/persistence';
import type { AppPaths } from '../app-paths.js';

/**
 * Local-data transparency and deletion (PRIV-001..003, M11-07). Everything here
 * is on-device: no upload transport exists in this build. `crashPreview` proves
 * the redaction on real state; `clearHistory` removes task history + caches
 * while keeping settings, provider keys and workspace registration.
 */

/** Logs roll off after this many days (must match the FileLogSink policy). */
export const LOG_RETENTION_DAYS = 30;

/** Whether this build has a telemetry/crash-report upload transport (none yet). */
export const TELEMETRY_TRANSPORT_AVAILABLE = false;

function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      try {
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) total += statSync(full).size;
      } catch {
        // races/permission — skip
      }
    }
  };
  walk(dir);
  return total;
}

function fileSize(file: string): number {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
}

/** All per-workspace attachment directories under userData/workspaces/<id>/attachments. */
function attachmentDirs(paths: AppPaths): string[] {
  const base = join(paths.userData, 'workspaces');
  if (!existsSync(base)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const att = join(base, entry.name, 'attachments');
    if (existsSync(att)) dirs.push(att);
  }
  return dirs;
}

export interface DataSummary {
  dataDir: string;
  totalBytes: number;
  history: number;
  attachments: number;
  logs: number;
  logRetentionDays: number;
  taskCount: number;
}

export function dataSummary(paths: AppPaths, db: SqlDatabase | null): DataSummary {
  const history = fileSize(paths.databaseFile);
  const attachments = attachmentDirs(paths).reduce((n, d) => n + dirSize(d), 0);
  const logs = dirSize(paths.logsDir) + dirSize(join(paths.userData, 'support'));
  let taskCount = 0;
  if (db) {
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n?: number } | undefined;
      taskCount = row?.n ?? 0;
    } catch {
      taskCount = 0;
    }
  }
  return {
    dataDir: paths.userData,
    totalBytes: history + attachments + logs,
    history,
    attachments,
    logs,
    logRetentionDays: LOG_RETENTION_DAYS,
    taskCount,
  };
}

/** A redacted crash-report sample built from real state (PRIV-002 preview). */
export function crashPreview(input: {
  appVersion: string;
  platform: string;
  arch: string;
  updateChannel: string;
  logsDir: string;
}): string {
  // A recent redacted log tail makes the preview honest rather than illustrative.
  let logTail = '';
  try {
    const files = readdirSync(input.logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort();
    const latest = files.at(-1);
    if (latest) {
      logTail = readFileSync(join(input.logsDir, latest), 'utf8').split('\n').slice(-6).join('\n');
    }
  } catch {
    logTail = '';
  }
  const sample = [
    `Charter ${input.appVersion} (${input.updateChannel}) · ${input.platform}/${input.arch}`,
    `Exception: (example) TypeError: Cannot read properties of null`,
    `  at <redacted:path>/renderer.js:214`,
    `recent log (redacted):`,
    logTail || '  (no recent log lines)',
  ].join('\n');
  return redactText(sample);
}

const HISTORY_TABLES_CHILD_FIRST = [
  'permission_decisions',
  'tool_calls',
  'agent_runs',
  'permission_requests',
  'verification_runs',
  'file_changes',
  'file_baselines',
  'task_conversation_references',
  'agent_sessions',
  'task_events',
  'tasks',
];

export interface ClearResult {
  clearedTasks: number;
  clearedBlobs: number;
  clearedAttachmentDirs: number;
  clearedLogFiles: number;
}

/**
 * Delete task history + caches. Keeps settings, provider keys, workspace
 * registration and UI layout. FKs reference tasks without CASCADE, so children
 * are deleted before parents inside one transaction.
 */
export function clearHistory(paths: AppPaths, db: SqlDatabase | null): ClearResult {
  let clearedTasks = 0;
  let clearedBlobs = 0;
  if (db) {
    const taskRow = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as
      { n?: number } | undefined;
    clearedTasks = taskRow?.n ?? 0;
    const blobRow = db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as
      { n?: number } | undefined;
    clearedBlobs = blobRow?.n ?? 0;
    db.transaction(() => {
      for (const table of HISTORY_TABLES_CHILD_FIRST) db.exec(`DELETE FROM ${table};`);
      db.exec('DELETE FROM blobs;');
      db.exec('DELETE FROM app_errors;');
    });
  }

  let clearedAttachmentDirs = 0;
  for (const dir of attachmentDirs(paths)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      clearedAttachmentDirs += 1;
    } catch {
      // best effort
    }
  }

  let clearedLogFiles = 0;
  for (const base of [paths.logsDir, join(paths.userData, 'support')]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      try {
        rmSync(join(base, name), { recursive: true, force: true });
        clearedLogFiles += 1;
      } catch {
        // best effort
      }
    }
  }

  return { clearedTasks, clearedBlobs, clearedAttachmentDirs, clearedLogFiles };
}
