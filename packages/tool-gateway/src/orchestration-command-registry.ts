import { z } from 'zod';

export const OrchestrationRuntimeSchema = z.enum(['managed', 'claude', 'codex', 'shell']);
export const OrchestrationWorkModeSchema = z.enum(['read-only', 'isolated-write', 'shared-write']);
export const OrchestrationMessageTypeSchema = z.enum([
  'assignment',
  'progress',
  'question',
  'answer',
  'escalation',
  'completion',
  'cancellation',
  'handoff',
  'heartbeat',
]);
export const OrchestrationPrioritySchema = z.enum(['normal', 'high', 'urgent']);
export const OrchestrationJsonObjectSchema = z.record(z.string(), z.unknown());

export const OrchestrationDelegateSchema = z
  .object({
    goal: z.string().min(1).max(100_000),
    title: z.string().min(1).max(300).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).default([]),
    dependencies: z.array(z.string().min(1)).max(100).optional(),
    expectedArtifacts: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    requestedRuntime: OrchestrationRuntimeSchema.default('managed'),
    requestedModel: z.string().min(1).max(300).optional(),
    workMode: OrchestrationWorkModeSchema.default('isolated-write'),
    writeScope: z.array(z.string().min(1).max(2_000)).max(500).optional(),
    reason: z.string().min(1).max(4_000),
    idempotencyKey: z.string().min(1).max(300),
  })
  .strict();

export const OrchestrationDelegateManySchema = z
  .object({
    children: z.array(OrchestrationDelegateSchema).min(1).max(50),
  })
  .strict();

