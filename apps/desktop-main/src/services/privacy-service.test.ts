import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, MIGRATIONS } from '@pi-ide/persistence';
import { createAppPaths } from '../app-paths.js';
import { clearHistory, crashPreview, dataSummary } from './privacy-service.js';

function setup() {
  const userData = mkdtempSync(join(tmpdir(), 'priv-'));
  const paths = createAppPaths(userData);
  mkdirSync(paths.backupsDir, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  const { db } = openDatabase({
    file: paths.databaseFile,
    backupDir: paths.backupsDir,
    migrations: MIGRATIONS,
  });
  // A workspace + a task with a child event and a blob.
  const now = '2026-07-18T00:00:00.000Z';
  db.prepare(
    'INSERT INTO workspaces (id, canonical_path, display_name, trust_state, last_opened_at, created_at) VALUES (?,?,?,?,?,?)',
  ).run('ws1', '/tmp/proj', 'proj', 'trusted', now, now);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run('t1', 'ws1', 'Task', 'goal', 'edit', 'REVIEW_READY', '{}', now, now);
  db.prepare(
    'INSERT INTO task_events (id, task_id, sequence, type, payload_json, created_at) VALUES (?,?,?,?,?,?)',
  ).run('e1', 't1', 1, 'user.message', '{}', now);
  db.prepare('INSERT INTO blobs (hash, size, created_at) VALUES (?,?,?)').run('abc', 2, now);
  return { paths, db, userData };
}

describe('privacy-service (M11-07, PRIV-003)', () => {
  it('dataSummary reports the data location, task count and sizes', () => {
    const { paths, db } = setup();
    writeFileSync(join(paths.logsDir, 'app.log'), 'line one\nline two\n');
    const summary = dataSummary(paths, db);
    expect(summary.dataDir).toBe(paths.userData);
    expect(summary.taskCount).toBe(1);
    expect(summary.history).toBeGreaterThan(0); // db file has bytes
    expect(summary.logs).toBeGreaterThan(0);
    expect(summary.logRetentionDays).toBe(30);
    expect(summary.totalBytes).toBe(summary.history + summary.attachments + summary.logs);
  });

  it('clearHistory deletes task history + blobs + logs, keeps the workspace', () => {
    const { paths, db } = setup();
    writeFileSync(join(paths.logsDir, 'app.log'), 'log data\n');
    // an attachment dir under a workspace data dir
    const attDir = join(paths.userData, 'workspaces', 'ws1', 'attachments', 't1');
    mkdirSync(attDir, { recursive: true });
    writeFileSync(join(attDir, 'shot.png'), 'x');

    const result = clearHistory(paths, db);
    expect(result.clearedTasks).toBe(1);
    expect(result.clearedBlobs).toBe(1);
    expect(result.clearedAttachmentDirs).toBe(1);
    expect(result.clearedLogFiles).toBeGreaterThanOrEqual(1);

    // task-scoped tables are empty…
    expect((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n).toBe(0);
    // …but the workspace registration survives.
    expect((db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n).toBe(1);
    // attachment files are gone.
    expect(existsSync(attDir)).toBe(false);
    expect(readdirSync(paths.logsDir).length).toBe(0);
  });

  it('crashPreview redacts secrets from the sampled log tail', () => {
    const { paths } = setup();
    writeFileSync(
      join(paths.logsDir, 'app.log'),
      'starting up\nusing key sk-supersecretshouldnotleak0000\n',
    );
    const text = crashPreview({
      appVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      updateChannel: 'stable',
      logsDir: paths.logsDir,
    });
    expect(text).toContain('Charter 1.0.0');
    expect(text).not.toContain('sk-supersecretshouldnotleak0000');
    expect(text).toContain('[REDACTED');
  });
});
