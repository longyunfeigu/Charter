import { newId, productError, ProductFailure } from '@pi-ide/foundation';
import {
  assertMissionTransition,
  assertAssignmentTransition,
  assertDependencyInsertion,
  defaultMissionExecutionPolicy,
  type Assignment,
  type AssignmentArtifact,
  type AssignmentWorkMode,
  type AssignmentState,
  type ActionRequestBlockingScope,
  type ActionRequestKind,
  type ActionRequestOption,
  type ActionRequestResponseType,
  type ContinuationBundle,
  type ContinuationCondition,
  type ContinuationMode,
  type ExecutionAttempt,
  type Mission,
  type MissionExecutionPolicy,
  type MissionTask,
  type OrchestrationActionRequest,
  type OrchestrationActionResolution,
  type OrchestrationConversation,
  type OrchestrationConversationParticipant,
  type OrchestrationIncident,
  type OrchestrationIncidentSeverity,
  type OrchestrationIncidentState,
  type OrchestrationMessage,
  type OrchestrationMessageDelivery,
  type OrchestrationMessagePriority,
  type OrchestrationMessageType,
  type OrchestrationPrincipal,
  type OrchestrationContinuation,
  type OrchestrationContinuationTarget,
  type OrchestrationResumeIntent,
  type OrchestrationRuntimeEvent,
  type OrchestrationRuntimeSession,
  type PrincipalKind,
  type RuntimeKind,
  type TaskDependency,
} from '@pi-ide/orchestration-domain';
import type { SqlDatabase } from './database.js';

type JsonObject = Record<string, unknown>;

const SNAPSHOT_RUNTIME_EVENT_LIMIT = 100;
const SNAPSHOT_RUNTIME_EVENT_PAYLOAD_MAX_BYTES = 16 * 1024;
const MISSION_TRASH_RETENTION_DAYS = 30;
const TERMINAL_MISSION_STATES = new Set<Mission['state']>(['COMPLETED', 'FAILED', 'CANCELLED']);

interface MissionRow {
  id: string;
  workspace_id: string;
  origin_conversation_task_id: string | null;
  title: string;
  goal_md: string;
  acceptance_json: string;
  execution_policy_json: string;
  state: Mission['state'];
  lead_assignment_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
}

interface TaskRow {
  id: string;
  mission_id: string;
  parent_task_id: string | null;
  created_by_assignment_id: string | null;
  title: string;
  goal_md: string;
  acceptance_json: string;
  expected_artifacts_json: string;
  work_mode: AssignmentWorkMode;
  write_scope_json: string | null;
  state: MissionTask['state'];
  result_json: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface PrincipalRow {
  id: string;
  kind: PrincipalKind;
  provider: string | null;
  external_identity: string | null;
  display_name: string;
  state: OrchestrationPrincipal['state'];
  created_at: string;
  last_seen_at: string | null;
}

interface AssignmentRow {
  id: string;
  mission_id: string;
  task_id: string;
  supervisor_assignment_id: string | null;
  assignee_principal_id: string;
  active_attempt_id: string | null;
  state: Assignment['state'];
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AttemptRow {
  id: string;
  assignment_id: string;
  ordinal: number;
  requested_runtime: RuntimeKind;
  requested_model: string | null;
  runtime_session_id: string | null;
  terminal_id: string | null;
  state: ExecutionAttempt['state'];
  lease_expires_at: string | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  failure_code: string | null;
  failure_json: string | null;
  result_json: string | null;
}

interface MessageRow {
  id: string;
  mission_id: string;
  conversation_id: string | null;
  action_request_id: string | null;
  from_assignment_id: string | null;
  to_assignment_id: string | null;
  thread_id: string | null;
  attempt_id: string | null;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  subject: string;
  body: string;
  payload_json: string | null;
  sequence: number;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
  suppressed_at: string | null;
  suppression_reason: string | null;
}

interface ConversationRow {
  id: string;
  mission_id: string;
  topic: string;
  created_by_principal_id: string | null;
  state: OrchestrationConversation['state'];
  created_at: string;
  updated_at: string;
}

interface ConversationParticipantRow {
  conversation_id: string;
  principal_id: string;
  assignment_id: string | null;
  joined_at: string;
}

interface ActionRequestRow {
  id: string;
  mission_id: string;
  conversation_id: string;
  related_task_id: string | null;
  created_by_principal_id: string;
  created_by_assignment_id: string | null;
  assigned_to_principal_id: string;
  assigned_to_assignment_id: string | null;
  kind: ActionRequestKind;
  title: string;
  context: string;
  response_type: ActionRequestResponseType;
  options_json: string;
  recommendation: string | null;
  impact: string | null;
  priority: OrchestrationMessagePriority;
  blocking_scope: ActionRequestBlockingScope;
  status: OrchestrationActionRequest['status'];
  opening_message_id: string | null;
  idempotency_key: string;
  due_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionResolutionRow {
  id: string;
  request_id: string;
  resolved_by_principal_id: string;
  resolved_by_assignment_id: string | null;
  outcome: string;
  body: string;
  payload_json: string | null;
  rationale: string | null;
  idempotency_key: string;
  created_at: string;
}

interface IncidentRow {
  id: string;
  mission_id: string;
  assignment_id: string | null;
  attempt_id: string | null;
  kind: string;
  severity: OrchestrationIncidentSeverity;
  state: OrchestrationIncidentState;
  summary: string;
  detail_json: string | null;
  automatic_attempts: number;
  action_request_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface ArtifactRow {
  id: string;
  mission_id: string;
  assignment_id: string;
  attempt_id: string | null;
  kind: string;
  label: string;
  reference_json: string;
  created_at: string;
}

interface RuntimeSessionRow {
  id: string;
  attempt_id: string;
  provider: string;
  transport: OrchestrationRuntimeSession['transport'];
  external_session_id: string | null;
  process_key: string | null;
  state: OrchestrationRuntimeSession['state'];
  cwd: string;
  capabilities_json: string;
  last_event_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RuntimeEventRow {
  id: string;
  runtime_session_id: string;
  attempt_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: string;
}

interface MessageDeliveryRow {
  message_id: string;
  assignment_id: string;
  state: OrchestrationMessageDelivery['state'];
  attempts: number;
  last_error: string | null;
  delivered_at: string | null;
  observed_at: string | null;
  updated_at: string;
}

interface ContinuationRow {
  id: string;
  mission_id: string;
  owner_assignment_id: string;
  owner_attempt_id: string;
  mode: ContinuationMode;
  state: OrchestrationContinuation['state'];
  reason: string;
  cursor_sequence: number;
  deadline_at: string | null;
  idempotency_key: string;
  ready_at: string | null;
  delivered_at: string | null;
  consumed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ContinuationTargetRow {
  id: string;
  continuation_id: string;
  kind: OrchestrationContinuationTarget['kind'];
  target_assignment_id: string | null;
  from_assignment_id: string | null;
  message_types_json: string | null;
  thread_id: string | null;
  terminal_states_json: string | null;
  satisfied_by: string | null;
  satisfied_payload_json: string | null;
  satisfied_at: string | null;
  created_at: string;
}

interface ResumeIntentRow {
  id: string;
  continuation_id: string;
  mission_id: string;
  owner_assignment_id: string;
  owner_attempt_id: string;
  runtime_session_id: string | null;
  state: OrchestrationResumeIntent['state'];
  idempotency_key: string;
  payload_json: string;
  attempts: number;
  available_at: string;
  last_error: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MissionSnapshot {
  mission: Mission;
  principals: OrchestrationPrincipal[];
  conversations: OrchestrationConversation[];
  conversationParticipants: OrchestrationConversationParticipant[];
  actionRequests: OrchestrationActionRequest[];
  actionResolutions: OrchestrationActionResolution[];
  incidents: OrchestrationIncident[];
  tasks: MissionTask[];
  dependencies: TaskDependency[];
  assignments: Assignment[];
  attempts: ExecutionAttempt[];
  messages: OrchestrationMessage[];
  artifacts: AssignmentArtifact[];
  runtimeSessions: OrchestrationRuntimeSession[];
  runtimeEvents: OrchestrationRuntimeEvent[];
  messageDeliveries: OrchestrationMessageDelivery[];
  continuations: OrchestrationContinuation[];
  continuationTargets: OrchestrationContinuationTarget[];
  resumeIntents: OrchestrationResumeIntent[];
}

export interface ArmContinuationInput {
  missionId: string;
  ownerAssignmentId: string;
  ownerAttemptId: string;
  mode: ContinuationMode;
  conditions: ContinuationCondition[];
  reason: string;
  cursorSequence?: number;
  deadlineAt?: string | null;
  idempotencyKey: string;
}

export interface ArmContinuationResult extends ContinuationBundle {
  reused: boolean;
}

export interface ConsumeContinuationResult extends ContinuationBundle {
  reused: boolean;
  messages: OrchestrationMessage[];
  assignments: Assignment[];
}

export interface CreateMissionInput {
  workspaceId: string;
  workspaceRoot: string;
  originConversationTaskId?: string | null;
  title: string;
  goal: string;
  acceptanceCriteria?: string[];
  executionPolicy?: MissionExecutionPolicy;
  lead: {
    principalId: string;
    kind: PrincipalKind;
    provider?: string | null;
    externalIdentity?: string | null;
    displayName: string;
    runtimeSessionId: string;
    terminalId?: string | null;
    requestedRuntime: RuntimeKind;
    requestedModel?: string | null;
  };
}

export interface DelegateInput {
  missionId: string;
  supervisorAssignmentId: string;
  actorPrincipalId: string;
  goal: string;
  title?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  expectedArtifacts?: string[];
  requestedRuntime: RuntimeKind;
  requestedModel?: string | null;
  workMode: AssignmentWorkMode;
  writeScope?: string[] | null;
  reason: string;
  idempotencyKey: string;
  /** Optional request-local key used only to resolve dependencies inside delegateMany. */
  batchKey?: string;
  /** Request-local keys of sibling entries in the same atomic delegateMany call. */
  dependsOnKeys?: string[];
}

export interface DelegateResult {
  missionId: string;
  task: MissionTask;
  assignment: Assignment;
  attempt: ExecutionAttempt;
  reused: boolean;
  batchKey?: string;
}

export interface OutboxRecord {
  id: string;
  missionId: string;
  operation: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: JsonObject;
  state: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  attempts: number;
  availableAt: string;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateMessageInput {
  missionId: string;
  conversationId?: string | null;
  actionRequestId?: string | null;
  fromAssignmentId: string | null;
  toAssignmentId: string | null;
  threadId?: string | null;
  attemptId?: string | null;
  type: OrchestrationMessageType;
  priority?: OrchestrationMessagePriority;
  subject: string;
  body?: string;
  payload?: JsonObject | null;
}

export interface CreateActionRequestInput {
  missionId: string;
  conversationId?: string | null;
  relatedTaskId?: string | null;
  createdByPrincipalId: string;
  createdByAssignmentId: string | null;
  assignedToPrincipalId: string;
  assignedToAssignmentId: string | null;
  kind: ActionRequestKind;
  title: string;
  context?: string;
  responseType: ActionRequestResponseType;
  options?: ActionRequestOption[];
  recommendation?: string | null;
  impact?: string | null;
  priority?: OrchestrationMessagePriority;
  blockingScope?: ActionRequestBlockingScope;
  dueAt?: string | null;
  idempotencyKey: string;
}

export interface CreateActionRequestResult {
  request: OrchestrationActionRequest;
  conversation: OrchestrationConversation;
  message: OrchestrationMessage;
  reused: boolean;
}

export interface ResolveActionRequestInput {
  requestId: string;
  resolvedByPrincipalId: string;
  resolvedByAssignmentId: string | null;
  outcome: string;
  body?: string;
  payload?: JsonObject | null;
  rationale?: string | null;
  idempotencyKey: string;
}

export interface ResolveActionRequestResult {
  request: OrchestrationActionRequest;
  resolution: OrchestrationActionResolution;
  message: OrchestrationMessage | null;
  reused: boolean;
}

export interface RecordIncidentInput {
  missionId: string;
  assignmentId?: string | null;
  attemptId?: string | null;
  kind: string;
  severity: OrchestrationIncidentSeverity;
  state?: OrchestrationIncidentState;
  summary: string;
  detail?: JsonObject | null;
  automaticAttempts?: number;
  actionRequestId?: string | null;
}

export interface CompleteAttemptInput {
  attemptId: string;
  principalId: string;
  outcome: 'success' | 'failure';
  summary: string;
  result?: JsonObject;
  artifacts?: Array<{ kind: string; label: string; reference: JsonObject }>;
  verification?: Array<{ id?: string; label: string; state: string; [key: string]: unknown }>;
  filesModified?: string[];
}

export interface ReassignInput {
  assignmentId: string;
  actorPrincipalId: string | null;
  assignee: {
    principalId?: string;
    kind: PrincipalKind;
    provider?: string | null;
    externalIdentity?: string | null;
    displayName: string;
  };
  requestedRuntime?: RuntimeKind;
  requestedModel?: string | null;
  reason: string;
}

export interface RequestRevisionInput {
  missionId: string;
  actorPrincipalId: string | null;
  feedback: string;
  idempotencyKey: string;
}

export type LifecycleResult =
  | { action: 'accepted'; message: OrchestrationMessage; assignment: Assignment; task: MissionTask }
  | { action: 'suppressed'; message: OrchestrationMessage; reason: string };

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

function normalizedScopePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function writeScopesOverlap(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return true;
  const a = left.map(normalizedScopePath).filter(Boolean);
  const b = right.map(normalizedScopePath).filter(Boolean);
  return a.some((first) =>
    b.some(
      (second) =>
        first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`),
    ),
  );
}

const missionFromRow = (row: MissionRow): Mission => ({
  id: row.id,
  workspaceId: row.workspace_id,
  originConversationTaskId: row.origin_conversation_task_id,
  title: row.title,
  goal: row.goal_md,
  acceptanceCriteria: parseJson(row.acceptance_json, []),
  executionPolicy: parseJson(row.execution_policy_json, defaultMissionExecutionPolicy('')),
  state: row.state,
  leadAssignmentId: row.lead_assignment_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  deletedAt: row.deleted_at,
});

const taskFromRow = (row: TaskRow): MissionTask => ({
  id: row.id,
  missionId: row.mission_id,
  parentTaskId: row.parent_task_id,
  createdByAssignmentId: row.created_by_assignment_id,
  title: row.title,
  goal: row.goal_md,
  acceptanceCriteria: parseJson(row.acceptance_json, []),
  expectedArtifacts: parseJson(row.expected_artifacts_json, []),
  workMode: row.work_mode,
  writeScope: parseJson(row.write_scope_json, null),
  state: row.state,
  result: parseJson(row.result_json, null),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const principalFromRow = (row: PrincipalRow): OrchestrationPrincipal => ({
  id: row.id,
  kind: row.kind,
  provider: row.provider,
  externalIdentity: row.external_identity,
  displayName: row.display_name,
  state: row.state,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

const assignmentFromRow = (row: AssignmentRow): Assignment => ({
  id: row.id,
  missionId: row.mission_id,
  taskId: row.task_id,
  supervisorAssignmentId: row.supervisor_assignment_id,
  assigneePrincipalId: row.assignee_principal_id,
  activeAttemptId: row.active_attempt_id,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const attemptFromRow = (row: AttemptRow): ExecutionAttempt => ({
  id: row.id,
  assignmentId: row.assignment_id,
  ordinal: row.ordinal,
  requestedRuntime: row.requested_runtime,
  requestedModel: row.requested_model,
  runtimeSessionId: row.runtime_session_id,
  terminalId: row.terminal_id,
  state: row.state,
  leaseExpiresAt: row.lease_expires_at,
  lastHeartbeatAt: row.last_heartbeat_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  failureCode: row.failure_code,
  failure: parseJson(row.failure_json, null),
  result: parseJson(row.result_json, null),
});

const messageFromRow = (row: MessageRow): OrchestrationMessage => ({
  id: row.id,
  missionId: row.mission_id,
  conversationId: row.conversation_id,
  actionRequestId: row.action_request_id,
  fromAssignmentId: row.from_assignment_id,
  toAssignmentId: row.to_assignment_id,
  threadId: row.thread_id,
  attemptId: row.attempt_id,
  type: row.type,
  priority: row.priority,
  subject: row.subject,
  body: row.body,
  payload: parseJson(row.payload_json, null),
  sequence: row.sequence,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  readAt: row.read_at,
  suppressedAt: row.suppressed_at,
  suppressionReason: row.suppression_reason,
});

const conversationFromRow = (row: ConversationRow): OrchestrationConversation => ({
  id: row.id,
  missionId: row.mission_id,
  topic: row.topic,
  createdByPrincipalId: row.created_by_principal_id,
  state: row.state,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const conversationParticipantFromRow = (
  row: ConversationParticipantRow,
): OrchestrationConversationParticipant => ({
  conversationId: row.conversation_id,
  principalId: row.principal_id,
  assignmentId: row.assignment_id,
  joinedAt: row.joined_at,
});

const actionRequestFromRow = (row: ActionRequestRow): OrchestrationActionRequest => ({
  id: row.id,
  missionId: row.mission_id,
  conversationId: row.conversation_id,
  relatedTaskId: row.related_task_id,
  createdByPrincipalId: row.created_by_principal_id,
  createdByAssignmentId: row.created_by_assignment_id,
  assignedToPrincipalId: row.assigned_to_principal_id,
  assignedToAssignmentId: row.assigned_to_assignment_id,
  kind: row.kind,
  title: row.title,
  context: row.context,
  responseType: row.response_type,
  options: parseJson(row.options_json, []),
  recommendation: row.recommendation,
  impact: row.impact,
  priority: row.priority,
  blockingScope: row.blocking_scope,
  status: row.status,
  openingMessageId: row.opening_message_id,
  idempotencyKey: row.idempotency_key,
  dueAt: row.due_at,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const actionResolutionFromRow = (row: ActionResolutionRow): OrchestrationActionResolution => ({
  id: row.id,
  requestId: row.request_id,
  resolvedByPrincipalId: row.resolved_by_principal_id,
  resolvedByAssignmentId: row.resolved_by_assignment_id,
  outcome: row.outcome,
  body: row.body,
  payload: parseJson(row.payload_json, null),
  rationale: row.rationale,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
});

const incidentFromRow = (row: IncidentRow): OrchestrationIncident => ({
  id: row.id,
  missionId: row.mission_id,
  assignmentId: row.assignment_id,
  attemptId: row.attempt_id,
  kind: row.kind,
  severity: row.severity,
  state: row.state,
  summary: row.summary,
  detail: parseJson(row.detail_json, null),
  automaticAttempts: row.automatic_attempts,
  actionRequestId: row.action_request_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at,
});

const artifactFromRow = (row: ArtifactRow): AssignmentArtifact => ({
  id: row.id,
  missionId: row.mission_id,
  assignmentId: row.assignment_id,
  attemptId: row.attempt_id,
  kind: row.kind,
  label: row.label,
  reference: parseJson(row.reference_json, {}),
  createdAt: row.created_at,
});

const runtimeSessionFromRow = (row: RuntimeSessionRow): OrchestrationRuntimeSession => ({
  id: row.id,
  attemptId: row.attempt_id,
  provider: row.provider,
  transport: row.transport,
  externalSessionId: row.external_session_id,
  processKey: row.process_key,
  state: row.state,
  cwd: row.cwd,
  capabilities: parseJson(row.capabilities_json, {}),
  lastEventAt: row.last_event_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const runtimeEventFromRow = (row: RuntimeEventRow): OrchestrationRuntimeEvent => ({
  id: row.id,
  runtimeSessionId: row.runtime_session_id,
  attemptId: row.attempt_id,
  sequence: row.sequence,
  kind: row.kind,
  payload: parseJson(row.payload_json, {}),
  createdAt: row.created_at,
});

const messageDeliveryFromRow = (row: MessageDeliveryRow): OrchestrationMessageDelivery => ({
  messageId: row.message_id,
  assignmentId: row.assignment_id,
  state: row.state,
  attempts: row.attempts,
  lastError: row.last_error,
  deliveredAt: row.delivered_at,
  observedAt: row.observed_at,
  updatedAt: row.updated_at,
});

const continuationFromRow = (row: ContinuationRow): OrchestrationContinuation => ({
  id: row.id,
  missionId: row.mission_id,
  ownerAssignmentId: row.owner_assignment_id,
  ownerAttemptId: row.owner_attempt_id,
  mode: row.mode,
  state: row.state,
  reason: row.reason,
  cursorSequence: row.cursor_sequence,
  deadlineAt: row.deadline_at,
  idempotencyKey: row.idempotency_key,
  readyAt: row.ready_at,
  deliveredAt: row.delivered_at,
  consumedAt: row.consumed_at,
  cancelledAt: row.cancelled_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const continuationTargetFromRow = (
  row: ContinuationTargetRow,
): OrchestrationContinuationTarget => ({
  id: row.id,
  continuationId: row.continuation_id,
  kind: row.kind,
  targetAssignmentId: row.target_assignment_id,
  fromAssignmentId: row.from_assignment_id,
  messageTypes: parseJson(row.message_types_json, null),
  threadId: row.thread_id,
  terminalStates: parseJson(row.terminal_states_json, null),
  satisfiedBy: row.satisfied_by,
  satisfiedPayload: parseJson(row.satisfied_payload_json, null),
  satisfiedAt: row.satisfied_at,
  createdAt: row.created_at,
});

const resumeIntentFromRow = (row: ResumeIntentRow): OrchestrationResumeIntent => ({
  id: row.id,
  continuationId: row.continuation_id,
  missionId: row.mission_id,
  ownerAssignmentId: row.owner_assignment_id,
  ownerAttemptId: row.owner_attempt_id,
  runtimeSessionId: row.runtime_session_id,
  state: row.state,
  idempotencyKey: row.idempotency_key,
  payload: parseJson(row.payload_json, {}),
  attempts: row.attempts,
  availableAt: row.available_at,
  lastError: row.last_error,
  deliveredAt: row.delivered_at,
  acknowledgedAt: row.acknowledged_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class MissionRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createMission(input: CreateMissionInput): MissionSnapshot {
    return this.db.transaction(() => {
      const at = this.timestamp();
      const missionId = newId('mission');
      const taskId = newId('mtask');
      const assignmentId = newId('assign');
      const attemptId = newId('attempt');
      const policy = input.executionPolicy ?? defaultMissionExecutionPolicy(input.workspaceRoot);

      this.upsertPrincipal({
        id: input.lead.principalId,
        kind: input.lead.kind,
        provider: input.lead.provider ?? null,
        externalIdentity: input.lead.externalIdentity ?? null,
        displayName: input.lead.displayName,
        state: 'active',
        createdAt: at,
        lastSeenAt: at,
      });
      this.upsertPrincipal({
        id: 'user',
        kind: 'user',
        provider: null,
        externalIdentity: null,
        displayName: 'You',
        state: 'active',
        createdAt: at,
        lastSeenAt: at,
      });
      this.db
        .prepare(
          `INSERT INTO missions
           (id, workspace_id, origin_conversation_task_id, title, goal_md, acceptance_json,
            execution_policy_json, state, lead_assignment_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`,
        )
        .run(
          missionId,
          input.workspaceId,
          input.originConversationTaskId ?? null,
          input.title,
          input.goal,
          JSON.stringify(input.acceptanceCriteria ?? []),
          JSON.stringify(policy),
          assignmentId,
          at,
          at,
        );
      this.db
        .prepare(
          `INSERT INTO mission_tasks
           (id, mission_id, title, goal_md, acceptance_json, work_mode, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'shared-write', 'RUNNING', ?, ?)`,
        )
        .run(
          taskId,
          missionId,
          input.title,
          input.goal,
          JSON.stringify(input.acceptanceCriteria ?? []),
          at,
          at,
        );
      this.db
        .prepare(
          `INSERT INTO assignments
           (id, mission_id, task_id, assignee_principal_id, active_attempt_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
        )
        .run(assignmentId, missionId, taskId, input.lead.principalId, attemptId, at, at);
      this.db
        .prepare(
          `INSERT INTO execution_attempts
           (id, assignment_id, ordinal, requested_runtime, requested_model, runtime_session_id,
            terminal_id, state, started_at, last_heartbeat_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, 'RUNNING', ?, ?)`,
        )
        .run(
          attemptId,
          assignmentId,
          input.lead.requestedRuntime,
          input.lead.requestedModel ?? null,
          input.lead.runtimeSessionId,
          input.lead.terminalId ?? null,
          at,
          at,
        );
      this.appendEvent(
        missionId,
        'mission.created',
        input.lead.principalId,
        assignmentId,
        attemptId,
        {
          originConversationTaskId: input.originConversationTaskId ?? null,
        },
      );
      return this.snapshot(missionId);
    });
  }

  delegate(input: DelegateInput): DelegateResult {
    return this.db.transaction(() => this.delegateOne(input));
  }

  delegateMany(inputs: readonly DelegateInput[]): DelegateResult[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => {
      const keyed = new Map<string, DelegateInput>();
      for (const input of inputs) {
        if (!input.batchKey) continue;
        if (keyed.has(input.batchKey)) {
          throw this.failure(
            'ORCHESTRATION_BATCH_KEY_DUPLICATE',
            `The delegate_many key "${input.batchKey}" is duplicated.`,
          );
        }
        keyed.set(input.batchKey, input);
      }
      for (const input of inputs) {
        for (const dependency of input.dependsOnKeys ?? []) {
          if (!keyed.has(dependency)) {
            throw this.failure(
              'ORCHESTRATION_BATCH_DEPENDENCY_NOT_FOUND',
              `The delegate_many dependency key "${dependency}" does not exist in this batch.`,
            );
          }
        }
      }

      const ordered: DelegateInput[] = [];
      const visiting = new Set<string>();
      const visited = new Set<DelegateInput>();
      const visit = (input: DelegateInput): void => {
        if (visited.has(input)) return;
        const key = input.batchKey;
        if (key && visiting.has(key)) {
          throw this.failure(
            'ORCHESTRATION_BATCH_DEPENDENCY_CYCLE',
            `The delegate_many dependency graph contains a cycle at "${key}".`,
          );
        }
        if (key) visiting.add(key);
        for (const dependency of input.dependsOnKeys ?? []) visit(keyed.get(dependency)!);
        if (key) visiting.delete(key);
        visited.add(input);
        ordered.push(input);
      };
      for (const input of inputs) visit(input);

      const byKey = new Map<string, DelegateResult>();
      const byInput = new Map<DelegateInput, DelegateResult>();
      for (const input of ordered) {
        const siblingDependencies = (input.dependsOnKeys ?? []).map(
          (dependency) => byKey.get(dependency)!.task.id,
        );
        const result = this.delegateOne({
          ...input,
          dependencies: [...new Set([...(input.dependencies ?? []), ...siblingDependencies])],
        });
        const tagged = input.batchKey ? { ...result, batchKey: input.batchKey } : result;
        if (input.batchKey) byKey.set(input.batchKey, tagged);
        byInput.set(input, tagged);
      }
      return inputs.map((input) => byInput.get(input)!);
    });
  }

