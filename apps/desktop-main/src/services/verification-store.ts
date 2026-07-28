import type { SqlDatabase } from '@pi-ide/persistence';
import type {
  VerificationCommand,
  VerificationRepo,
  VerificationRunRecord,
} from '@pi-ide/verification-service';

interface Row {
  id: string;
  task_id: string;
  label: string;
  command_json: string;
  code_revision: string | null;
  state: string;
  exit_code: number | null;
  timed_out: number;
  cancelled: number;
  stale: number;
  superseded_by: string | null;
  output_ref: string | null;
  output_excerpt: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

function rowToRecord(row: Row): VerificationRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    label: row.label,
    command: JSON.parse(row.command_json) as VerificationCommand,
    codeRevision: row.code_revision,
    state: row.state as VerificationRunRecord['state'],
    exitCode: row.exit_code,
    timedOut: row.timed_out === 1,
    cancelled: row.cancelled === 1,
    stale: row.stale === 1,
    supersededBy: row.superseded_by,
    outputRef: row.output_ref,
    outputExcerpt: row.output_excerpt ?? '',
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
  };
}

/** VerificationRepo over the product SQLite database (verification_runs, §11.2). */
export class SqlVerificationRepo implements VerificationRepo {
  constructor(private readonly db: SqlDatabase) {}

  insert(run: VerificationRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO verification_runs (id, task_id, label, command_json, code_revision, state, exit_code, timed_out, cancelled, stale, superseded_by, output_ref, output_excerpt, started_at, ended_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.taskId,
        run.label,
        JSON.stringify(run.command),
        run.codeRevision,
        run.state,
        run.exitCode,
        run.timedOut ? 1 : 0,
        run.cancelled ? 1 : 0,
        run.stale ? 1 : 0,
        run.supersededBy,
        run.outputRef,
        run.outputExcerpt,
        run.startedAt,
        run.endedAt,
        run.createdAt,
      );
  }

  update(run: VerificationRunRecord): void {
    this.db
      .prepare(
        `UPDATE verification_runs SET state = ?, exit_code = ?, timed_out = ?, cancelled = ?, output_ref = ?, output_excerpt = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        run.state,
        run.exitCode,
        run.timedOut ? 1 : 0,
        run.cancelled ? 1 : 0,
        run.outputRef,
        run.outputExcerpt,
        run.endedAt,
        run.id,
      );
  }

  listForTask(taskId: string): VerificationRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_runs WHERE task_id = ? ORDER BY created_at, id')
      .all(taskId) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  markSuperseded(taskId: string, label: string, byRunId: string): void {
    this.db
      .prepare(
        'UPDATE verification_runs SET superseded_by = ? WHERE task_id = ? AND label = ? AND id != ? AND superseded_by IS NULL',
      )
      .run(byRunId, taskId, label, byRunId);
  }

  markStale(taskId: string, currentRevision: string): void {
    this.db
      .prepare(
        'UPDATE verification_runs SET stale = 1 WHERE task_id = ? AND code_revision IS NOT NULL AND code_revision != ? AND stale = 0',
      )
      .run(taskId, currentRevision);
  }

  markAllStale(taskId: string): void {
    this.db
      .prepare('UPDATE verification_runs SET stale = 1 WHERE task_id = ? AND stale = 0')
      .run(taskId);
  }
}