export const OrchestrationMessageSchema = z
  .object({
    toAssignmentId: z.string().min(1),
    type: OrchestrationMessageTypeSchema.default('assignment'),
    priority: OrchestrationPrioritySchema.default('normal'),
    subject: z.string().min(1).max(1_000),
    body: z.string().max(100_000).default(''),
    payload: OrchestrationJsonObjectSchema.nullable().optional(),
    threadId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const OrchestrationReplySchema = z
  .object({
    messageId: z.string().min(1),
    subject: z.string().min(1).max(1_000).optional(),
    body: z.string().max(100_000),
    payload: OrchestrationJsonObjectSchema.optional(),
  })
  .strict();

export const OrchestrationWaitSchema = z
  .object({
    types: z.array(OrchestrationMessageTypeSchema).optional(),
    threadId: z.string().min(1).optional(),
    afterSequence: z.number().int().min(0).optional(),
    unreadOnly: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(100),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
    markRead: z.boolean().default(false),
  })
  .strict();

export const OrchestrationSyncSchema = z
  .object({
    afterSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(200),
    markObserved: z.boolean().default(true),
  })
  .strict();

export const OrchestrationAskSchema = z
  .object({
    toAssignmentId: z.string().min(1),
    subject: z.string().min(1).max(1_000),
    body: z.string().min(1).max(100_000),
    payload: OrchestrationJsonObjectSchema.nullable().optional(),
    priority: OrchestrationPrioritySchema.default('normal'),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
  })
  .strict();

export const OrchestrationJoinSchema = z
  .object({
    assignmentIds: z.array(z.string().min(1)).min(1).max(100),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
  })
  .strict();

export const OrchestrationProgressSchema = z
  .object({
    phase: z.string().min(1).max(300),
    summary: z.string().min(1).max(100_000),
    completed: z.array(z.string()).optional(),
    remaining: z.array(z.string()).optional(),
    blockers: z.array(z.string()).optional(),
  })
  .strict();

export const OrchestrationCompleteSchema = z
  .object({
    outcome: z.enum(['success', 'failure']),
    summary: z.string().min(1).max(100_000),
    result: OrchestrationJsonObjectSchema.optional(),
    artifacts: z
      .array(
        z
          .object({
            kind: z.string().min(1),
            label: z.string().min(1),
            reference: OrchestrationJsonObjectSchema,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    verification: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            label: z.string().min(1).max(1_000),
            state: z.string().min(1).max(100),
          })
          .catchall(z.unknown()),
      )
      .max(100)
      .optional(),
    filesModified: z.array(z.string().min(1).max(4_000)).max(2_000).optional(),
  })
  .strict();

export const OrchestrationEscalateSchema = z
  .object({
    subject: z.string().min(1).max(1_000),
    body: z.string().min(1).max(100_000),
    priority: OrchestrationPrioritySchema.default('high'),
  })
  .strict();

export const OrchestrationTargetSchema = z.object({ assignmentId: z.string().min(1) }).strict();

export const OrchestrationCancelSchema = z
  .object({
    assignmentId: z.string().min(1),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

export const OrchestrationRetrySchema = z
  .object({
    assignmentId: z.string().min(1),
    requestedRuntime: OrchestrationRuntimeSchema.optional(),
  })
  .strict();

export const OrchestrationSteerSchema = z
  .object({
    assignmentId: z.string().min(1),
    text: z.string().min(1).max(100_000),
  })
  .strict();

export const OrchestrationReassignSchema = z
  .object({
    assignmentId: z.string().min(1),
    assignee: z
      .object({
        principalId: z.string().min(1).optional(),
        kind: z.enum(['user', 'managed_agent', 'external_agent', 'shell_agent', 'system']),
        provider: z.string().nullable().optional(),
        externalIdentity: z.string().nullable().optional(),
        displayName: z.string().min(1).max(300),
      })
      .strict(),
    requestedRuntime: OrchestrationRuntimeSchema.optional(),
    requestedModel: z.string().nullable().optional(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

export const ORCHESTRATION_COMMAND_REGISTRY = [
  {
    command: 'inspect',
    description:
      'Inspect the durable Mission, Assignment tree, Task graph, active Attempt, and unread messages.',
    schema: z.object({}).strict(),
  },
  {
    command: 'sync',
    description:
      'Synchronize committed Mission messages since a sequence cursor and acknowledge observation.',
    schema: OrchestrationSyncSchema,
  },
  {
    command: 'delegate',
    description:
      'Create a durable child Task, Assignment, Attempt, and runtime under the caller Assignment.',
    schema: OrchestrationDelegateSchema,
  },
  {
    command: 'delegate_many',
    description:
      'Atomically create multiple independent child Assignments whose runtimes start in parallel.',
    schema: OrchestrationDelegateManySchema,
  },
  {
    command: 'message',
    description: 'Send a typed durable message to any Assignment in the Mission.',
    schema: OrchestrationMessageSchema,
  },
  {
    command: 'reply',
    description: 'Reply to a durable Mission message while preserving its thread.',
    schema: OrchestrationReplySchema,
  },
  {
    command: 'ask',
    description: 'Send a durable question and wait event-first for the threaded answer.',
    schema: OrchestrationAskSchema,
  },
  {
    command: 'wait',
    description: 'Wait event-first for durable Mission messages without polling terminal output.',
    schema: OrchestrationWaitSchema,
  },
  {
    command: 'join',
    description: 'Wait event-first until a set of Assignments reaches terminal states.',
    schema: OrchestrationJoinSchema,
  },
  {
    command: 'progress',
    description: 'Report structured progress and renew the active Attempt heartbeat.',
    schema: OrchestrationProgressSchema,
  },
  {
    command: 'complete',
    description: 'Complete or fail the caller active Attempt with structured evidence.',
    schema: OrchestrationCompleteSchema,
  },
  {
    command: 'escalate',
    description: 'Escalate a blocker or decision to the supervisor, Lead, or user inbox.',
    schema: OrchestrationEscalateSchema,
  },
  {
    command: 'pause',
    description: 'Pause an Assignment runtime in the Mission.',
    schema: OrchestrationTargetSchema,
  },
  {
    command: 'resume',
    description: 'Resume a paused Assignment runtime in the Mission.',
    schema: OrchestrationTargetSchema,
  },
  {
    command: 'cancel',
    description: 'Cancel an Assignment and its active runtime in the Mission.',
    schema: OrchestrationCancelSchema,
  },
  {
    command: 'retry',
    description: 'Create a fresh active Attempt for a failed Assignment.',
    schema: OrchestrationRetrySchema,
  },
  {
    command: 'steer',
    description: 'Steer the active runtime of an Assignment in the Mission.',
    schema: OrchestrationSteerSchema,
  },
  {
    command: 'reassign',
    description: 'Replace an Assignment assignee and create a fresh active Attempt.',
    schema: OrchestrationReassignSchema,
  },
] as const;

export type OrchestrationCommand = (typeof ORCHESTRATION_COMMAND_REGISTRY)[number]['command'];

export const ORCHESTRATION_COMMANDS = ORCHESTRATION_COMMAND_REGISTRY.map(
  (entry) => entry.command,
) as OrchestrationCommand[];

export const ORCHESTRATION_TOOL_NAMES = ORCHESTRATION_COMMAND_REGISTRY.map(
  (entry) => `orchestration.${entry.command}`,
);

export const ORCHESTRATION_MCP_TOOLS = ORCHESTRATION_COMMAND_REGISTRY.map((entry) => ({
  name: `orchestration_${entry.command}`,
  description: entry.description,
  inputSchema: z.toJSONSchema(entry.schema, { target: 'draft-7' }) as Record<string, unknown>,
}));

export function orchestrationCommand(command: string) {
  return ORCHESTRATION_COMMAND_REGISTRY.find((entry) => entry.command === command);
}
