import type { ModelRef } from '@pi-ide/agent-contract';
import type { OrchestrationCallerContext } from '@pi-ide/orchestration-domain';
import type { SettingsService } from './settings-service.js';
import type { TaskService } from './task-service.js';
import type {
  OrchestrationRuntimeAdapter,
  RuntimeObservation,
  RuntimeReconciliation,
  RuntimeSessionBinding,
  RuntimeStartRequest,
} from './orchestration-runtime-registry.js';

function requestedModel(value: string | null, settings: SettingsService): ModelRef {
  const separator = value?.includes('::') ? '::' : '/';
  const [explicitProvider, explicitModel] = value?.split(separator) ?? [];
  const effective = settings.effective;
  const providerId = explicitProvider || effective.models.defaultProviderId;
  const modelId = explicitModel || value || effective.models.defaultModelId;
  if (effective.models.useMockRuntime) return { providerId: 'mock', modelId: modelId ?? 'mock-1' };
  if (!providerId || !modelId) {
    throw new Error('No default managed model is configured for this Mission Assignment.');
  }
  return {
    providerId,
    modelId,
    thinkingLevel: effective.models.defaultThinkingLevel,
  };
}

export class ManagedAgentRuntime implements OrchestrationRuntimeAdapter {
  readonly kind = 'managed-agent' as const;

  constructor(
    private readonly tasks: TaskService,
    private readonly settings: SettingsService,
  ) {}

  async start(input: RuntimeStartRequest): Promise<RuntimeSessionBinding> {
    const callerContext: OrchestrationCallerContext = {
      principalId: input.assignment.assigneePrincipalId,
      runtimeSessionId: '',
      missionId: input.mission.id,
      assignmentId: input.assignment.id,
      attemptId: input.attempt.id,
      origin: 'managed-run',
    };
    const result = await this.tasks.createOrchestratedTask(
      {
        title: input.task.title,
        goalMd: input.task.goal,
        acceptance: input.task.acceptanceCriteria,
        mode:
          input.task.workMode === 'read-only' ? 'ask' : this.settings.effective.agent.defaultMode,
        model: requestedModel(input.attempt.requestedModel, this.settings),
        verification: [],
        projectPath: input.workspaceRoot,
        isolation: input.task.workMode === 'isolated-write' ? 'worktree' : 'none',
      },
      callerContext,
      { attemptId: input.attempt.id, idempotencyKey: input.idempotencyKey },
    );
    const task = this.tasks.getTask(result.taskId);
    return {
      runtimeSessionId: `managed-task:${result.taskId}`,
      transport: 'native',
      provider: 'managed',
      externalSessionId: result.taskId,
      capabilities: { steer: true, pause: true, resume: true, durableInboxDoorbell: true },
      artifacts: [
        {
          kind: 'managed-task',
          label: task.title,
          reference: { taskId: task.id },
        },
        ...(task.worktree
          ? [
              {
                kind: 'worktree',
                label: task.worktree.branch,
                reference: {
                  taskId: task.id,
                  path: task.worktree.path,
                  branch: task.worktree.branch,
                  baseHead: task.worktree.baseHead,
                  baseBranch: task.worktree.baseBranch,
                  integrationTarget: input.workspaceRoot,
                },
              },
            ]
          : []),
      ],
    };
  }

  async steer(runtimeSessionId: string, text: string): Promise<void> {
    await this.tasks.steerOrchestratedTask(this.taskId(runtimeSessionId), text);
  }

  async deliver(runtimeSessionId: string, message: string): Promise<void> {
    await this.tasks.steerOrchestratedTask(this.taskId(runtimeSessionId), message);
  }

  async pause(runtimeSessionId: string): Promise<void> {
    await this.tasks.stopTask(this.taskId(runtimeSessionId));
  }

  async resume(runtimeSessionId: string): Promise<void> {
    await this.tasks.startTask(this.taskId(runtimeSessionId));
  }

  async cancel(runtimeSessionId: string): Promise<void> {
    await this.tasks.stopTask(this.taskId(runtimeSessionId));
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeObservation> {
    try {
      const task = this.tasks.getTask(this.taskId(runtimeSessionId));
      if (['IN_PROGRESS', 'EXPLORING', 'PLANNING', 'VERIFYING'].includes(task.state)) {
        return { state: 'running', detail: task.state };
      }
      if (['READY', 'IDLE', 'AWAITING_USER', 'REVIEW_READY'].includes(task.state)) {
        return { state: 'waiting', detail: task.state };
      }
      return { state: 'ended', detail: task.state };
    } catch {
      return { state: 'missing' };
    }
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation> {
    const observation = await this.inspect(runtimeSessionId);
    return observation.state === 'missing'
      ? { state: 'missing' }
      : { state: 'alive', binding: { runtimeSessionId }, detail: observation.detail };
  }

  private taskId(runtimeSessionId: string): string {
    if (!runtimeSessionId.startsWith('managed-task:')) {
      throw new Error(`Invalid managed runtime id: ${runtimeSessionId}`);
    }
    return runtimeSessionId.slice('managed-task:'.length);
  }
}
