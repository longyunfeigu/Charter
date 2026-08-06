import type { SqlDatabase } from '@pi-ide/persistence';

/**
 * Tool-audit runs belong to a Session, not merely to its resident terminal.
 * A daemon terminal can host several successive/re-attached Sessions, so the
 * task id is part of the durable key even though Mission runtime identity stays
 * terminal-scoped.
 */
export function terminalControlRunId(taskId: string, terminalId: string): string {
  return `terminal:${terminalId}:task:${taskId}`;
}

function replacementRunId(runId: string, taskId: string): string {
  const taskMarker = runId.indexOf(':task:');
  const terminalRunId = taskMarker >= 0 ? runId.slice(0, taskMarker) : runId;
  return `${terminalRunId}:task:${taskId}`;
}

/**
 * Older builds keyed terminal-control runs only by terminal id. When the same
 * daemon PTY was re-attached as a new Session, its later tool calls could point
 * at a run owned by the earlier Session. Before deleting that owner, preserve
 * every foreign Session's audit rows by moving them to a task-owned clone.
 */
export function rehomeCrossTaskTerminalRunToolCalls(
  db: SqlDatabase,
  deletingTaskId: string,
): number {
  const shared = db
    .prepare(
      `SELECT DISTINCT agent_runs.id AS run_id, tool_calls.task_id AS task_id
       FROM agent_runs
       JOIN tool_calls ON tool_calls.run_id = agent_runs.id
       WHERE agent_runs.task_id = ? AND tool_calls.task_id <> ?`,
    )
    .all(deletingTaskId, deletingTaskId) as Array<{ run_id: string; task_id: string }>;

  for (const row of shared) {
    const nextRunId = replacementRunId(row.run_id, row.task_id);
    db.prepare(
      `INSERT OR IGNORE INTO agent_runs
        (id, task_id, session_id, state, provider, model, thinking_level,
         usage_json, stop_reason, error_json, started_at, ended_at,
         review_state, reviewed_at)
       SELECT ?, ?, NULL, state, provider, model, thinking_level,
              usage_json, stop_reason, error_json, started_at, ended_at,
              review_state, reviewed_at
       FROM agent_runs
       WHERE id = ?`,
    ).run(nextRunId, row.task_id, row.run_id);
    db.prepare('UPDATE tool_calls SET run_id = ? WHERE run_id = ? AND task_id = ?').run(
      nextRunId,
      row.run_id,
      row.task_id,
    );
  }

  return shared.length;
}
