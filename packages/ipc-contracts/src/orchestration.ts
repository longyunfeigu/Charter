import { z } from 'zod';

export const OrchestrationWorkerSchema = z.object({
  terminalId: z.string(),
  commanderTaskId: z.string(),
  commanderTerminalId: z.string().nullable(),
  createdAt: z.string(),
  launch: z.enum(['shell', 'claude', 'codex']),
  title: z.string(),
  projectName: z.string(),
  taskId: z.string().nullable(),
  status: z.enum(['streaming', 'quiet', 'completed', 'failed', 'exited']),
  busy: z.boolean(),
  paused: z.boolean(),
  takeover: z.boolean(),
  queuedSends: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  outputTail: z.string(),
  updatedAt: z.string(),
});

export const OrchestrationSnapshotSchema = z.object({
  enabled: z.boolean(),
  fleetPausedTaskIds: z.array(z.string()),
  workers: z.array(OrchestrationWorkerSchema),
});

export type OrchestrationWorkerDto = z.infer<typeof OrchestrationWorkerSchema>;
export type OrchestrationSnapshotDto = z.infer<typeof OrchestrationSnapshotSchema>;

export const MissionStateSchema = z.enum([
  'PLANNING',
  'RUNNING',
  'BLOCKED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const MissionTaskStateSchema = z.enum([
  'PROPOSED',
  'BLOCKED',
  'READY',
  'RUNNING',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
export const AssignmentStateSchema = z.enum([
  'PENDING',
  'ACTIVE',
  'WAITING',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ORPHANED',
]);
export const AttemptStateSchema = z.enum([
  'PLANNED',
  'STARTING',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'STALE',
]);
export const RuntimeKindSchema = z.enum(['managed', 'claude', 'codex', 'shell']);
export const PrincipalKindSchema = z.enum([
  'user',
  'managed_agent',
  'external_agent',
  'shell_agent',
  'system',
]);

const MissionExecutionPolicySchema = z.object({
  inheritHostPermissions: z.literal(true),
  controlScope: z.enum(['mission-wide', 'hierarchical']),
  workspaceRoot: z.string(),
  toolPolicy: z.literal('inherit'),
  runtimeDefaults: z.object({
    environment: z.record(z.string(), z.string()),
    preferredRuntime: RuntimeKindSchema.optional(),
    preferredModel: z.string().optional(),
  }),
  limits: z.object({
    maxConcurrentAgents: z.number().int().positive().nullable(),
    maxTotalAgents: z.number().int().positive().nullable(),
  }),
});

export const MissionDtoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  originConversationTaskId: z.string().nullable(),
  title: z.string(),
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()),
  executionPolicy: MissionExecutionPolicySchema,
  state: MissionStateSchema,
  leadAssignmentId: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable().optional(),
});
export const MissionTaskDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  parentTaskId: z.string().nullable(),
  createdByAssignmentId: z.string().nullable(),
  title: z.string(),
  goal: z.string(),
  acceptanceCriteria: z.array(z.string()),
  expectedArtifacts: z.array(z.string()),
  workMode: z.enum(['read-only', 'isolated-write', 'shared-write']),
  writeScope: z.array(z.string()).nullable(),
  state: MissionTaskStateSchema,
  result: z.record(z.string(), z.unknown()).nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export const AssignmentDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  taskId: z.string(),
  supervisorAssignmentId: z.string().nullable(),
  assigneePrincipalId: z.string(),
  activeAttemptId: z.string().nullable(),
  state: AssignmentStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export const AttemptDtoSchema = z.object({
  id: z.string(),
  assignmentId: z.string(),
  ordinal: z.number().int().positive(),
  requestedRuntime: RuntimeKindSchema,
  requestedModel: z.string().nullable(),
  runtimeSessionId: z.string().nullable(),
  terminalId: z.string().nullable(),
  state: AttemptStateSchema,
  leaseExpiresAt: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
  failure: z.record(z.string(), z.unknown()).nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
});
export const PrincipalDtoSchema = z.object({
  id: z.string(),
  kind: PrincipalKindSchema,
  provider: z.string().nullable(),
  externalIdentity: z.string().nullable(),
  displayName: z.string(),
  state: z.enum(['active', 'disconnected', 'ended']),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export const OrchestrationMessageDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  conversationId: z.string().nullable().optional(),
  actionRequestId: z.string().nullable().optional(),
  fromAssignmentId: z.string().nullable(),
  toAssignmentId: z.string().nullable(),
  threadId: z.string().nullable(),
  attemptId: z.string().nullable(),
  type: z.enum([
    'assignment',
    'progress',
    'question',
    'answer',
    'escalation',
    'completion',
    'cancellation',
    'handoff',
    'heartbeat',
  ]),
  priority: z.enum(['normal', 'high', 'urgent']),
  subject: z.string(),
  body: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  sequence: z.number().int(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  suppressedAt: z.string().nullable(),
  suppressionReason: z.string().nullable(),
});
export const ConversationDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  topic: z.string(),
  createdByPrincipalId: z.string().nullable(),
  state: z.enum(['OPEN', 'ARCHIVED']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ConversationParticipantDtoSchema = z.object({
  conversationId: z.string(),
  principalId: z.string(),
  assignmentId: z.string().nullable(),
  joinedAt: z.string(),
});
export const ActionRequestOptionDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  danger: z.boolean().optional(),
});
export const ActionRequestDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  conversationId: z.string(),
  relatedTaskId: z.string().nullable(),
  createdByPrincipalId: z.string(),
  createdByAssignmentId: z.string().nullable(),
  assignedToPrincipalId: z.string(),
  assignedToAssignmentId: z.string().nullable(),
  kind: z.enum(['information', 'review', 'approval', 'choice', 'input', 'recovery', 'escalation']),
  title: z.string(),
  context: z.string(),
  responseType: z.enum(['text', 'approval', 'choice', 'review', 'recovery']),
  options: z.array(ActionRequestOptionDtoSchema),
  recommendation: z.string().nullable(),
  impact: z.string().nullable(),
  priority: z.enum(['normal', 'high', 'urgent']),
  blockingScope: z.enum(['none', 'assignment', 'task', 'mission']),
  status: z.enum(['OPEN', 'RESOLVED', 'CANCELLED', 'EXPIRED']),
  openingMessageId: z.string().nullable(),
  idempotencyKey: z.string(),
  dueAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ActionResolutionDtoSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  resolvedByPrincipalId: z.string(),
  resolvedByAssignmentId: z.string().nullable(),
  outcome: z.string(),
  body: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  rationale: z.string().nullable(),
  idempotencyKey: z.string(),
  createdAt: z.string(),
});
export const IncidentDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  assignmentId: z.string().nullable(),
  attemptId: z.string().nullable(),
  kind: z.string(),
  severity: z.enum(['warning', 'error', 'critical']),
  state: z.enum(['OPEN', 'RECOVERING', 'RECOVERED', 'NEEDS_ACTION', 'CLOSED']),
  summary: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  automaticAttempts: z.number().int().nonnegative(),
  actionRequestId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export const AssignmentArtifactDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  assignmentId: z.string(),
  attemptId: z.string().nullable(),
  kind: z.string(),
  label: z.string(),
  reference: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export const RuntimeSessionDtoSchema = z.object({
  id: z.string(),
  attemptId: z.string(),
  provider: z.string(),
  transport: z.enum(['native', 'acp', 'terminal']),
  externalSessionId: z.string().nullable(),
  processKey: z.string().nullable(),
  state: z.enum([
    'STARTING',
    'READY',
    'RUNNING',
    'WAITING',
    'PAUSED',
    'ENDED',
    'FAILED',
    'DISCONNECTED',
  ]),
  cwd: z.string(),
  capabilities: z.record(z.string(), z.unknown()),
  lastEventAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const RuntimeEventDtoSchema = z.object({
  id: z.string(),
  runtimeSessionId: z.string(),
  attemptId: z.string(),
  sequence: z.number().int().positive(),
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export const MessageDeliveryDtoSchema = z.object({
  messageId: z.string(),
  assignmentId: z.string(),
  state: z.enum(['pending', 'delivered', 'observed', 'failed']),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  observedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export const ContinuationDtoSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  ownerAssignmentId: z.string(),
  ownerAttemptId: z.string(),
  mode: z.enum(['all', 'any']),
  state: z.enum(['ARMED', 'READY', 'DELIVERING', 'DELIVERED', 'CONSUMED', 'CANCELLED']),
  reason: z.string(),
  cursorSequence: z.number().int().nonnegative(),
  deadlineAt: z.string().nullable(),
  idempotencyKey: z.string(),
  readyAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  consumedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ContinuationTargetDtoSchema = z.object({
  id: z.string(),
  continuationId: z.string(),
  kind: z.enum(['assignment_terminal', 'message']),
  targetAssignmentId: z.string().nullable(),
  fromAssignmentId: z.string().nullable(),
  messageTypes: z
    .array(
      z.enum([
        'assignment',
        'progress',
        'question',
        'answer',
        'escalation',
        'completion',
        'cancellation',
        'handoff',
        'heartbeat',
      ]),
    )
    .nullable(),
  threadId: z.string().nullable(),
  terminalStates: z.array(AssignmentStateSchema).nullable(),
  satisfiedBy: z.string().nullable(),
  satisfiedPayload: z.record(z.string(), z.unknown()).nullable(),
  satisfiedAt: z.string().nullable(),
  createdAt: z.string(),
});
export const ResumeIntentDtoSchema = z.object({
  id: z.string(),
  continuationId: z.string(),
  missionId: z.string(),
  ownerAssignmentId: z.string(),
  ownerAttemptId: z.string(),
  runtimeSessionId: z.string().nullable(),
  state: z.enum(['PENDING', 'PROCESSING', 'DELIVERED', 'ACKNOWLEDGED', 'CANCELLED']),
  idempotencyKey: z.string(),
  payload: z.record(z.string(), z.unknown()),
  attempts: z.number().int().nonnegative(),
  availableAt: z.string(),
  lastError: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const MissionSnapshotSchema = z.object({
  mission: MissionDtoSchema,
  principals: z.array(PrincipalDtoSchema),
  conversations: z.array(ConversationDtoSchema).optional(),
  conversationParticipants: z.array(ConversationParticipantDtoSchema).optional(),
  actionRequests: z.array(ActionRequestDtoSchema).optional(),
  actionResolutions: z.array(ActionResolutionDtoSchema).optional(),
  incidents: z.array(IncidentDtoSchema).optional(),
  tasks: z.array(MissionTaskDtoSchema),
  dependencies: z.array(
    z.object({ taskId: z.string(), dependsOnTaskId: z.string(), createdAt: z.string() }),
  ),
  assignments: z.array(AssignmentDtoSchema),
  attempts: z.array(AttemptDtoSchema),
  messages: z.array(OrchestrationMessageDtoSchema),
  artifacts: z.array(AssignmentArtifactDtoSchema),
  runtimeSessions: z.array(RuntimeSessionDtoSchema).optional(),
  runtimeEvents: z.array(RuntimeEventDtoSchema).optional(),
  messageDeliveries: z.array(MessageDeliveryDtoSchema).optional(),
  continuations: z.array(ContinuationDtoSchema).optional(),
  continuationTargets: z.array(ContinuationTargetDtoSchema).optional(),
  resumeIntents: z.array(ResumeIntentDtoSchema).optional(),
});

export type MissionSnapshotDto = z.infer<typeof MissionSnapshotSchema>;
export type ConversationDto = z.infer<typeof ConversationDtoSchema>;
export type ConversationParticipantDto = z.infer<typeof ConversationParticipantDtoSchema>;
export type ActionRequestDto = z.infer<typeof ActionRequestDtoSchema>;
export type ActionResolutionDto = z.infer<typeof ActionResolutionDtoSchema>;
export type IncidentDto = z.infer<typeof IncidentDtoSchema>;
export type AssignmentDto = z.infer<typeof AssignmentDtoSchema>;
export type AttemptDto = z.infer<typeof AttemptDtoSchema>;
export type AssignmentArtifactDto = z.infer<typeof AssignmentArtifactDtoSchema>;
export type RuntimeSessionDto = z.infer<typeof RuntimeSessionDtoSchema>;
export type RuntimeEventDto = z.infer<typeof RuntimeEventDtoSchema>;
export type MessageDeliveryDto = z.infer<typeof MessageDeliveryDtoSchema>;
export type ContinuationDto = z.infer<typeof ContinuationDtoSchema>;
export type ContinuationTargetDto = z.infer<typeof ContinuationTargetDtoSchema>;
export type ResumeIntentDto = z.infer<typeof ResumeIntentDtoSchema>;
