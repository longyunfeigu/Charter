import { z } from 'zod';

export const OrchestrationRuntimeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const OrchestrationWorkModeSchema = z.enum(['read-only', 'isolated-write', 'shared-write']);
export const OrchestrationRequestedWorkModeSchema = z.enum([
  'auto',
  'read-only',
  'isolated-write',
  'shared-write',
]);
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
export const OrchestrationActionKindSchema = z.enum([
  'information',
  'review',
  'approval',
  'choice',
  'input',
  'recovery',
  'escalation',
]);
export const OrchestrationActionResponseTypeSchema = z.enum([
  'text',
  'approval',
  'choice',
  'review',
  'recovery',
]);
export const OrchestrationBlockingScopeSchema = z.enum(['none', 'assignment', 'task', 'mission']);
export const ORCHESTRATION_CONTROL_JSON_MAX_BYTES = 64 * 1024;
export const ORCHESTRATION_CONTROL_RECORD_MAX_BYTES = 128 * 1024;
export const ORCHESTRATION_CONTROL_BATCH_MAX_BYTES = 512 * 1024;

function jsonBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function boundedControlInput<T extends z.ZodType>(schema: T, maxBytes: number): T {
  return schema.superRefine((value, context) => {
    if (jsonBytes(value) <= maxBytes) return;
    context.addIssue({
      code: 'custom',
      message: `Control-plane input exceeds ${maxBytes} UTF-8 bytes. Store large content in a workspace artifact and send its reference instead.`,
    });
  }) as T;
}

export const OrchestrationJsonObjectSchema = boundedControlInput(
  z.record(z.string(), z.json()),
  ORCHESTRATION_CONTROL_JSON_MAX_BYTES,
);

export const OrchestrationInspectSchema = z
  .object({ view: z.enum(['compact', 'full']).default('compact') })
  .strict();

const OrchestrationDelegateObjectSchema = z
  .object({
    goal: z.string().min(1).max(100_000),
    title: z.string().min(1).max(300).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).default([]),
    dependencies: z.array(z.string().min(1)).max(100).optional(),
    expectedArtifacts: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    requestedRuntime: OrchestrationRuntimeSchema.default('managed'),
    requestedModel: z.string().min(1).max(300).optional(),
    workMode: OrchestrationRequestedWorkModeSchema.default('auto'),
    writeScope: z.array(z.string().min(1).max(2_000)).max(500).optional(),
    reason: z.string().min(1).max(4_000),
    idempotencyKey: z.string().min(1).max(300),
  })
  .strict();

export const OrchestrationDelegateSchema = boundedControlInput(
  OrchestrationDelegateObjectSchema,
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

const OrchestrationBatchKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const OrchestrationDelegateBatchChildSchema = OrchestrationDelegateObjectSchema.extend({
  key: OrchestrationBatchKeySchema.optional(),
  dependsOn: z.array(OrchestrationBatchKeySchema).max(50).optional(),
}).strict();

export const OrchestrationIntegrationPlanSchema = z
  .object({
    mode: z.enum(['auto', 'none']).default('auto'),
    title: z.string().min(1).max(300).optional(),
    requestedRuntime: OrchestrationRuntimeSchema.optional(),
    requestedModel: z.string().min(1).max(300).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(4_000)).max(100).optional(),
  })
  .strict();

export const OrchestrationDelegateManySchema = boundedControlInput(
  z
    .object({
      children: z.array(OrchestrationDelegateBatchChildSchema).min(1).max(50),
      integration: OrchestrationIntegrationPlanSchema.default({ mode: 'auto' }),
    })
    .strict(),
  ORCHESTRATION_CONTROL_BATCH_MAX_BYTES,
);

export const OrchestrationPromoteSchema = boundedControlInput(
  z
    .object({
      reason: z.string().min(1).max(4_000),
      children: z.array(OrchestrationDelegateBatchChildSchema).min(1).max(50),
      integration: OrchestrationIntegrationPlanSchema.default({ mode: 'auto' }),
    })
    .strict(),
  ORCHESTRATION_CONTROL_BATCH_MAX_BYTES,
);