  private delegateOne(input: DelegateInput): DelegateResult {
    const existing = this.db
      .prepare(
        `SELECT aggregate_id FROM orchestration_outbox
           WHERE mission_id = ? AND operation = 'start-runtime' AND idempotency_key = ?`,
      )
      .get(input.missionId, input.idempotencyKey) as { aggregate_id: string } | undefined;
    if (existing) return { ...this.delegateResult(existing.aggregate_id), reused: true };

    const mission = this.requireMission(input.missionId);
    if (mission.state !== 'RUNNING' && mission.state !== 'BLOCKED') {
      throw this.failure(
        'ORCHESTRATION_MISSION_NOT_ACTIVE',
        'This Mission is not accepting new work.',
      );
    }
    const supervisor = this.requireAssignment(input.supervisorAssignmentId);
    if (
      supervisor.missionId !== mission.id ||
      supervisor.assigneePrincipalId !== input.actorPrincipalId
    ) {
      throw this.failure(
        'ORCHESTRATION_CALLER_MISMATCH',
        'The caller is not the assignee of the supervising Assignment.',
      );
    }
    if (!['ACTIVE', 'WAITING', 'PAUSED'].includes(supervisor.state)) {
      throw this.failure(
        'ORCHESTRATION_ASSIGNMENT_NOT_ACTIVE',
        'The supervising Assignment is not active.',
      );
    }
    this.assertCapacity(mission);

    const at = this.timestamp();
    const taskId = newId('mtask');
    const assignmentId = newId('assign');
    const attemptId = newId('attempt');
    const principalId = newId('principal');
    const dependencies = [...new Set(input.dependencies ?? [])];
    const tasks = this.listTasks(mission.id);
    const edges = this.listDependencies(mission.id);
    assertDependencyInsertion(
      tasks.map((task) => task.id),
      edges,
      taskId,
      dependencies,
    );
    for (const dependency of dependencies) {
      const depTask = tasks.find((task) => task.id === dependency);
      if (!depTask || depTask.missionId !== mission.id) {
        throw this.failure(
          'ORCHESTRATION_DEPENDENCY_NOT_FOUND',
          'A dependency is outside the Mission.',
        );
      }
    }
    const ready = dependencies.every(
      (dependency) => tasks.find((task) => task.id === dependency)?.state === 'COMPLETED',
    );
    const principalKind: PrincipalKind =
      input.requestedRuntime === 'managed'
        ? 'managed_agent'
        : input.requestedRuntime === 'shell'
          ? 'shell_agent'
          : 'external_agent';
    this.upsertPrincipal({
      id: principalId,
      kind: principalKind,
      provider: input.requestedRuntime,
      externalIdentity: null,
      displayName: input.title ?? input.goal.slice(0, 80),
      state: 'disconnected',
      createdAt: at,
      lastSeenAt: null,
    });
    this.db
      .prepare(
        `INSERT INTO mission_tasks
           (id, mission_id, parent_task_id, created_by_assignment_id, title, goal_md,
            acceptance_json, expected_artifacts_json, work_mode, write_scope_json, state,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        mission.id,
        supervisor.taskId,
        supervisor.id,
        input.title ?? input.goal.slice(0, 120),
        input.goal,
        JSON.stringify(input.acceptanceCriteria),
        JSON.stringify(input.expectedArtifacts ?? []),
        input.workMode,
        input.writeScope ? JSON.stringify(input.writeScope) : null,
        ready ? 'READY' : 'BLOCKED',
        at,
        at,
      );
    for (const dependency of dependencies) {
      this.db
        .prepare(
          'INSERT INTO mission_task_dependencies (task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)',
        )
        .run(taskId, dependency, at);
    }
    this.db
      .prepare(
        `INSERT INTO assignments
           (id, mission_id, task_id, supervisor_assignment_id, assignee_principal_id,
            active_attempt_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(assignmentId, mission.id, taskId, supervisor.id, principalId, attemptId, at, at);
    this.db
      .prepare(
        `INSERT INTO execution_attempts
           (id, assignment_id, ordinal, requested_runtime, requested_model, state)
           VALUES (?, ?, 1, ?, ?, 'PLANNED')`,
      )
      .run(attemptId, assignmentId, input.requestedRuntime, input.requestedModel ?? null);
    const outboxId = newId('outbox');
    this.db
      .prepare(
        `INSERT INTO orchestration_outbox
           (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
            available_at, created_at)
           VALUES (?, ?, 'start-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
      )
      .run(
        outboxId,
        mission.id,
        assignmentId,
        input.idempotencyKey,
        JSON.stringify({ assignmentId, attemptId, reason: input.reason }),
        at,
        at,
      );
    this.appendEvent(
      mission.id,
      'assignment.delegated',
      input.actorPrincipalId,
      assignmentId,
      attemptId,
      {
        supervisorAssignmentId: supervisor.id,
        taskId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      },
    );
    if (input.workMode === 'shared-write') {
      const overlaps = (
        this.db
          .prepare(
            `SELECT a.id AS assignment_id, t.id AS task_id, t.write_scope_json
               FROM assignments a JOIN mission_tasks t ON t.id = a.task_id
               WHERE a.mission_id = ? AND a.id <> ? AND t.work_mode = 'shared-write'
                 AND a.state IN ('PENDING','ACTIVE','WAITING','PAUSED')`,
          )
          .all(mission.id, assignmentId) as unknown as Array<{
          assignment_id: string;
          task_id: string;
          write_scope_json: string | null;
        }>
      ).filter((row) =>
        writeScopesOverlap(input.writeScope ?? null, parseJson(row.write_scope_json, null)),
      );
      if (overlaps.length > 0) {
        const target = mission.leadAssignmentId ?? supervisor.id;
        this.insertMessage({
          missionId: mission.id,
          fromAssignmentId: assignmentId,
          toAssignmentId: target,
          attemptId,
          type: 'escalation',
          priority: 'high',
          subject: 'Shared-write overlap requires coordination',
          body: 'This Assignment shares a target tree with another active writer. File attribution may be ambiguous.',
          payload: {
            assignmentId,
            writeScope: input.writeScope ?? null,
            overlaps: overlaps.map((row) => ({
              assignmentId: row.assignment_id,
              taskId: row.task_id,
            })),
          },
        });
        this.appendEvent(
          mission.id,
          'assignment.sharedWriteOverlap',
          input.actorPrincipalId,
          assignmentId,
          attemptId,
          { overlappingAssignmentIds: overlaps.map((row) => row.assignment_id) },
        );
      }
    }
    return { ...this.delegateResult(assignmentId), reused: false };
  }

  bindRuntime(
    assignmentId: string,
    attemptId: string,
    input: {
      runtimeSessionId: string;
      terminalId?: string | null;
      leaseExpiresAt?: string | null;
      artifacts?: Array<{ kind: string; label: string; reference: JsonObject }>;
    },
  ): ExecutionAttempt {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      if (assignment.activeAttemptId !== attemptId) {
        throw this.failure(
          'ORCHESTRATION_ATTEMPT_STALE',
          'This execution Attempt is no longer active.',
        );
      }
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE execution_attempts SET runtime_session_id = ?, terminal_id = ?, state = 'RUNNING',
           lease_expires_at = ?, last_heartbeat_at = ?, started_at = COALESCE(started_at, ?)
           WHERE id = ? AND assignment_id = ? AND state IN ('PLANNED','STARTING')`,
        )
        .run(
          input.runtimeSessionId,
          input.terminalId ?? null,
          input.leaseExpiresAt ?? null,
          at,
          at,
          attemptId,
          assignmentId,
        );
      this.db
        .prepare("UPDATE assignments SET state = 'ACTIVE', updated_at = ? WHERE id = ?")
        .run(at, assignmentId);
      if (input.artifacts?.length) {
        this.recordArtifacts(assignment.missionId, assignment.id, attemptId, input.artifacts);
      }
      this.db
        .prepare(
          "UPDATE mission_tasks SET state = 'RUNNING', updated_at = ?, version = version + 1 WHERE id = ? AND state = 'READY'",
        )
        .run(at, assignment.taskId);
      this.appendEvent(
        assignment.missionId,
        'attempt.started',
        assignment.assigneePrincipalId,
        assignment.id,
        attemptId,
        {
          runtimeSessionId: input.runtimeSessionId,
          terminalId: input.terminalId ?? null,
        },
      );
      return this.requireAttempt(attemptId);
    });
  }

