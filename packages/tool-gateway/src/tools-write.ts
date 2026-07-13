import { z } from 'zod';
import { applyPatch as applyUnifiedPatch, createTwoFilesPatch } from 'diff';
import { productError, ProductFailure } from '@pi-ide/foundation';
import type { ChangeService } from '@pi-ide/change-service';
import type { DocumentStore } from '@pi-ide/document-service';
import type { PlanStep, TaskPlan } from '@pi-ide/agent-contract';
import type { PermissionDecider, ToolGateway } from './gateway.js';

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'apply_patch',
  'create_file',
  'delete_file',
  'rename_file',
]);
export const PLAN_TOOL_NAMES: ReadonlySet<string> = new Set(['propose_plan', 'update_plan']);

export interface ProposedPlanInput {
  summary: string;
  steps: Array<{
    title: string;
    description?: string;
    expectedFiles?: string[];
    verification?: string;
  }>;
}

export interface PlanStepUpdate {
  id: string;
  status: PlanStep['status'];
}

/**
 * The plan approval boundary (AG-007/008). propose() blocks until the user
 * decides (edit mode) or the mode policy auto-approves (auto mode); rejection
 * is thrown as PLAN_REJECTED and the task is cancelled by the host.
 */
export interface PlanGate {
  propose(
    input: { taskId: string; runId: string; callId: string; plan: ProposedPlanInput },
    signal: AbortSignal,
  ): Promise<
    | { decision: 'approved' | 'edited'; plan: TaskPlan }
    /** ADR-0009: the user asked for revisions — propose a new plan version. */
    | { decision: 'changes_requested'; plan: TaskPlan; feedback: string }
  >;
  update(input: { taskId: string; updates: PlanStepUpdate[]; note?: string }): Promise<TaskPlan>;
}

/**
 * Wraps the permission engine with the M8 plan policy: plan tools are
 * interactive and never need engine approval; write tools in edit/auto are
 * refused until the task has an approved plan (AG-007).
 */
export function createPlanAwarePermission(
  inner: PermissionDecider,
  options: { planApproved(taskId: string): boolean },
): PermissionDecider {
  return {
    async decide(input) {
      const name = input.tool.name;
      if (PLAN_TOOL_NAMES.has(name)) return { kind: 'allow', scope: 'auto' };
      if (
        WRITE_TOOL_NAMES.has(name) &&
        (input.mode === 'edit' || input.mode === 'auto') &&
        !options.planApproved(input.call.taskId)
      ) {
        return {
          kind: 'deny',
          reason:
            'A structured plan must be proposed and approved before the first file modification. Call propose_plan with your step-by-step plan, wait for approval, then retry this change.',
          permanent: false,
        };
      }
      return inner.decide(input);
    },
  };
}

export interface WriteToolServices {
  root: string;
  changes: () => ChangeService | null;
  documents: DocumentStore;
  planGate: PlanGate;
}

const CONTENT_MAX = 512 * 1024;

function mustChanges(services: WriteToolServices): ChangeService {
  const changes = services.changes();
  if (!changes) {
    throw new ProductFailure(
      productError('CHG_NO_WORKSPACE', {
        userMessage: 'No workspace is open, so file changes are not possible.',
      }),
    );
  }
  return changes;
}

