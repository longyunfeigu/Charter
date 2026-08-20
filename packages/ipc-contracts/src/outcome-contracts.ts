import { z } from 'zod';

export const OutcomeSubjectKindSchema = z.enum(['task', 'work_item']);
export type OutcomeSubjectKind = z.infer<typeof OutcomeSubjectKindSchema>;

export const OutcomeDomainSchema = z.enum([
  'general',
  'software',
  'product',
  'finance',
  'data',
  'content',
  'design',
  'operations',
]);
export type OutcomeDomain = z.infer<typeof OutcomeDomainSchema>;

export const OutcomeLifecycleSchema = z.enum([
  'draft',
  'ready',
  'verifying',
  'verified',
  'failed',
  'blocked',
  'unverified',
]);
export type OutcomeLifecycle = z.infer<typeof OutcomeLifecycleSchema>;

export const OutcomeAcceptanceStateSchema = z.enum(['pending', 'accepted', 'rejected']);
export type OutcomeAcceptanceState = z.infer<typeof OutcomeAcceptanceStateSchema>;

export const OutcomeClaimStatusSchema = z.enum([
  'pending',
  'passed',
  'failed',
  'blocked',
  'unverified',
]);
export type OutcomeClaimStatus = z.infer<typeof OutcomeClaimStatusSchema>;

export const OutcomeVerifierSchema = z.enum(['automatic', 'agent', 'human', 'external']);
export type OutcomeVerifier = z.infer<typeof OutcomeVerifierSchema>;

export const OutcomeSeveritySchema = z.enum(['blocking', 'advisory']);
export type OutcomeSeverity = z.infer<typeof OutcomeSeveritySchema>;

export const OutcomeMethodSchema = z.enum([
  'command',
  'state',
  'journey',
  'calculation',
  'semantic',
  'visual',
  'human_review',
  'external_record',
]);
export type OutcomeMethod = z.infer<typeof OutcomeMethodSchema>;

export const OutcomeSourceSchema = z
  .object({
    kind: z.enum(['user', 'task', 'project_policy', 'domain_pack', 'external_policy']),
    reference: z.string().max(2_000),
  })
  .strict();
export type OutcomeSource = z.infer<typeof OutcomeSourceSchema>;

export const OutcomeOracleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), commandLabel: z.string().min(1).max(120) }).strict(),
  z.object({ type: z.literal('exact'), expected: z.string().max(20_000) }).strict(),
  z.object({ type: z.literal('contains'), expected: z.string().min(1).max(5_000) }).strict(),
  z
    .object({
      type: z.literal('numeric_tolerance'),
      expected: z.number().finite(),
      tolerance: z.number().finite().nonnegative(),
      unit: z.string().max(80),
    })
    .strict(),
  z
    .object({
      type: z.literal('checklist'),
      expected: z.array(z.string().min(1).max(1_000)).min(1).max(50),
    })
    .strict(),
  z
    .object({
      type: z.literal('semantic_rubric'),
      rubric: z.string().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('visual_reference'),
      reference: z.string().max(4_000),
      rubric: z.string().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('human_judgment'),
      guidance: z.string().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      type: z.literal('external_authority'),
      authority: z.string().min(1).max(1_000),
      expected: z.string().max(10_000),
    })
    .strict(),
]);
export type OutcomeOracle = z.infer<typeof OutcomeOracleSchema>;

export const OutcomeEvidenceKindSchema = z.enum([
  'note',
  'command_output',
  'screenshot',
  'trace',
  'log',
  'file',
  'link',
  'metric',
  'approval',
  'agent_report',
  'external_record',
]);
export type OutcomeEvidenceKind = z.infer<typeof OutcomeEvidenceKindSchema>;

export const OutcomeEvidenceRequirementSchema = z
  .object({
    kind: OutcomeEvidenceKindSchema,
    description: z.string().min(1).max(1_000),
    required: z.boolean(),
  })
  .strict();
export type OutcomeEvidenceRequirement = z.infer<typeof OutcomeEvidenceRequirementSchema>;

export const OutcomeEvidenceDraftSchema = z
  .object({
    kind: OutcomeEvidenceKindSchema,
    label: z.string().min(1).max(300),
    summary: z.string().max(20_000),
    reference: z.string().max(8_000),
    hash: z.string().max(256).nullable().default(null),
    source: z.enum(['system', 'agent', 'human', 'external']),
    fidelity: z.enum(['deterministic', 'native', 'observed', 'declared']),
  })
  .strict();
export type OutcomeEvidenceDraft = z.infer<typeof OutcomeEvidenceDraftSchema>;

export const OutcomeEvidenceSchema = OutcomeEvidenceDraftSchema.extend({
  id: z.string().min(1).max(120),
  claimIds: z.array(z.string().min(1).max(120)).max(100),
  capturedBy: z.string().min(1).max(500),
  capturedAt: z.string().datetime(),
  stale: z.boolean(),
}).strict();
export type OutcomeEvidence = z.infer<typeof OutcomeEvidenceSchema>;

export const OutcomeClaimDraftSchema = z
  .object({
    statement: z.string().trim().min(1).max(10_000),
    source: OutcomeSourceSchema,
    includedScope: z.array(z.string().min(1).max(1_000)).max(50).default([]),
    excludedScope: z.array(z.string().min(1).max(1_000)).max(50).default([]),
    preconditions: z.array(z.string().min(1).max(1_000)).max(50).default([]),
    method: OutcomeMethodSchema,
    oracle: OutcomeOracleSchema,
    verifier: OutcomeVerifierSchema,
    severity: OutcomeSeveritySchema,
    evidenceRequirements: z.array(OutcomeEvidenceRequirementSchema).max(20).default([]),
  })
  .strict();
