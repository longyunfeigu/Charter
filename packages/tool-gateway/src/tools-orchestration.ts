import { z } from 'zod';
import type { ToolCallRequest } from '@pi-ide/agent-contract';
import type {
  OrchestrationCallerContext,
  OrchestrationMessagePriority,
  OrchestrationMessageType,
  PrincipalKind,
  RuntimeKind,
} from '@pi-ide/orchestration-domain';
import type { GatewayTool, ToolGateway } from './gateway.js';
import {
  ORCHESTRATION_TOOL_NAMES,
  OrchestrationAskSchema,
  OrchestrationCancelSchema,
  OrchestrationCompleteSchema,
  OrchestrationContinueSchema,
  OrchestrationDecisionRequestSchema,
  OrchestrationDelegateManySchema,
  OrchestrationDelegateSchema,
  OrchestrationEscalateSchema,
  OrchestrationJoinSchema,
  OrchestrationMessageSchema,
  OrchestrationParkSchema,
  OrchestrationProgressSchema,
  OrchestrationReassignSchema,
  OrchestrationReplySchema,
  OrchestrationRequestSchema,
  OrchestrationResolveRequestSchema,
  OrchestrationRetrySchema,
  OrchestrationSteerSchema,
  OrchestrationSyncSchema,
  OrchestrationTargetSchema,
  OrchestrationWaitSchema,
} from './orchestration-command-registry.js';

export {
  ORCHESTRATION_TOOL_NAMES,
  OrchestrationDelegateSchema,
  OrchestrationMessageSchema,
  OrchestrationRequestSchema,
  OrchestrationDecisionRequestSchema,
  OrchestrationResolveRequestSchema,
} from './orchestration-command-registry.js';

const AutoAllow = 'auto-allow' as const;

