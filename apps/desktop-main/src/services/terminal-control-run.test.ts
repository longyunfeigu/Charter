import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, type SqlDatabase } from '@pi-ide/persistence';
import {
  rehomeCrossTaskTerminalRunToolCalls,
  terminalControlRunId,
} from './terminal-control-run.js';

describe('terminal-control run ownership', () => {
  let dir: string;
  let db: SqlDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'charter-terminal-run-'));
    db = openDatabase({
      file: join(dir, 'state.sqlite'),
      migrations: MIGRATIONS,
      backupDir: join(dir, 'backups'),
    }).db;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces
       (id, canonical_path, display_name, last_opened_at, created_at)
       VALUES ('ws', ?, 'Repo', ?, ?)`,
    ).run(dir, now, now);
    for (const taskId of ['task-old', 'task-new']) {
      db.prepare(
        `INSERT INTO tasks
         (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at)
         VALUES (?, 'ws', ?, '', 'edit', 'REVIEW_READY', '{}', ?, ?)`,
      ).run(taskId, taskId, now, now);
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses a different durable audit run for each Session on one terminal', () => {
    expect(terminalControlRunId('task-old', 'term-1')).toBe('terminal:term-1:task:task-old');
    expect(terminalControlRunId('task-new', 'term-1')).not.toBe(
      terminalControlRunId('task-old', 'term-1'),
    );
  });

  it('repairs legacy cross-Session tool calls before their owning Session is deleted', () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_runs (id, task_id, state, provider, model, started_at)
       VALUES ('terminal:term-1', 'task-old', 'STREAMING', 'external', 'terminal-control', ?)`,
    ).run(now);
    for (const [id, taskId] of [
      ['call-old', 'task-old'],
      ['call-new', 'task-new'],
    ] as const) {
      db.prepare(
        `INSERT INTO tool_calls
         (id, run_id, task_id, name, state, input_json, created_at)
         VALUES (?, 'terminal:term-1', ?, 'orchestration.inspect', 'SUCCEEDED', '{}', ?)`,
      ).run(id, taskId, now);
    }

    expect(rehomeCrossTaskTerminalRunToolCalls(db, 'task-old')).toBe(1);
    expect(db.prepare("SELECT run_id FROM tool_calls WHERE id = 'call-new'").get()).toEqual({
      run_id: 'terminal:term-1:task:task-new',
    });
    expect(
      db.prepare("SELECT task_id FROM agent_runs WHERE id = 'terminal:term-1:task:task-new'").get(),
    ).toEqual({ task_id: 'task-new' });

    expect(() =>
      db.transaction(() => {
        db.prepare("DELETE FROM tool_calls WHERE task_id = 'task-old'").run();
        db.prepare("DELETE FROM agent_runs WHERE task_id = 'task-old'").run();
        db.prepare("DELETE FROM tasks WHERE id = 'task-old'").run();
      }),
    ).not.toThrow();
    expect(db.prepare("SELECT id FROM tool_calls WHERE id = 'call-new'").get()).toEqual({
      id: 'call-new',
    });
  });
});
