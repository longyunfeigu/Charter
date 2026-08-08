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
  {
    version: 7,
    name: 'repair-legacy-external-status',
    // Rows written by pre-ADR-0030 builds carry external_json.status values
    // (e.g. 'interrupted') that TaskExternalSchema no longer accepts. One such
    // row made the whole task.list response fail validation. Anything that is
    // not a live session normalizes to 'ended'.
    up: `
UPDATE tasks SET external_json = json_set(external_json, '$.status', 'ended')
  WHERE external_json IS NOT NULL
    AND json_extract(external_json, '$.status') NOT IN ('active', 'ended');
`,
  },
  {
    version: 8,
    name: 'skill-usage-ledger',
    // ADR-0037: skills usage insight. load_skill calls already land in
    // tool_calls; explicit `/skill:name` expansions bypass the tool gateway,
    // so they get their own append-only ledger. The tool_calls index keeps
    // the 45-day aggregation cheap on long-lived databases.
    up: `
CREATE TABLE skill_invocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  at TEXT NOT NULL
);
CREATE INDEX idx_skill_invocations_skill_at ON skill_invocations(skill, at);
CREATE INDEX idx_tool_calls_name_created ON tool_calls(name, created_at);
`,
  },
  {
    version: 9,
    name: 'mission-orchestration-v2',
    // Mission Orchestration V2: normalized responsibility tree, task DAG,
    // replaceable attempts, structured messages and idempotent runtime outbox.
    up: `
CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  origin_conversation_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  execution_policy_json TEXT NOT NULL,
  state TEXT NOT NULL,
  lead_assignment_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_missions_workspace_state ON missions(workspace_id, state, updated_at);

CREATE TABLE mission_tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  parent_task_id TEXT REFERENCES mission_tasks(id) ON DELETE SET NULL,
  created_by_assignment_id TEXT,
  title TEXT NOT NULL,
  goal_md TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  expected_artifacts_json TEXT NOT NULL DEFAULT '[]',
  work_mode TEXT NOT NULL DEFAULT 'read-only',
  write_scope_json TEXT,
  state TEXT NOT NULL,
  result_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_mission_tasks_mission_state ON mission_tasks(mission_id, state, created_at);
CREATE INDEX idx_mission_tasks_parent ON mission_tasks(parent_task_id);

CREATE TABLE mission_task_dependencies (
  task_id TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX idx_mission_task_dependencies_dep ON mission_task_dependencies(depends_on_task_id);

CREATE TABLE orchestration_principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT,
  external_identity TEXT,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE UNIQUE INDEX idx_orchestration_principals_external
  ON orchestration_principals(provider, external_identity)
  WHERE external_identity IS NOT NULL;

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  supervisor_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  assignee_principal_id TEXT NOT NULL REFERENCES orchestration_principals(id),
  active_attempt_id TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_assignments_mission_state ON assignments(mission_id, state, created_at);
CREATE INDEX idx_assignments_supervisor ON assignments(supervisor_assignment_id);
CREATE INDEX idx_assignments_principal ON assignments(assignee_principal_id, state);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  requested_runtime TEXT NOT NULL,
  requested_model TEXT,
  runtime_session_id TEXT,
  terminal_id TEXT,
  state TEXT NOT NULL,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  failure_code TEXT,
  failure_json TEXT,
  result_json TEXT,
  UNIQUE (assignment_id, ordinal)
);
CREATE INDEX idx_execution_attempts_state ON execution_attempts(state, lease_expires_at);
CREATE INDEX idx_execution_attempts_runtime ON execution_attempts(runtime_session_id);
CREATE INDEX idx_execution_attempts_terminal ON execution_attempts(terminal_id);

CREATE TABLE orchestration_messages (
  id TEXT NOT NULL UNIQUE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  from_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  to_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  thread_id TEXT,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  suppressed_at TEXT,
  suppression_reason TEXT
);
CREATE INDEX idx_orchestration_messages_inbox
  ON orchestration_messages(mission_id, to_assignment_id, read_at, sequence);
CREATE INDEX idx_orchestration_messages_thread ON orchestration_messages(thread_id, sequence);

CREATE TABLE mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_principal_id TEXT REFERENCES orchestration_principals(id) ON DELETE SET NULL,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, sequence)
);
CREATE INDEX idx_mission_events_mission ON mission_events(mission_id, sequence);

CREATE TABLE orchestration_outbox (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (mission_id, operation, idempotency_key)
);
CREATE INDEX idx_orchestration_outbox_pending
  ON orchestration_outbox(state, available_at, created_at);

CREATE TABLE assignment_artifacts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assignment_artifacts_assignment ON assignment_artifacts(assignment_id, created_at);
`,
  },
  {
    version: 10,
    name: 'mission-fabric-runtime-and-delivery',
    up: `
CREATE TABLE orchestration_runtime_sessions (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES execution_attempts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  external_session_id TEXT,
  process_key TEXT,
  state TEXT NOT NULL,
  cwd TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  last_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orchestration_runtime_sessions_process
  ON orchestration_runtime_sessions(provider, process_key, state);

CREATE TABLE orchestration_runtime_events (
  id TEXT PRIMARY KEY,
  runtime_session_id TEXT NOT NULL REFERENCES orchestration_runtime_sessions(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(runtime_session_id, sequence)
);
CREATE INDEX idx_orchestration_runtime_events_attempt
  ON orchestration_runtime_events(attempt_id, sequence);

CREATE TABLE orchestration_message_deliveries (
  message_id TEXT NOT NULL REFERENCES orchestration_messages(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  delivered_at TEXT,
  observed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(message_id, assignment_id)
);
CREATE INDEX idx_orchestration_message_deliveries_pending
  ON orchestration_message_deliveries(assignment_id, state, updated_at);

INSERT INTO orchestration_message_deliveries
  (message_id, assignment_id, state, delivered_at, observed_at, updated_at)
SELECT id, to_assignment_id,
  CASE WHEN read_at IS NOT NULL THEN 'observed'
       WHEN delivered_at IS NOT NULL THEN 'delivered'
       ELSE 'pending' END,
  delivered_at, read_at, created_at
FROM orchestration_messages
WHERE to_assignment_id IS NOT NULL AND suppressed_at IS NULL;
`,
  },
  {
    version: 11,
    name: 'mission-continuations-and-resume-intents',
    up: `
CREATE TABLE orchestration_continuations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  owner_assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  owner_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  cursor_sequence INTEGER NOT NULL DEFAULT 0,
  deadline_at TEXT,
  idempotency_key TEXT NOT NULL,
  ready_at TEXT,
  delivered_at TEXT,
  consumed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(mission_id, owner_assignment_id, idempotency_key)
);
CREATE INDEX idx_orchestration_continuations_mission
  ON orchestration_continuations(mission_id, created_at);
CREATE INDEX idx_orchestration_continuations_deadline
  ON orchestration_continuations(state, deadline_at);
CREATE UNIQUE INDEX idx_orchestration_continuations_active_owner
  ON orchestration_continuations(owner_attempt_id)
  WHERE state IN ('ARMED','READY','DELIVERING','DELIVERED');

CREATE TABLE orchestration_continuation_targets (
  id TEXT PRIMARY KEY,
  continuation_id TEXT NOT NULL REFERENCES orchestration_continuations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
  from_assignment_id TEXT REFERENCES assignments(id) ON DELETE CASCADE,
  message_types_json TEXT,
  thread_id TEXT,
  terminal_states_json TEXT,
  satisfied_by TEXT,
  satisfied_payload_json TEXT,
  satisfied_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_orchestration_continuation_targets_assignment
  ON orchestration_continuation_targets(target_assignment_id, satisfied_at);
CREATE INDEX idx_orchestration_continuation_targets_message
  ON orchestration_continuation_targets(from_assignment_id, thread_id, satisfied_at);

CREATE TABLE orchestration_resume_intents (
  id TEXT PRIMARY KEY,
  continuation_id TEXT NOT NULL UNIQUE REFERENCES orchestration_continuations(id) ON DELETE CASCADE,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  owner_assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  owner_attempt_id TEXT NOT NULL REFERENCES execution_attempts(id) ON DELETE CASCADE,
  runtime_session_id TEXT,
  state TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  last_error TEXT,
  delivered_at TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orchestration_resume_intents_pending
  ON orchestration_resume_intents(state, available_at, created_at);
`,
  },
  {
    version: 12,
    name: 'deleted-external-sessions',
    // Deleting a tracked external Session removes Charter's complete task
    // ledger, but must not make the same read-only Claude/Codex transcript
    // reappear as an untracked archaeology result on the next scan.
    up: `
CREATE TABLE deleted_external_sessions (
  cli TEXT NOT NULL,
  session_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (cli, session_id)
);
`,
  },
  {
    version: 13,
    name: 'mission-conversations-actions-and-incidents',
    up: `
INSERT OR IGNORE INTO orchestration_principals
  (id, kind, display_name, state, created_at, last_seen_at)
VALUES ('user', 'user', 'You', 'active', datetime('now'), datetime('now'));

CREATE TABLE orchestration_conversations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  created_by_principal_id TEXT REFERENCES orchestration_principals(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_orchestration_conversations_mission
  ON orchestration_conversations(mission_id, updated_at);

CREATE TABLE orchestration_conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES orchestration_conversations(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES orchestration_principals(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, principal_id)
);

ALTER TABLE orchestration_messages ADD COLUMN conversation_id TEXT;
ALTER TABLE orchestration_messages ADD COLUMN action_request_id TEXT;

INSERT OR IGNORE INTO orchestration_conversations
  (id, mission_id, topic, created_by_principal_id, state, created_at, updated_at)
SELECT
  'conversation:' || m.mission_id || ':' || COALESCE(m.thread_id, m.id),
  m.mission_id,
  MIN(m.subject),
  MIN(a.assignee_principal_id),
  'OPEN',
  MIN(m.created_at),
  MAX(m.created_at)
FROM orchestration_messages m
LEFT JOIN assignments a ON a.id = m.from_assignment_id
GROUP BY m.mission_id, COALESCE(m.thread_id, m.id);

UPDATE orchestration_messages
SET conversation_id =
  'conversation:' || mission_id || ':' || COALESCE(thread_id, id)
WHERE conversation_id IS NULL;

INSERT OR IGNORE INTO orchestration_conversation_participants
  (conversation_id, principal_id, assignment_id, joined_at)
SELECT m.conversation_id, a.assignee_principal_id, a.id, MIN(m.created_at)
FROM orchestration_messages m
JOIN assignments a ON a.id = m.from_assignment_id
WHERE m.conversation_id IS NOT NULL
GROUP BY m.conversation_id, a.assignee_principal_id;

INSERT OR IGNORE INTO orchestration_conversation_participants
  (conversation_id, principal_id, assignment_id, joined_at)
SELECT m.conversation_id, a.assignee_principal_id, a.id, MIN(m.created_at)
FROM orchestration_messages m
JOIN assignments a ON a.id = m.to_assignment_id
WHERE m.conversation_id IS NOT NULL
GROUP BY m.conversation_id, a.assignee_principal_id;

CREATE INDEX idx_orchestration_messages_conversation
  ON orchestration_messages(conversation_id, sequence);
CREATE INDEX idx_orchestration_messages_action_request
  ON orchestration_messages(action_request_id, sequence);

CREATE TABLE orchestration_action_requests (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES orchestration_conversations(id) ON DELETE CASCADE,
  related_task_id TEXT REFERENCES mission_tasks(id) ON DELETE SET NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES orchestration_principals(id),
  created_by_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  assigned_to_principal_id TEXT NOT NULL REFERENCES orchestration_principals(id),
  assigned_to_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  response_type TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  recommendation TEXT,
  impact TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  blocking_scope TEXT NOT NULL DEFAULT 'none',
  status TEXT NOT NULL DEFAULT 'OPEN',
  opening_message_id TEXT,
  idempotency_key TEXT NOT NULL,
  due_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mission_id, created_by_principal_id, idempotency_key)
);
CREATE INDEX idx_orchestration_action_requests_assignee
  ON orchestration_action_requests(mission_id, assigned_to_principal_id, status, created_at);
CREATE INDEX idx_orchestration_action_requests_assignment
  ON orchestration_action_requests(assigned_to_assignment_id, status, created_at);

CREATE TABLE orchestration_action_resolutions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES orchestration_action_requests(id) ON DELETE CASCADE,
  resolved_by_principal_id TEXT NOT NULL REFERENCES orchestration_principals(id),
  resolved_by_assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  outcome TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  rationale TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE orchestration_incidents (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  assignment_id TEXT REFERENCES assignments(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  summary TEXT NOT NULL,
  detail_json TEXT,
  automatic_attempts INTEGER NOT NULL DEFAULT 0,
  action_request_id TEXT REFERENCES orchestration_action_requests(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (assignment_id, attempt_id, kind)
);
CREATE INDEX idx_orchestration_incidents_mission
  ON orchestration_incidents(mission_id, state, updated_at);

INSERT OR IGNORE INTO orchestration_incidents
  (id, mission_id, assignment_id, attempt_id, kind, severity, state, summary,
   automatic_attempts, created_at, updated_at)
SELECT
  'incident:' || a.id || ':' || COALESCE(a.active_attempt_id, 'none') || ':legacy-state',
  a.mission_id,
  a.id,
  a.active_attempt_id,
  'legacy-state',
  'error',
  'OPEN',
  CASE WHEN a.state = 'ORPHANED' THEN 'Agent runtime disconnected' ELSE 'Assignment failed' END,
  0,
  a.updated_at,
  a.updated_at
FROM assignments a
WHERE a.state IN ('FAILED', 'ORPHANED');
`,
  },
  {
    version: 14,
    name: 'mission-retention-lifecycle',
    // Mission history is user-managed data. Deletion first moves the complete
    // aggregate to a recoverable local trash; the repository permanently
    // purges expired rows and SQLite cascades every Mission-owned record.
    up: `
ALTER TABLE missions ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_missions_deleted_updated ON missions(deleted_at, updated_at);
`,
  },
  {
    version: 15,
    name: 'work-items-board',
    // Long-lived, role-neutral work lives above execution Sessions and
    // Missions. JSON columns hold user-authored schemas/checklists; the
    // normalized reminder, evidence and execution tables remain queryable.
    up: `
CREATE TABLE work_board_columns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL,
  wip_limit INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_board_columns_position
  ON work_board_columns(archived, position);

CREATE TABLE work_item_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  field_definitions_json TEXT NOT NULL DEFAULT '[]',
  built_in INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_item_types_position
  ON work_item_types(archived, position);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL REFERENCES work_item_types(id),
  column_id TEXT NOT NULL REFERENCES work_board_columns(id),
  title TEXT NOT NULL,
  description_md TEXT NOT NULL DEFAULT '',
  background_md TEXT NOT NULL DEFAULT '',
  source_person TEXT NOT NULL DEFAULT '',
  source_channel TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT 'You',
  priority TEXT NOT NULL DEFAULT 'none',
  labels_json TEXT NOT NULL DEFAULT '[]',
  start_at TEXT,
  due_at TEXT,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  custom_fields_json TEXT NOT NULL DEFAULT '{}',
  position REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_work_items_board
  ON work_items(archived, column_id, position, updated_at);
CREATE INDEX idx_work_items_due
  ON work_items(archived, due_at);

CREATE TABLE work_item_executions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT,
  role TEXT NOT NULL,
  approach TEXT NOT NULL DEFAULT '',
  display_label TEXT NOT NULL DEFAULT '',
  agent_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'linked',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_item_executions_item
  ON work_item_executions(work_item_id, created_at);
CREATE UNIQUE INDEX idx_work_item_executions_target
  ON work_item_executions(work_item_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

CREATE TABLE work_item_reminders (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled',
  message TEXT NOT NULL DEFAULT '',
  fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_work_item_reminders_due
  ON work_item_reminders(state, remind_at);
CREATE INDEX idx_work_item_reminders_item
  ON work_item_reminders(work_item_id, created_at);

CREATE TABLE work_item_evidence (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'You',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_work_item_evidence_item
  ON work_item_evidence(work_item_id, created_at);

CREATE TABLE work_item_events (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE(work_item_id, sequence)
);
CREATE INDEX idx_work_item_events_item
  ON work_item_events(work_item_id, sequence);
`,
  },
  {
    version: 16,
    name: 'simplify-default-workflow',
    // Inbox already represents work that is not yet committed. Start/deadline
    // and priority carry scheduling intent, so the built-in Planned stage added
    // a distinction without a reliable behavioral transition. Preserve every
    // item by returning Planned work to Inbox before hiding the redundant stage.
    up: `
UPDATE work_items
SET column_id = 'work-col-inbox', version = version + 1
WHERE column_id = 'work-col-planned'
  AND EXISTS (
    SELECT 1 FROM work_board_columns WHERE id = 'work-col-inbox'
  );

UPDATE work_board_columns
SET archived = 1
WHERE id = 'work-col-planned'
  AND EXISTS (
    SELECT 1 FROM work_board_columns WHERE id = 'work-col-inbox'
  );
`,
  },
];
