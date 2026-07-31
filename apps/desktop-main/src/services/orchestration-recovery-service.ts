import { errorMessage, type Logger } from '@pi-ide/foundation';
import type { ExecutionAttempt } from '@pi-ide/orchestration-domain';
import type { MissionRepository } from '@pi-ide/persistence';
import { OrchestrationRuntimeRegistry } from './orchestration-runtime-registry.js';

export interface OrchestrationRecoveryOptions {
  intervalMs?: number;
  leaseMs?: number;
  onChanged?: (missionId: string) => void;
}

/** Reconciles durable Attempts with real runtimes after restart and on lease expiry. */
export class OrchestrationRecoveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly repository: MissionRepository,
    private readonly runtimes: OrchestrationRuntimeRegistry,
    private readonly logger: Logger,
    private readonly options: OrchestrationRecoveryOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 30_000;
    this.timer = setInterval(() => void this.reconcileExpired(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async reconcileAll(): Promise<void> {
    const attempts = this.repository
      .listRecoverableMissions()
      .flatMap((mission) =>
        this.repository
          .snapshot(mission.id)
          .attempts.filter((attempt) => ['STARTING', 'RUNNING', 'WAITING'].includes(attempt.state)),
      );
    await this.reconcile(attempts);
  }

  async reconcileExpired(): Promise<void> {
    await this.reconcile(this.repository.listExpiredAttempts(new Date().toISOString()));
  }

  private async reconcile(attempts: ExecutionAttempt[]): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile(attempts).finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile(attempts: ExecutionAttempt[]): Promise<void> {
    for (const attempt of attempts) {
      const assignment = this.repository.getAssignment(attempt.assignmentId);
      if (!assignment || assignment.activeAttemptId !== attempt.id) continue;
      if (!attempt.runtimeSessionId) {
        // STARTING with no handle is owned by the recovered outbox operation.
        if (attempt.state === 'STARTING') continue;
        this.repository.orphanAttemptFromRuntime(attempt.id, 'runtime_handle_missing', {});
        this.options.onChanged?.(assignment.missionId);
        continue;
      }
      try {
        const adapter = this.runtimes.forRuntime(attempt.requestedRuntime);
        const result = adapter.reconcile
          ? await adapter.reconcile(attempt.runtimeSessionId)
          : { state: 'unknown' as const };
        if (result.state === 'alive') {
          const runtimeSessionId = result.binding?.runtimeSessionId ?? attempt.runtimeSessionId;
          if (assignment.state === 'PAUSED') {
            await adapter.pause?.(runtimeSessionId);
          }
          this.repository.rebindActiveRuntime(assignment.id, {
            runtimeSessionId,
            terminalId: result.binding?.terminalId ?? attempt.terminalId,
            leaseExpiresAt: new Date(
              Date.now() + (this.options.leaseMs ?? 2 * 60_000),
            ).toISOString(),
          });
          this.options.onChanged?.(assignment.missionId);
        } else if (result.state === 'missing') {
          const mission = this.repository.getMission(assignment.missionId);
          if (mission?.leadAssignmentId === assignment.id) {
            this.repository.orphanAttemptFromRuntime(attempt.id, 'runtime_missing', {
              detail: result.detail ?? null,
            });
          } else {
            this.repository.failAttemptFromRuntime(attempt.id, 'runtime_missing', {
              detail: result.detail ?? null,
            });
          }
          this.options.onChanged?.(assignment.missionId);
        }
      } catch (error) {
        this.logger.warn('Mission runtime reconciliation failed', {
          attemptId: attempt.id,
          error: errorMessage(error),
        });
      }
    }
  }
}
