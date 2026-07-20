import type { Migration } from './database.js';

/** Product schema v1 (spec §11.2). Task/event/tool tables are created up front so
 * later milestones only add columns via new migrations. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core-schema',
    up: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  trust_state TEXT NOT NULL DEFAULT 'untrusted',
  pinned INTEGER NOT NULL DEFAULT 0,
  settings_override_json TEXT,
  last_opened_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  model_json TEXT NOT NULL,
  scope_json TEXT,
  verification_json TEXT NOT NULL DEFAULT '[]',
  git_baseline_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_workspace_state ON tasks(workspace_id, state, archived);

CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, sequence)
);
CREATE INDEX idx_task_events_task ON task_events(task_id, sequence);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  runtime TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  external_session_id TEXT,
  external_session_file TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT REFERENCES agent_sessions(id),
  state TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  thinking_level TEXT,
  usage_json TEXT,
  stop_reason TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_agent_runs_task ON agent_runs(task_id);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_runs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  risk TEXT,
  state TEXT NOT NULL,
  input_json TEXT NOT NULL,
  result_json TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_calls_task ON tool_calls(task_id);

CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE permission_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES permission_requests(id),
  workspace_id TEXT REFERENCES workspaces(id),
  task_id TEXT REFERENCES tasks(id),
  decision TEXT NOT NULL,
  scope TEXT NOT NULL,
  rule_json TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_permission_decisions_ws ON permission_decisions(workspace_id, scope);

CREATE TABLE file_baselines (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  relative_path TEXT NOT NULL,
  existed INTEGER NOT NULL,
  blob_hash TEXT,
  mode INTEGER,
  size INTEGER,
  encoding TEXT,
  eol TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (task_id, relative_path)
);

CREATE TABLE file_changes (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tool_call_id TEXT,
  relative_path TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  patch TEXT,
  rename_to TEXT,
  author TEXT NOT NULL DEFAULT 'agent',
  review_state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_file_changes_task ON file_changes(task_id);

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  label TEXT NOT NULL,
  command_json TEXT NOT NULL,
  code_revision TEXT,
  state TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  output_ref TEXT,
  output_excerpt TEXT,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_verification_runs_task ON verification_runs(task_id);

CREATE TABLE ui_workspace_state (
  workspace_id TEXT PRIMARY KEY,
  layout_json TEXT,
  open_tabs_json TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE app_errors (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  sanitized_context TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_app_errors_created ON app_errors(created_at);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'global-tasks-worktrees',
    // ADR-0009: worktree isolation metadata + net changed-file count recorded at
    // run finalization (drives the zero-change "Answered" presentation).
    up: `
ALTER TABLE tasks ADD COLUMN worktree_json TEXT;
ALTER TABLE tasks ADD COLUMN changed_files INTEGER;
CREATE INDEX idx_tasks_updated ON tasks(updated_at);
`,
  },
  {
    version: 3,
    name: 'external-cli-sessions',
    // ADR-0017: marks a task as an external CLI agent session
    // ({ cli, terminalId, snapshotRef, status }); such tasks never dispatch
    // an agent run — their changes arrive through watcher accounting.
    up: `
ALTER TABLE tasks ADD COLUMN external_json TEXT;
`,
  },
  {
    version: 4,
    name: 'task-conversation-references',
    // Snapshot referenced conversations at task creation so a queued start is
    // reproducible even if the source task continues or is later archived.
    up: `
CREATE TABLE task_conversation_references (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  position INTEGER NOT NULL,
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  source_title TEXT NOT NULL,
  source_project_name TEXT NOT NULL,
  source_project_path TEXT NOT NULL,
  turns_json TEXT NOT NULL,
  latest_diff TEXT,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (task_id, position)
);
CREATE INDEX idx_task_conversation_refs_source
  ON task_conversation_references(source_task_id);
`,
  },
  {
    version: 5,
    name: 'project-memory',
    // ADR-0028: project memory. Rule text + enabled state live in the shared
    // .charter/rules.md file; these tables hold the machine-local halves only:
    // captured-but-unapproved candidates, per-rule provenance/observation
    // counters, and the managed-block sync state for CLAUDE.md / AGENTS.md.
    up: `
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  text TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  similar_count INTEGER NOT NULL DEFAULT 1,
  matched_rule_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_rule_id TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_memory_candidates_ws ON memory_candidates(workspace_id, status, created_at);

CREATE TABLE memory_rule_stats (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  rule_id TEXT NOT NULL,
  source_task_id TEXT,
  source_label TEXT,
  created_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TEXT,
  PRIMARY KEY (workspace_id, rule_id)
);

CREATE TABLE memory_rule_injections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  rule_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  injected_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, rule_id, task_id)
);
CREATE INDEX idx_memory_injections_ws ON memory_rule_injections(workspace_id, injected_at);

CREATE TABLE memory_sync_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  target TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  managed_block_hash TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'off',
  detail TEXT,
  PRIMARY KEY (workspace_id, target)
);
`,
  },
  {
    version: 6,
    name: 'session-as-conversation',
    // ADR-0032: settlement moves from the task to the turn (one agent run).
    // review_state: accepted | auto_accepted | rolled_back | answered — NULL
    // means the finished turn is still awaiting review. Historic terminal
    // tasks migrate: worktree ones lost their tree on accept and become
    // archived read-only Sessions; plain ones become IDLE, continuable
    // conversations (their last run inherits the matching settlement).
    up: `
ALTER TABLE agent_runs ADD COLUMN review_state TEXT;
ALTER TABLE agent_runs ADD COLUMN reviewed_at TEXT;
UPDATE agent_runs SET
  review_state = CASE (SELECT state FROM tasks WHERE tasks.id = agent_runs.task_id)
    WHEN 'ACCEPTED' THEN 'accepted'
    WHEN 'ROLLED_BACK' THEN 'rolled_back'
  END,
  reviewed_at = COALESCE(ended_at, (SELECT updated_at FROM tasks WHERE tasks.id = agent_runs.task_id))
WHERE id IN (
  SELECT r.id FROM agent_runs r
  JOIN tasks t ON t.id = r.task_id AND t.state IN ('ACCEPTED','ROLLED_BACK')
  WHERE NOT EXISTS (
    SELECT 1 FROM agent_runs r2
    WHERE r2.task_id = r.task_id AND r2.started_at > r.started_at
  )
);
UPDATE tasks SET archived = 1
  WHERE state IN ('ACCEPTED','ROLLED_BACK') AND worktree_json IS NOT NULL AND archived = 0;
UPDATE tasks SET state = 'IDLE'
  WHERE state IN ('ACCEPTED','ROLLED_BACK') AND archived = 0;
`,
  },
];
