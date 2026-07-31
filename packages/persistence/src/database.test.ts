import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductFailure } from '@pi-ide/foundation';
import { openDatabase, type Migration } from './database.js';
import { MIGRATIONS } from './migrations.js';

const M1: Migration = {
  version: 1,
  name: 'initial',
  up: 'CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL);',
};
const M2: Migration = {
  version: 2,
  name: 'add-count',
  up: 'ALTER TABLE items ADD COLUMN count INTEGER NOT NULL DEFAULT 0;',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-ide-db-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function open(migrations: Migration[]) {
  return openDatabase({
    file: join(dir, 'app.db'),
    backupDir: join(dir, 'backups'),
    migrations,
  });
}

describe('persistence database', () => {
  it('applies migrations on a fresh database and records checksums', () => {
    const { db, appliedVersions } = open([M1]);
    expect(appliedVersions).toEqual([1]);
    const rows = db
      .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number; checksum: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    db.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('a', 'hello');
    db.close();
  });

  it('is idempotent across reopen and applies only pending migrations with a backup', () => {
    const first = open([M1]);
    first.db.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('a', 'hello');
    first.db.close();

    const second = open([M1, M2]);
    expect(second.appliedVersions).toEqual([2]);
    const row = second.db.prepare('SELECT value, count FROM items WHERE id = ?').get('a') as {
      value: string;
      count: number;
    };
    expect(row).toEqual({ value: 'hello', count: 0 });
    second.db.close();
    // upgrade of an existing db must leave a pre-migration backup behind
    expect(existsSync(join(dir, 'backups'))).toBe(true);
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThan(0);
  });

  it('rejects when an applied migration text was tampered with', () => {
    open([M1]).db.close();
    const tampered: Migration = { ...M1, up: M1.up + ' -- changed' };
    expect(() => open([tampered])).toThrowError(ProductFailure);
    try {
      open([tampered]);
    } catch (e) {
      expect((e as ProductFailure).error.code).toBe('DB_MIGRATION_CHECKSUM');
    }
  });

  it('E2E-023 fault injection: restores the byte-identical pre-migration database', () => {
    const first = open([M1]);
    first.db.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('a', 'hello');
    first.db.close();
    const before = readFileSync(join(dir, 'app.db'));

    const broken: Migration = { version: 2, name: 'broken', up: 'THIS IS NOT SQL;' };
    expect(() => open([M1, broken])).toThrowError(ProductFailure);
    expect(readFileSync(join(dir, 'app.db'))).toEqual(before);

    // Database must still be usable at version 1 with data intact.
    const reopened = open([M1]);
    const row = reopened.db.prepare('SELECT value FROM items WHERE id = ?').get('a') as {
      value: string;
    };
    expect(row.value).toBe('hello');
    reopened.db.close();
  });

  it('transactions roll back on error', () => {
    const { db } = open([M1]);
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('x', '1');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const rows = db.prepare('SELECT * FROM items').all();
    expect(rows).toHaveLength(0);
    // and the connection is still usable afterwards
    db.transaction(() => {
      db.prepare('INSERT INTO items (id, value) VALUES (?, ?)').run('y', '2');
    });
    expect(db.prepare('SELECT * FROM items').all()).toHaveLength(1);
    db.close();
  });

  it('uses WAL journaling', () => {
    const { db } = open([M1]);
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    db.close();
  });

  it('upgrades an existing v3 database with conversation refs and project memory', () => {
    const before = open(MIGRATIONS.slice(0, 3));
    before.db.close();

    const upgraded = open(MIGRATIONS);
    expect(upgraded.appliedVersions).toEqual([4, 5, 6, 7, 8, 9, 10]);
    const names = (
      upgraded.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task_conversation_references', 'memory_candidates', 'memory_rule_stats', 'memory_rule_injections', 'memory_sync_state') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(names).toEqual([
      'memory_candidates',
      'memory_rule_injections',
      'memory_rule_stats',
      'memory_sync_state',
      'task_conversation_references',
    ]);
    upgraded.db.close();
  });

  it('v6 migrates settled tasks into conversations (ADR-0032)', () => {
    const before = open(MIGRATIONS.slice(0, 5));
    const now = new Date().toISOString();
    const insertTask = before.db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at, archived, worktree_json) VALUES (?, 'ws', ?, '', 'edit', ?, '{}', ?, ?, 0, ?)",
    );
    before.db
      .prepare(
        "INSERT INTO workspaces (id, canonical_path, display_name, last_opened_at, created_at) VALUES ('ws', '/tmp/x', 'x', ?, ?)",
      )
      .run(now, now);
    insertTask.run('t-accepted', 'plain accepted', 'ACCEPTED', now, now, null);
    insertTask.run('t-rolled', 'plain rolled back', 'ROLLED_BACK', now, now, null);
    insertTask.run(
      't-wt',
      'worktree accepted',
      'ACCEPTED',
      now,
      now,
      JSON.stringify({ path: '/tmp/wt', branch: 'b', baseHead: null, baseBranch: null }),
    );
    insertTask.run('t-review', 'still in review', 'REVIEW_READY', now, now, null);
    const insertRun = before.db.prepare(
      "INSERT INTO agent_runs (id, task_id, state, started_at, ended_at) VALUES (?, ?, 'DONE', ?, ?)",
    );
    insertRun.run('r-a1', 't-accepted', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z');
    insertRun.run('r-a2', 't-accepted', '2026-07-01T00:02:00Z', '2026-07-01T00:03:00Z');
    insertRun.run('r-rev', 't-review', '2026-07-01T00:00:00Z', '2026-07-01T00:01:00Z');
    before.db.close();

    const upgraded = open(MIGRATIONS);
    const task = (id: string) =>
      upgraded.db.prepare('SELECT state, archived FROM tasks WHERE id = ?').get(id) as {
        state: string;
        archived: number;
      };
    // Plain settled tasks become live IDLE conversations.
    expect(task('t-accepted')).toEqual({ state: 'IDLE', archived: 0 });
    expect(task('t-rolled')).toEqual({ state: 'IDLE', archived: 0 });
    // Worktree tasks lost their tree on accept: archived read-only, state kept.
    expect(task('t-wt')).toEqual({ state: 'ACCEPTED', archived: 1 });
    // Unsettled work is untouched.
    expect(task('t-review')).toEqual({ state: 'REVIEW_READY', archived: 0 });
    // Only the LAST run of a settled task inherits the settlement.
    const run = (id: string) =>
      (
        upgraded.db.prepare('SELECT review_state FROM agent_runs WHERE id = ?').get(id) as {
          review_state: string | null;
        }
      ).review_state;
    expect(run('r-a1')).toBeNull();
    expect(run('r-a2')).toBe('accepted');
    expect(run('r-rev')).toBeNull();
    upgraded.db.close();
  });

  it('v7 repairs legacy external_json.status values that poisoned task.list', () => {
    const before = open(MIGRATIONS.slice(0, 6));
    const now = new Date().toISOString();
    before.db
      .prepare(
        "INSERT INTO workspaces (id, canonical_path, display_name, last_opened_at, created_at) VALUES ('ws', '/tmp/x', 'x', ?, ?)",
      )
      .run(now, now);
    const insertTask = before.db.prepare(
      "INSERT INTO tasks (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at, external_json) VALUES (?, 'ws', 't', '', 'edit', 'IDLE', '{}', ?, ?, ?)",
    );
    insertTask.run('t-legacy', now, now, JSON.stringify({ cli: 'claude', status: 'interrupted' }));
    insertTask.run('t-live', now, now, JSON.stringify({ cli: 'claude', status: 'active' }));
    insertTask.run('t-done', now, now, JSON.stringify({ cli: 'claude', status: 'ended' }));
    insertTask.run('t-managed', now, now, null);
    before.db.close();

    const upgraded = open(MIGRATIONS);
    expect(upgraded.appliedVersions).toEqual([7, 8, 9, 10]);
    const status = (id: string) =>
      (
        upgraded.db
          .prepare("SELECT json_extract(external_json, '$.status') AS s FROM tasks WHERE id = ?")
          .get(id) as { s: string | null }
      ).s;
    expect(status('t-legacy')).toBe('ended'); // repaired
    expect(status('t-live')).toBe('active'); // untouched
    expect(status('t-done')).toBe('ended'); // untouched
    expect(status('t-managed')).toBeNull(); // no external payload
    upgraded.db.close();
  });

  it('v9-v10 add normalized Missions, runtime sessions, events, and delivery state', () => {
    const before = open(MIGRATIONS.slice(0, 8));
    before.db.close();
    const upgraded = open(MIGRATIONS);
    expect(upgraded.appliedVersions).toEqual([9, 10]);
    const names = (
      upgraded.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
           ('missions','mission_tasks','mission_task_dependencies','orchestration_principals',
            'assignments','execution_attempts','orchestration_messages','mission_events',
            'orchestration_outbox','assignment_artifacts','orchestration_runtime_sessions',
            'orchestration_runtime_events','orchestration_message_deliveries') ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(names).toEqual([
      'assignment_artifacts',
      'assignments',
      'execution_attempts',
      'mission_events',
      'mission_task_dependencies',
      'mission_tasks',
      'missions',
      'orchestration_message_deliveries',
      'orchestration_messages',
      'orchestration_outbox',
      'orchestration_principals',
      'orchestration_runtime_events',
      'orchestration_runtime_sessions',
    ]);
    upgraded.db.close();
  });
});