  rebindActiveRuntime(
    assignmentId: string,
    input: { runtimeSessionId: string; terminalId?: string | null; leaseExpiresAt?: string | null },
  ): ExecutionAttempt {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      if (!assignment.activeAttemptId) {
        throw this.failure(
          'ORCHESTRATION_ATTEMPT_REQUIRED',
          'The Assignment has no active Attempt.',
        );
      }
      const attempt = this.requireAttempt(assignment.activeAttemptId);
      if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'].includes(attempt.state)) {
        throw this.failure(
          'ORCHESTRATION_ATTEMPT_TERMINAL',
          'The active Attempt is already terminal.',
        );
      }
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE execution_attempts SET runtime_session_id = ?, terminal_id = ?,
           last_heartbeat_at = ?, lease_expires_at = ?,
           state = CASE WHEN state IN ('PLANNED','STARTING') THEN 'RUNNING' ELSE state END
           WHERE id = ?`,
        )
        .run(
          input.runtimeSessionId,
          input.terminalId ?? null,
          at,
          input.leaseExpiresAt ?? attempt.leaseExpiresAt,
          attempt.id,
        );
      const preserveDurableWait = this.hasActiveContinuationForOwner(assignment.id);
      this.db
        .prepare(
          `UPDATE assignments
           SET state = ?, completed_at = NULL, updated_at = ?
           WHERE id = ? AND state IN ('PENDING','WAITING','ORPHANED','FAILED')`,
        )
        .run(preserveDurableWait ? 'WAITING' : 'ACTIVE', at, assignment.id);
      this.db
        .prepare(
          "UPDATE mission_tasks SET state = 'RUNNING', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND state IN ('READY','FAILED')",
        )
        .run(at, assignment.taskId);
      const mission = this.requireMission(assignment.missionId);
      if (mission.leadAssignmentId === assignment.id) {
        this.db
          .prepare(
            "UPDATE missions SET state = 'RUNNING', completed_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND state = 'BLOCKED'",
          )
          .run(at, assignment.missionId);
      }
      this.appendEvent(
        assignment.missionId,
        'attempt.runtimeRebound',
        assignment.assigneePrincipalId,
        assignment.id,
        attempt.id,
        { runtimeSessionId: input.runtimeSessionId, terminalId: input.terminalId ?? null },
      );
      return this.requireAttempt(attempt.id);
    });
  }

  markAttemptStarting(attemptId: string): ExecutionAttempt {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      if (assignment.activeAttemptId !== attempt.id) {
        throw this.failure(
          'ORCHESTRATION_ATTEMPT_STALE',
          'This execution Attempt is no longer active.',
        );
      }
      if (attempt.state === 'PLANNED') {
        this.db
          .prepare(
            "UPDATE execution_attempts SET state = 'STARTING' WHERE id = ? AND state = 'PLANNED'",
          )
          .run(attempt.id);
      }
      return this.requireAttempt(attempt.id);
    });
  }

  createRetry(assignmentId: string, requestedRuntime?: RuntimeKind): ExecutionAttempt {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      const active = assignment.activeAttemptId
        ? this.requireAttempt(assignment.activeAttemptId)
        : null;
      if (active && !['FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'].includes(active.state)) {
        throw this.failure(
          'ORCHESTRATION_ATTEMPT_ACTIVE',
          'The Assignment already has an active Attempt.',
        );
      }
      this.cancelOwnedContinuations(assignment.id, active?.id ?? null, 'attempt_retry_planned');
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM execution_attempts WHERE assignment_id = ?',
        )
        .get(assignmentId) as { ordinal: number };
      const attemptId = newId('attempt');
      const at = this.timestamp();
      const runtime = requestedRuntime ?? active?.requestedRuntime ?? 'managed';
      this.db
        .prepare(
          `INSERT INTO execution_attempts
           (id, assignment_id, ordinal, requested_runtime, requested_model, state)
           VALUES (?, ?, ?, ?, ?, 'PLANNED')`,
        )
        .run(attemptId, assignmentId, row.ordinal + 1, runtime, active?.requestedModel ?? null);
      this.db
        .prepare(
          "UPDATE assignments SET active_attempt_id = ?, state = 'PENDING', updated_at = ? WHERE id = ?",
        )
        .run(attemptId, at, assignmentId);
      this.db
        .prepare(
          "UPDATE mission_tasks SET state = 'READY', updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(at, assignment.taskId);
      this.db
        .prepare(
          `UPDATE orchestration_incidents SET state = 'RECOVERING',
           automatic_attempts = automatic_attempts + 1, updated_at = ?
           WHERE assignment_id = ? AND state IN ('OPEN', 'NEEDS_ACTION')`,
        )
        .run(at, assignment.id);
      this.db
        .prepare(
          `INSERT INTO orchestration_outbox
           (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
            available_at, created_at)
           VALUES (?, ?, 'start-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          newId('outbox'),
          assignment.missionId,
          assignment.id,
          `${assignment.id}:retry:${row.ordinal + 1}`,
          JSON.stringify({ assignmentId, attemptId, retry: true }),
          at,
          at,
        );
      this.appendEvent(
        assignment.missionId,
        'attempt.retryPlanned',
        assignment.assigneePrincipalId,
        assignment.id,
        attemptId,
        {
          ordinal: row.ordinal + 1,
        },
      );
      return this.requireAttempt(attemptId);
    });
  }

  /** Re-open the Lead's work after a user rejects a VERIFYING result. The
   * durable Assignment identity stays stable while a fresh Attempt owns the
   * replacement runtime. */
  requestRevision(input: RequestRevisionInput): {
    assignment: Assignment;
    attempt: ExecutionAttempt;
    reused: boolean;
  } {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT aggregate_id FROM orchestration_outbox
           WHERE mission_id = ? AND operation = 'start-runtime' AND idempotency_key = ?`,
        )
        .get(input.missionId, input.idempotencyKey) as { aggregate_id: string } | undefined;
      if (existing) {
        const assignment = this.requireAssignment(existing.aggregate_id);
        if (!assignment.activeAttemptId) {
          throw this.failure(
            'ORCHESTRATION_ATTEMPT_REQUIRED',
            'The revision Assignment has no active Attempt.',
          );
        }
        return {
          assignment,
          attempt: this.requireAttempt(assignment.activeAttemptId),
          reused: true,
        };
      }

      const mission = this.requireMission(input.missionId);
      if (mission.state !== 'VERIFYING') {
        throw this.failure(
          'ORCHESTRATION_MISSION_NOT_VERIFYING',
          'Changes can only be requested while a Mission is ready for review.',
        );
      }
      if (!mission.leadAssignmentId) {
        throw this.failure('ORCHESTRATION_LEAD_REQUIRED', 'The Mission has no Lead to revise it.');
      }
      const assignment = this.requireAssignment(mission.leadAssignmentId);
      const previousAttempt = assignment.activeAttemptId
        ? this.requireAttempt(assignment.activeAttemptId)
        : null;
      this.cancelOwnedContinuations(
        assignment.id,
        previousAttempt?.id ?? null,
        'mission_revision_requested',
      );
      const ordinalRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM execution_attempts WHERE assignment_id = ?',
        )
        .get(assignment.id) as { ordinal: number };
      const attemptId = newId('attempt');
      const at = this.timestamp();
      const requestedRuntime = previousAttempt?.requestedRuntime ?? 'managed';
      this.db
        .prepare(
          `INSERT INTO execution_attempts
           (id, assignment_id, ordinal, requested_runtime, requested_model, state)
           VALUES (?, ?, ?, ?, ?, 'PLANNED')`,
        )
        .run(
          attemptId,
          assignment.id,
          ordinalRow.ordinal + 1,
          requestedRuntime,
          previousAttempt?.requestedModel ?? null,
        );
      this.db
        .prepare(
          `UPDATE assignments SET active_attempt_id = ?, state = 'PENDING', completed_at = NULL,
           updated_at = ? WHERE id = ?`,
        )
        .run(attemptId, at, assignment.id);
      this.db
        .prepare(
          `UPDATE mission_tasks SET state = 'READY', result_json = NULL, completed_at = NULL,
           goal_md = goal_md || ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(`\n\nUser requested revision:\n${input.feedback}`, at, assignment.taskId);
      this.db
        .prepare(
          `UPDATE missions SET state = 'RUNNING', completed_at = NULL, updated_at = ?,
           version = version + 1 WHERE id = ?`,
        )
        .run(at, mission.id);
      this.db
        .prepare(
          `INSERT INTO orchestration_outbox
           (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
            available_at, created_at)
           VALUES (?, ?, 'start-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          newId('outbox'),
          mission.id,
          assignment.id,
          input.idempotencyKey,
          JSON.stringify({
            assignmentId: assignment.id,
            attemptId,
            reason: 'User requested changes during Mission review.',
          }),
          at,
          at,
        );
      this.insertMessage({
        missionId: mission.id,
        fromAssignmentId: null,
        toAssignmentId: assignment.id,
        attemptId,
        type: 'assignment',
        priority: 'high',
        subject: 'User requested changes',
        body: input.feedback,
      });
      this.appendEvent(
        mission.id,
        'mission.revisionRequested',
        input.actorPrincipalId,
        assignment.id,
        attemptId,
        { feedback: input.feedback, idempotencyKey: input.idempotencyKey },
      );
      return {
        assignment: this.requireAssignment(assignment.id),
        attempt: this.requireAttempt(attemptId),
        reused: false,
      };
    });
  }

  createMessage(input: CreateMessageInput): OrchestrationMessage {
    return this.db.transaction(() => {
      this.requireMission(input.missionId);
      if (input.fromAssignmentId)
        this.assertAssignmentMission(input.fromAssignmentId, input.missionId);
      if (input.toAssignmentId) this.assertAssignmentMission(input.toAssignmentId, input.missionId);
      if (input.actionRequestId) {
        const request = this.requireActionRequest(input.actionRequestId);
        if (request.missionId !== input.missionId) {
          throw this.failure(
            'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
            'The Action Request belongs to another Mission.',
          );
        }
      }
      return this.insertMessage(input);
    });
  }

  getConversation(id: string): OrchestrationConversation | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined;
    return row ? conversationFromRow(row) : null;
  }

  listConversations(missionId: string): OrchestrationConversation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orchestration_conversations WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as ConversationRow[]
    ).map(conversationFromRow);
  }

  listConversationParticipants(missionId: string): OrchestrationConversationParticipant[] {
    return (
      this.db
        .prepare(
          `SELECT p.* FROM orchestration_conversation_participants p
           JOIN orchestration_conversations c ON c.id = p.conversation_id
           WHERE c.mission_id = ? ORDER BY p.joined_at, p.rowid`,
        )
        .all(missionId) as unknown as ConversationParticipantRow[]
    ).map(conversationParticipantFromRow);
  }

  getMessage(id: string): OrchestrationMessage | null {
    const row = this.db.prepare('SELECT * FROM orchestration_messages WHERE id = ?').get(id) as
      MessageRow | undefined;
    return row ? messageFromRow(row) : null;
  }

  getActionRequest(id: string): OrchestrationActionRequest | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_action_requests WHERE id = ?')
      .get(id) as ActionRequestRow | undefined;
    return row ? actionRequestFromRow(row) : null;
  }

  listActionRequests(missionId: string): OrchestrationActionRequest[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orchestration_action_requests WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as ActionRequestRow[]
    ).map(actionRequestFromRow);
  }

  listActionResolutions(missionId: string): OrchestrationActionResolution[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM orchestration_action_resolutions r
           JOIN orchestration_action_requests q ON q.id = r.request_id
           WHERE q.mission_id = ? ORDER BY r.created_at, r.rowid`,
        )
        .all(missionId) as unknown as ActionResolutionRow[]
    ).map(actionResolutionFromRow);
  }

