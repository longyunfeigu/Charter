import { z } from 'zod';

export const AgentProcessStateSchema = z.enum(['running', 'exited']);
export const AgentLifecycleSchema = z.enum(['working', 'blocked', 'idle', 'unknown']);
export const AgentAttentionSchema = z.enum(['none', 'needs_user', 'done']);
export const AgentPresenceSourceSchema = z.enum([
  'structured',
  'osc',
  'screen-manifest',
  'turn',
  'process',
]);

export const AgentPresenceSnapshotSchema = z
  .object({
    terminalId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    agent: z.string().min(1),
    processState: AgentProcessStateSchema,
    lifecycle: AgentLifecycleSchema,
    attention: AgentAttentionSchema,
    source: AgentPresenceSourceSchema,
    /** Monotonic incarnation number for this terminal id. It changes only
     * when a new Agent process replaces/restarts the previous one. */
    identitySeq: z.number().int().positive(),
    stateChangeSeq: z.number().int().nonnegative(),
    changedAt: z.string().datetime(),
    message: z.string().max(300).nullable(),
    matchedRuleId: z.string().max(100).nullable(),
    manifestVersion: z.string().max(100).nullable(),
  })
  .strict();

export const AgentPresenceRuleEvaluationSchema = z
  .object({
    id: z.string().min(1).max(100),
    priority: z.number().int(),
    region: z.string().min(1).max(100),
    state: AgentLifecycleSchema,
    matched: z.boolean(),
    regionBytes: z.number().int().nonnegative(),
    regionPreview: z.string().max(500),
  })
  .strict();

export const AgentPresenceExplainSchema = z
  .object({
    snapshot: AgentPresenceSnapshotSchema,
    matchedRule: z
      .object({
        id: z.string().min(1).max(100),
        priority: z.number().int(),
        region: z.string().min(1).max(100),
        state: AgentLifecycleSchema,
        visibleIdle: z.boolean(),
        visibleBlocker: z.boolean(),
        visibleWorking: z.boolean(),
        skipStateUpdate: z.boolean(),
      })
      .strict()
      .nullable(),
    evaluatedRules: z.array(AgentPresenceRuleEvaluationSchema).max(128),
    screenPreview: z.string().max(4_000),
    oscTitle: z.string().max(500),
    fallbackReason: z.string().max(300).nullable(),
    stabilization: z
      .object({
        candidate: AgentLifecycleSchema.nullable(),
        samples: z.number().int().nonnegative(),
        requiredSamples: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type AgentProcessState = z.infer<typeof AgentProcessStateSchema>;
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;
export type AgentPresenceSource = z.infer<typeof AgentPresenceSourceSchema>;
export type AgentPresenceSnapshot = z.infer<typeof AgentPresenceSnapshotSchema>;
export type AgentPresenceRuleEvaluation = z.infer<typeof AgentPresenceRuleEvaluationSchema>;
export type AgentPresenceExplain = z.infer<typeof AgentPresenceExplainSchema>;
