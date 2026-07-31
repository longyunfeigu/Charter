import { errorMessage, newId, productError, ProductFailure } from '@pi-ide/foundation';
import type {
  AssignmentWorkMode,
  ContinuationCondition,
  ContinuationMode,
  OrchestrationCallerContext,
  OrchestrationMessagePriority,
  OrchestrationMessageType,
  PrincipalKind,
  RuntimeKind,
} from '@pi-ide/orchestration-domain';
import {
  MissionRepository,
  type CompleteAttemptInput,
  type MissionSnapshot,
} from '@pi-ide/persistence';
import { OrchestrationMessageBus, type WaitForMessagesInput } from './orchestration-message-bus.js';
import { OrchestrationOutboxRunner } from './orchestration-outbox-runner.js';

export interface AdoptMissionInput {
  workspaceId: string;
  workspaceRoot: string;
  originConversationTaskId?: string | null;
  title: string;
  goal: string;
  acceptanceCriteria?: string[];
  principal: {
    id?: string;
    kind: PrincipalKind;
    provider?: string | null;
    externalIdentity?: string | null;
    displayName: string;
  };
  runtimeSessionId: string;
  terminalId?: string | null;
  requestedRuntime: RuntimeKind;
  requestedModel?: string | null;
}

export interface DelegateRequest {
  goal: string;
  title?: string;
  acceptanceCriteria: string[];
  dependencies?: string[];
  expectedArtifacts?: string[];
  requestedRuntime?: RuntimeKind;
  requestedModel?: string | null;
  workMode?: AssignmentWorkMode;
  writeScope?: string[] | null;
  reason: string;
  idempotencyKey: string;
}

export interface InspectResult {
  caller: OrchestrationCallerContext;
  snapshot: MissionSnapshot;
  assignment: MissionSnapshot['assignments'][number] | null;
  attempt: MissionSnapshot['attempts'][number] | null;
  parent: MissionSnapshot['assignments'][number] | null;
  children: MissionSnapshot['assignments'];
  unreadMessages: MissionSnapshot['messages'];
}

export class MissionOrchestrationService {
  readonly messages: OrchestrationMessageBus;

  constructor(
    readonly repository: MissionRepository,
    private readonly outbox: OrchestrationOutboxRunner,
    private readonly onChanged: (missionId: string) => void = () => {},
  ) {
    this.messages = new OrchestrationMessageBus(repository);
  }

  start(): void {
    this.outbox.start();
  }

  shutdown(): void {
    this.messages.shutdown();
    this.outbox.stop();
  }