  createActionRequest(input: CreateActionRequestInput): CreateActionRequestResult {
    return this.db.transaction(() => {
      this.requireMission(input.missionId);
      this.requirePrincipal(input.createdByPrincipalId);
      this.requirePrincipal(input.assignedToPrincipalId);
      if (input.createdByAssignmentId) {
        const creator = this.requireAssignment(input.createdByAssignmentId);
        if (
          creator.missionId !== input.missionId ||
          creator.assigneePrincipalId !== input.createdByPrincipalId
        ) {
          throw this.failure(
            'ORCHESTRATION_CALLER_MISMATCH',
            'The request creator does not own the supplied Assignment.',
          );
        }
      }
      if (input.assignedToAssignmentId) {
        const assignee = this.requireAssignment(input.assignedToAssignmentId);
        if (
          assignee.missionId !== input.missionId ||
          assignee.assigneePrincipalId !== input.assignedToPrincipalId
        ) {
          throw this.failure(
            'ORCHESTRATION_TARGET_MISMATCH',
            'The requested assignee does not own the target Assignment.',
          );
        }
      }
      if (input.relatedTaskId) {
        const task = this.requireTask(input.relatedTaskId);
        if (task.missionId !== input.missionId) {
          throw this.failure(
            'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
            'The related Task belongs to another Mission.',
          );
        }
      }

      const existingRow = this.db
        .prepare(
          `SELECT * FROM orchestration_action_requests
           WHERE mission_id = ? AND created_by_principal_id = ? AND idempotency_key = ?`,
        )
        .get(input.missionId, input.createdByPrincipalId, input.idempotencyKey) as
        ActionRequestRow | undefined;
      if (existingRow) {
        const existing = actionRequestFromRow(existingRow);
        const conversation = this.requireConversation(existing.conversationId);
        const message = existing.openingMessageId
          ? this.getMessage(existing.openingMessageId)
          : null;
        if (!message) {
          throw this.failure(
            'ORCHESTRATION_MESSAGE_NOT_FOUND',
            'The Action Request opening message was not found.',
          );
        }
        return { request: existing, conversation, message, reused: true };
      }

      const at = this.timestamp();
      const conversation = this.ensureConversation(
        input.missionId,
        input.conversationId ?? null,
        input.title,
        input.createdByPrincipalId,
      );
      this.addConversationParticipant(
        conversation.id,
        input.createdByPrincipalId,
        input.createdByAssignmentId,
        at,
      );
      this.addConversationParticipant(
        conversation.id,
        input.assignedToPrincipalId,
        input.assignedToAssignmentId,
        at,
      );
      const id = newId('request');
      const options = input.options ?? [];
      this.db
        .prepare(
          `INSERT INTO orchestration_action_requests
           (id, mission_id, conversation_id, related_task_id, created_by_principal_id,
            created_by_assignment_id, assigned_to_principal_id, assigned_to_assignment_id,
            kind, title, context, response_type, options_json, recommendation, impact, priority,
            blocking_scope, status, idempotency_key, due_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.missionId,
          conversation.id,
          input.relatedTaskId ?? null,
          input.createdByPrincipalId,
          input.createdByAssignmentId,
          input.assignedToPrincipalId,
          input.assignedToAssignmentId,
          input.kind,
          input.title,
          input.context ?? '',
          input.responseType,
          JSON.stringify(options),
          input.recommendation ?? null,
          input.impact ?? null,
          input.priority ?? 'normal',
          input.blockingScope ?? 'none',
          input.idempotencyKey,
          input.dueAt ?? null,
          at,
          at,
        );
      const message = this.insertMessage({
        missionId: input.missionId,
        conversationId: conversation.id,
        actionRequestId: id,
        fromAssignmentId: input.createdByAssignmentId,
        toAssignmentId: input.assignedToAssignmentId,
        type: ['escalation', 'recovery'].includes(input.kind) ? 'escalation' : 'question',
        priority: input.priority ?? 'normal',
        subject: input.title,
        body: input.context ?? '',
        payload: {
          actionRequestId: id,
          kind: input.kind,
          responseType: input.responseType,
          options,
          recommendation: input.recommendation ?? null,
          impact: input.impact ?? null,
          blockingScope: input.blockingScope ?? 'none',
        },
      });
      this.db
        .prepare('UPDATE orchestration_action_requests SET opening_message_id = ? WHERE id = ?')
        .run(message.id, id);
      this.appendEvent(
        input.missionId,
        'actionRequest.created',
        input.createdByPrincipalId,
        input.createdByAssignmentId,
        null,
        {
          requestId: id,
          assignedToPrincipalId: input.assignedToPrincipalId,
          assignedToAssignmentId: input.assignedToAssignmentId,
          kind: input.kind,
          blockingScope: input.blockingScope ?? 'none',
        },
      );
      return {
        request: this.requireActionRequest(id),
        conversation,
        message,
        reused: false,
      };
    });
  }

  resolveActionRequest(input: ResolveActionRequestInput): ResolveActionRequestResult {
    return this.db.transaction(() => {
      const request = this.requireActionRequest(input.requestId);
      if (
        request.assignedToPrincipalId !== input.resolvedByPrincipalId ||
        request.assignedToAssignmentId !== input.resolvedByAssignmentId
      ) {
        throw this.failure(
          'ORCHESTRATION_ACTION_ASSIGNEE_REQUIRED',
          'Only the principal assigned this request can resolve it.',
        );
      }
      const existingRow = this.db
        .prepare('SELECT * FROM orchestration_action_resolutions WHERE request_id = ?')
        .get(request.id) as ActionResolutionRow | undefined;
      if (existingRow) {
        const resolution = actionResolutionFromRow(existingRow);
        const messageRow = this.db
          .prepare(
            `SELECT * FROM orchestration_messages
             WHERE action_request_id = ? AND type = 'answer' ORDER BY sequence DESC LIMIT 1`,
          )
          .get(request.id) as MessageRow | undefined;
        return {
          request,
          resolution,
          message: messageRow ? messageFromRow(messageRow) : null,
          reused: true,
        };
      }
      if (request.status !== 'OPEN') {
        throw this.failure(
          'ORCHESTRATION_ACTION_NOT_OPEN',
          'This Action Request is no longer open.',
        );
      }
      if (
        request.options.length > 0 &&
        !request.options.some((option) => option.id === input.outcome)
      ) {
        throw this.failure(
          'ORCHESTRATION_ACTION_INVALID_OUTCOME',
          'Choose one of the outcomes offered by this Action Request.',
        );
      }
      const at = this.timestamp();
      const resolutionId = newId('resolution');
      this.db
        .prepare(
          `INSERT INTO orchestration_action_resolutions
           (id, request_id, resolved_by_principal_id, resolved_by_assignment_id, outcome, body,
            payload_json, rationale, idempotency_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          resolutionId,
          request.id,
          input.resolvedByPrincipalId,
          input.resolvedByAssignmentId,
          input.outcome,
          input.body ?? '',
          input.payload ? JSON.stringify(input.payload) : null,
          input.rationale ?? null,
          input.idempotencyKey,
          at,
        );
      this.db
        .prepare(
          `UPDATE orchestration_action_requests
           SET status = 'RESOLVED', resolved_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(at, at, request.id);
      const selected = request.options.find((option) => option.id === input.outcome);
      const body = input.body?.trim() || selected?.label || input.outcome;
      const message = this.insertMessage({
        missionId: request.missionId,
        conversationId: request.conversationId,
        actionRequestId: request.id,
        fromAssignmentId: input.resolvedByAssignmentId,
        toAssignmentId: request.createdByAssignmentId,
        threadId: request.openingMessageId,
        type: 'answer',
        priority: request.priority,
        subject: `Resolved: ${request.title}`,
        body,
        payload: {
          actionRequestId: request.id,
          outcome: input.outcome,
          rationale: input.rationale ?? null,
          ...(input.payload ?? {}),
        },
      });
      this.db
        .prepare(
          `UPDATE orchestration_incidents SET state = 'CLOSED', resolved_at = ?, updated_at = ?
           WHERE action_request_id = ? AND state NOT IN ('RECOVERED', 'CLOSED')`,
        )
        .run(at, at, request.id);
      this.appendEvent(
        request.missionId,
        'actionRequest.resolved',
        input.resolvedByPrincipalId,
        input.resolvedByAssignmentId,
        null,
        { requestId: request.id, resolutionId, outcome: input.outcome },
      );
      return {
        request: this.requireActionRequest(request.id),
        resolution: this.requireActionResolution(resolutionId),
        message,
        reused: false,
      };
    });
  }

  listIncidents(missionId: string): OrchestrationIncident[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orchestration_incidents WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as IncidentRow[]
    ).map(incidentFromRow);
  }

  recordIncident(input: RecordIncidentInput): OrchestrationIncident {
    return this.db.transaction(() => {
      this.requireMission(input.missionId);
      if (input.assignmentId) this.assertAssignmentMission(input.assignmentId, input.missionId);
      if (input.attemptId) {
        const attempt = this.requireAttempt(input.attemptId);
        if (input.assignmentId && attempt.assignmentId !== input.assignmentId) {
          throw this.failure(
            'ORCHESTRATION_ATTEMPT_MISMATCH',
            'The Incident Attempt does not belong to its Assignment.',
          );
        }
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM orchestration_incidents
           WHERE mission_id = ? AND assignment_id IS ? AND attempt_id IS ? AND kind = ?
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(input.missionId, input.assignmentId ?? null, input.attemptId ?? null, input.kind) as
        IncidentRow | undefined;
      const at = this.timestamp();
      if (existing) {
        this.db
          .prepare(
            `UPDATE orchestration_incidents SET severity = ?, state = ?, summary = ?, detail_json = ?,
             automatic_attempts = ?, action_request_id = ?, updated_at = ?, resolved_at = ?
             WHERE id = ?`,
          )
          .run(
            input.severity,
            input.state ?? existing.state,
            input.summary,
            input.detail ? JSON.stringify(input.detail) : null,
            input.automaticAttempts ?? existing.automatic_attempts,
            input.actionRequestId ?? existing.action_request_id,
            at,
            ['RECOVERED', 'CLOSED'].includes(input.state ?? existing.state) ? at : null,
            existing.id,
          );
        return this.requireIncident(existing.id);
      }
      const id = newId('incident');
      this.db
        .prepare(
          `INSERT INTO orchestration_incidents
           (id, mission_id, assignment_id, attempt_id, kind, severity, state, summary, detail_json,
            automatic_attempts, action_request_id, created_at, updated_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.missionId,
          input.assignmentId ?? null,
          input.attemptId ?? null,
          input.kind,
          input.severity,
          input.state ?? 'OPEN',
          input.summary,
          input.detail ? JSON.stringify(input.detail) : null,
          input.automaticAttempts ?? 0,
          input.actionRequestId ?? null,
          at,
          at,
          ['RECOVERED', 'CLOSED'].includes(input.state ?? 'OPEN') ? at : null,
        );
      this.appendEvent(
        input.missionId,
        'incident.recorded',
        null,
        input.assignmentId ?? null,
        input.attemptId ?? null,
        {
          incidentId: id,
          kind: input.kind,
          severity: input.severity,
          state: input.state ?? 'OPEN',
        },
      );
      return this.requireIncident(id);
    });
  }

  recordArtifacts(
    missionId: string,
    assignmentId: string,
    attemptId: string | null,
    artifacts: Array<{ kind: string; label: string; reference: JsonObject }>,
  ): AssignmentArtifact[] {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      if (assignment.missionId !== missionId) {
        throw this.failure(
          'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
          'Artifact Assignment does not belong to this Mission.',
        );
      }
      if (attemptId) {
        const attempt = this.requireAttempt(attemptId);
        if (attempt.assignmentId !== assignment.id) {
          throw this.failure(
            'ORCHESTRATION_ATTEMPT_MISMATCH',
            'Artifact Attempt does not belong to this Assignment.',
          );
        }
      }
      const at = this.timestamp();
      const created: AssignmentArtifact[] = [];
      for (const artifact of artifacts) {
        const id = newId('artifact');
        this.db
          .prepare(
            `INSERT INTO assignment_artifacts
             (id, mission_id, assignment_id, attempt_id, kind, label, reference_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            missionId,
            assignment.id,
            attemptId,
            artifact.kind,
            artifact.label,
            JSON.stringify(artifact.reference),
            at,
          );
        created.push({
          id,
          missionId,
          assignmentId: assignment.id,
          attemptId,
          kind: artifact.kind,
          label: artifact.label,
          reference: artifact.reference,
          createdAt: at,
        });
      }
      return created;
    });
  }

  listInbox(
    assignmentId: string,
    input: {
      unreadOnly?: boolean;
      types?: OrchestrationMessageType[];
      threadId?: string;
      afterSequence?: number;
      limit?: number;
    } = {},
  ): OrchestrationMessage[] {
    const assignment = this.requireAssignment(assignmentId);
    const clauses = ['mission_id = ?', 'to_assignment_id = ?', 'suppressed_at IS NULL'];
    const params: Array<string | number> = [assignment.missionId, assignmentId];
    if (input.unreadOnly ?? true) clauses.push('read_at IS NULL');
    if (input.threadId) {
      clauses.push('thread_id = ?');
      params.push(input.threadId);
    }
    if (input.afterSequence !== undefined) {
      clauses.push('sequence > ?');
      params.push(input.afterSequence);
    }
    if (input.types && input.types.length > 0) {
      clauses.push(`type IN (${input.types.map(() => '?').join(',')})`);
      params.push(...input.types);
    }
    params.push(input.limit ?? 100);
    return (
      this.db
        .prepare(
          `SELECT * FROM orchestration_messages WHERE ${clauses.join(' AND ')}
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(...params) as unknown as MessageRow[]
    ).map(messageFromRow);
  }

  markMessagesRead(assignmentId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const assignment = this.requireAssignment(assignmentId);
    const placeholders = messageIds.map(() => '?').join(',');
    const at = this.timestamp();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE orchestration_messages SET read_at = COALESCE(read_at, ?)
           WHERE mission_id = ? AND to_assignment_id = ? AND id IN (${placeholders})`,
        )
        .run(at, assignment.missionId, assignmentId, ...messageIds);
      this.db
        .prepare(
          `UPDATE orchestration_message_deliveries
           SET state = 'observed', observed_at = COALESCE(observed_at, ?),
               delivered_at = COALESCE(delivered_at, ?), updated_at = ?
           WHERE assignment_id = ? AND message_id IN (${placeholders})`,
        )
        .run(at, at, at, assignmentId, ...messageIds);
    });
  }

  markMessagesDelivered(assignmentId: string, messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const assignment = this.requireAssignment(assignmentId);
    const placeholders = messageIds.map(() => '?').join(',');
    const at = this.timestamp();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE orchestration_messages SET delivered_at = COALESCE(delivered_at, ?)
           WHERE mission_id = ? AND to_assignment_id = ? AND id IN (${placeholders})`,
        )
        .run(at, assignment.missionId, assignmentId, ...messageIds);
      this.db
        .prepare(
          `UPDATE orchestration_message_deliveries
           SET state = CASE WHEN state = 'observed' THEN state ELSE 'delivered' END,
               attempts = attempts + 1, last_error = NULL,
               delivered_at = COALESCE(delivered_at, ?), updated_at = ?
           WHERE assignment_id = ? AND message_id IN (${placeholders})`,
        )
        .run(at, at, assignmentId, ...messageIds);
    });
  }

  markMessageDeliveryFailed(
    assignmentId: string,
    messageIds: readonly string[],
    error: string,
  ): void {
    if (messageIds.length === 0) return;
    const placeholders = messageIds.map(() => '?').join(',');
    this.db
      .prepare(
        `UPDATE orchestration_message_deliveries
         SET state = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE assignment_id = ? AND message_id IN (${placeholders})`,
      )
      .run(error, this.timestamp(), assignmentId, ...messageIds);
  }

  armContinuation(input: ArmContinuationInput): ArmContinuationResult {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM orchestration_continuations
           WHERE mission_id = ? AND owner_assignment_id = ? AND idempotency_key = ?`,
        )
        .get(input.missionId, input.ownerAssignmentId, input.idempotencyKey) as
        ContinuationRow | undefined;
      if (existing) {
        if (existing.owner_attempt_id !== input.ownerAttemptId) {
          throw this.failure(
            'ORCHESTRATION_CONTINUATION_STALE_KEY',
            'This continuation idempotency key belongs to an older Attempt.',
          );
        }
        return { ...this.continuationBundle(existing.id), reused: true };
      }

      const mission = this.requireMission(input.missionId);
      const owner = this.requireAssignment(input.ownerAssignmentId);
      const attempt = this.requireAttempt(input.ownerAttemptId);
      if (
        owner.missionId !== mission.id ||
        attempt.assignmentId !== owner.id ||
        owner.activeAttemptId !== attempt.id
      ) {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_OWNER_MISMATCH',
          'The continuation must belong to the caller active Attempt.',
        );
      }
      if (
        !['ACTIVE', 'WAITING'].includes(owner.state) ||
        !['RUNNING', 'WAITING'].includes(attempt.state)
      ) {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_OWNER_INACTIVE',
          'Only an active Assignment Attempt can park for continuation.',
        );
      }
      if (input.conditions.length === 0) {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_CONDITION_REQUIRED',
          'At least one continuation condition is required.',
        );
      }
      const active = this.db
        .prepare(
          `SELECT id FROM orchestration_continuations
           WHERE owner_attempt_id = ? AND state IN ('ARMED','READY','DELIVERING','DELIVERED')`,
        )
        .get(attempt.id) as { id: string } | undefined;
      if (active) {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_ALREADY_ACTIVE',
          'This Attempt already has an active continuation.',
        );
      }

      for (const condition of input.conditions) {
        if (condition.kind === 'assignment_terminal') {
          this.assertAssignmentMission(condition.assignmentId, mission.id);
        } else if (condition.fromAssignmentId) {
          this.assertAssignmentMission(condition.fromAssignmentId, mission.id);
        }
      }

      const at = this.timestamp();
      const id = newId('continuation');
      const cursorSequence = Math.max(0, Math.trunc(input.cursorSequence ?? 0));
      this.db
        .prepare(
          `INSERT INTO orchestration_continuations
           (id, mission_id, owner_assignment_id, owner_attempt_id, mode, state, reason,
            cursor_sequence, deadline_at, idempotency_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ARMED', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          mission.id,
          owner.id,
          attempt.id,
          input.mode,
          input.reason,
          cursorSequence,
          input.deadlineAt ?? null,
          input.idempotencyKey,
          at,
          at,
        );
      for (const condition of input.conditions) {
        const targetId = newId('continuation_target');
        if (condition.kind === 'assignment_terminal') {
          const terminalStates = condition.states?.length
            ? [...new Set(condition.states)]
            : (['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'] satisfies AssignmentState[]);
          this.db
            .prepare(
              `INSERT INTO orchestration_continuation_targets
               (id, continuation_id, kind, target_assignment_id, terminal_states_json, created_at)
               VALUES (?, ?, 'assignment_terminal', ?, ?, ?)`,
            )
            .run(targetId, id, condition.assignmentId, JSON.stringify(terminalStates), at);
        } else {
          this.db
            .prepare(
              `INSERT INTO orchestration_continuation_targets
               (id, continuation_id, kind, from_assignment_id, message_types_json, thread_id,
                created_at)
               VALUES (?, ?, 'message', ?, ?, ?, ?)`,
            )
            .run(
              targetId,
              id,
              condition.fromAssignmentId ?? null,
              condition.types?.length ? JSON.stringify([...new Set(condition.types)]) : null,
              condition.threadId ?? null,
              at,
            );
        }
      }

      this.db
        .prepare(
          "UPDATE assignments SET state = 'WAITING', updated_at = ? WHERE id = ? AND state = 'ACTIVE'",
        )
        .run(at, owner.id);
      this.db
        .prepare(
          "UPDATE execution_attempts SET state = 'WAITING' WHERE id = ? AND state = 'RUNNING'",
        )
        .run(attempt.id);
      this.db
        .prepare(
          "UPDATE orchestration_runtime_sessions SET state = 'WAITING', updated_at = ? WHERE attempt_id = ? AND state IN ('READY','RUNNING')",
        )
        .run(at, attempt.id);
      this.appendEvent(
        mission.id,
        'continuation.armed',
        owner.assigneePrincipalId,
        owner.id,
        attempt.id,
        {
          continuationId: id,
          mode: input.mode,
          conditionCount: input.conditions.length,
          cursorSequence,
          deadlineAt: input.deadlineAt ?? null,
        },
      );
      this.reconcileContinuation(id);
      return { ...this.continuationBundle(id), reused: false };
    });
  }

  consumeContinuation(
    continuationId: string,
    ownerAssignmentId: string,
    ownerAttemptId: string,
  ): ConsumeContinuationResult {
    return this.db.transaction(() => {
      const continuation = this.requireContinuation(continuationId);
      if (
        continuation.ownerAssignmentId !== ownerAssignmentId ||
        continuation.ownerAttemptId !== ownerAttemptId
      ) {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_CALLER_MISMATCH',
          'This continuation belongs to a different Assignment Attempt.',
        );
      }
      const owner = this.requireAssignment(ownerAssignmentId);
      if (owner.activeAttemptId !== ownerAttemptId) {
        this.cancelContinuation(continuation.id, 'owner_attempt_replaced');
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_STALE',
          'The continuation owner Attempt is no longer active.',
        );
      }
      if (continuation.state === 'ARMED') {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_NOT_READY',
          'The continuation conditions have not been satisfied.',
        );
      }
      if (continuation.state === 'CANCELLED') {
        throw this.failure(
          'ORCHESTRATION_CONTINUATION_CANCELLED',
          'The continuation was cancelled before it could resume.',
        );
      }

      const reused = continuation.state === 'CONSUMED';
      if (!reused) {
        const at = this.timestamp();
        this.db
          .prepare(
            `UPDATE orchestration_continuations
             SET state = 'CONSUMED', consumed_at = COALESCE(consumed_at, ?), updated_at = ?
             WHERE id = ? AND state IN ('READY','DELIVERING','DELIVERED')`,
          )
          .run(at, at, continuation.id);
        this.db
          .prepare(
            `UPDATE orchestration_resume_intents
             SET state = 'ACKNOWLEDGED', acknowledged_at = COALESCE(acknowledged_at, ?),
                 updated_at = ?, last_error = NULL
             WHERE continuation_id = ? AND state <> 'CANCELLED'`,
          )
          .run(at, at, continuation.id);
        this.db
          .prepare(
            "UPDATE assignments SET state = 'ACTIVE', updated_at = ? WHERE id = ? AND state = 'WAITING'",
          )
          .run(at, owner.id);
        this.db
          .prepare(
            "UPDATE execution_attempts SET state = 'RUNNING' WHERE id = ? AND state = 'WAITING'",
          )
          .run(ownerAttemptId);
        this.db
          .prepare(
            "UPDATE orchestration_runtime_sessions SET state = 'RUNNING', updated_at = ? WHERE attempt_id = ? AND state = 'WAITING'",
          )
          .run(at, ownerAttemptId);
        this.appendEvent(
          continuation.missionId,
          'continuation.consumed',
          owner.assigneePrincipalId,
          owner.id,
          ownerAttemptId,
          { continuationId: continuation.id },
        );
      }

