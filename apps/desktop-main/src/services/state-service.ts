import { openDatabase, MIGRATIONS, type SqlDatabase } from '@pi-ide/persistence';
import {
  LayoutStateSchema,
  type LayoutState,
  type RecentWorkspaceDto,
} from '@pi-ide/ipc-contracts';
import { errorMessage, newId, type Logger, type ProductError } from '@pi-ide/foundation';
import { existsSync } from 'node:fs';

const APP_SCOPE = '__app__';

/** Main-process durable state: layout, recent workspaces, local error records. */
export class StateService {
  readonly db: SqlDatabase;
  readonly appliedMigrations: number[];

  constructor(
    dbFile: string,
    backupDir: string,
    private readonly logger: Logger,
  ) {
    const result = openDatabase({ file: dbFile, backupDir, migrations: MIGRATIONS });
    this.db = result.db;
    this.appliedMigrations = result.appliedVersions;
    if (result.appliedVersions.length > 0) {
      logger.info('database migrated', { versions: result.appliedVersions });
    }
  }

  getLayout(scopeId: string | null): LayoutState | null {
    const row = this.db
      .prepare('SELECT layout_json FROM ui_workspace_state WHERE workspace_id = ?')
      .get(scopeId ?? APP_SCOPE) as { layout_json: string | null } | undefined;
    if (!row?.layout_json) return null;
    try {
      const parsed = LayoutStateSchema.safeParse(JSON.parse(row.layout_json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  saveLayout(scopeId: string | null, layout: LayoutState): void {
    this.db
      .prepare(
        `INSERT INTO ui_workspace_state (workspace_id, layout_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET layout_json = excluded.layout_json, updated_at = excluded.updated_at`,
      )
      .run(scopeId ?? APP_SCOPE, JSON.stringify(layout), new Date().toISOString());
  }

  getOpenTabs(scopeId: string): unknown | null {
    const row = this.db
      .prepare('SELECT open_tabs_json FROM ui_workspace_state WHERE workspace_id = ?')
      .get(scopeId) as { open_tabs_json: string | null } | undefined;
    if (!row?.open_tabs_json) return null;
    try {
      return JSON.parse(row.open_tabs_json);
    } catch {
      return null;
    }
  }

  saveOpenTabs(scopeId: string, tabs: unknown): void {
    this.db
      .prepare(
        `INSERT INTO ui_workspace_state (workspace_id, open_tabs_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET open_tabs_json = excluded.open_tabs_json, updated_at = excluded.updated_at`,
      )
      .run(scopeId, JSON.stringify(tabs), new Date().toISOString());
  }

  recentWorkspaces(): RecentWorkspaceDto[] {
    const rows = this.db
      .prepare(
        'SELECT canonical_path, display_name, last_opened_at, pinned FROM workspaces ORDER BY pinned DESC, last_opened_at DESC LIMIT 20',
      )
      .all() as Array<{
      canonical_path: string;
      display_name: string;
      last_opened_at: string;
      pinned: number;
    }>;
    return rows.map((r) => ({
      path: r.canonical_path,
      displayName: r.display_name,
      lastOpenedAt: r.last_opened_at,
      pinned: r.pinned === 1,
      exists: existsSync(r.canonical_path),
      kind: null, // project-type badge is detected at the IPC layer (cheap fs checks)
    }));
  }

  /**
   * ADR-0034: forget a project. Deletes the workspace row and every recorded
   * Session (tasks + their event/tool/change/verification records) in one
   * transaction. Never touches files on disk. Content-addressed blobs stay
   * (they are shared and already have no delete path — see BlobStore).
   *
   * A project with a running session is never removed — the caller shows the
   * refusal; a crash-orphaned "running" row is repaired at startup
   * (system.interruptedByRestart), so this can not wedge permanently.
   */
  removeWorkspace(
    canonicalPath: string,
  ):
    | { status: 'removed'; removedSessions: number }
    | { status: 'missing' }
    | { status: 'running'; running: number } {
    const ws = this.db
      .prepare('SELECT id FROM workspaces WHERE canonical_path = ?')
      .get(canonicalPath) as { id: string } | undefined;
    if (!ws) return { status: 'missing' };

    const running = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
         WHERE workspace_id = ?
           AND (state IN ('EXPLORING','PLANNING','IN_PROGRESS','AWAITING_USER','AWAITING_PERMISSION','VERIFYING')
                OR json_extract(external_json, '$.status') = 'active')`,
      )
      .get(ws.id) as { n: number };
    if (running.n > 0) return { status: 'running', running: running.n };

    return this.db.transaction(() => {
      const removedSessions = (
        this.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?').get(ws.id) as {
          n: number;
        }
      ).n;
      const inTasks = '(SELECT id FROM tasks WHERE workspace_id = ?)';
      const taskScoped = [
        `DELETE FROM permission_decisions WHERE task_id IN ${inTasks}`,
        `DELETE FROM permission_requests WHERE task_id IN ${inTasks}`,
        `DELETE FROM file_changes WHERE task_id IN ${inTasks}`,
        `DELETE FROM file_baselines WHERE task_id IN ${inTasks}`,
        `DELETE FROM verification_runs WHERE task_id IN ${inTasks}`,
        `DELETE FROM tool_calls WHERE task_id IN ${inTasks}`,
        `DELETE FROM agent_runs WHERE task_id IN ${inTasks}`,
        `DELETE FROM agent_sessions WHERE task_id IN ${inTasks}`,
        `DELETE FROM task_events WHERE task_id IN ${inTasks}`,
        // Both directions: rows owned by removed tasks AND rows in other
        // projects that referenced these tasks as a source. The NOT NULL
        // source_task_id foreign key leaves no way to keep the snapshot
        // once its source row is gone.
        `DELETE FROM task_conversation_references WHERE task_id IN ${inTasks} OR source_task_id IN ${inTasks}`,
        `DELETE FROM memory_rule_injections WHERE task_id IN ${inTasks}`,
      ];
      for (const sql of taskScoped) {
        const params = sql.split(inTasks).length - 1;
        this.db.prepare(sql).run(...Array<string>(params).fill(ws.id));
      }
      const workspaceScoped = [
        'permission_decisions',
        'memory_candidates',
        'memory_rule_stats',
        'memory_rule_injections',
        'memory_sync_state',
        'ui_workspace_state',
      ];
      for (const table of workspaceScoped) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(ws.id);
      }
      this.db.prepare('DELETE FROM tasks WHERE workspace_id = ?').run(ws.id);
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
      return { status: 'removed' as const, removedSessions };
    });
  }

  recordError(component: string, error: ProductError): void {
    try {
      this.db
        .prepare(
          'INSERT INTO app_errors (id, component, code, severity, sanitized_context, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          newId('err'),
          component,
          error.code,
          error.severity,
          JSON.stringify({ userMessage: error.userMessage }),
          new Date().toISOString(),
        );
    } catch (e) {
      this.logger.warn('failed to record error', { e: errorMessage(e) });
    }
  }

  recentErrors(
    limit = 50,
  ): Array<{ code: string; component: string; severity: string; at: string }> {
    const rows = this.db
      .prepare(
        'SELECT code, component, severity, created_at FROM app_errors ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as Array<{
      code: string;
      component: string;
      severity: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      code: r.code,
      component: r.component,
      severity: r.severity,
      at: r.created_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