export const OrchestrationMessageSchema = boundedControlInput(
  z
    .object({
      toAssignmentId: z.string().min(1),
      type: OrchestrationMessageTypeSchema.default('assignment'),
      priority: OrchestrationPrioritySchema.default('normal'),
      subject: z.string().min(1).max(1_000),
      body: z.string().max(100_000).default(''),
      payload: OrchestrationJsonObjectSchema.nullable().optional(),
      threadId: z.string().min(1).nullable().optional(),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationReplySchema = boundedControlInput(
  z
    .object({
      messageId: z.string().min(1),
      subject: z.string().min(1).max(1_000).optional(),
      body: z.string().max(100_000),
      payload: OrchestrationJsonObjectSchema.optional(),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

const OrchestrationActionOptionsSchema = z
  .array(
    z
      .object({
        id: z.string().min(1).max(100),
        label: z.string().min(1).max(300),
        description: z.string().min(1).max(2_000).optional(),
        recommended: z.boolean().optional(),
        danger: z.boolean().optional(),
      })
      .strict(),
  )
  .max(20);

export const OrchestrationRequestSchema = boundedControlInput(
  z
    .object({
      toAssignmentId: z.string().min(1),
      kind: OrchestrationActionKindSchema.default('information'),
      title: z.string().min(1).max(1_000),
      context: z.string().max(100_000).default(''),
      responseType: OrchestrationActionResponseTypeSchema.default('text'),
      options: OrchestrationActionOptionsSchema.optional(),
      recommendation: z.string().max(10_000).nullable().optional(),
      impact: z.string().max(10_000).nullable().optional(),
      priority: OrchestrationPrioritySchema.default('normal'),
      blockingScope: OrchestrationBlockingScopeSchema.default('none'),
      relatedTaskId: z.string().min(1).nullable().optional(),
      conversationId: z.string().min(1).nullable().optional(),
      dueAt: z.string().datetime().nullable().optional(),
      idempotencyKey: z.string().min(1).max(300),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationDecisionRequestSchema = boundedControlInput(
  z
    .object({
      kind: z.enum(['approval', 'choice', 'input', 'review', 'recovery']).default('choice'),
      title: z.string().min(1).max(1_000),
      context: z.string().max(100_000).default(''),
      responseType: OrchestrationActionResponseTypeSchema,
      options: OrchestrationActionOptionsSchema.optional(),
      recommendation: z.string().max(10_000).nullable().optional(),
      impact: z.string().min(1).max(10_000),
      priority: OrchestrationPrioritySchema.default('high'),
      blockingScope: OrchestrationBlockingScopeSchema.default('mission'),
      relatedTaskId: z.string().min(1).nullable().optional(),
      conversationId: z.string().min(1).nullable().optional(),
      dueAt: z.string().datetime().nullable().optional(),
      idempotencyKey: z.string().min(1).max(300),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationResolveRequestSchema = boundedControlInput(
  z
    .object({
      requestId: z.string().min(1),
      outcome: z.string().min(1).max(300),
      body: z.string().max(100_000).optional(),
      payload: OrchestrationJsonObjectSchema.nullable().optional(),
      rationale: z.string().max(10_000).nullable().optional(),
      idempotencyKey: z.string().min(1).max(300),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationWaitSchema = z
  .object({
    types: z.array(OrchestrationMessageTypeSchema).optional(),
    threadId: z.string().min(1).optional(),
    afterSequence: z.number().int().min(0).optional(),
    unreadOnly: z.boolean().default(true),
    limit: z.number().int().min(1).max(100).default(100),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(30_000),
    // A blocking wait hands the messages to the caller, so observation is the
    // safe default. Diagnostics may still opt into a non-consuming peek with
    // markRead:false.
    markRead: z.boolean().default(true),
  })
  .strict();

export const OrchestrationSyncSchema = z
  .object({
    afterSequence: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(200),
    markObserved: z.boolean().default(true),
  })
  .strict();

export const OrchestrationAskSchema = boundedControlInput(
  z
    .object({
      toAssignmentId: z.string().min(1),
      subject: z.string().min(1).max(1_000),
      body: z.string().min(1).max(100_000),
      payload: OrchestrationJsonObjectSchema.nullable().optional(),
      priority: OrchestrationPrioritySchema.default('normal'),
      timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationJoinSchema = z
  .object({
    assignmentIds: z.array(z.string().min(1)).min(1).max(100),
    timeoutMs: z.number().int().min(1).max(3_600_000).default(600_000),
  })
  .strict();

const OrchestrationTerminalAssignmentStateSchema = z.enum([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ORPHANED',
]);

export const OrchestrationContinuationConditionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('assignment_terminal'),
      assignmentId: z.string().min(1),
      states: z.array(OrchestrationTerminalAssignmentStateSchema).min(1).max(4).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      fromAssignmentId: z.string().min(1).nullable().optional(),
      types: z.array(OrchestrationMessageTypeSchema).min(1).max(9).optional(),
      threadId: z.string().min(1).nullable().optional(),
    })
    .strict(),
]);

export const OrchestrationParkSchema = boundedControlInput(
  z
    .object({
      mode: z.enum(['all', 'any']).default('all'),
      conditions: z.array(OrchestrationContinuationConditionSchema).min(1).max(100),
      afterSequence: z.number().int().min(0).default(0),
      timeoutMs: z
        .number()
        .int()
        .min(1_000)
        .max(30 * 24 * 60 * 60 * 1_000)
        .optional(),
      reason: z.string().min(1).max(4_000),
      idempotencyKey: z.string().min(1).max(300),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationContinueSchema = z
  .object({
    continuationId: z.string().min(1),
  })
  .strict();

export const OrchestrationProgressSchema = boundedControlInput(
  z
    .object({
      phase: z.string().min(1).max(300),
      summary: z.string().min(1).max(100_000),
      completed: z.array(z.string()).optional(),
      remaining: z.array(z.string()).optional(),
      blockers: z.array(z.string()).optional(),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

export const OrchestrationCompleteSchema = boundedControlInput(
  z
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
    .strict(),
  ORCHESTRATION_CONTROL_BATCH_MAX_BYTES,
);

export const OrchestrationEscalateSchema = boundedControlInput(
  z
    .object({
      subject: z.string().min(1).max(1_000),
      body: z.string().min(1).max(100_000),
      priority: OrchestrationPrioritySchema.default('high'),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

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

export const OrchestrationSteerSchema = boundedControlInput(
  z
    .object({
      assignmentId: z.string().min(1),
      text: z.string().min(1).max(100_000),
    })
    .strict(),
  ORCHESTRATION_CONTROL_RECORD_MAX_BYTES,
);

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
    command: 'promote',
    description:
      'Promote the current ordinary Session into a Mission and atomically start a validated delegation plan.',
    schema: OrchestrationPromoteSchema,
  },
  {
    command: 'inspect',
    description:
      'Inspect the durable Mission, Assignment tree, Task graph, active Attempt, and unread messages.',
    schema: OrchestrationInspectSchema,
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
    description:
      'Send durable FYI/progress context to an Assignment; this never creates an actionable request.',
    schema: OrchestrationMessageSchema,
  },
  {
    command: 'request',
    description: 'Assign an explicit durable Action Request to another Agent Assignment.',
    schema: OrchestrationRequestSchema,
  },
  {
    command: 'request_decision',
    description:
      'Mission Lead only: assign an irreducible typed decision to the user Your actions inbox.',
    schema: OrchestrationDecisionRequestSchema,
  },
  {
    command: 'resolve_request',
    description: 'Resolve an Action Request assigned to the caller with a typed outcome.',
    schema: OrchestrationResolveRequestSchema,
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
    command: 'park',
    description:
      'Persist continuation conditions, end the current turn, and let Charter resume this exact Session when they match.',
    schema: OrchestrationParkSchema,
  },
  {
    command: 'continue',
    description:
      'Acknowledge a Charter resume intent idempotently and return the committed continuation context.',
    schema: OrchestrationContinueSchema,
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