export type OutcomeClaimDraft = z.infer<typeof OutcomeClaimDraftSchema>;

export const OutcomeClaimSchema = OutcomeClaimDraftSchema.extend({
  id: z.string().min(1).max(120),
  status: OutcomeClaimStatusSchema,
  actual: z.string().max(20_000),
  note: z.string().max(20_000),
  evidenceIds: z.array(z.string().min(1).max(120)).max(100),
  verifiedBy: z.string().max(500).nullable(),
  verifiedAt: z.string().datetime().nullable(),
}).strict();
export type OutcomeClaim = z.infer<typeof OutcomeClaimSchema>;

export const OutcomeAgentRunSchema = z
  .object({
    id: z.string().min(1).max(120),
    agentId: z.string().min(1).max(120),
    terminalId: z.string().min(1).max(200).nullable(),
    claimIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    status: z.enum(['pending', 'running', 'needs_user', 'completed', 'failed', 'cancelled']),
    promptHash: z.string().length(64),
    resultSource: z.enum(['native_history', 'screen']).nullable(),
    resultFidelity: z.enum(['native', 'observed']).nullable(),
    message: z.string().min(1).max(2_000),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
  })
  .strict();
export type OutcomeAgentRun = z.infer<typeof OutcomeAgentRunSchema>;

export const OutcomeDecisionSchema = z
  .object({
    id: z.string().min(1).max(120),
    decision: z.enum(['accepted', 'rejected']),
    actor: z.string().min(1).max(500),
    role: z.string().min(1).max(500),
    note: z.string().max(10_000),
    override: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type OutcomeDecision = z.infer<typeof OutcomeDecisionSchema>;

export const OutcomeAuditEventSchema = z
  .object({
    id: z.string().min(1).max(120),
    sequence: z.number().int().positive(),
    type: z.string().min(1).max(200),
    actor: z.string().min(1).max(500),
    detail: z.string().max(4_000),
    at: z.string().datetime(),
  })
  .strict();
export type OutcomeAuditEvent = z.infer<typeof OutcomeAuditEventSchema>;

export const OutcomeContractSchema = z
  .object({
    id: z.string().min(1).max(120),
    subjectKind: OutcomeSubjectKindSchema,
    subjectId: z.string().min(1).max(200),
    domain: OutcomeDomainSchema,
    title: z.string().trim().min(1).max(500),
    objective: z.string().max(20_000),
    requester: z.string().max(500),
    approver: z.string().max(500),
    lifecycle: OutcomeLifecycleSchema,
    acceptanceState: OutcomeAcceptanceStateSchema,
    revision: z.number().int().positive(),
    frozenAt: z.string().datetime().nullable(),
    acceptedAt: z.string().datetime().nullable(),
    openQuestions: z.array(z.string().min(1).max(2_000)).max(50),
    claims: z.array(OutcomeClaimSchema).max(100),
    evidence: z.array(OutcomeEvidenceSchema).max(500),
    agentRuns: z.array(OutcomeAgentRunSchema).max(50),
    decisions: z.array(OutcomeDecisionSchema).max(100),
    audit: z.array(OutcomeAuditEventSchema).max(1_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

export const OutcomeContractVersionSchema = z
  .object({
    id: z.string().min(1).max(120),
    contractId: z.string().min(1).max(120),
    revision: z.number().int().positive(),
    contract: OutcomeContractSchema,
    frozenAt: z.string().datetime(),
  })
  .strict();
export type OutcomeContractVersion = z.infer<typeof OutcomeContractVersionSchema>;

export const OutcomeContractDraftSchema = z
  .object({
    domain: OutcomeDomainSchema,
    title: z.string().trim().min(1).max(500),
    objective: z.string().max(20_000),
    requester: z.string().max(500),
    approver: z.string().max(500),
    openQuestions: z.array(z.string().min(1).max(2_000)).max(50),
    claims: z.array(OutcomeClaimDraftSchema).max(100),
  })
  .strict();
export type OutcomeContractDraft = z.infer<typeof OutcomeContractDraftSchema>;

export const OutcomePackClaimSchema = OutcomeClaimDraftSchema.extend({
  templateId: z.string().min(1).max(120),
  optional: z.boolean(),
}).strict();

export const OutcomeDomainPackSchema = z
  .object({
    id: OutcomeDomainSchema,
    name: z.string().min(1).max(120),
    audience: z.string().min(1).max(500),
    description: z.string().min(1).max(2_000),
    questions: z.array(z.string().min(1).max(1_000)).max(30),
    authorityGuidance: z.string().min(1).max(2_000),
    recommendedClaims: z.array(OutcomePackClaimSchema).max(30),
  })
  .strict();
export type OutcomeDomainPack = z.infer<typeof OutcomeDomainPackSchema>;

export const OutcomeContractSummarySchema = z
  .object({
    id: z.string(),
    subjectKind: OutcomeSubjectKindSchema,
    subjectId: z.string(),
    domain: OutcomeDomainSchema,
    lifecycle: OutcomeLifecycleSchema,
    acceptanceState: OutcomeAcceptanceStateSchema,
    revision: z.number().int().positive(),
    blockingPassed: z.number().int().nonnegative(),
    blockingTotal: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type OutcomeContractSummary = z.infer<typeof OutcomeContractSummarySchema>;