export interface OrchestrationControlPort {
  inspect(caller: OrchestrationCallerContext): unknown;
  delegate(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationDelegateSchema>,
  ): unknown;
  delegateMany(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationDelegateManySchema>,
  ): unknown;
  message(
    caller: OrchestrationCallerContext,
    input: {
      toAssignmentId: string;
      type?: OrchestrationMessageType;
      priority?: OrchestrationMessagePriority;
      subject: string;
      body?: string;
      payload?: Record<string, unknown> | null;
      threadId?: string | null;
    },
  ): unknown;
  request(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationRequestSchema>,
  ): unknown;
  requestDecision(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationDecisionRequestSchema>,
  ): unknown;
  resolveRequest(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationResolveRequestSchema>,
  ): unknown;
  reply(
    caller: OrchestrationCallerContext,
    input: {
      messageId: string;
      subject?: string;
      body: string;
      payload?: Record<string, unknown>;
    },
  ): unknown;
  sync(caller: OrchestrationCallerContext, input: z.infer<typeof OrchestrationSyncSchema>): unknown;
  ask(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationAskSchema> & { signal?: AbortSignal },
  ): Promise<unknown>;
  wait(
    caller: OrchestrationCallerContext,
    input: {
      types?: OrchestrationMessageType[];
      unreadOnly?: boolean;
      threadId?: string;
      afterSequence?: number;
      limit?: number;
      timeoutMs: number;
      markRead?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
  join(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationJoinSchema> & { signal?: AbortSignal },
  ): Promise<unknown>;
  park(caller: OrchestrationCallerContext, input: z.infer<typeof OrchestrationParkSchema>): unknown;
  continue(
    caller: OrchestrationCallerContext,
    input: z.infer<typeof OrchestrationContinueSchema>,
  ): unknown;
  progress(
    caller: OrchestrationCallerContext,
    input: {
      phase: string;
      summary: string;
      completed?: string[];
      remaining?: string[];
      blockers?: string[];
    },
  ): unknown;
  complete(
    caller: OrchestrationCallerContext,
    input: {
      outcome: 'success' | 'failure';
      summary: string;
      result?: Record<string, unknown>;
      artifacts?: Array<{ kind: string; label: string; reference: Record<string, unknown> }>;
      verification?: Array<{ id?: string; label: string; state: string; [key: string]: unknown }>;
      filesModified?: string[];
    },
  ): unknown;
  escalate(
    caller: OrchestrationCallerContext,
    input: {
      subject: string;
      body: string;
      priority?: OrchestrationMessagePriority;
    },
  ): unknown;
  pause(caller: OrchestrationCallerContext, assignmentId: string, paused?: boolean): unknown;
  cancel(caller: OrchestrationCallerContext, assignmentId: string, reason: string): unknown;
  retry(caller: OrchestrationCallerContext, assignmentId: string, runtime?: RuntimeKind): unknown;
  reassign(
    caller: OrchestrationCallerContext,
    input: {
      assignmentId: string;
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
    },
  ): unknown;
  steer(
    caller: OrchestrationCallerContext,
    assignmentId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface OrchestrationToolServices {
  control: OrchestrationControlPort;
  callerForCall(call: ToolCallRequest): OrchestrationCallerContext;
}

export function registerOrchestrationTools(
  gateway: ToolGateway,
  services: OrchestrationToolServices,
): void {
  const caller = (call: ToolCallRequest) => services.callerForCall(call);
  const register = <I>(tool: GatewayTool<I>): void => gateway.register(tool);

  register({
    name: 'orchestration.inspect',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Inspect your durable Mission, Assignment tree, Task graph, active Attempt, and unread messages.',
    promptGuidance:
      'Call before delegating. Every Mission member may delegate recursively without asking its parent to proxy.',
    inputSchema: z.object({}).strict(),
    risk: () => ({ level: 'R0', reasons: ['reads Mission state'] }),
    preview: async () => ({ summary: 'Inspect Mission' }),
    execute: async (_input, _signal, call) => ({
      code: 'OK',
      summary: 'Inspected Mission.',
      data: services.control.inspect(caller(call)),
    }),
  });
  register({
    name: 'orchestration.sync',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Synchronize committed Mission messages since a sequence cursor and acknowledge observation.',
    promptGuidance:
      'Call when a Charter inbox doorbell arrives. Persist the returned nextSequence as your next cursor.',
    inputSchema: OrchestrationSyncSchema,
    risk: () => ({ level: 'R0', reasons: ['reads and acknowledges durable Mission messages'] }),
    preview: async () => ({ summary: 'Synchronize Mission inbox' }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Mission inbox synchronized.',
      data: services.control.sync(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.delegate',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Create a durable child Task, Assignment, Attempt, and runtime under your Assignment.',
    promptGuidance:
      'Delegate only a bounded independently verifiable subproblem. Supply a stable idempotencyKey. The child may delegate again.',
    inputSchema: OrchestrationDelegateSchema,
    risk: () => ({
      level: 'R2',
      reasons: ['starts a Mission member using the inherited host permissions'],
    }),
    preview: async (input) => ({ summary: `Delegate: ${input.title ?? input.goal.slice(0, 100)}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Delegated Mission work.',
      data: services.control.delegate(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.delegate_many',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Atomically create multiple independent child Assignments whose runtimes start in parallel.',
    promptGuidance:
      'Prefer this over sequential delegate calls when the children can make progress independently.',
    inputSchema: OrchestrationDelegateManySchema,
    risk: () => ({
      level: 'R2',
      reasons: ['starts multiple Mission members using inherited host permissions'],
    }),
    preview: async (input) => ({ summary: `Delegate ${input.children.length} Mission workers` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: `Delegated ${input.children.length} Mission workers.`,
      data: services.control.delegateMany(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.message',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Send durable FYI/progress context to an Assignment. This never creates an Action Request.',
    promptGuidance:
      'Use message only when no response is required. Use request for Agent work and request_decision only for irreducible user input.',
    inputSchema: OrchestrationMessageSchema,
    risk: () => ({ level: 'R0', reasons: ['persists structured Mission coordination'] }),
    preview: async (input) => ({ summary: `Message ${input.toAssignmentId}: ${input.subject}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Sent Mission message.',
      data: services.control.message(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.request',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Assign an explicit durable Action Request to another Agent Assignment.',
    promptGuidance:
      'Use this when the target must answer, review, approve, or recover something. Agent requests stay in Team activity and never enter the user inbox.',
    inputSchema: OrchestrationRequestSchema,
    risk: () => ({ level: 'R0', reasons: ['assigns structured coordination work'] }),
    preview: async (input) => ({ summary: `Request ${input.toAssignmentId}: ${input.title}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Agent Action Request created.',
      data: services.control.request(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.request_decision',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Mission Lead only: create a typed, explicit request in the user Your actions inbox.',
    promptGuidance:
      'Use only when the team cannot safely infer or recover the answer. Include impact, options, and a recommendation whenever possible.',
    inputSchema: OrchestrationDecisionRequestSchema,
    risk: () => ({ level: 'R0', reasons: ['requests an explicit user decision'] }),
    preview: async (input) => ({ summary: `Request user decision: ${input.title}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'User Action Request created.',
      data: services.control.requestDecision(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.resolve_request',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Resolve an Action Request assigned to the caller with a typed outcome.',
    inputSchema: OrchestrationResolveRequestSchema,
    risk: () => ({ level: 'R0', reasons: ['resolves only a request assigned to the caller'] }),
    preview: async (input) => ({ summary: `Resolve ${input.requestId}: ${input.outcome}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Action Request resolved.',
      data: services.control.resolveRequest(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.reply',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Reply to a durable Mission message while preserving its thread.',
    inputSchema: OrchestrationReplySchema,
    risk: () => ({ level: 'R0', reasons: ['persists a structured reply'] }),
    preview: async (input) => ({ summary: `Reply to ${input.messageId}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Replied to Mission message.',
      data: services.control.reply(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.ask',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Send a durable question and wait event-first for the threaded answer.',
    inputSchema: OrchestrationAskSchema,
    risk: () => ({ level: 'R0', reasons: ['persists and awaits Mission coordination'] }),
    preview: async (input) => ({ summary: `Ask ${input.toAssignmentId}: ${input.subject}` }),
    execute: async (input, signal, call) => ({
      code: 'OK',
      summary: 'Mission question finished waiting.',
      data: await services.control.ask(caller(call), { ...input, signal }),
    }),
  });
  register({
    name: 'orchestration.wait',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Wait event-first for durable Mission messages. This does not poll terminal output.',
    inputSchema: OrchestrationWaitSchema,
    risk: () => ({ level: 'R0', reasons: ['waits for committed Mission events'] }),
    preview: async () => ({ summary: 'Wait for Mission messages' }),
    execute: async (input, signal, call) => ({
      code: 'OK',
      summary: 'Mission wait finished.',
      data: await services.control.wait(caller(call), { ...input, signal }),
    }),
  });
  register({
    name: 'orchestration.join',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Wait event-first until a set of Assignments reaches terminal states.',
    inputSchema: OrchestrationJoinSchema,
    risk: () => ({ level: 'R0', reasons: ['waits for committed Mission state transitions'] }),
    preview: async (input) => ({ summary: `Join ${input.assignmentIds.length} Assignments` }),
    execute: async (input, signal, call) => ({
      code: 'OK',
      summary: 'Mission join finished.',
      data: await services.control.join(caller(call), { ...input, signal }),
    }),
  });
  register({
    name: 'orchestration.park',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Persist continuation conditions, end this turn, and let Charter resume this exact Session when they match.',
    promptGuidance:
      'Use for work that will take longer than a single blocking tool call. Pass the latest sync cursor as afterSequence, then stop the current turn immediately after success. Do not wrap park in a wait loop.',
    inputSchema: OrchestrationParkSchema,
    risk: () => ({ level: 'R0', reasons: ['parks only the caller active Attempt'] }),
    preview: async (input) => ({
      summary: `Park until ${input.mode === 'all' ? 'all' : 'any'} of ${input.conditions.length} conditions`,
    }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Continuation armed. End this agent turn now.',
      data: services.control.park(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.continue',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Acknowledge the exact Charter resume intent and return its committed context idempotently.',
    promptGuidance:
      'Call only when Charter injects a continuation-ready prompt. Continue the original task using the returned conditions, Assignment states, and messages.',
    inputSchema: OrchestrationContinueSchema,
    risk: () => ({ level: 'R0', reasons: ['resumes only the caller parked Attempt'] }),
    preview: async (input) => ({ summary: `Continue ${input.continuationId}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Continuation acknowledged.',
      data: services.control.continue(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.progress',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Report structured progress and renew the active Attempt heartbeat.',
    inputSchema: OrchestrationProgressSchema,
    risk: () => ({ level: 'R0', reasons: ['updates the caller active Attempt only'] }),
    preview: async (input) => ({ summary: `Report progress: ${input.phase}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Progress recorded.',
      data: services.control.progress(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.complete',
    version: 1,
    permissionPolicy: AutoAllow,
    description:
      'Complete or fail your active Attempt with structured evidence. It does not by itself complete the Mission.',
    inputSchema: OrchestrationCompleteSchema,
    risk: () => ({ level: 'R0', reasons: ['transitions the caller active Attempt only'] }),
    preview: async (input) => ({ summary: `Report Attempt ${input.outcome}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Attempt result recorded.',
      data: services.control.complete(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.escalate',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Escalate a blocker or decision to the supervisor, Mission Lead, or user inbox.',
    inputSchema: OrchestrationEscalateSchema,
    risk: () => ({ level: 'R0', reasons: ['persists a structured escalation'] }),
    preview: async (input) => ({ summary: `Escalate: ${input.subject}` }),
    execute: async (input, _signal, call) => ({
      code: 'OK',
      summary: 'Escalation recorded.',
      data: services.control.escalate(caller(call), input),
    }),
  });
  register({
    name: 'orchestration.pause',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Pause any Assignment runtime in your Mission.',
    inputSchema: OrchestrationTargetSchema,
    risk: () => ({ level: 'R2', reasons: ['pauses a live Mission runtime'] }),
    preview: async (i) => ({ summary: `Pause ${i.assignmentId}` }),
    execute: async (i, _s, c) => ({
      code: 'OK',
      summary: 'Assignment paused.',
      data: services.control.pause(caller(c), i.assignmentId, true),
    }),
  });
  register({
    name: 'orchestration.resume',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Resume any paused Assignment runtime in your Mission.',
    inputSchema: OrchestrationTargetSchema,
    risk: () => ({ level: 'R2', reasons: ['resumes a live Mission runtime'] }),
    preview: async (i) => ({ summary: `Resume ${i.assignmentId}` }),
    execute: async (i, _s, c) => ({
      code: 'OK',
      summary: 'Assignment resumed.',
      data: services.control.pause(caller(c), i.assignmentId, false),
    }),
  });
  register({
    name: 'orchestration.cancel',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Cancel an Assignment and its active runtime in your Mission.',
    inputSchema: OrchestrationCancelSchema,
    risk: () => ({ level: 'R3', reasons: ['cancels a durable Assignment and live runtime'] }),
    preview: async (i) => ({ summary: `Cancel ${i.assignmentId}` }),
    execute: async (i, _s, c) => ({
      code: 'OK',
      summary: 'Assignment cancelled.',
      data: services.control.cancel(caller(c), i.assignmentId, i.reason),
    }),
  });
  register({
    name: 'orchestration.retry',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Create a new active Attempt for a failed Assignment.',
    inputSchema: OrchestrationRetrySchema,
    risk: () => ({ level: 'R2', reasons: ['starts a replacement runtime'] }),
    preview: async (i) => ({ summary: `Retry ${i.assignmentId}` }),
    execute: async (i, _s, c) => ({
      code: 'OK',
      summary: 'Retry planned.',
      data: services.control.retry(caller(c), i.assignmentId, i.requestedRuntime),
    }),
  });
  register({
    name: 'orchestration.steer',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Steer the active runtime of any Assignment in your Mission.',
    inputSchema: OrchestrationSteerSchema,
    risk: () => ({ level: 'R1', reasons: ['delivers new instructions to a Mission runtime'] }),
    preview: async (i) => ({ summary: `Steer ${i.assignmentId}` }),
    execute: async (i, s, c) => {
      await services.control.steer(caller(c), i.assignmentId, i.text, s);
      return { code: 'OK', summary: 'Runtime steered.', data: {} };
    },
  });
  register({
    name: 'orchestration.reassign',
    version: 1,
    permissionPolicy: AutoAllow,
    description: 'Replace an Assignment assignee and create a fresh active Attempt.',
    inputSchema: OrchestrationReassignSchema,
    risk: () => ({
      level: 'R3',
      reasons: ['changes durable responsibility and replaces a runtime'],
    }),
    preview: async (i) => ({ summary: `Reassign ${i.assignmentId} to ${i.assignee.displayName}` }),
    execute: async (i, _s, c) => ({
      code: 'OK',
      summary: 'Assignment reassigned.',
      data: services.control.reassign(caller(c), i),
    }),
  });
}
