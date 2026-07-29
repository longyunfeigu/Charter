import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@pi-ide/foundation';
import { StateService } from './state-service.js';

let dir: string;
let state: StateService;

const NOW = new Date().toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-ide-state-'));
  state = new StateService(
    join(dir, 'app.db'),
    join(dir, 'backups'),
    createLogger('test', { write: () => undefined }),
  );
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedWorkspace(id: string, path: string): void {
  state.db
    .prepare(
      'INSERT INTO workspaces (id, canonical_path, display_name, last_opened_at, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, path, path.split('/').pop() ?? path, NOW, NOW);
}

function seedTask(id: string, workspaceId: string, taskState = 'IDLE', external?: object): void {
  state.db
    .prepare(
      "INSERT INTO tasks (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at, external_json) VALUES (?, ?, 't', '', 'edit', ?, '{}', ?, ?, ?)",
    )
    .run(id, workspaceId, taskState, NOW, NOW, external ? JSON.stringify(external) : null);
}

function count(table: string): number {
  return (state.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('StateService.removeWorkspace (ADR-0034)', () => {
  it('removes the workspace with every recorded session and its evidence', () => {
    seedWorkspace('ws1', '/tmp/gone');
    seedWorkspace('ws2', '/tmp/stays');
    seedTask('t1', 'ws1');
    seedTask('t2', 'ws1');
    seedTask('t3', 'ws2');
    state.db
      .prepare(
        "INSERT INTO task_events (id, task_id, sequence, type, payload_json, created_at) VALUES ('e1', 't1', 1, 'agent.message', '{}', ?)",
      )
      .run(NOW);
    state.db
      .prepare(
        "INSERT INTO file_changes (id, task_id, relative_path, kind, created_at) VALUES ('c1', 't1', 'a.py', 'create', ?)",
      )
      .run(NOW);
    state.db
      .prepare(
        "INSERT INTO task_events (id, task_id, sequence, type, payload_json, created_at) VALUES ('e2', 't3', 1, 'agent.message', '{}', ?)",
      )
      .run(NOW);

    const result = state.removeWorkspace('/tmp/gone');
    expect(result).toEqual({ status: 'removed', removedSessions: 2 });
    expect(count('workspaces')).toBe(1);
    expect(count('tasks')).toBe(1);
    // Evidence for the removed project is gone; the other project's stays.
    expect(count('task_events')).toBe(1);
    expect(count('file_changes')).toBe(0);
    expect(state.recentWorkspaces().map((w) => w.path)).toEqual(['/tmp/stays']);
  });

  it('drops conversation references in both directions (FK forbids dangling sources)', () => {
    seedWorkspace('ws1', '/tmp/gone');
    seedWorkspace('ws2', '/tmp/stays');
    seedTask('t1', 'ws1');
    seedTask('t3', 'ws2');
    // t3 (staying) references t1 (going) as its source. source_task_id is a
    // NOT NULL foreign key, so the reference row must go with the source.
    state.db
      .prepare(
        "INSERT INTO task_conversation_references (task_id, position, source_task_id, source_title, source_project_name, source_project_path, turns_json, captured_at) VALUES ('t3', 0, 't1', 's', 'p', '/tmp/gone', '[]', ?)",
      )
      .run(NOW);

    expect(state.removeWorkspace('/tmp/gone')).toEqual({ status: 'removed', removedSessions: 1 });
    expect(count('task_conversation_references')).toBe(0);
    expect(count('tasks')).toBe(1); // t3 itself stays
  });

  it('refuses while a session is running or an external CLI session is live', () => {
    seedWorkspace('ws1', '/tmp/busy');
    seedTask('t1', 'ws1', 'IN_PROGRESS');
    expect(state.removeWorkspace('/tmp/busy')).toEqual({ status: 'running', running: 1 });

    seedWorkspace('ws2', '/tmp/cli');
    seedTask('t2', 'ws2', 'IDLE', { cli: 'claude', status: 'active' });
    expect(state.removeWorkspace('/tmp/cli')).toEqual({ status: 'running', running: 1 });

    // Nothing was deleted by refused attempts.
    expect(count('workspaces')).toBe(2);
    expect(count('tasks')).toBe(2);
  });

  it('reports a path it has never seen', () => {
    expect(state.removeWorkspace('/tmp/never-opened')).toEqual({ status: 'missing' });
  });
});

describe('StateService update backup', () => {
  it('creates a consistent SQLite snapshot before installing a new app version', async () => {
    seedWorkspace('ws1', '/tmp/preserved');
    const file = await state.backupForUpdate('1.1.0-beta.1');

    expect(file).toContain('charter.before-1.1.0-beta.1');
    expect(existsSync(file)).toBe(true);
  });
});
