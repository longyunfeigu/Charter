import { errorMessage } from '@pi-ide/foundation';
import type { OrchestrationResumeIntent } from '@pi-ide/orchestration-domain';
import type { MissionRepository, OutboxRecord } from '@pi-ide/persistence';
import { OrchestrationRuntimeRegistry } from './orchestration-runtime-registry.js';

export interface OrchestrationOutboxRunnerOptions {
  onChanged?: (missionId: string) => void;
  maxAttempts?: number;
  retryBaseMs?: number;
}

export class OrchestrationOutboxRunner {
  private running: Promise<void> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt: number | null = null;
  private continuationDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly doorbellTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deliveringAssignments = new Set<string>();
  private stopped = false;

  constructor(
    private readonly repository: MissionRepository,
    private readonly runtimes: OrchestrationRuntimeRegistry,
    private readonly options: OrchestrationOutboxRunnerOptions = {},
  ) {}

  start(): void {
    this.stopped = false;
    this.repository.recoverInterruptedOutbox();
    this.repository.recoverAndReconcileContinuations();
    const assignments = new Set(
      this.repository
        .listUndeliveredMessages()
        .map((message) => message.toAssignmentId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const assignmentId of assignments) {
      if (!this.repository.hasActiveContinuationForOwner(assignmentId)) {
        this.signalAssignment(assignmentId);
      }
    }
    this.scheduleContinuationDeadline();
    this.wake();
  }

  signalAssignment(assignmentId: string, delayMs = 25): void {
    if (this.stopped || this.doorbellTimers.has(assignmentId)) return;
    const timer = setTimeout(() => {
      this.doorbellTimers.delete(assignmentId);
      if (this.stopped) return;
      if (this.deliveringAssignments.has(assignmentId)) return;
      this.deliveringAssignments.add(assignmentId);
      void this.deliverInbox(assignmentId)
        .catch(() => {
          // Teardown may close persistence immediately after stop(); delivery
          // remains durable and is retried on the next application start.
        })
        .finally(() => {
          this.deliveringAssignments.delete(assignmentId);
          if (this.stopped) return;
          try {
            const pending = this.repository.listUndeliveredMessages(assignmentId);
            const urgent = pending.some((message) => message.priority === 'urgent');
            if (
              pending.length > 0 &&
              (!this.repository.hasActiveContinuationForOwner(assignmentId) || urgent)
            ) {
              this.signalAssignment(assignmentId, 0);
            }
          } catch {
            // Persistence may already be closing during application teardown.
          }
        });
    }, delayMs);
    timer.unref?.();
    this.doorbellTimers.set(assignmentId, timer);
  }

  wake(delayMs = 0): void {
    if (this.stopped) return;
    const target = Date.now() + Math.max(0, delayMs);
    if (this.wakeTimer && this.wakeAt !== null && this.wakeAt <= target) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = target;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeAt = null;
        void this.drain();
      },
      Math.max(0, target - Date.now()),
    );
  }

  async drain(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doDrain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async pauseRuntime(attemptId: string): Promise<void> {
    const attempt = this.repository.getAttempt(attemptId);
    if (!attempt?.runtimeSessionId) return;
    await this.runtimes.forRuntime(attempt.requestedRuntime).pause?.(attempt.runtimeSessionId);
    this.repository.updateRuntimeSessionState(attemptId, 'PAUSED');
  }

  async resumeRuntime(attemptId: string): Promise<void> {
    const attempt = this.repository.getAttempt(attemptId);
    if (!attempt?.runtimeSessionId) return;
    await this.runtimes.forRuntime(attempt.requestedRuntime).resume?.(attempt.runtimeSessionId);
    const assignment = this.repository.getAssignment(attempt.assignmentId);
    this.repository.updateRuntimeSessionState(
      attemptId,
      assignment && this.repository.hasActiveContinuationForOwner(assignment.id)
        ? 'WAITING'
        : 'RUNNING',
    );
  }

  async steerRuntime(
    attemptId: string,
    text: string,
    signal = new AbortController().signal,
  ): Promise<void> {
    const attempt = this.repository.getAttempt(attemptId);
    if (!attempt?.runtimeSessionId) throw new Error('The Attempt has no active runtime session.');
    const adapter = this.runtimes.forRuntime(attempt.requestedRuntime);
    if (!adapter.steer)
      throw new Error(`Runtime ${attempt.requestedRuntime} does not support steer.`);
    await adapter.steer(attempt.runtimeSessionId, text, signal);
  }

  async closeRuntime(attemptId: string, reason: string): Promise<void> {
    const attempt = this.repository.getAttempt(attemptId);
    if (!attempt?.runtimeSessionId) return;
    await this.runtimes
      .forRuntime(attempt.requestedRuntime)
      .cancel(attempt.runtimeSessionId, reason);
    this.repository.updateRuntimeSessionState(attemptId, 'ENDED');
  }

  stop(): void {
    this.stopped = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeAt = null;
    if (this.continuationDeadlineTimer) clearTimeout(this.continuationDeadlineTimer);
    this.continuationDeadlineTimer = null;
    for (const timer of this.doorbellTimers.values()) clearTimeout(timer);
    this.doorbellTimers.clear();
  }

  private async doDrain(): Promise<void> {
    this.repository.recoverAndReconcileContinuations();
    for (;;) {
      const records = this.repository.listPendingOutbox();
      if (records.length === 0 || this.stopped) break;
      const orderedByAggregate = new Map<string, OutboxRecord[]>();
      for (const record of records) {
        const group = orderedByAggregate.get(record.aggregateId) ?? [];
        group.push(record);
        orderedByAggregate.set(record.aggregateId, group);
      }
      await Promise.all(
        [...orderedByAggregate.values()].map(async (group) => {
          for (const record of group) {
            if (this.stopped) return;
            await this.process(record);
          }
        }),
      );
      if (records.length < 20) break;
    }
    if (!this.stopped) await this.drainResumeIntents();
    if (!this.stopped) this.scheduleContinuationDeadline();
    const nextResume = this.repository.nextResumeIntentAvailableAt();
    if (!this.stopped && nextResume) {
      this.wake(Math.max(0, Date.parse(nextResume) - Date.now()));
    }
  }

  private async drainResumeIntents(): Promise<void> {
    for (;;) {
      const intents = this.repository.listPendingResumeIntents();
      if (intents.length === 0 || this.stopped) return;
      await Promise.all(intents.map((intent) => this.processResumeIntent(intent)));
      if (intents.length < 20) return;
    }
  }

  private async processResumeIntent(intent: OrchestrationResumeIntent): Promise<void> {
    const continuation = this.repository.getContinuation(intent.continuationId);
    const assignment = this.repository.getAssignment(intent.ownerAssignmentId);
    const attempt = this.repository.getAttempt(intent.ownerAttemptId);
    if (
      !continuation ||
      !assignment ||
      !attempt ||
      assignment.activeAttemptId !== attempt.id ||
      continuation.state !== 'READY'
    ) {
      this.repository.recoverAndReconcileContinuations();
      return;
    }

    const runtimeSessionId = attempt.runtimeSessionId;
    if (!this.repository.markResumeIntentProcessing(intent.id, runtimeSessionId)) return;
    try {
      if (!runtimeSessionId) throw new Error('The parked Attempt has no online runtime session.');
      const adapter = this.runtimes.forRuntime(attempt.requestedRuntime);
      if (!adapter.deliver) {
        throw new Error(`Runtime ${attempt.requestedRuntime} cannot receive continuation prompts.`);
      }
      await adapter.deliver(
        runtimeSessionId,
        this.resumePrompt(intent, continuation.reason),
        new AbortController().signal,
      );
      this.repository.markResumeIntentDelivered(intent.id);
      const runtime = this.repository.getRuntimeSessionForAttempt(attempt.id);
      if (runtime) {
        this.repository.appendRuntimeEvent(runtime.id, attempt.id, 'continuation.delivered', {
          continuationId: continuation.id,
          resumeIntentId: intent.id,
          attempts: intent.attempts + 1,
        });
      }
      this.options.onChanged?.(intent.missionId);
    } catch (error) {
      const retryBase = Math.max(25, this.options.retryBaseMs ?? 250);
      const retryMs = Math.min(30_000, retryBase * 2 ** Math.min(intent.attempts, 8));
      this.repository.retryResumeIntent(
        intent.id,
        errorMessage(error),
        new Date(Date.now() + retryMs).toISOString(),
      );
      this.options.onChanged?.(intent.missionId);
      this.wake(retryMs);
    }
  }

  private resumePrompt(intent: OrchestrationResumeIntent, reason: string): string {
    const request = JSON.stringify({ continuationId: intent.continuationId });
    const trigger = intent.payload.trigger as Record<string, unknown> | undefined;
    const timedOut = trigger?.timedOut === true;
    return [
      `[Charter continuation ${timedOut ? 'deadline reached' : 'ready'}]`,
      `The durable wait for "${reason}" is ready. Resume intent ${intent.id}.`,
      `First run: charter orchestration continue --request-json '${request}' --json`,
      'That idempotent command acknowledges this exact Attempt and returns the committed conditions, Assignment states, and messages.',
      'Then continue the original work. Do not start a wait/poll loop for this continuation.',
    ].join('\n');
  }

  private scheduleContinuationDeadline(): void {
    if (this.continuationDeadlineTimer) clearTimeout(this.continuationDeadlineTimer);
    this.continuationDeadlineTimer = null;
    const deadline = this.repository.nextContinuationDeadline();
    if (!deadline || this.stopped) return;
    const delay = Math.max(0, Math.min(2_147_000_000, Date.parse(deadline) - Date.now()));
    this.continuationDeadlineTimer = setTimeout(() => {
      this.continuationDeadlineTimer = null;
      this.wake();
    }, delay);
    this.continuationDeadlineTimer.unref?.();
  }

  private async process(record: OutboxRecord): Promise<void> {
    if (record.operation === 'start-runtime') {
      const assignment = this.repository.getAssignment(record.aggregateId);
      if (assignment) {
        const task = this.repository
          .snapshot(record.missionId)
          .tasks.find((candidate) => candidate.id === assignment.taskId);
        if (task?.state === 'BLOCKED') {
          const delay = 1_000;
          this.repository.retryOutbox(
            record.id,
            'Waiting for Mission task dependencies.',
            new Date(Date.now() + delay).toISOString(),
          );
          this.wake(delay);
          return;
        }
      }
    }
    if (!this.repository.markOutboxProcessing(record.id)) return;
    try {
      if (record.operation === 'start-runtime') await this.startRuntime(record);
      else if (record.operation === 'cancel-runtime') await this.cancelRuntime(record);
      else throw new Error(`Unknown orchestration outbox operation: ${record.operation}`);
      this.repository.completeOutbox(record.id);
      this.options.onChanged?.(record.missionId);
    } catch (error) {
      const message = errorMessage(error);
      const attemptId =
        typeof record.payload.attemptId === 'string' ? record.payload.attemptId : null;
      const maxAttempts = this.options.maxAttempts ?? 5;
      if (record.attempts + 1 >= maxAttempts) {
        this.repository.failOutbox(record.id, message);
        if (record.operation === 'start-runtime' && attemptId) {
          this.repository.failAttemptFromRuntime(attemptId, 'runtime_start_failed', { message });
        }
        this.options.onChanged?.(record.missionId);
        return;
      }
      const base = this.options.retryBaseMs ?? 250;
      const retryMs = Math.min(30_000, base * 2 ** record.attempts);
      this.repository.retryOutbox(record.id, message, new Date(Date.now() + retryMs).toISOString());
      this.wake(retryMs);
    }
  }

  private async startRuntime(record: OutboxRecord): Promise<void> {
    const assignment = this.repository.getAssignment(record.aggregateId);
    const attemptId =
      typeof record.payload.attemptId === 'string' ? record.payload.attemptId : null;
    if (!assignment || !attemptId || assignment.activeAttemptId !== attemptId) return;
    const attempt = this.repository.getAttempt(attemptId);
    if (
      !attempt ||
      ['RUNNING', 'WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE'].includes(attempt.state)
    )
      return;
    const snapshot = this.repository.snapshot(record.missionId);
    const task = snapshot.tasks.find((candidate) => candidate.id === assignment.taskId);
    if (!task) throw new Error(`Mission task ${assignment.taskId} is missing.`);
    this.repository.markAttemptStarting(attempt.id);
    const binding = await this.runtimes.forRuntime(attempt.requestedRuntime).start(
      {
        idempotencyKey: record.idempotencyKey,
        mission: snapshot.mission,
        task,
        assignment,
        attempt,
        workspaceRoot: snapshot.mission.executionPolicy.workspaceRoot,
      },
      new AbortController().signal,
    );
    this.repository.bindRuntime(assignment.id, attempt.id, {
      ...binding,
      leaseExpiresAt: binding.leaseExpiresAt ?? new Date(Date.now() + 2 * 60_000).toISOString(),
    });
    const runtime = this.repository.upsertRuntimeSession({
      id: `runtime:${attempt.id}`,
      attemptId: attempt.id,
      provider: binding.provider ?? attempt.requestedRuntime,
      transport:
        binding.transport ?? (attempt.requestedRuntime === 'managed' ? 'native' : 'terminal'),
      externalSessionId: binding.externalSessionId ?? binding.runtimeSessionId,
      processKey: binding.processKey ?? null,
      state: 'RUNNING',
      cwd: snapshot.mission.executionPolicy.workspaceRoot,
      capabilities: binding.capabilities ?? {},
    });
    this.repository.appendRuntimeEvent(runtime.id, attempt.id, 'session.started', {
      runtimeSessionId: binding.runtimeSessionId,
      terminalId: binding.terminalId ?? null,
      transport: runtime.transport,
    });
    await this.runtimes.forRuntime(attempt.requestedRuntime).activate?.(binding.runtimeSessionId);
    this.signalAssignment(assignment.id, 0);
  }

  private async cancelRuntime(record: OutboxRecord): Promise<void> {
    const attemptId =
      typeof record.payload.attemptId === 'string' ? record.payload.attemptId : null;
    const reason = typeof record.payload.reason === 'string' ? record.payload.reason : 'cancelled';
    if (!attemptId) return;
    const attempt = this.repository.getAttempt(attemptId);
    if (!attempt?.runtimeSessionId) return;
    await this.runtimes
      .forRuntime(attempt.requestedRuntime)
      .cancel(attempt.runtimeSessionId, reason);
    this.repository.updateRuntimeSessionState(attempt.id, 'ENDED');
  }

  private async deliverInbox(assignmentId: string): Promise<void> {
    if (this.stopped) return;
    const messages = this.repository.listUndeliveredMessages(assignmentId);
    if (messages.length === 0) return;
    if (
      this.repository.hasActiveContinuationForOwner(assignmentId) &&
      !messages.some((message) => message.priority === 'urgent')
    ) {
      return;
    }
    const assignment = this.repository.getAssignment(assignmentId);
    if (!assignment?.activeAttemptId) return;
    const attempt = this.repository.getAttempt(assignment.activeAttemptId);
    if (!attempt?.runtimeSessionId) return;
    const adapter = this.runtimes.forRuntime(attempt.requestedRuntime);
    if (!adapter.deliver) return;
    const messageIds = messages.map((message) => message.id);
    const urgent = messages.some((message) => message.priority === 'urgent');
    const latest = messages.at(-1)!;
    const notice = [
      `[Charter Mission inbox${urgent ? ' — urgent' : ''}]`,
      `${messages.length} committed message${messages.length === 1 ? '' : 's'} are waiting; latest sequence ${latest.sequence}: ${latest.subject}`,
      'Call orchestration.sync (or `charter orchestration sync --json`) before continuing.',
    ].join('\n');
    try {
      await adapter.deliver(attempt.runtimeSessionId, notice, new AbortController().signal);
      this.repository.markMessagesDelivered(assignmentId, messageIds);
      const runtime = this.repository.getRuntimeSessionForAttempt(attempt.id);
      if (runtime) {
        this.repository.appendRuntimeEvent(runtime.id, attempt.id, 'inbox.doorbell', {
          messageIds,
          latestSequence: latest.sequence,
        });
      }
      this.options.onChanged?.(assignment.missionId);
    } catch (error) {
      this.repository.markMessageDeliveryFailed(assignmentId, messageIds, errorMessage(error));
      this.options.onChanged?.(assignment.missionId);
      this.signalAssignment(assignmentId, 1_000);
    }
  }
}