      const bundle = this.continuationBundle(continuation.id);
      const assignmentIds = [
        ...new Set(
          bundle.targets
            .map((target) => target.targetAssignmentId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const continuationMessages = this.listInbox(owner.id, {
        unreadOnly: false,
        afterSequence: bundle.continuation.cursorSequence,
        limit: 200,
      });
      this.markMessagesRead(
        owner.id,
        continuationMessages.map((message) => message.id),
      );
      return {
        ...bundle,
        reused,
        messages: this.listInbox(owner.id, {
          unreadOnly: false,
          afterSequence: bundle.continuation.cursorSequence,
          limit: 200,
        }),
        assignments: assignmentIds.map((id) => this.requireAssignment(id)),
      };
    });
  }

  getContinuation(id: string): OrchestrationContinuation | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_continuations WHERE id = ?')
      .get(id) as ContinuationRow | undefined;
    return row ? continuationFromRow(row) : null;
  }

  listContinuations(missionId: string): OrchestrationContinuation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orchestration_continuations WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as ContinuationRow[]
    ).map(continuationFromRow);
  }

  listContinuationTargets(missionId: string): OrchestrationContinuationTarget[] {
    return (
      this.db
        .prepare(
          `SELECT t.* FROM orchestration_continuation_targets t
           JOIN orchestration_continuations c ON c.id = t.continuation_id
           WHERE c.mission_id = ? ORDER BY c.created_at, t.rowid`,
        )
        .all(missionId) as unknown as ContinuationTargetRow[]
    ).map(continuationTargetFromRow);
  }

  getResumeIntent(id: string): OrchestrationResumeIntent | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_resume_intents WHERE id = ?')
      .get(id) as ResumeIntentRow | undefined;
    return row ? resumeIntentFromRow(row) : null;
  }

  listResumeIntents(missionId: string): OrchestrationResumeIntent[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM orchestration_resume_intents WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as ResumeIntentRow[]
    ).map(resumeIntentFromRow);
  }

  listPendingResumeIntents(limit = 20): OrchestrationResumeIntent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM orchestration_resume_intents
           WHERE state = 'PENDING' AND available_at <= ? ORDER BY created_at, rowid LIMIT ?`,
        )
        .all(this.timestamp(), limit) as unknown as ResumeIntentRow[]
    ).map(resumeIntentFromRow);
  }

  nextResumeIntentAvailableAt(): string | null {
    const row = this.db
      .prepare(
        "SELECT MIN(available_at) AS available_at FROM orchestration_resume_intents WHERE state = 'PENDING'",
      )
      .get() as { available_at: string | null };
    return row.available_at;
  }

  markResumeIntentProcessing(id: string, runtimeSessionId: string | null): boolean {
    return this.db.transaction(() => {
      const at = this.timestamp();
      const result = this.db
        .prepare(
          `UPDATE orchestration_resume_intents
           SET state = 'PROCESSING', runtime_session_id = ?, attempts = attempts + 1,
               updated_at = ?, last_error = NULL
           WHERE id = ? AND state = 'PENDING'`,
        )
        .run(runtimeSessionId, at, id);
      if (Number(result.changes) !== 1) return false;
      this.db
        .prepare(
          `UPDATE orchestration_continuations SET state = 'DELIVERING', updated_at = ?
           WHERE id = (SELECT continuation_id FROM orchestration_resume_intents WHERE id = ?)
             AND state = 'READY'`,
        )
        .run(at, id);
      return true;
    });
  }

  markResumeIntentDelivered(id: string): OrchestrationResumeIntent | null {
    return this.db.transaction(() => {
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE orchestration_resume_intents
           SET state = 'DELIVERED', delivered_at = COALESCE(delivered_at, ?), updated_at = ?,
               last_error = NULL WHERE id = ? AND state = 'PROCESSING'`,
        )
        .run(at, at, id);
      this.db
        .prepare(
          `UPDATE orchestration_continuations
           SET state = 'DELIVERED', delivered_at = COALESCE(delivered_at, ?), updated_at = ?
           WHERE id = (SELECT continuation_id FROM orchestration_resume_intents WHERE id = ?)
             AND state = 'DELIVERING'`,
        )
        .run(at, at, id);
      return this.getResumeIntent(id);
    });
  }

  retryResumeIntent(id: string, error: string, availableAt: string): void {
    this.db.transaction(() => {
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE orchestration_resume_intents
           SET state = 'PENDING', available_at = ?, last_error = ?, updated_at = ?
           WHERE id = ? AND state = 'PROCESSING'`,
        )
        .run(availableAt, error, at, id);
      this.db
        .prepare(
          `UPDATE orchestration_continuations SET state = 'READY', updated_at = ?
           WHERE id = (SELECT continuation_id FROM orchestration_resume_intents WHERE id = ?)
             AND state = 'DELIVERING'`,
        )
        .run(at, id);
    });
  }

  recoverAndReconcileContinuations(): { recovered: number; ready: number; cancelled: number } {
    return this.db.transaction(() => {
      const at = this.timestamp();
      const recovered = this.db
        .prepare(
          `UPDATE orchestration_resume_intents SET state = 'PENDING', available_at = ?, updated_at = ?
           WHERE state = 'PROCESSING'`,
        )
        .run(at, at);
      this.db
        .prepare(
          "UPDATE orchestration_continuations SET state = 'READY', updated_at = ? WHERE state = 'DELIVERING'",
        )
        .run(at);

      let ready = 0;
      let cancelled = 0;
      const rows = this.db
        .prepare(
          `SELECT * FROM orchestration_continuations
           WHERE state IN ('ARMED','READY','DELIVERING','DELIVERED') ORDER BY created_at`,
        )
        .all() as unknown as ContinuationRow[];
      for (const row of rows) {
        const continuation = continuationFromRow(row);
        const owner = this.getAssignment(continuation.ownerAssignmentId);
        const attempt = this.getAttempt(continuation.ownerAttemptId);
        if (
          !owner ||
          !attempt ||
          owner.activeAttemptId !== attempt.id ||
          ['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'].includes(owner.state) ||
          ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'].includes(attempt.state)
        ) {
          if (this.cancelContinuation(continuation.id, 'owner_attempt_inactive')) cancelled += 1;
          continue;
        }
        const before = continuation.state;
        const after = this.reconcileContinuation(continuation.id).continuation.state;
        if (before === 'ARMED' && after === 'READY') ready += 1;
      }
      return { recovered: Number(recovered.changes), ready, cancelled };
    });
  }

  nextContinuationDeadline(): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(deadline_at) AS deadline_at FROM orchestration_continuations
         WHERE state = 'ARMED' AND deadline_at IS NOT NULL`,
      )
      .get() as { deadline_at: string | null };
    return row.deadline_at;
  }

  hasActiveContinuationForOwner(assignmentId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM orchestration_continuations
           WHERE owner_assignment_id = ? AND state IN ('ARMED','READY','DELIVERING','DELIVERED')
           LIMIT 1`,
        )
        .get(assignmentId),
    );
  }

  recordProgress(input: {
    attemptId: string;
    principalId: string;
    phase: string;
    summary: string;
    completed?: string[];
    remaining?: string[];
    blockers?: string[];
    leaseExpiresAt?: string | null;
  }): LifecycleResult {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(input.attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      const authority = this.lifecycleAuthority(assignment, attempt, input.principalId);
      const message = this.insertMessage(
        {
          missionId: assignment.missionId,
          fromAssignmentId: assignment.id,
          toAssignmentId: assignment.supervisorAssignmentId,
          attemptId: attempt.id,
          type: 'progress',
          subject: input.phase,
          body: input.summary,
          payload: {
            completed: input.completed ?? [],
            remaining: input.remaining ?? [],
            blockers: input.blockers ?? [],
          },
        },
        authority,
      );
      if (authority) return { action: 'suppressed', message, reason: authority };
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE execution_attempts SET last_heartbeat_at = ?, lease_expires_at = ?
           WHERE id = ? AND state IN ('RUNNING','WAITING')`,
        )
        .run(at, input.leaseExpiresAt ?? attempt.leaseExpiresAt, attempt.id);
      this.db
        .prepare(
          "UPDATE orchestration_principals SET state = 'active', last_seen_at = ? WHERE id = ?",
        )
        .run(at, input.principalId);
      return {
        action: 'accepted',
        message,
        assignment: this.requireAssignment(assignment.id),
        task: this.requireTask(assignment.taskId),
      };
    });
  }

  recordHeartbeat(input: {
    attemptId: string;
    principalId: string;
    leaseExpiresAt?: string | null;
  }): LifecycleResult {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(input.attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      const authority = this.lifecycleAuthority(assignment, attempt, input.principalId);
      const message = this.insertMessage(
        {
          missionId: assignment.missionId,
          fromAssignmentId: assignment.id,
          toAssignmentId: assignment.supervisorAssignmentId,
          attemptId: attempt.id,
          type: 'heartbeat',
          subject: 'heartbeat',
          payload: { attemptId: attempt.id },
        },
        authority,
      );
      if (authority) return { action: 'suppressed', message, reason: authority };
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE execution_attempts SET last_heartbeat_at = ?, lease_expires_at = ?
           WHERE id = ? AND state IN ('RUNNING','WAITING')`,
        )
        .run(at, input.leaseExpiresAt ?? attempt.leaseExpiresAt, attempt.id);
      this.db
        .prepare(
          "UPDATE orchestration_principals SET state = 'active', last_seen_at = ? WHERE id = ?",
        )
        .run(at, input.principalId);
      return {
        action: 'accepted',
        message,
        assignment: this.requireAssignment(assignment.id),
        task: this.requireTask(assignment.taskId),
      };
    });
  }

  completeAttempt(input: CompleteAttemptInput): LifecycleResult {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(input.attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      const authority = this.lifecycleAuthority(assignment, attempt, input.principalId);
      const message = this.insertMessage(
        {
          missionId: assignment.missionId,
          fromAssignmentId: assignment.id,
          toAssignmentId: assignment.supervisorAssignmentId,
          attemptId: attempt.id,
          type: 'completion',
          subject: input.outcome,
          body: input.summary,
          payload: { outcome: input.outcome, ...(input.result ?? {}) },
        },
        authority,
      );
      if (authority) return { action: 'suppressed', message, reason: authority };

      const at = this.timestamp();
      const success = input.outcome === 'success';
      this.db
        .prepare(
          `UPDATE execution_attempts SET state = ?, result_json = ?, failure_code = ?,
           failure_json = ?, ended_at = ? WHERE id = ?`,
        )
        .run(
          success ? 'SUCCEEDED' : 'FAILED',
          success ? JSON.stringify(input.result ?? { summary: input.summary }) : null,
          success ? null : 'agent_reported_failure',
          success ? null : JSON.stringify(input.result ?? { summary: input.summary }),
          at,
          attempt.id,
        );
      this.db
        .prepare('UPDATE assignments SET state = ?, updated_at = ?, completed_at = ? WHERE id = ?')
        .run(success ? 'COMPLETED' : 'FAILED', at, at, assignment.id);
      this.db
        .prepare(
          `UPDATE mission_tasks SET state = ?, result_json = ?, version = version + 1,
           updated_at = ?, completed_at = ? WHERE id = ?`,
        )
        .run(
          success ? 'COMPLETED' : 'FAILED',
          JSON.stringify(input.result ?? { summary: input.summary }),
          at,
          at,
          assignment.taskId,
        );
      const artifacts = [
        ...(input.artifacts ?? []),
        ...[...new Set(input.filesModified ?? [])].map((path) => ({
          kind: 'file-change',
          label: path,
          reference: { path },
        })),
        ...(input.verification ?? []).map((verification) => ({
          kind: 'verification',
          label: verification.label,
          reference: { ...verification },
        })),
      ];
      for (const artifact of artifacts) {
        this.db
          .prepare(
            `INSERT INTO assignment_artifacts
             (id, mission_id, assignment_id, attempt_id, kind, label, reference_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId('artifact'),
            assignment.missionId,
            assignment.id,
            attempt.id,
            artifact.kind,
            artifact.label,
            JSON.stringify(artifact.reference),
            at,
          );
      }
      if (success) this.promoteReadyTasks(assignment.missionId, assignment.taskId, at);
      if (success) this.reconcileMissionState(assignment.missionId, at);
      if (success) {
        this.db
          .prepare(
            `UPDATE orchestration_incidents SET state = 'RECOVERED', resolved_at = ?, updated_at = ?
             WHERE assignment_id = ? AND state IN ('OPEN', 'RECOVERING')`,
          )
          .run(at, at, assignment.id);
      } else {
        this.recordIncident({
          missionId: assignment.missionId,
          assignmentId: assignment.id,
          attemptId: attempt.id,
          kind: 'agent-reported-failure',
          severity: 'error',
          summary: input.summary,
          detail: input.result ?? { summary: input.summary },
        });
      }
      this.appendEvent(
        assignment.missionId,
        success ? 'attempt.completed' : 'attempt.failed',
        input.principalId,
        assignment.id,
        attempt.id,
        { summary: input.summary },
      );
      const completedAssignment = this.requireAssignment(assignment.id);
      this.cancelOwnedContinuations(assignment.id, attempt.id, 'owner_attempt_completed');
      this.satisfyContinuationsFromAssignment(completedAssignment);
      return {
        action: 'accepted',
        message,
        assignment: completedAssignment,
        task: this.requireTask(assignment.taskId),
      };
    });
  }

  failAttemptFromRuntime(attemptId: string, code: string, failure: JsonObject): Assignment {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      if (
        assignment.activeAttemptId !== attempt.id ||
        !['STARTING', 'RUNNING', 'WAITING'].includes(attempt.state)
      ) {
        return assignment;
      }
      const at = this.timestamp();
      this.db
        .prepare(
          "UPDATE execution_attempts SET state = 'FAILED', failure_code = ?, failure_json = ?, ended_at = ? WHERE id = ?",
        )
        .run(code, JSON.stringify(failure), at, attempt.id);
      this.db
        .prepare(
          "UPDATE assignments SET state = 'FAILED', updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .run(at, at, assignment.id);
      this.db
        .prepare(
          "UPDATE mission_tasks SET state = 'FAILED', updated_at = ?, completed_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(at, at, assignment.taskId);
      this.appendEvent(
        assignment.missionId,
        'attempt.runtimeFailed',
        null,
        assignment.id,
        attempt.id,
        {
          code,
          failure,
        },
      );
      this.recordIncident({
        missionId: assignment.missionId,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        kind: code,
        severity: 'error',
        summary: 'Agent runtime failed',
        detail: failure,
      });
      const failedAssignment = this.requireAssignment(assignment.id);
      this.cancelOwnedContinuations(assignment.id, attempt.id, 'owner_runtime_failed');
      this.satisfyContinuationsFromAssignment(failedAssignment);
      return failedAssignment;
    });
  }

  pauseAssignment(
    assignmentId: string,
    paused: boolean,
    actorPrincipalId: string | null,
  ): Assignment {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      const next = paused
        ? 'PAUSED'
        : this.hasActiveContinuationForOwner(assignment.id)
          ? 'WAITING'
          : assignment.activeAttemptId
            ? 'ACTIVE'
            : 'PENDING';
      assertAssignmentTransition(assignment.state, next);
      const at = this.timestamp();
      this.db
        .prepare('UPDATE assignments SET state = ?, updated_at = ? WHERE id = ?')
        .run(next, at, assignment.id);
      this.appendEvent(
        assignment.missionId,
        paused ? 'assignment.paused' : 'assignment.resumed',
        actorPrincipalId,
        assignment.id,
        assignment.activeAttemptId,
        {},
      );
      return this.requireAssignment(assignment.id);
    });
  }

  cancelAssignment(
    assignmentId: string,
    actorPrincipalId: string | null,
    reason: string,
  ): Assignment {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(assignmentId);
      assertAssignmentTransition(assignment.state, 'CANCELLED');
      const at = this.timestamp();
      if (assignment.activeAttemptId) {
        this.db
          .prepare(
            `UPDATE execution_attempts SET state = 'CANCELLED', ended_at = ?, failure_code = 'cancelled',
             failure_json = ? WHERE id = ? AND state NOT IN ('SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','STALE')`,
          )
          .run(at, JSON.stringify({ reason }), assignment.activeAttemptId);
        const attempt = this.requireAttempt(assignment.activeAttemptId);
        if (attempt.runtimeSessionId) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO orchestration_outbox
               (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
                available_at, created_at)
               VALUES (?, ?, 'cancel-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
            )
            .run(
              newId('outbox'),
              assignment.missionId,
              assignment.id,
              `${assignment.id}:cancel:${assignment.activeAttemptId}`,
              JSON.stringify({ assignmentId, attemptId: assignment.activeAttemptId, reason }),
              at,
              at,
            );
        }
      }
      this.db
        .prepare(
          "UPDATE assignments SET state = 'CANCELLED', updated_at = ?, completed_at = ? WHERE id = ?",
        )
        .run(at, at, assignment.id);
      this.db
        .prepare(
          "UPDATE mission_tasks SET state = 'CANCELLED', updated_at = ?, completed_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(at, at, assignment.taskId);
      this.appendEvent(
        assignment.missionId,
        'assignment.cancelled',
        actorPrincipalId,
        assignment.id,
        assignment.activeAttemptId,
        { reason },
      );
      const cancelledAssignment = this.requireAssignment(assignment.id);
      this.cancelOwnedContinuations(
        assignment.id,
        assignment.activeAttemptId,
        'owner_assignment_cancelled',
      );
      this.satisfyContinuationsFromAssignment(cancelledAssignment);
      this.cancelMissionWhenAssignmentsExhausted(
        assignment.missionId,
        actorPrincipalId,
        reason,
        at,
      );
      return cancelledAssignment;
    });
  }

  promoteLead(
    missionId: string,
    assignmentId: string,
    actorPrincipalId: string | null,
    reason: string,
  ): MissionSnapshot {
    return this.db.transaction(() => {
      const mission = this.requireMission(missionId);
      const nextLead = this.requireAssignment(assignmentId);
      if (nextLead.missionId !== mission.id) {
        throw this.failure(
          'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
          'The promoted Lead must belong to this Mission.',
        );
      }
      if (!['PENDING', 'ACTIVE', 'WAITING', 'PAUSED', 'ORPHANED'].includes(nextLead.state)) {
        throw this.failure(
          'ORCHESTRATION_LEAD_NOT_AVAILABLE',
          'Only a recoverable Mission member can become Lead.',
        );
      }
      if (mission.leadAssignmentId === nextLead.id) return this.snapshot(mission.id);
      const previousLead = mission.leadAssignmentId
        ? this.requireAssignment(mission.leadAssignmentId)
        : null;
      const at = this.timestamp();
      this.db
        .prepare(
          'UPDATE assignments SET supervisor_assignment_id = NULL, updated_at = ? WHERE id = ?',
        )
        .run(at, nextLead.id);
      if (previousLead && previousLead.id !== nextLead.id) {
        this.db
          .prepare(
            'UPDATE assignments SET supervisor_assignment_id = ?, updated_at = ? WHERE id = ?',
          )
          .run(nextLead.id, at, previousLead.id);
      }
      this.db
        .prepare(
          `UPDATE missions SET lead_assignment_id = ?,
           state = CASE WHEN state = 'BLOCKED' THEN 'RUNNING' ELSE state END,
           version = version + 1, updated_at = ? WHERE id = ?`,
        )
        .run(nextLead.id, at, mission.id);
      this.appendEvent(
        mission.id,
        'mission.leadPromoted',
        actorPrincipalId,
        nextLead.id,
        nextLead.activeAttemptId,
        { previousLeadAssignmentId: previousLead?.id ?? null, reason },
      );
      return this.snapshot(mission.id);
    });
  }

  reassign(input: ReassignInput): { assignment: Assignment; attempt: ExecutionAttempt } {
    return this.db.transaction(() => {
      const assignment = this.requireAssignment(input.assignmentId);
      if (['COMPLETED', 'CANCELLED'].includes(assignment.state)) {
        throw this.failure(
          'ORCHESTRATION_ASSIGNMENT_TERMINAL',
          'A completed or cancelled Assignment cannot be reassigned.',
        );
      }
      const active = assignment.activeAttemptId
        ? this.requireAttempt(assignment.activeAttemptId)
        : null;
      this.cancelOwnedContinuations(assignment.id, active?.id ?? null, 'assignment_reassigned');
      const at = this.timestamp();
      const principalId = input.assignee.principalId ?? newId('principal');
      this.upsertPrincipal({
        id: principalId,
        kind: input.assignee.kind,
        provider: input.assignee.provider ?? null,
        externalIdentity: input.assignee.externalIdentity ?? null,
        displayName: input.assignee.displayName,
        state: 'disconnected',
        createdAt: at,
        lastSeenAt: null,
      });
      if (
        active &&
        !['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'].includes(active.state)
      ) {
        this.db
          .prepare(
            "UPDATE execution_attempts SET state = 'STALE', ended_at = ?, failure_code = 'reassigned', failure_json = ? WHERE id = ?",
          )
          .run(at, JSON.stringify({ reason: input.reason }), active.id);
        if (active.runtimeSessionId) {
          this.db
            .prepare(
              `INSERT OR IGNORE INTO orchestration_outbox
               (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
                available_at, created_at)
               VALUES (?, ?, 'cancel-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
            )
            .run(
              newId('outbox'),
              assignment.missionId,
              assignment.id,
              `${assignment.id}:reassign-cancel:${active.id}`,
              JSON.stringify({
                assignmentId: assignment.id,
                attemptId: active.id,
                reason: input.reason,
              }),
              at,
              at,
            );
        }
      }
      const ordinalRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM execution_attempts WHERE assignment_id = ?',
        )
        .get(assignment.id) as { ordinal: number };
      const attemptId = newId('attempt');
      const runtime = input.requestedRuntime ?? active?.requestedRuntime ?? 'managed';
      this.db
        .prepare(
          `INSERT INTO execution_attempts
           (id, assignment_id, ordinal, requested_runtime, requested_model, state)
           VALUES (?, ?, ?, ?, ?, 'PLANNED')`,
        )
        .run(
          attemptId,
          assignment.id,
          ordinalRow.ordinal + 1,
          runtime,
          input.requestedModel ?? active?.requestedModel ?? null,
        );
      this.db
        .prepare(
          "UPDATE assignments SET assignee_principal_id = ?, active_attempt_id = ?, state = 'PENDING', completed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(principalId, attemptId, at, assignment.id);
      this.db
        .prepare(
          `UPDATE mission_tasks
           SET state = CASE
             WHEN EXISTS (
               SELECT 1 FROM mission_task_dependencies d
               JOIN mission_tasks dependency ON dependency.id = d.depends_on_task_id
               WHERE d.task_id = mission_tasks.id AND dependency.state <> 'COMPLETED'
             ) THEN 'BLOCKED'
             ELSE 'READY'
           END,
           completed_at = NULL, updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(at, assignment.taskId);
      this.db
        .prepare(
          `UPDATE orchestration_incidents SET state = 'RECOVERING',
           automatic_attempts = automatic_attempts + 1, updated_at = ?
           WHERE assignment_id = ? AND state IN ('OPEN', 'NEEDS_ACTION')`,
        )
        .run(at, assignment.id);
      this.db
        .prepare(
          `INSERT INTO orchestration_outbox
           (id, mission_id, operation, aggregate_id, idempotency_key, payload_json, state,
            available_at, created_at)
           VALUES (?, ?, 'start-runtime', ?, ?, ?, 'PENDING', ?, ?)`,
        )
        .run(
          newId('outbox'),
          assignment.missionId,
          assignment.id,
          `${assignment.id}:reassign:${attemptId}`,
          JSON.stringify({ assignmentId: assignment.id, attemptId, reason: input.reason }),
          at,
          at,
        );
      this.appendEvent(
        assignment.missionId,
        'assignment.reassigned',
        input.actorPrincipalId,
        assignment.id,
        attemptId,
        { principalId, reason: input.reason },
      );
      return {
        assignment: this.requireAssignment(assignment.id),
        attempt: this.requireAttempt(attemptId),
      };
    });
  }

  listExpiredAttempts(at: string): ExecutionAttempt[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM execution_attempts WHERE state IN ('STARTING','RUNNING','WAITING')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < ? ORDER BY lease_expires_at`,
        )
        .all(at) as unknown as AttemptRow[]
    ).map(attemptFromRow);
  }

  renewAttemptLease(attemptId: string, leaseExpiresAt: string): ExecutionAttempt {
    const attempt = this.requireAttempt(attemptId);
    this.db
      .prepare(
        `UPDATE execution_attempts SET last_heartbeat_at = ?, lease_expires_at = ?
         WHERE id = ? AND state IN ('STARTING','RUNNING','WAITING')`,
      )
      .run(this.timestamp(), leaseExpiresAt, attempt.id);
    return this.requireAttempt(attempt.id);
  }

  orphanAttemptFromRuntime(attemptId: string, code: string, failure: JsonObject): Assignment {
    return this.db.transaction(() => {
      const attempt = this.requireAttempt(attemptId);
      const assignment = this.requireAssignment(attempt.assignmentId);
      if (assignment.activeAttemptId !== attempt.id) return assignment;
      const at = this.timestamp();
      this.db
        .prepare(
          "UPDATE execution_attempts SET state = 'STALE', ended_at = ?, failure_code = ?, failure_json = ? WHERE id = ? AND state IN ('STARTING','RUNNING','WAITING')",
        )
        .run(at, code, JSON.stringify(failure), attempt.id);
      this.db
        .prepare("UPDATE assignments SET state = 'ORPHANED', updated_at = ? WHERE id = ?")
        .run(at, assignment.id);
      const mission = this.requireMission(assignment.missionId);
      if (mission.leadAssignmentId === assignment.id && mission.state === 'RUNNING') {
        this.db
          .prepare(
            "UPDATE missions SET state = 'BLOCKED', updated_at = ?, version = version + 1 WHERE id = ?",
          )
          .run(at, mission.id);
      }
      this.insertMessage({
        missionId: assignment.missionId,
        fromAssignmentId: assignment.id,
        toAssignmentId: assignment.supervisorAssignmentId,
        attemptId: attempt.id,
        type: 'escalation',
        priority: 'urgent',
        subject: 'Runtime lost',
        body: `Runtime reconciliation failed: ${code}`,
        payload: failure,
      });
      this.appendEvent(assignment.missionId, 'attempt.orphaned', null, assignment.id, attempt.id, {
        code,
        failure,
      });
      this.recordIncident({
        missionId: assignment.missionId,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        kind: code,
        severity: mission.leadAssignmentId === assignment.id ? 'critical' : 'error',
        summary: 'Agent runtime disconnected',
        detail: failure,
      });
      const orphanedAssignment = this.requireAssignment(assignment.id);
      this.cancelOwnedContinuations(assignment.id, attempt.id, 'owner_runtime_orphaned');
      this.satisfyContinuationsFromAssignment(orphanedAssignment);
      return orphanedAssignment;
    });
  }

  setMissionState(
    missionId: string,
    state: Mission['state'],
    actorPrincipalId: string | null,
    reason: string,
  ): Mission {
    return this.db.transaction(() => {
      const mission = this.requireMission(missionId);
      if (mission.state === state) return mission;
      assertMissionTransition(mission.state, state);
      const at = this.timestamp();
      this.db
        .prepare(
          `UPDATE missions SET state = ?, version = version + 1, updated_at = ?,
           completed_at = CASE WHEN ? IN ('COMPLETED','FAILED','CANCELLED') THEN ? ELSE NULL END
           WHERE id = ?`,
        )
        .run(state, at, state, at, missionId);
      this.appendEvent(missionId, `mission.${state.toLowerCase()}`, actorPrincipalId, null, null, {
        reason,
      });
      return this.requireMission(missionId);
    });
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(id) as
      MissionRow | undefined;
    return row ? missionFromRow(row) : null;
  }

  getMissionForOriginTask(taskId: string): Mission | null {
    const row = this.db
      .prepare(
        `SELECT * FROM missions
         WHERE origin_conversation_task_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as MissionRow | undefined;
    return row ? missionFromRow(row) : null;
  }

  getMissionForRuntime(runtimeSessionId: string): Mission | null {
    const row = this.db
      .prepare(
        `SELECT m.* FROM missions m
         JOIN assignments a ON a.mission_id = m.id
         JOIN execution_attempts e ON e.assignment_id = a.id
         WHERE e.runtime_session_id = ? AND m.deleted_at IS NULL
         ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(runtimeSessionId) as MissionRow | undefined;
    return row ? missionFromRow(row) : null;
  }

  getAssignment(id: string): Assignment | null {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as
      AssignmentRow | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  getPrincipal(id: string): OrchestrationPrincipal | null {
    const row = this.db.prepare('SELECT * FROM orchestration_principals WHERE id = ?').get(id) as
      PrincipalRow | undefined;
    return row ? principalFromRow(row) : null;
  }

  getAssignmentForRuntime(runtimeSessionId: string): Assignment | null {
    const row = this.db
      .prepare(
        `SELECT a.* FROM assignments a JOIN execution_attempts e ON e.assignment_id = a.id
         WHERE e.runtime_session_id = ? ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(runtimeSessionId) as AssignmentRow | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  getAssignmentForTerminal(terminalId: string): Assignment | null {
    const row = this.db
      .prepare(
        `SELECT a.* FROM assignments a JOIN execution_attempts e ON e.assignment_id = a.id
         WHERE e.terminal_id = ? ORDER BY e.rowid DESC LIMIT 1`,
      )
      .get(terminalId) as AssignmentRow | undefined;
    return row ? assignmentFromRow(row) : null;
  }

  getAttempt(id: string): ExecutionAttempt | null {
    const row = this.db.prepare('SELECT * FROM execution_attempts WHERE id = ?').get(id) as
      AttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  listTasks(missionId: string): MissionTask[] {
    return (
      this.db
        .prepare('SELECT * FROM mission_tasks WHERE mission_id = ? ORDER BY created_at, rowid')
        .all(missionId) as unknown as TaskRow[]
    ).map(taskFromRow);
  }

  listDependencies(missionId: string): TaskDependency[] {
    return (
      this.db
        .prepare(
          `SELECT d.task_id, d.depends_on_task_id, d.created_at
           FROM mission_task_dependencies d JOIN mission_tasks t ON t.id = d.task_id
           WHERE t.mission_id = ? ORDER BY d.created_at, d.rowid`,
        )
        .all(missionId) as unknown as Array<{
        task_id: string;
        depends_on_task_id: string;
        created_at: string;
      }>
    ).map((row) => ({
      taskId: row.task_id,
      dependsOnTaskId: row.depends_on_task_id,
      createdAt: row.created_at,
    }));
  }

  listArtifacts(missionId: string): AssignmentArtifact[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM assignment_artifacts WHERE mission_id = ? ORDER BY created_at, rowid',
        )
        .all(missionId) as unknown as ArtifactRow[]
    ).map(artifactFromRow);
  }

  upsertRuntimeSession(input: {
    id: string;
    attemptId: string;
    provider: string;
    transport: OrchestrationRuntimeSession['transport'];
    externalSessionId?: string | null;
    processKey?: string | null;
    state: OrchestrationRuntimeSession['state'];
    cwd: string;
    capabilities?: JsonObject;
  }): OrchestrationRuntimeSession {
    const at = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO orchestration_runtime_sessions
         (id, attempt_id, provider, transport, external_session_id, process_key, state, cwd,
          capabilities_json, last_event_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
           provider = excluded.provider, transport = excluded.transport,
           external_session_id = excluded.external_session_id,
           process_key = excluded.process_key, state = excluded.state, cwd = excluded.cwd,
           capabilities_json = excluded.capabilities_json, updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.attemptId,
        input.provider,
        input.transport,
        input.externalSessionId ?? null,
        input.processKey ?? null,
        input.state,
        input.cwd,
        JSON.stringify(input.capabilities ?? {}),
        at,
        at,
        at,
      );
    return this.getRuntimeSessionForAttempt(input.attemptId)!;
  }

  updateRuntimeSessionState(
    attemptId: string,
    state: OrchestrationRuntimeSession['state'],
  ): OrchestrationRuntimeSession | null {
    this.db
      .prepare(
        'UPDATE orchestration_runtime_sessions SET state = ?, updated_at = ? WHERE attempt_id = ?',
      )
      .run(state, this.timestamp(), attemptId);
    return this.getRuntimeSessionForAttempt(attemptId);
  }

  appendRuntimeEvent(
    runtimeSessionId: string,
    attemptId: string,
    kind: string,
    payload: JsonObject = {},
  ): OrchestrationRuntimeEvent {
    return this.db.transaction(() => {
      const at = this.timestamp();
      const sequenceRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM orchestration_runtime_events WHERE runtime_session_id = ?',
        )
        .get(runtimeSessionId) as { sequence: number };
      const id = newId('runtime_event');
      this.db
        .prepare(
          `INSERT INTO orchestration_runtime_events
           (id, runtime_session_id, attempt_id, sequence, kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          runtimeSessionId,
          attemptId,
          sequenceRow.sequence,
          kind,
          JSON.stringify(payload),
          at,
        );
      this.db
        .prepare(
          'UPDATE orchestration_runtime_sessions SET last_event_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(at, at, runtimeSessionId);
      return {
        id,
        runtimeSessionId,
        attemptId,
        sequence: sequenceRow.sequence,
        kind,
        payload,
        createdAt: at,
      };
    });
  }

  getRuntimeSessionForAttempt(attemptId: string): OrchestrationRuntimeSession | null {
    const row = this.db
      .prepare('SELECT * FROM orchestration_runtime_sessions WHERE attempt_id = ?')
      .get(attemptId) as RuntimeSessionRow | undefined;
    return row ? runtimeSessionFromRow(row) : null;
  }

  listRuntimeSessions(missionId: string): OrchestrationRuntimeSession[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM orchestration_runtime_sessions r
           JOIN execution_attempts e ON e.id = r.attempt_id
           JOIN assignments a ON a.id = e.assignment_id
           WHERE a.mission_id = ? ORDER BY r.created_at, r.rowid`,
        )
        .all(missionId) as unknown as RuntimeSessionRow[]
    ).map(runtimeSessionFromRow);
  }

  listRuntimeEvents(missionId: string, limit = 500): OrchestrationRuntimeEvent[] {
    return (
      this.db
        .prepare(
          `SELECT e.* FROM orchestration_runtime_events e
           JOIN execution_attempts x ON x.id = e.attempt_id
           JOIN assignments a ON a.id = x.assignment_id
           WHERE a.mission_id = ? ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
        )
        .all(missionId, limit) as unknown as RuntimeEventRow[]
    )
      .map(runtimeEventFromRow)
      .reverse();
  }

  /**
   * Product snapshots need recent runtime state, not multi-megabyte raw ACP
   * tool payloads. Keep the durable event log intact for audit/replay while
   * bounding the data copied through Electron on every Mission update.
   */
  listRuntimeEventSummaries(
    missionId: string,
    limit = SNAPSHOT_RUNTIME_EVENT_LIMIT,
  ): OrchestrationRuntimeEvent[] {
    const boundedLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
    if (boundedLimit === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT
             e.id,
             e.runtime_session_id,
             e.attempt_id,
             e.sequence,
             e.kind,
             CASE
               WHEN length(CAST(e.payload_json AS BLOB)) <= ?
                 THEN e.payload_json
               ELSE '{"truncated":true,"originalBytes":'
                 || length(CAST(e.payload_json AS BLOB))
                 || '}'
             END AS payload_json,
             e.created_at
           FROM orchestration_runtime_events e
           JOIN execution_attempts x ON x.id = e.attempt_id
           JOIN assignments a ON a.id = x.assignment_id
           WHERE a.mission_id = ?
           ORDER BY e.created_at DESC, e.rowid DESC
           LIMIT ?`,
        )
        .all(
          SNAPSHOT_RUNTIME_EVENT_PAYLOAD_MAX_BYTES,
          missionId,
          boundedLimit,
        ) as unknown as RuntimeEventRow[]
    )
      .map(runtimeEventFromRow)
      .reverse();
  }

  listMessageDeliveries(missionId: string): OrchestrationMessageDelivery[] {
    return (
      this.db
        .prepare(
          `SELECT d.* FROM orchestration_message_deliveries d
           JOIN orchestration_messages m ON m.id = d.message_id
           WHERE m.mission_id = ? ORDER BY m.sequence`,
        )
        .all(missionId) as unknown as MessageDeliveryRow[]
    ).map(messageDeliveryFromRow);
  }

  listUndeliveredMessages(assignmentId?: string): OrchestrationMessage[] {
    const whereAssignment = assignmentId ? 'AND d.assignment_id = ?' : '';
    const params = assignmentId ? [assignmentId] : [];
    return (
      this.db
        .prepare(
          `SELECT m.* FROM orchestration_messages m
           JOIN orchestration_message_deliveries d ON d.message_id = m.id
           JOIN assignments a ON a.id = d.assignment_id
           WHERE d.state IN ('pending','failed') AND m.suppressed_at IS NULL
             AND a.state IN ('PENDING','ACTIVE','WAITING','PAUSED') ${whereAssignment}
           ORDER BY m.sequence`,
        )
        .all(...params) as unknown as MessageRow[]
    ).map(messageFromRow);
  }

  snapshot(
    missionId: string,
    messageLimit = 200,
    runtimeEventLimit = SNAPSHOT_RUNTIME_EVENT_LIMIT,
  ): MissionSnapshot {
    const mission = this.requireMission(missionId);
    const assignments = (
      this.db
        .prepare('SELECT * FROM assignments WHERE mission_id = ? ORDER BY created_at, rowid')
        .all(missionId) as unknown as AssignmentRow[]
    ).map(assignmentFromRow);
    const conversations = this.listConversations(missionId);
    const conversationParticipants = this.listConversationParticipants(missionId);
    const actionRequests = this.listActionRequests(missionId);
    const actionResolutions = this.listActionResolutions(missionId);
    const incidents = this.listIncidents(missionId);
    const principalIds = [
      ...new Set(
        [
          ...assignments.map((assignment) => assignment.assigneePrincipalId),
          ...conversationParticipants.map((participant) => participant.principalId),
          ...conversations.map((conversation) => conversation.createdByPrincipalId),
          ...actionRequests.flatMap((request) => [
            request.createdByPrincipalId,
            request.assignedToPrincipalId,
          ]),
          ...actionResolutions.map((resolution) => resolution.resolvedByPrincipalId),
          'user',
        ].filter((id): id is string => id !== null),
      ),
    ];
    const principals = principalIds.map((id) => this.requirePrincipal(id));
    const attempts = (
      this.db
        .prepare(
          `SELECT e.* FROM execution_attempts e JOIN assignments a ON a.id = e.assignment_id
         WHERE a.mission_id = ? ORDER BY e.rowid`,
        )
        .all(missionId) as unknown as AttemptRow[]
    ).map(attemptFromRow);
    const messages = (
      this.db
        .prepare(
          'SELECT * FROM orchestration_messages WHERE mission_id = ? ORDER BY sequence DESC LIMIT ?',
        )
        .all(missionId, messageLimit) as unknown as MessageRow[]
    )
      .map(messageFromRow)
      .reverse();
    return {
      mission,
      principals,
      conversations,
      conversationParticipants,
      actionRequests,
      actionResolutions,
      incidents,
      tasks: this.listTasks(missionId),
      dependencies: this.listDependencies(missionId),
      assignments,
      attempts,
      messages,
      artifacts: this.listArtifacts(missionId),
      runtimeSessions: this.listRuntimeSessions(missionId),
      runtimeEvents: this.listRuntimeEventSummaries(missionId, runtimeEventLimit),
      messageDeliveries: this.listMessageDeliveries(missionId),
      continuations: this.listContinuations(missionId),
      continuationTargets: this.listContinuationTargets(missionId),
      resumeIntents: this.listResumeIntents(missionId),
    };
  }

  listRecoverableMissions(): Mission[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM missions
           WHERE deleted_at IS NULL
             AND state IN ('PLANNING','RUNNING','BLOCKED','VERIFYING')
           ORDER BY updated_at`,
        )
        .all() as unknown as MissionRow[]
    ).map(missionFromRow);
  }

  /**
   * Repair the pre-contract state where every live Session had been stopped
   * and at least one Assignment was cancelled, but the Mission row remained
   * RUNNING forever. New cancellations enforce this invariant immediately;
   * startup calls this sweep once so existing local Missions converge too.
   */
  reconcileMissionsWithoutActiveAssignments(): string[] {
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(
          `SELECT m.id FROM missions m
           WHERE m.deleted_at IS NULL
             AND m.state IN ('PLANNING','RUNNING','BLOCKED','VERIFYING')
             AND EXISTS (
               SELECT 1 FROM assignments cancelled
               WHERE cancelled.mission_id = m.id AND cancelled.state = 'CANCELLED'
             )
             AND NOT EXISTS (
               SELECT 1 FROM assignments live
               WHERE live.mission_id = m.id
                 AND live.state IN ('PENDING','ACTIVE','WAITING','PAUSED','ORPHANED')
             )
           ORDER BY m.updated_at`,
        )
        .all() as Array<{ id: string }>;
      const at = this.timestamp();
      return candidates.flatMap(({ id }) =>
        this.cancelMissionWhenAssignmentsExhausted(
          id,
          null,
          'All active Mission Sessions were stopped.',
          at,
        )
          ? [id]
          : [],
      );
    });
  }

  /**
   * Product-facing Mission history. Recovery deliberately reads only live
   * Missions, while the Mission Center also needs recent terminal Missions so
   * completion, evidence and user acceptance do not disappear after restart.
   */
  listMissions(limit = 50): Mission[] {
    this.purgeExpiredTrashedMissions();
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return (
      this.db
        .prepare(
          `SELECT * FROM missions
           WHERE deleted_at IS NULL
           ORDER BY updated_at DESC, rowid DESC LIMIT ?`,
        )
        .all(boundedLimit) as unknown as MissionRow[]
    ).map(missionFromRow);
  }

  /** Recoverable Mission trash. Origin Sessions and project files are not owned
   * by this aggregate and are deliberately left untouched. */
  listDeletedMissions(limit = 50): Mission[] {
    this.purgeExpiredTrashedMissions();
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return (
      this.db
        .prepare(
          `SELECT * FROM missions
           WHERE deleted_at IS NOT NULL
           ORDER BY deleted_at DESC, rowid DESC LIMIT ?`,
        )
        .all(boundedLimit) as unknown as MissionRow[]
    ).map(missionFromRow);
  }

  trashMission(missionId: string): Mission {
    const mission = this.requireMission(missionId);
    if (!TERMINAL_MISSION_STATES.has(mission.state)) {
      throw this.failure(
        'ORCHESTRATION_MISSION_ACTIVE',
        'Cancel or finish the active Mission before deleting it.',
      );
    }
    if (mission.deletedAt) return mission;
    const at = this.timestamp();
    this.db
      .prepare(
        `UPDATE missions
         SET deleted_at = ?, updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(at, at, mission.id);
    return this.requireMission(mission.id);
  }

  restoreMission(missionId: string): Mission {
    const mission = this.requireMission(missionId);
    if (!mission.deletedAt) return mission;
    const at = this.timestamp();
    this.db
      .prepare(
        `UPDATE missions
         SET deleted_at = NULL, updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(at, mission.id);
    return this.requireMission(mission.id);
  }

  deleteMissionPermanently(missionId: string): void {
    const mission = this.requireMission(missionId);
    if (!mission.deletedAt) {
      throw this.failure(
        'ORCHESTRATION_MISSION_NOT_TRASHED',
        'Move the Mission to Recently Deleted before deleting it permanently.',
      );
    }
    this.db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id);
  }

  purgeExpiredTrashedMissions(retentionDays = MISSION_TRASH_RETENTION_DAYS): number {
    const cutoff = new Date(
      this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare('DELETE FROM missions WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
      .run(cutoff);
    return Number(result.changes ?? 0);
  }

  listPendingOutbox(limit = 20): OutboxRecord[] {
    const now = this.timestamp();
    return (
      this.db
        .prepare(
          `SELECT * FROM orchestration_outbox
         WHERE state = 'PENDING' AND available_at <= ? ORDER BY created_at LIMIT ?`,
        )
        .all(now, limit) as unknown as Array<{
        id: string;
        mission_id: string;
        operation: string;
        aggregate_id: string;
        idempotency_key: string;
        payload_json: string;
        state: OutboxRecord['state'];
        attempts: number;
        available_at: string;
        last_error: string | null;
        created_at: string;
        completed_at: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      missionId: row.mission_id,
      operation: row.operation,
      aggregateId: row.aggregate_id,
      idempotencyKey: row.idempotency_key,
      payload: parseJson(row.payload_json, {}),
      state: row.state,
      attempts: row.attempts,
      availableAt: row.available_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    }));
  }

  markOutboxProcessing(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE orchestration_outbox SET state = 'PROCESSING', attempts = attempts + 1 WHERE id = ? AND state = 'PENDING'",
      )
      .run(id);
    return Number(result.changes) === 1;
  }

  completeOutbox(id: string): void {
    this.db
      .prepare(
        "UPDATE orchestration_outbox SET state = 'COMPLETED', completed_at = ?, last_error = NULL WHERE id = ?",
      )
      .run(this.timestamp(), id);
  }

  retryOutbox(id: string, error: string, availableAt: string): void {
    this.db
      .prepare(
        "UPDATE orchestration_outbox SET state = 'PENDING', available_at = ?, last_error = ? WHERE id = ?",
      )
      .run(availableAt, error, id);
  }

  failOutbox(id: string, error: string): void {
    this.db
      .prepare(
        "UPDATE orchestration_outbox SET state = 'FAILED', completed_at = ?, last_error = ? WHERE id = ?",
      )
      .run(this.timestamp(), error, id);
  }

  recoverInterruptedOutbox(): number {
    const result = this.db
      .prepare("UPDATE orchestration_outbox SET state = 'PENDING' WHERE state = 'PROCESSING'")
      .run();
    return Number(result.changes);
  }

  private delegateResult(assignmentId: string): Omit<DelegateResult, 'reused'> {
    const assignment = this.requireAssignment(assignmentId);
    return {
      missionId: assignment.missionId,
      assignment,
      task: this.requireTask(assignment.taskId),
      attempt: this.requireAttempt(assignment.activeAttemptId!),
    };
  }

  private reconcileMissionState(missionId: string, at: string): void {
    const mission = this.requireMission(missionId);
    if (mission.state !== 'RUNNING') return;
    const tasks = this.listTasks(missionId);
    if (tasks.length === 0 || !tasks.every((task) => task.state === 'COMPLETED')) return;
    this.db
      .prepare(
        "UPDATE missions SET state = 'VERIFYING', version = version + 1, updated_at = ? WHERE id = ? AND state = 'RUNNING'",
      )
      .run(at, missionId);
    this.appendEvent(missionId, 'mission.verificationReady', null, null, null, {
      completedTasks: tasks.length,
    });
  }

  private cancelMissionWhenAssignmentsExhausted(
    missionId: string,
    actorPrincipalId: string | null,
    reason: string,
    at: string,
  ): boolean {
    const mission = this.requireMission(missionId);
    if (TERMINAL_MISSION_STATES.has(mission.state)) return false;
    const counts = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
           SUM(CASE WHEN state IN ('PENDING','ACTIVE','WAITING','PAUSED','ORPHANED')
                    THEN 1 ELSE 0 END) AS live
         FROM assignments WHERE mission_id = ?`,
      )
      .get(missionId) as { cancelled: number | null; live: number | null };
    if ((counts.cancelled ?? 0) === 0 || (counts.live ?? 0) > 0) return false;

    assertMissionTransition(mission.state, 'CANCELLED');
    this.db
      .prepare(
        `UPDATE missions SET state = 'CANCELLED', version = version + 1,
         updated_at = ?, completed_at = ? WHERE id = ?`,
      )
      .run(at, at, missionId);
    this.appendEvent(missionId, 'mission.cancelled', actorPrincipalId, null, null, {
      reason,
      source: 'assignments_exhausted',
    });
    return true;
  }

  private requireMission(id: string): Mission {
    const mission = this.getMission(id);
    if (!mission)
      throw this.failure('ORCHESTRATION_MISSION_NOT_FOUND', `Mission ${id} was not found.`);
    return mission;
  }

  private requireTask(id: string): MissionTask {
    const row = this.db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(id) as
      TaskRow | undefined;
    if (!row)
      throw this.failure('ORCHESTRATION_TASK_NOT_FOUND', `Mission task ${id} was not found.`);
    return taskFromRow(row);
  }

  private requirePrincipal(id: string): OrchestrationPrincipal {
    const principal = this.getPrincipal(id);
    if (!principal)
      throw this.failure('ORCHESTRATION_PRINCIPAL_NOT_FOUND', `Principal ${id} was not found.`);
    return principal;
  }

  private requireAssignment(id: string): Assignment {
    const assignment = this.getAssignment(id);
    if (!assignment)
      throw this.failure('ORCHESTRATION_ASSIGNMENT_NOT_FOUND', `Assignment ${id} was not found.`);
    return assignment;
  }

  private requireAttempt(id: string): ExecutionAttempt {
    const attempt = this.getAttempt(id);
    if (!attempt)
      throw this.failure('ORCHESTRATION_ATTEMPT_NOT_FOUND', `Attempt ${id} was not found.`);
    return attempt;
  }

  private requireConversation(id: string): OrchestrationConversation {
    const conversation = this.getConversation(id);
    if (!conversation) {
      throw this.failure(
        'ORCHESTRATION_CONVERSATION_NOT_FOUND',
        `Conversation ${id} was not found.`,
      );
    }
    return conversation;
  }

  private requireActionRequest(id: string): OrchestrationActionRequest {
    const request = this.getActionRequest(id);
    if (!request) {
      throw this.failure(
        'ORCHESTRATION_ACTION_REQUEST_NOT_FOUND',
        `Action Request ${id} was not found.`,
      );
    }
    return request;
  }

  private requireActionResolution(id: string): OrchestrationActionResolution {
    const row = this.db
      .prepare('SELECT * FROM orchestration_action_resolutions WHERE id = ?')
      .get(id) as ActionResolutionRow | undefined;
    if (!row) {
      throw this.failure(
        'ORCHESTRATION_ACTION_RESOLUTION_NOT_FOUND',
        `Action Resolution ${id} was not found.`,
      );
    }
    return actionResolutionFromRow(row);
  }

  private requireIncident(id: string): OrchestrationIncident {
    const row = this.db.prepare('SELECT * FROM orchestration_incidents WHERE id = ?').get(id) as
      IncidentRow | undefined;
    if (!row) {
      throw this.failure('ORCHESTRATION_INCIDENT_NOT_FOUND', `Incident ${id} was not found.`);
    }
    return incidentFromRow(row);
  }

  private upsertPrincipal(principal: OrchestrationPrincipal): void {
    this.db
      .prepare(
        `INSERT INTO orchestration_principals
         (id, kind, provider, external_identity, display_name, state, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider = excluded.provider,
           external_identity = COALESCE(excluded.external_identity, orchestration_principals.external_identity),
           display_name = excluded.display_name, state = excluded.state,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        principal.id,
        principal.kind,
        principal.provider,
        principal.externalIdentity,
        principal.displayName,
        principal.state,
        principal.createdAt,
        principal.lastSeenAt,
      );
  }

  private ensureConversation(
    missionId: string,
    requestedId: string | null,
    topic: string,
    createdByPrincipalId: string | null,
    threadId?: string | null,
  ): OrchestrationConversation {
    if (requestedId) {
      const requested = this.requireConversation(requestedId);
      if (requested.missionId !== missionId) {
        throw this.failure(
          'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
          'The Conversation belongs to another Mission.',
        );
      }
      return requested;
    }
    if (threadId) {
      const row = this.db
        .prepare(
          `SELECT c.* FROM orchestration_messages m
           JOIN orchestration_conversations c ON c.id = m.conversation_id
           WHERE m.mission_id = ? AND (m.id = ? OR m.thread_id = ?)
           ORDER BY m.sequence DESC LIMIT 1`,
        )
        .get(missionId, threadId, threadId) as ConversationRow | undefined;
      if (row) return conversationFromRow(row);
    }
    const id = newId('conversation');
    const at = this.timestamp();
    this.db
      .prepare(
        `INSERT INTO orchestration_conversations
         (id, mission_id, topic, created_by_principal_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'OPEN', ?, ?)`,
      )
      .run(id, missionId, topic, createdByPrincipalId, at, at);
    return this.requireConversation(id);
  }

  private addConversationParticipant(
    conversationId: string,
    principalId: string,
    assignmentId: string | null,
    joinedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO orchestration_conversation_participants
         (conversation_id, principal_id, assignment_id, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, principal_id) DO UPDATE SET
           assignment_id = COALESCE(excluded.assignment_id, assignment_id)`,
      )
      .run(conversationId, principalId, assignmentId, joinedAt);
  }

  private insertMessage(
    input: CreateMessageInput,
    suppressionReason?: string | null,
  ): OrchestrationMessage {
    const id = newId('message');
    const at = this.timestamp();
    const creator = input.fromAssignmentId
      ? this.requireAssignment(input.fromAssignmentId).assigneePrincipalId
      : null;
    const conversation = this.ensureConversation(
      input.missionId,
      input.conversationId ?? null,
      input.subject,
      creator,
      input.threadId ?? null,
    );
    this.db
      .prepare(
        `INSERT INTO orchestration_messages
         (id, mission_id, conversation_id, action_request_id, from_assignment_id,
          to_assignment_id, thread_id, attempt_id, type, priority, subject, body, payload_json,
          created_at, suppressed_at, suppression_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.missionId,
        conversation.id,
        input.actionRequestId ?? null,
        input.fromAssignmentId,
        input.toAssignmentId,
        input.threadId ?? null,
        input.attemptId ?? null,
        input.type,
        input.priority ?? 'normal',
        input.subject,
        input.body ?? '',
        input.payload ? JSON.stringify(input.payload) : null,
        at,
        suppressionReason ? at : null,
        suppressionReason ?? null,
      );
    if (input.fromAssignmentId) {
      const assignment = this.requireAssignment(input.fromAssignmentId);
      this.addConversationParticipant(
        conversation.id,
        assignment.assigneePrincipalId,
        assignment.id,
        at,
      );
    }
    if (input.toAssignmentId) {
      const assignment = this.requireAssignment(input.toAssignmentId);
      this.addConversationParticipant(
        conversation.id,
        assignment.assigneePrincipalId,
        assignment.id,
        at,
      );
    }
    this.db
      .prepare('UPDATE orchestration_conversations SET updated_at = ? WHERE id = ?')
      .run(at, conversation.id);
    if (input.toAssignmentId && !suppressionReason) {
      this.db
        .prepare(
          `INSERT INTO orchestration_message_deliveries
           (message_id, assignment_id, state, updated_at)
           VALUES (?, ?, 'pending', ?)`,
        )
        .run(id, input.toAssignmentId, at);
    }
    const row = this.db
      .prepare('SELECT * FROM orchestration_messages WHERE id = ?')
      .get(id) as unknown as MessageRow;
    const message = messageFromRow(row);
    if (!suppressionReason) this.satisfyContinuationsFromMessage(message);
    return message;
  }

  private requireContinuation(id: string): OrchestrationContinuation {
    const continuation = this.getContinuation(id);
    if (!continuation) {
      throw this.failure(
        'ORCHESTRATION_CONTINUATION_NOT_FOUND',
        `Continuation ${id} was not found.`,
      );
    }
    return continuation;
  }

  private continuationBundle(id: string): ContinuationBundle {
    const continuation = this.requireContinuation(id);
    const targets = (
      this.db
        .prepare(
          'SELECT * FROM orchestration_continuation_targets WHERE continuation_id = ? ORDER BY rowid',
        )
        .all(id) as unknown as ContinuationTargetRow[]
    ).map(continuationTargetFromRow);
    const intentRow = this.db
      .prepare('SELECT * FROM orchestration_resume_intents WHERE continuation_id = ?')
      .get(id) as ResumeIntentRow | undefined;
    return {
      continuation,
      targets,
      resumeIntent: intentRow ? resumeIntentFromRow(intentRow) : null,
    };
  }

  private reconcileContinuation(id: string): ContinuationBundle {
    let bundle = this.continuationBundle(id);
    if (bundle.continuation.state !== 'ARMED') return bundle;

    for (const target of bundle.targets) {
      if (target.satisfiedAt) continue;
      if (target.kind === 'assignment_terminal' && target.targetAssignmentId) {
        const assignment = this.getAssignment(target.targetAssignmentId);
        if (assignment && (target.terminalStates ?? []).includes(assignment.state)) {
          this.satisfyContinuationTarget(target.id, assignment.id, {
            kind: 'assignment_terminal',
            assignmentId: assignment.id,
            state: assignment.state,
          });
        }
        continue;
      }

      if (target.kind === 'message') {
        const clauses = [
          'mission_id = ?',
          'to_assignment_id = ?',
          'suppressed_at IS NULL',
          'sequence > ?',
        ];
        const params: Array<string | number> = [
          bundle.continuation.missionId,
          bundle.continuation.ownerAssignmentId,
          bundle.continuation.cursorSequence,
        ];
        if (target.fromAssignmentId) {
          clauses.push('from_assignment_id = ?');
          params.push(target.fromAssignmentId);
        }
        if (target.threadId) {
          clauses.push('thread_id = ?');
          params.push(target.threadId);
        }
        if (target.messageTypes?.length) {
          clauses.push(`type IN (${target.messageTypes.map(() => '?').join(',')})`);
          params.push(...target.messageTypes);
        }
        const row = this.db
          .prepare(
            `SELECT * FROM orchestration_messages WHERE ${clauses.join(' AND ')}
             ORDER BY sequence LIMIT 1`,
          )
          .get(...params) as MessageRow | undefined;
        if (row) {
          const message = messageFromRow(row);
          this.satisfyContinuationTarget(target.id, message.id, {
            kind: 'message',
            messageId: message.id,
            sequence: message.sequence,
            fromAssignmentId: message.fromAssignmentId,
            type: message.type,
            threadId: message.threadId,
            subject: message.subject,
          });
        }
      }
    }

    bundle = this.continuationBundle(id);
    const satisfied = bundle.targets.filter((target) => Boolean(target.satisfiedAt));
    const conditionsReady =
      bundle.continuation.mode === 'all'
        ? satisfied.length === bundle.targets.length
        : satisfied.length > 0;
    if (conditionsReady) {
      this.readyContinuation(id, {
        kind: 'conditions',
        satisfiedTargetIds: satisfied.map((target) => target.id),
      });
    } else if (
      bundle.continuation.deadlineAt &&
      Date.parse(bundle.continuation.deadlineAt) <= this.now().getTime()
    ) {
      this.readyContinuation(id, {
        kind: 'deadline',
        timedOut: true,
        deadlineAt: bundle.continuation.deadlineAt,
        satisfiedTargetIds: satisfied.map((target) => target.id),
      });
    }
    return this.continuationBundle(id);
  }

  private satisfyContinuationTarget(
    targetId: string,
    satisfiedBy: string,
    payload: JsonObject,
  ): boolean {
    const at = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE orchestration_continuation_targets
         SET satisfied_by = ?, satisfied_payload_json = ?, satisfied_at = ?
         WHERE id = ? AND satisfied_at IS NULL
           AND continuation_id IN (
             SELECT id FROM orchestration_continuations WHERE state = 'ARMED'
           )`,
      )
      .run(satisfiedBy, JSON.stringify(payload), at, targetId);
    return Number(result.changes) === 1;
  }

  private readyContinuation(id: string, trigger: JsonObject): boolean {
    const continuation = this.requireContinuation(id);
    if (continuation.state !== 'ARMED') return false;
    const at = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE orchestration_continuations
         SET state = 'READY', ready_at = COALESCE(ready_at, ?), updated_at = ?
         WHERE id = ? AND state = 'ARMED'`,
      )
      .run(at, at, id);
    if (Number(result.changes) !== 1) return false;
    const attempt = this.requireAttempt(continuation.ownerAttemptId);
    const intentId = newId('resume_intent');
    const payload = {
      continuationId: continuation.id,
      reason: continuation.reason,
      trigger,
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orchestration_resume_intents
         (id, continuation_id, mission_id, owner_assignment_id, owner_attempt_id,
          runtime_session_id, state, idempotency_key, payload_json, available_at, created_at,
          updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
      )
      .run(
        intentId,
        continuation.id,
        continuation.missionId,
        continuation.ownerAssignmentId,
        continuation.ownerAttemptId,
        attempt.runtimeSessionId,
        `resume:${continuation.id}`,
        JSON.stringify(payload),
        at,
        at,
        at,
      );
    this.appendEvent(
      continuation.missionId,
      'continuation.ready',
      null,
      continuation.ownerAssignmentId,
      continuation.ownerAttemptId,
      payload,
    );
    return true;
  }

  private satisfyContinuationsFromMessage(message: OrchestrationMessage): void {
    if (!message.toAssignmentId || message.suppressedAt) return;
    const rows = this.db
      .prepare(
        `SELECT t.* FROM orchestration_continuation_targets t
         JOIN orchestration_continuations c ON c.id = t.continuation_id
         WHERE c.state = 'ARMED' AND c.owner_assignment_id = ?
           AND c.mission_id = ? AND c.cursor_sequence < ?
           AND t.kind = 'message' AND t.satisfied_at IS NULL`,
      )
      .all(
        message.toAssignmentId,
        message.missionId,
        message.sequence,
      ) as unknown as ContinuationTargetRow[];
    const touched = new Set<string>();
    for (const row of rows) {
      const target = continuationTargetFromRow(row);
      if (target.fromAssignmentId && target.fromAssignmentId !== message.fromAssignmentId) continue;
      if (target.threadId && target.threadId !== message.threadId) continue;
      if (target.messageTypes?.length && !target.messageTypes.includes(message.type)) continue;
      if (
        this.satisfyContinuationTarget(target.id, message.id, {
          kind: 'message',
          messageId: message.id,
          sequence: message.sequence,
          fromAssignmentId: message.fromAssignmentId,
          type: message.type,
          threadId: message.threadId,
          subject: message.subject,
        })
      ) {
        touched.add(target.continuationId);
      }
    }
    for (const continuationId of touched) this.reconcileContinuation(continuationId);
  }

  private satisfyContinuationsFromAssignment(assignment: Assignment): void {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM orchestration_continuation_targets t
         JOIN orchestration_continuations c ON c.id = t.continuation_id
         WHERE c.state = 'ARMED' AND c.mission_id = ?
           AND t.kind = 'assignment_terminal' AND t.target_assignment_id = ?
           AND t.satisfied_at IS NULL`,
      )
      .all(assignment.missionId, assignment.id) as unknown as ContinuationTargetRow[];
    const touched = new Set<string>();
    for (const row of rows) {
      const target = continuationTargetFromRow(row);
      if (!(target.terminalStates ?? []).includes(assignment.state)) continue;
      if (
        this.satisfyContinuationTarget(target.id, assignment.id, {
          kind: 'assignment_terminal',
          assignmentId: assignment.id,
          state: assignment.state,
        })
      ) {
        touched.add(target.continuationId);
      }
    }
    for (const continuationId of touched) this.reconcileContinuation(continuationId);
  }

  private cancelOwnedContinuations(
    ownerAssignmentId: string,
    ownerAttemptId: string | null,
    reason: string,
  ): number {
    const rows = this.db
      .prepare(
        `SELECT id FROM orchestration_continuations
         WHERE owner_assignment_id = ?
           AND (? IS NULL OR owner_attempt_id = ?)
           AND state IN ('ARMED','READY','DELIVERING','DELIVERED')`,
      )
      .all(ownerAssignmentId, ownerAttemptId, ownerAttemptId) as unknown as Array<{ id: string }>;
    let cancelled = 0;
    for (const row of rows) if (this.cancelContinuation(row.id, reason)) cancelled += 1;
    return cancelled;
  }

  private cancelContinuation(id: string, reason: string): boolean {
    const continuation = this.getContinuation(id);
    if (!continuation || ['CONSUMED', 'CANCELLED'].includes(continuation.state)) return false;
    const at = this.timestamp();
    const result = this.db
      .prepare(
        `UPDATE orchestration_continuations
         SET state = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, ?), updated_at = ?
         WHERE id = ? AND state IN ('ARMED','READY','DELIVERING','DELIVERED')`,
      )
      .run(at, at, id);
    if (Number(result.changes) !== 1) return false;
    this.db
      .prepare(
        `UPDATE orchestration_resume_intents
         SET state = 'CANCELLED', last_error = ?, updated_at = ?
         WHERE continuation_id = ? AND state <> 'ACKNOWLEDGED'`,
      )
      .run(reason, at, id);
    this.appendEvent(
      continuation.missionId,
      'continuation.cancelled',
      null,
      continuation.ownerAssignmentId,
      continuation.ownerAttemptId,
      { continuationId: id, reason },
    );
    return true;
  }

  private lifecycleAuthority(
    assignment: Assignment,
    attempt: ExecutionAttempt,
    principalId: string,
  ): string | null {
    if (assignment.assigneePrincipalId !== principalId) return 'sender_not_assignee';
    if (assignment.activeAttemptId !== attempt.id) return 'inactive_attempt';
    if (!['STARTING', 'RUNNING', 'WAITING'].includes(attempt.state)) return 'attempt_not_active';
    return null;
  }

  private promoteReadyTasks(missionId: string, completedTaskId: string, at: string): void {
    const candidates = this.db
      .prepare(
        `SELECT DISTINCT t.* FROM mission_tasks t
         JOIN mission_task_dependencies d ON d.task_id = t.id
         WHERE t.mission_id = ? AND t.state = 'BLOCKED' AND d.depends_on_task_id = ?`,
      )
      .all(missionId, completedTaskId) as unknown as TaskRow[];
    for (const candidate of candidates) {
      const incomplete = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM mission_task_dependencies d
           JOIN mission_tasks dep ON dep.id = d.depends_on_task_id
           WHERE d.task_id = ? AND dep.state <> 'COMPLETED'`,
        )
        .get(candidate.id) as { count: number };
      if (incomplete.count === 0) {
        this.db
          .prepare(
            "UPDATE mission_tasks SET state = 'READY', updated_at = ?, version = version + 1 WHERE id = ?",
          )
          .run(at, candidate.id);
        this.db
          .prepare(
            `UPDATE orchestration_outbox SET available_at = ?
             WHERE state = 'PENDING' AND operation = 'start-runtime'
               AND aggregate_id IN (SELECT id FROM assignments WHERE task_id = ?)`,
          )
          .run(at, candidate.id);
        this.appendEvent(missionId, 'task.ready', null, null, null, { taskId: candidate.id });
      }
    }
  }

  private assertAssignmentMission(assignmentId: string, missionId: string): void {
    if (this.requireAssignment(assignmentId).missionId !== missionId) {
      throw this.failure('ORCHESTRATION_TARGET_MISMATCH', 'The target belongs to another Mission.');
    }
  }

  private appendEvent(
    missionId: string,
    type: string,
    actorPrincipalId: string | null,
    assignmentId: string | null,
    attemptId: string | null,
    payload: JsonObject,
  ): void {
    const durableActor =
      actorPrincipalId && this.getPrincipal(actorPrincipalId) ? actorPrincipalId : null;
    const sequence = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM mission_events WHERE mission_id = ?',
        )
        .get(missionId) as {
        next: number;
      }
    ).next;
    this.db
      .prepare(
        `INSERT INTO mission_events
         (id, mission_id, sequence, type, actor_principal_id, assignment_id, attempt_id,
          payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('mevent'),
        missionId,
        sequence,
        type,
        durableActor,
        assignmentId,
        attemptId,
        JSON.stringify(payload),
        this.timestamp(),
      );
  }

  private assertCapacity(mission: Mission): void {
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS count FROM assignments WHERE mission_id = ?')
        .get(mission.id) as {
        count: number;
      }
    ).count;
    const active = (
      this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM assignments WHERE mission_id = ? AND state IN ('PENDING','ACTIVE','WAITING','PAUSED','ORPHANED')",
        )
        .get(mission.id) as { count: number }
    ).count;
    const limits = mission.executionPolicy.limits;
    if (limits.maxTotalAgents !== null && total >= limits.maxTotalAgents) {
      throw this.failure(
        'ORCHESTRATION_TOTAL_LIMIT',
        'This Mission reached its configured Agent limit.',
      );
    }
    if (limits.maxConcurrentAgents !== null && active >= limits.maxConcurrentAgents) {
      throw this.failure(
        'ORCHESTRATION_CONCURRENCY_LIMIT',
        'This Mission reached its configured concurrency limit.',
      );
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private failure(code: string, userMessage: string): ProductFailure {
    return new ProductFailure(productError(code, { userMessage }));
  }
}
