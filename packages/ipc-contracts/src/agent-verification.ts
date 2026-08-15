import { z } from 'zod';
import { AgentIdSchema } from './agents.js';

export const AgentVerificationLevelSchema = z.enum([
  'unverified',
  'source_verified',
  'integration_tested',
  'locally_verified',
]);
export type AgentVerificationLevel = z.infer<typeof AgentVerificationLevelSchema>;

export const AgentVerificationCheckIdSchema = z.enum([
  'source',
  'integration',
  'installation',
  'version',
  'authentication',
  'launch',
  'prompt_response',
  'image_path',
  'image_response',
  'local',
  'ssh',
  'lifecycle_working',
  'lifecycle_needs_user',
  'lifecycle_done',
  'acp',
  'exact_resume',
  'history',
  'skills',
  'instructions',
]);
export type AgentVerificationCheckId = z.infer<typeof AgentVerificationCheckIdSchema>;

export const AgentVerificationCheckStatusSchema = z.enum([
  'passed',
  'failed',
  'available',
  'unsupported',
  'not_run',
  'needs_user',
]);
export type AgentVerificationCheckStatus = z.infer<typeof AgentVerificationCheckStatusSchema>;

export const AgentVerificationCheckSchema = z
  .object({
    id: AgentVerificationCheckIdSchema,
    label: z.string().min(1).max(100),
    status: AgentVerificationCheckStatusSchema,
    detail: z.string().min(1).max(500),
    checkedAt: z.string().datetime().nullable(),
  })
  .strict();
export type AgentVerificationCheck = z.infer<typeof AgentVerificationCheckSchema>;

export const AgentVerificationRunSchema = z
  .object({
    id: z.string().min(1).max(100),
    agentId: AgentIdSchema,
    mode: z.enum(['core', 'image']),
    target: z.enum(['local', 'ssh']),
    status: z.enum([
      'pending',
      'running',
      'needs_user',
      'passed',
      'failed',
      'cancelled',
      'timed_out',
    ]),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    terminalId: z.string().min(1).nullable(),
    checks: z.array(AgentVerificationCheckSchema).max(24),
    message: z.string().min(1).max(500),
  })
  .strict();
export type AgentVerificationRun = z.infer<typeof AgentVerificationRunSchema>;

export const AgentVerificationAgentSchema = z
  .object({
    agentId: AgentIdSchema,
    displayName: z.string().min(1).max(100),
    installed: z.boolean(),
    version: z.string().max(300).nullable(),
    level: AgentVerificationLevelSchema,
    checks: z.array(AgentVerificationCheckSchema).max(24),
    latestRuns: z.array(AgentVerificationRunSchema).max(4),
  })
  .strict();
export type AgentVerificationAgent = z.infer<typeof AgentVerificationAgentSchema>;

export const AgentVerificationSnapshotSchema = z
  .object({
    generatedAt: z.string().datetime(),
    agents: z.array(AgentVerificationAgentSchema),
    privacy: z
      .object({
        storesPrompt: z.literal(false),
        storesTerminalOutput: z.literal(false),
        storesWorkspacePath: z.literal(false),
        storesAccountIdentity: z.literal(false),
      })
      .strict(),
  })
  .strict();
export type AgentVerificationSnapshot = z.infer<typeof AgentVerificationSnapshotSchema>;

export const AgentVerificationBeginResultSchema = z
  .object({
    run: AgentVerificationRunSchema,
    /** One fixed, read-only challenge. It is intentionally returned only for
     * immediate delivery and is never written to the verification report. */
    prompt: z.string().min(1).max(2_000),
  })
  .strict();
export type AgentVerificationBeginResult = z.infer<typeof AgentVerificationBeginResultSchema>;
