import { z } from 'zod';

export const AgentModeSchema = z.enum(['ask', 'edit', 'auto', 'full']);
export const TaskStateSchema = z.enum([
  'DRAFT',
  'READY',
  'EXPLORING',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_PERMISSION',
  'VERIFYING',
  'REVIEW_READY',
  'ACCEPTED',
  'ROLLED_BACK',
  'INTERRUPTED',
  'FAILED',
  'CANCELLED',
  'ARCHIVED',
]);

export const ModelRefSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  thinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
});

export const VerificationCommandSchema = z.object({
  label: z.string().min(1).max(120),
  executable: z.string().min(1).max(200),
  args: z.array(z.string().max(500)).max(50),
  cwd: z.string().max(500).default(''),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(30 * 60 * 1000)
    .default(300000),
});

/** Worktree isolation metadata (ADR-0009): the task runs in its own git worktree. */
export const TaskWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string(),
  baseHead: z.string().nullable(),
  baseBranch: z.string().nullable(),
  /** The worktree directory no longer exists on disk (deleted externally). */
  missing: z.boolean().optional(),
});
export type TaskWorktreeDto = z.infer<typeof TaskWorktreeSchema>;

export const TaskDtoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  goalMd: z.string(),
  acceptance: z.array(z.string()),
  mode: AgentModeSchema,
  state: TaskStateSchema,
  model: ModelRefSchema,
  verification: z.array(VerificationCommandSchema),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  gitBaseline: z.object({ head: z.string().nullable(), branch: z.string().nullable() }).nullable(),
  /** ADR-0009: tasks are global citizens — the project is an attribute. */
  projectName: z.string(),
  projectPath: z.string(),
  /** Net changed-file count recorded at run finalization; null before then. */
  changedFiles: z.number().int().nullable(),
  worktree: TaskWorktreeSchema.nullable(),
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const TimelineEventDtoSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sequence: z.number().int(),
  type: z.string(),
  schemaVersion: z.number().int(),
  at: z.string(),
  payload: z.unknown(),
});
export type TimelineEventDto = z.infer<typeof TimelineEventDtoSchema>;

export const RiskLevelSchema = z.enum(['R0', 'R1', 'R2', 'R3', 'R4']);

/** Approval card shown to the user (§13.3, PERM-004). */
export const PermissionCardDtoSchema = z.object({
  requestId: z.string(),
  callId: z.string(),
  runId: z.string(),
  taskId: z.string(),
  toolName: z.string(),
  toolDescription: z.string(),
  reason: z.string().nullable(),
  risk: z.object({ level: RiskLevelSchema, reasons: z.array(z.string()) }),
  preview: z.object({
    summary: z.string(),
    detail: z.string().optional(),
    diff: z.string().nullable().optional(),
    command: z
      .object({ executable: z.string(), args: z.array(z.string()), cwd: z.string() })
      .nullable()
      .optional(),
    targets: z.array(z.string()).optional(),
  }),
  input: z.unknown(),
  paramsHash: z.string(),
  options: z.object({
    allowScopes: z.array(z.enum(['once', 'task', 'workspace'])),
    denyScopes: z.array(z.enum(['once', 'always'])),
  }),
  createdAt: z.string(),
});
export type PermissionCardDto = z.infer<typeof PermissionCardDtoSchema>;

/** Clarifying question raised by the ask_user tool. */
export const AskUserPromptDtoSchema = z.object({
  callId: z.string(),
  taskId: z.string(),
  runId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  allowFreeForm: z.boolean(),
  createdAt: z.string(),
});
export type AskUserPromptDto = z.infer<typeof AskUserPromptDtoSchema>;

/** Structured task plan (§13.2). */
export const PlanStepDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped', 'blocked']),
  expectedFiles: z.array(z.string()).optional(),
  verification: z.string().optional(),
});
export const TaskPlanDtoSchema = z.object({
  version: z.number().int(),
  summary: z.string(),
  steps: z.array(PlanStepDtoSchema),
});
export type TaskPlanDto = z.infer<typeof TaskPlanDtoSchema>;

/** User edit of a proposed plan: text/order only; status is preserved server-side. */
export const PlanEditDtoSchema = z.object({
  summary: z.string().min(1).max(2000).optional(),
  steps: z
    .array(
      z.object({
        id: z.string().max(100).optional(),
        title: z.string().min(1).max(300),
        description: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(30),
});
export type PlanEditDto = z.infer<typeof PlanEditDtoSchema>;

/** One reviewable hunk of a file's net diff (CHG-007/008). */
export const ReviewHunkDtoSchema = z.object({
  key: z.string(),
  header: z.string(),
  lines: z.array(z.string()),
  state: z.enum(['pending', 'accepted', 'rejected']),
});
export type ReviewHunkDto = z.infer<typeof ReviewHunkDtoSchema>;

export const ChangeSetFileDtoSchema = z.object({
  path: z.string(),
  status: z.enum(['created', 'modified', 'deleted', 'renamed']),
  renamedFrom: z.string().nullable(),
  binary: z.boolean(),
  additions: z.number().int(),
  deletions: z.number().int(),
  currentHash: z.string().nullable(),
  reviewState: z.enum(['pending', 'accepted', 'rejected', 'partial']),
  hunks: z.array(ReviewHunkDtoSchema),
});
export type ChangeSetFileDto = z.infer<typeof ChangeSetFileDtoSchema>;

export const ChangeSetDtoSchema = z.object({
  taskId: z.string(),
  files: z.array(ChangeSetFileDtoSchema),
  totalAdditions: z.number().int(),
  totalDeletions: z.number().int(),
});
export type ChangeSetDto = z.infer<typeof ChangeSetDtoSchema>;

/** One verification run (VER-003/005/008). */
export const VerificationRunDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(['running', 'passed', 'failed', 'timeout', 'cancelled']),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  stale: z.boolean(),
  superseded: z.boolean(),
  outputExcerpt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type VerificationRunDto = z.infer<typeof VerificationRunDtoSchema>;

export const ModelDescriptorDtoSchema = z.object({
  providerId: z.string(),
  providerName: z.string(),
  modelId: z.string(),
  displayName: z.string(),
  contextWindow: z.number().nullable(),
  supportsThinking: z.boolean(),
  supportedThinkingLevels: z
    .array(z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']))
    .default(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  configured: z.boolean(),
  authKind: z.enum(['api-key', 'oauth', 'none', 'unknown']),
});
export type ModelDescriptorDto = z.infer<typeof ModelDescriptorDtoSchema>;
