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