  adopt(input: AdoptMissionInput): {
    caller: OrchestrationCallerContext;
    snapshot: MissionSnapshot;
  } {
    if (input.originConversationTaskId) {
      const existing = this.repository.getMissionForOriginTask(input.originConversationTaskId);
      if (existing) {
        let assignment = this.repository.getAssignmentForRuntime(input.runtimeSessionId);
        if (!assignment && existing.leadAssignmentId) {
          assignment = this.repository.getAssignment(existing.leadAssignmentId);
          if (assignment) {
            const active = assignment.activeAttemptId
              ? this.repository.getAttempt(assignment.activeAttemptId)
              : null;
            if (
              active &&
              !['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'STALE'].includes(active.state)
            ) {
              this.repository.rebindActiveRuntime(assignment.id, {
                runtimeSessionId: input.runtimeSessionId,
                ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
              });
            }
          }
        }
        if (!assignment) {
          throw this.failure(
            'ORCHESTRATION_ORIGIN_ALREADY_ADOPTED',
            'This Mission has no live Lead Assignment to reattach.',
          );
        }
        return {
          caller: this.contextForAssignment(assignment.id, 'attached-cli'),
          snapshot: this.repository.snapshot(existing.id),
        };
      }
    }
    const principalId = input.principal.id ?? newId('principal');
    const snapshot = this.repository.createMission({
      workspaceId: input.workspaceId,
      workspaceRoot: input.workspaceRoot,
      ...(input.originConversationTaskId !== undefined
        ? { originConversationTaskId: input.originConversationTaskId }
        : {}),
      title: input.title,
      goal: input.goal,
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      lead: {
        principalId,
        kind: input.principal.kind,
        ...(input.principal.provider !== undefined ? { provider: input.principal.provider } : {}),
        ...(input.principal.externalIdentity !== undefined
          ? { externalIdentity: input.principal.externalIdentity }
          : {}),
        displayName: input.principal.displayName,
        runtimeSessionId: input.runtimeSessionId,
        ...(input.terminalId !== undefined ? { terminalId: input.terminalId } : {}),
        requestedRuntime: input.requestedRuntime,
        ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
      },
    });
    this.changed(snapshot.mission.id);
    return {
      caller: this.contextForAssignment(snapshot.mission.leadAssignmentId!, this.originFor(input)),
      snapshot,
    };
  }

  contextForRuntime(
    runtimeSessionId: string,
    origin: OrchestrationCallerContext['origin'],
  ): OrchestrationCallerContext | null {
    const assignment = this.repository.getAssignmentForRuntime(runtimeSessionId);
    if (!assignment) return null;
    return this.contextForAssignment(assignment.id, origin);
  }

  contextForAssignment(
    assignmentId: string,
    origin: OrchestrationCallerContext['origin'],
  ): OrchestrationCallerContext {
    const assignment = this.repository.getAssignment(assignmentId);
    if (!assignment)
      throw this.failure('ORCHESTRATION_ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
    const attempt = assignment.activeAttemptId
      ? this.repository.getAttempt(assignment.activeAttemptId)
      : null;
    return {
      principalId: assignment.assigneePrincipalId,
      runtimeSessionId: attempt?.runtimeSessionId ?? '',
      missionId: assignment.missionId,
      assignmentId: assignment.id,
      attemptId: attempt?.id ?? null,
      origin,
    };
  }

  inspect(callerInput: OrchestrationCallerContext): InspectResult {
    const caller = this.requireCaller(callerInput);
    if (!caller.missionId)
      throw this.failure('ORCHESTRATION_MISSION_REQUIRED', 'No Mission is attached.');
    const snapshot = this.repository.snapshot(caller.missionId);
    const assignment = caller.assignmentId
      ? (snapshot.assignments.find((item) => item.id === caller.assignmentId) ?? null)
      : null;
    const attempt = caller.attemptId
      ? (snapshot.attempts.find((item) => item.id === caller.attemptId) ?? null)
      : null;
    return {
      caller,
      snapshot,
      assignment,
      attempt,
      parent: assignment?.supervisorAssignmentId
        ? (snapshot.assignments.find((item) => item.id === assignment.supervisorAssignmentId) ??
          null)
        : null,
      children: assignment
        ? snapshot.assignments.filter((item) => item.supervisorAssignmentId === assignment.id)
        : [],
      unreadMessages: assignment
        ? this.repository.listInbox(assignment.id, { unreadOnly: true, limit: 100 })
        : [],
    };
  }

  delegate(callerInput: OrchestrationCallerContext, input: DelegateRequest) {
    const caller = this.requireMember(callerInput);
    const result = this.repository.delegate({
      missionId: caller.missionId!,
      supervisorAssignmentId: caller.assignmentId!,
      actorPrincipalId: caller.principalId,
      goal: input.goal,
      ...(input.title ? { title: input.title } : {}),
      acceptanceCriteria: input.acceptanceCriteria,
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      ...(input.expectedArtifacts ? { expectedArtifacts: input.expectedArtifacts } : {}),
      requestedRuntime: input.requestedRuntime ?? 'managed',
      ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
      workMode: input.workMode ?? 'isolated-write',
      ...(input.writeScope !== undefined ? { writeScope: input.writeScope } : {}),
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    this.changed(result.missionId);
    this.outbox.wake();
    return result;
  }

  delegateMany(callerInput: OrchestrationCallerContext, input: { children: DelegateRequest[] }) {
    const caller = this.requireMember(callerInput);
    const results = this.repository.delegateMany(
      input.children.map((child) => ({
        missionId: caller.missionId!,
        supervisorAssignmentId: caller.assignmentId!,
        actorPrincipalId: caller.principalId,
        goal: child.goal,
        ...(child.title ? { title: child.title } : {}),
        acceptanceCriteria: child.acceptanceCriteria,
        ...(child.dependencies ? { dependencies: child.dependencies } : {}),
        ...(child.expectedArtifacts ? { expectedArtifacts: child.expectedArtifacts } : {}),
        requestedRuntime: child.requestedRuntime ?? 'managed',
        ...(child.requestedModel !== undefined ? { requestedModel: child.requestedModel } : {}),
        workMode: child.workMode ?? 'isolated-write',
        ...(child.writeScope !== undefined ? { writeScope: child.writeScope } : {}),
        reason: child.reason,
        idempotencyKey: child.idempotencyKey,
      })),
    );
    this.changed(caller.missionId!);
    this.outbox.wake();
    return { results };
  }

  sync(
    callerInput: OrchestrationCallerContext,
    input: { afterSequence?: number; limit?: number; markObserved?: boolean },
  ) {
    const caller = this.requireMember(callerInput);
    const messages = this.repository.listInbox(caller.assignmentId!, {
      unreadOnly: false,
      afterSequence: input.afterSequence ?? 0,
      limit: input.limit ?? 200,
    });
    if ((input.markObserved ?? true) && messages.length > 0) {
      this.repository.markMessagesRead(
        caller.assignmentId!,
        messages.map((message) => message.id),
      );
    }
    const snapshot = this.repository.snapshot(caller.missionId!);
    return {
      missionVersion: snapshot.mission.version,
      messages,
      nextSequence: messages.at(-1)?.sequence ?? input.afterSequence ?? 0,
      assignments: snapshot.assignments,
      attempts: snapshot.attempts,
    };
  }

  message(
    callerInput: OrchestrationCallerContext,
    input: {
      toAssignmentId: string;
      type?: OrchestrationMessageType;
      priority?: OrchestrationMessagePriority;
      subject: string;
      body?: string;
      payload?: Record<string, unknown> | null;
      threadId?: string | null;
    },
  ) {
    const caller = this.requireMember(callerInput);
    this.requireTargetInMission(input.toAssignmentId, caller.missionId!);
    const message = this.repository.createMessage({
      missionId: caller.missionId!,
      fromAssignmentId: caller.assignmentId,
      toAssignmentId: input.toAssignmentId,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      type: input.type ?? 'assignment',
      ...(input.priority ? { priority: input.priority } : {}),
      subject: input.subject,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
    this.changed(caller.missionId!);
    this.messages.notifyAssignment(input.toAssignmentId);
    if (
      !this.repository.hasActiveContinuationForOwner(input.toAssignmentId) ||
      (input.priority ?? 'normal') === 'urgent'
    ) {
      this.outbox.signalAssignment(input.toAssignmentId);
    }
    this.outbox.wake();
    return message;
  }

  reply(
    callerInput: OrchestrationCallerContext,
    input: { messageId: string; subject?: string; body: string; payload?: Record<string, unknown> },
  ) {
    const caller = this.requireMember(callerInput);
    const original = this.repository
      .snapshot(caller.missionId!)
      .messages.find((message) => message.id === input.messageId);
    if (!original || !original.fromAssignmentId) {
      throw this.failure('ORCHESTRATION_MESSAGE_NOT_FOUND', 'The message cannot be replied to.');
    }
    return this.message(caller, {
      toAssignmentId: original.fromAssignmentId,
      type: 'answer',
      subject: input.subject ?? `Re: ${original.subject}`,
      body: input.body,
      ...(input.payload ? { payload: input.payload } : {}),
      threadId: original.threadId ?? original.id,
    });
  }

  async ask(
    callerInput: OrchestrationCallerContext,
    input: {
      toAssignmentId: string;
      subject: string;
      body: string;
      payload?: Record<string, unknown> | null;
      priority?: OrchestrationMessagePriority;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ) {
    const caller = this.requireMember(callerInput);
    const question = this.message(caller, {
      toAssignmentId: input.toAssignmentId,
      type: 'question',
      priority: input.priority ?? 'normal',
      subject: input.subject,
      body: input.body,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    });
    const answers = await this.messages.wait({
      assignmentId: caller.assignmentId!,
      types: ['answer'],
      threadId: question.id,
      unreadOnly: false,
      timeoutMs: input.timeoutMs,
      markRead: true,
      signal: input.signal,
    });
    return { question, answer: answers[0] ?? null, timedOut: answers.length === 0 };
  }

  wait(callerInput: OrchestrationCallerContext, input: Omit<WaitForMessagesInput, 'assignmentId'>) {
    const caller = this.requireMember(callerInput);
    return this.messages.wait({ ...input, assignmentId: caller.assignmentId! });
  }

  async join(
    callerInput: OrchestrationCallerContext,
    input: { assignmentIds: string[]; timeoutMs: number; signal?: AbortSignal },
  ) {
    const caller = this.requireMember(callerInput);
    const ids = [...new Set(input.assignmentIds)];
    for (const id of ids) this.requireTargetInMission(id, caller.missionId!);
    const read = () => {
      const assignments = ids.map((id) => this.repository.getAssignment(id)!);
      const terminal = assignments.filter((assignment) =>
        ['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'].includes(assignment.state),
      );
      return terminal.length === assignments.length ? assignments : null;
    };
    const assignments = await this.messages.waitForMission(
      caller.missionId!,
      read,
      input.timeoutMs,
      input.signal,
    );
    return {
      assignments: assignments ?? ids.map((id) => this.repository.getAssignment(id)!),
      timedOut: assignments === null,
    };
  }

  park(
    callerInput: OrchestrationCallerContext,
    input: {
      mode: ContinuationMode;
      conditions: ContinuationCondition[];
      afterSequence?: number;
      timeoutMs?: number;
      reason: string;
      idempotencyKey: string;
    },
  ) {
    const caller = this.requireActiveAttempt(callerInput);
    for (const condition of input.conditions) {
      if (condition.kind === 'assignment_terminal') {
        this.requireTargetInMission(condition.assignmentId, caller.missionId!);
      } else if (condition.fromAssignmentId) {
        this.requireTargetInMission(condition.fromAssignmentId, caller.missionId!);
      }
    }
    const result = this.repository.armContinuation({
      missionId: caller.missionId!,
      ownerAssignmentId: caller.assignmentId!,
      ownerAttemptId: caller.attemptId!,
      mode: input.mode,
      conditions: input.conditions,
      reason: input.reason,
      cursorSequence: input.afterSequence ?? 0,
      deadlineAt:
        input.timeoutMs === undefined ? null : new Date(Date.now() + input.timeoutMs).toISOString(),
      idempotencyKey: input.idempotencyKey,
    });
    this.changed(caller.missionId!);
    this.outbox.wake();
    return {
      ...result,
      nextAction:
        'Stop this agent turn now. Charter will resume this exact Session after the durable conditions match.',
    };
  }

  continue(callerInput: OrchestrationCallerContext, input: { continuationId: string }) {
    const caller = this.requireMember(callerInput);
    if (!caller.attemptId) {
      throw this.failure(
        'ORCHESTRATION_ATTEMPT_REQUIRED',
        'A continuation can only resume its exact active Attempt.',
      );
    }
    const result = this.repository.consumeContinuation(
      input.continuationId,
      caller.assignmentId!,
      caller.attemptId,
    );
    this.changed(caller.missionId!);
    return result;
  }

  progress(
    callerInput: OrchestrationCallerContext,
    input: {
      phase: string;
      summary: string;
      completed?: string[];
      remaining?: string[];
      blockers?: string[];
      leaseExpiresAt?: string | null;
    },
  ) {
    const caller = this.requireActiveAttempt(callerInput);
    const result = this.repository.recordProgress({
      attemptId: caller.attemptId!,
      principalId: caller.principalId,
      phase: input.phase,
      summary: input.summary,
      ...(input.completed ? { completed: input.completed } : {}),
      ...(input.remaining ? { remaining: input.remaining } : {}),
      ...(input.blockers ? { blockers: input.blockers } : {}),
      ...(input.leaseExpiresAt !== undefined ? { leaseExpiresAt: input.leaseExpiresAt } : {}),
    });
    this.afterLifecycle(caller.missionId!, result.message.toAssignmentId);
    return result;
  }

  heartbeat(callerInput: OrchestrationCallerContext, leaseExpiresAt?: string | null) {
    const caller = this.requireActiveAttempt(callerInput);
    const result = this.repository.recordHeartbeat({
      attemptId: caller.attemptId!,
      principalId: caller.principalId,
      ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
    });
    this.afterLifecycle(caller.missionId!, result.message.toAssignmentId);
    return result;
  }

  complete(
    callerInput: OrchestrationCallerContext,
    input: Omit<CompleteAttemptInput, 'attemptId' | 'principalId'>,
  ) {
    const caller = this.requireActiveAttempt(callerInput);
    const result = this.repository.completeAttempt({
      ...input,
      attemptId: caller.attemptId!,
      principalId: caller.principalId,
    });
    this.repository.updateRuntimeSessionState(caller.attemptId!, 'WAITING');
    this.afterLifecycle(caller.missionId!, result.message.toAssignmentId);
    this.outbox.wake();
    return result;
  }

  escalate(
    callerInput: OrchestrationCallerContext,
    input: { subject: string; body: string; priority?: OrchestrationMessagePriority },
  ) {
    const caller = this.requireMember(callerInput);
    const assignment = this.repository.getAssignment(caller.assignmentId!)!;
    const mission = this.repository.getMission(caller.missionId!)!;
    const target = assignment.supervisorAssignmentId ?? mission.leadAssignmentId;
    if (!target || target === assignment.id) {
      return this.repository.createMessage({
        missionId: caller.missionId!,
        fromAssignmentId: assignment.id,
        toAssignmentId: null,
        type: 'escalation',
        priority: input.priority ?? 'high',
        subject: input.subject,
        body: input.body,
      });
    }
    return this.message(caller, {
      toAssignmentId: target,
      type: 'escalation',
      priority: input.priority ?? 'high',
      subject: input.subject,
      body: input.body,
    });
  }

  pause(callerInput: OrchestrationCallerContext, assignmentId: string, paused = true) {
    const caller = this.requireControlTarget(callerInput, assignmentId);
    const assignment = this.repository.pauseAssignment(assignmentId, paused, caller.principalId);
    const attemptId = assignment.activeAttemptId;
    if (attemptId) {
      const operation = paused
        ? this.outbox.pauseRuntime(attemptId)
        : this.outbox.resumeRuntime(attemptId);
      void operation.catch((error) => {
        this.repository.createMessage({
          missionId: assignment.missionId,
          fromAssignmentId: null,
          toAssignmentId: assignment.id,
          attemptId,
          type: 'escalation',
          priority: 'high',
          subject: paused ? 'Runtime pause failed' : 'Runtime resume failed',
          body: errorMessage(error),
        });
        this.changed(assignment.missionId);
      });
    }
    this.changed(assignment.missionId);
    return assignment;
  }

  cancel(callerInput: OrchestrationCallerContext, assignmentId: string, reason: string) {
    const caller = this.requireControlTarget(callerInput, assignmentId);
    const assignment = this.repository.cancelAssignment(assignmentId, caller.principalId, reason);
    this.changed(assignment.missionId);
    this.outbox.wake();
    return assignment;
  }

  retry(callerInput: OrchestrationCallerContext, assignmentId: string, runtime?: RuntimeKind) {
    this.requireControlTarget(callerInput, assignmentId);
    const attempt = this.repository.createRetry(assignmentId, runtime);
    const assignment = this.repository.getAssignment(assignmentId)!;
    this.changed(assignment.missionId);
    this.outbox.wake();
    return attempt;
  }

  promoteLead(callerInput: OrchestrationCallerContext, assignmentId: string, reason: string) {
    const caller = this.requireControlTarget(callerInput, assignmentId);
    const snapshot = this.repository.promoteLead(
      caller.missionId!,
      assignmentId,
      caller.principalId,
      reason,
    );
    this.changed(caller.missionId!);
    return snapshot;
  }

  async closeRuntime(
    callerInput: OrchestrationCallerContext,
    assignmentId: string,
    reason: string,
  ): Promise<void> {
    this.requireControlTarget(callerInput, assignmentId);
    const assignment = this.repository.getAssignment(assignmentId)!;
    if (!['COMPLETED', 'FAILED', 'CANCELLED', 'ORPHANED'].includes(assignment.state)) {
      throw this.failure(
        'ORCHESTRATION_ASSIGNMENT_STILL_ACTIVE',
        'Cancel the active Assignment instead of closing its runtime independently.',
      );
    }
    if (!assignment.activeAttemptId) return;
    await this.outbox.closeRuntime(assignment.activeAttemptId, reason);
    this.repository.createMessage({
      missionId: assignment.missionId,
      fromAssignmentId: null,
      toAssignmentId: assignment.id,
      attemptId: assignment.activeAttemptId,
      type: 'cancellation',
      subject: 'Resident runtime closed',
      body: reason,
    });
    this.changed(assignment.missionId);
  }

  reassign(
    callerInput: OrchestrationCallerContext,
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
  ) {
    const caller = this.requireControlTarget(callerInput, input.assignmentId);
    const result = this.repository.reassign({
      assignmentId: input.assignmentId,
      actorPrincipalId: caller.principalId,
      assignee: input.assignee,
      ...(input.requestedRuntime ? { requestedRuntime: input.requestedRuntime } : {}),
      ...(input.requestedModel !== undefined ? { requestedModel: input.requestedModel } : {}),
      reason: input.reason,
    });
    this.changed(result.assignment.missionId);
    this.outbox.wake();
    return result;
  }

  steer(
    callerInput: OrchestrationCallerContext,
    assignmentId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireControlTarget(callerInput, assignmentId);
    const assignment = this.repository.getAssignment(assignmentId)!;
    if (!assignment.activeAttemptId) {
      throw this.failure('ORCHESTRATION_ATTEMPT_REQUIRED', 'The Assignment has no active Attempt.');
    }
    return this.outbox.steerRuntime(assignment.activeAttemptId, text, signal);
  }

  finishMission(
    caller: OrchestrationCallerContext,
    missionId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    reason: string,
  ) {
    if (caller.origin !== 'user' && caller.origin !== 'system') {
      throw this.failure(
        'ORCHESTRATION_USER_DECISION_REQUIRED',
        'Mission acceptance is a user or system verification decision.',
      );
    }
    const next =
      outcome === 'completed' ? 'COMPLETED' : outcome === 'failed' ? 'FAILED' : 'CANCELLED';
    if (outcome === 'cancelled' || outcome === 'failed') {
      for (const assignment of this.repository.snapshot(missionId).assignments) {
        if (['COMPLETED', 'CANCELLED'].includes(assignment.state)) continue;
        this.repository.cancelAssignment(assignment.id, caller.principalId, reason);
      }
      this.outbox.wake();
    }
    const mission = this.repository.setMissionState(missionId, next, caller.principalId, reason);
    this.changed(missionId);
    return mission;
  }

  requestRevision(
    callerInput: OrchestrationCallerContext,
    missionId: string,
    feedback: string,
    idempotencyKey: string,
  ) {
    const caller = this.requireCaller(callerInput);
    if (caller.origin !== 'user' && caller.origin !== 'system') {
      throw this.failure(
        'ORCHESTRATION_USER_DECISION_REQUIRED',
        'Only the user or system verifier may request Mission changes.',
      );
    }
    if (caller.missionId !== missionId) {
      throw this.failure('ORCHESTRATION_MISSION_MISMATCH', 'The revision targets another Mission.');
    }
    const result = this.repository.requestRevision({
      missionId,
      actorPrincipalId: caller.principalId,
      feedback,
      idempotencyKey,
    });
    this.changed(missionId);
    this.outbox.wake();
    return result;
  }

  private requireCaller(input: OrchestrationCallerContext): OrchestrationCallerContext {
    if (input.origin === 'system' || input.origin === 'user') return input;
    let caller = input;
    if (!caller.assignmentId && caller.runtimeSessionId) {
      const resolved = this.contextForRuntime(caller.runtimeSessionId, caller.origin);
      if (resolved) caller = resolved;
    }
    if (!caller.assignmentId || !caller.missionId) return caller;
    const assignment = this.repository.getAssignment(caller.assignmentId);
    if (
      !assignment ||
      assignment.missionId !== caller.missionId ||
      assignment.assigneePrincipalId !== caller.principalId
    ) {
      throw this.failure(
        'ORCHESTRATION_CALLER_MISMATCH',
        'The caller identity does not own this Assignment.',
      );
    }
    return caller;
  }

  private requireMember(input: OrchestrationCallerContext): OrchestrationCallerContext {
    const caller = this.requireCaller(input);
    if (!caller.missionId || !caller.assignmentId) {
      throw this.failure(
        'ORCHESTRATION_MISSION_REQUIRED',
        'The caller must first join or create a Mission.',
      );
    }
    return caller;
  }

  private requireActiveAttempt(input: OrchestrationCallerContext): OrchestrationCallerContext {
    const caller = this.requireMember(input);
    const assignment = this.repository.getAssignment(caller.assignmentId!)!;
    if (!caller.attemptId || assignment.activeAttemptId !== caller.attemptId) {
      throw this.failure(
        'ORCHESTRATION_ATTEMPT_STALE',
        'Only the active Attempt may perform this operation.',
      );
    }
    return caller;
  }

  private requireControlTarget(
    input: OrchestrationCallerContext,
    assignmentId: string,
  ): OrchestrationCallerContext {
    const caller = this.requireMember(input);
    this.requireTargetInMission(assignmentId, caller.missionId!);
    return caller;
  }

  private requireTargetInMission(assignmentId: string, missionId: string): void {
    const target = this.repository.getAssignment(assignmentId);
    if (!target || target.missionId !== missionId) {
      throw this.failure(
        'ORCHESTRATION_TARGET_OUTSIDE_MISSION',
        'Mission-wide control cannot target an Assignment outside this Mission.',
      );
    }
  }

  private afterLifecycle(missionId: string, target: string | null): void {
    this.changed(missionId);
    if (target) {
      this.messages.notifyAssignment(target);
      if (!this.repository.hasActiveContinuationForOwner(target)) {
        this.outbox.signalAssignment(target);
      }
    }
    this.outbox.wake();
  }

  private changed(missionId: string): void {
    this.onChanged(missionId);
    this.messages.notifyMission(missionId);
  }

  private originFor(input: AdoptMissionInput): OrchestrationCallerContext['origin'] {
    if (input.principal.kind === 'managed_agent') return 'managed-run';
    if (input.terminalId) return 'charter-terminal';
    return 'attached-cli';
  }

  private failure(code: string, userMessage: string): ProductFailure {
    return new ProductFailure(productError(code, { userMessage }));
  }
}