/** Write + plan tools (TOOL-003 write set, M8-01/02). All writes go through the ChangeService. */
export function registerWriteTools(gateway: ToolGateway, services: WriteToolServices): void {
  gateway.register({
    name: 'apply_patch',
    version: 1,
    description:
      'Apply a unified diff to one workspace text file. baseHash must be the hash returned by the read_file call you based the patch on; if the file changed since, the patch is rejected with CHG_VERSION_CONFLICT and you must re-read.',
    promptGuidance:
      'Always read_file first and pass its hash as baseHash. Keep patches minimal and focused.',
    inputSchema: z
      .object({
        path: z.string().min(1).max(1000),
        patch: z.string().min(1).max(CONTENT_MAX),
        baseHash: z.string().min(8).max(128),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    risk: () => ({ level: 'R1', reasons: ['reversible workspace write (patch)'] }),
    preview: async (input) => {
      let diff: string | null = null;
      try {
        const current = await services.documents.readLogical(input.path);
        if (!current.binary && current.hash === input.baseHash) {
          const next = applyUnifiedPatch(current.content, input.patch);
          if (next !== false) {
            diff = createTwoFilesPatch(input.path, input.path, current.content, next, '', '');
          }
        }
      } catch {
        // fall through to the raw proposed patch
      }
      return {
        summary: `Patch ${input.path}`,
        detail: `why: ${input.reason}`,
        diff: diff ?? input.patch,
        targets: [input.path],
        ruleKey: 'write:apply_patch',
      };
    },
    async execute(input, _signal, call) {
      const changes = mustChanges(services);
      const result = await changes.applyPatch(call.taskId, call.callId, input);
      return {
        code: 'OK',
        summary: `Patched ${input.path} (+${result.additions}/-${result.deletions}).`,
        data: result,
      };
    },
  });

  gateway.register({
    name: 'create_file',
    version: 1,
    description:
      'Create a new workspace text file. Fails with CHG_ALREADY_EXISTS if the file exists — it never overwrites.',
    inputSchema: z
      .object({
        path: z.string().min(1).max(1000),
        content: z.string().max(CONTENT_MAX),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    risk: () => ({ level: 'R1', reasons: ['creates a new workspace file (reversible)'] }),
    preview: async (input) => ({
      summary: `Create ${input.path}`,
      detail: `why: ${input.reason}`,
      diff: createTwoFilesPatch(input.path, input.path, '', input.content, '', ''),
      targets: [input.path],
      ruleKey: 'write:create_file',
    }),
    async execute(input, _signal, call) {
      const changes = mustChanges(services);
      const result = await changes.createFile(call.taskId, call.callId, input);
      return {
        code: 'OK',
        summary: `Created ${input.path}.`,
        data: result,
      };
    },
  });

  gateway.register({
    name: 'delete_file',
    version: 1,
    description:
      'Delete one workspace file. High risk (R3): always requires explicit user confirmation; a snapshot is taken first so the review can restore it.',
    inputSchema: z
      .object({
        path: z.string().min(1).max(1000),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    risk: () => ({
      level: 'R3',
      reasons: ['deletes a file — hard to reverse outside the task snapshot'],
    }),
    preview: async (input) => {
      let diff: string | null = null;
      try {
        const current = await services.documents.readLogical(input.path);
        if (!current.binary) {
          diff = createTwoFilesPatch(input.path, input.path, current.content, '', '', '');
        }
      } catch {
        diff = null;
      }
      return {
        summary: `Delete ${input.path}`,
        detail: `why: ${input.reason}`,
        diff,
        targets: [input.path],
        ruleKey: 'write:delete_file',
      };
    },
    async execute(input, _signal, call) {
      const changes = mustChanges(services);
      await changes.deleteFile(call.taskId, call.callId, { path: input.path });
      return {
        code: 'OK',
        summary: `Deleted ${input.path} (snapshot kept for rollback).`,
        data: { deleted: input.path },
      };
    },
  });

  gateway.register({
    name: 'rename_file',
    version: 1,
    description:
      'Rename or move one workspace file. Fails if the target already exists — it never overwrites.',
    inputSchema: z
      .object({
        from: z.string().min(1).max(1000),
        to: z.string().min(1).max(1000),
        reason: z.string().min(1).max(500),
      })
      .strict(),
    risk: () => ({ level: 'R1', reasons: ['renames a file within the workspace (reversible)'] }),
    preview: async (input) => ({
      summary: `Rename ${input.from} → ${input.to}`,
      detail: `why: ${input.reason}`,
      diff: null,
      targets: [input.from, input.to],
      ruleKey: 'write:rename_file',
    }),
    async execute(input, _signal, call) {
      const changes = mustChanges(services);
      await changes.renameFile(call.taskId, call.callId, { from: input.from, to: input.to });
      return {
        code: 'OK',
        summary: `Renamed ${input.from} to ${input.to}.`,
        data: { from: input.from, to: input.to },
      };
    },
  });

  gateway.register({
    name: 'propose_plan',
    version: 1,
    description:
      'Propose your structured step-by-step plan for this task. Required before the first file modification. The run pauses until the user approves, edits or rejects the plan; the result contains the plan you must follow (the user may have edited it).',
    promptGuidance:
      'Call this once before your first write. Keep steps small and verifiable; list expected files per step.',
    inputSchema: z
      .object({
        summary: z.string().min(1).max(2000),
        steps: z
          .array(
            z
              .object({
                title: z.string().min(1).max(300),
                description: z.string().max(2000).optional(),
                expectedFiles: z.array(z.string().max(500)).max(50).optional(),
                verification: z.string().max(500).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(30),
      })
      .strict(),
    // R1 keeps plan tools out of the ask-mode catalog; the plan-aware permission
    // wrapper auto-allows them, so no approval card is shown for the plan itself.
    risk: () => ({ level: 'R1', reasons: ['starts the write workflow; pauses for plan approval'] }),
    preview: async (input) => ({
      summary: `Plan: ${input.summary.slice(0, 120)}`,
      detail: `${input.steps.length} steps`,
    }),
    async execute(input, signal, call) {
      const outcome = await services.planGate.propose(
        { taskId: call.taskId, runId: call.runId, callId: call.callId, plan: input },
        signal,
      );
      if (outcome.decision === 'changes_requested') {
        // ADR-0009: not an error — the model must revise and call propose_plan again.
        return {
          code: 'PLAN_CHANGES_REQUESTED',
          summary: `The user requested changes to the plan: "${outcome.feedback.slice(0, 600)}". Revise the plan accordingly and call propose_plan again with the new version. Do not modify any files yet.`,
          data: { decision: outcome.decision, feedback: outcome.feedback },
        };
      }
      return {
        code: 'OK',
        summary:
          outcome.decision === 'edited'
            ? 'The user edited and approved the plan — follow the edited version in the result.'
            : 'The user approved the plan.',
        data: { decision: outcome.decision, plan: outcome.plan },
      };
    },
  });

  gateway.register({
    name: 'update_plan',
    version: 1,
    description:
      'Update the status of steps in the approved plan (pending / in_progress / done / skipped / blocked). History is kept; updates never overwrite the approved plan text.',
    inputSchema: z
      .object({
        updates: z
          .array(
            z
              .object({
                id: z.string().min(1).max(100),
                status: z.enum(['pending', 'in_progress', 'done', 'skipped', 'blocked']),
              })
              .strict(),
          )
          .min(1)
          .max(50),
        note: z.string().max(1000).optional(),
      })
      .strict(),
    risk: () => ({ level: 'R1', reasons: ['updates plan step status; no file side effects'] }),
    preview: async (input) => ({
      summary: `Update plan (${input.updates.length} step${input.updates.length > 1 ? 's' : ''})`,
    }),
    async execute(input, _signal, call) {
      const plan = await services.planGate.update({
        taskId: call.taskId,
        updates: input.updates,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
      return {
        code: 'OK',
        summary: `Plan updated (version ${plan.version}).`,
        data: { plan },
      };
    },
  });
}
