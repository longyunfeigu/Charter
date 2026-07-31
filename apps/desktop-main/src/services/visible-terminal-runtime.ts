import type { RuntimeKind } from '@pi-ide/orchestration-domain';
import type { TerminalControlService } from './terminal-control-service.js';
import type {
  OrchestrationRuntimeAdapter,
  OrchestrationRuntimeAdapterKind,
  RuntimeObservation,
  RuntimeReconciliation,
  RuntimeSessionBinding,
  RuntimeStartRequest,
} from './orchestration-runtime-registry.js';

interface TerminalCreateResult {
  terminal?: { id?: string };
}

interface TerminalListResult {
  terminals?: Array<{ id?: string; busy?: boolean }>;
}

function launchFor(kind: RuntimeKind): 'shell' | 'claude' | 'codex' {
  return kind === 'shell' ? 'shell' : kind === 'claude' ? 'claude' : 'codex';
}

export function missionWorkerPrompt(input: RuntimeStartRequest): string {
  const criteria = input.task.acceptanceCriteria.length
    ? `\nAcceptance criteria:\n${input.task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
    : '';
  return [
    `You are Assignment ${input.assignment.id} in Charter Mission ${input.mission.id}.`,
    input.task.goal,
    criteria,
    '',
    'Use the charter-orchestration Skill and `charter orchestration` commands for structured coordination.',
    'You may delegate a bounded subproblem directly; do not ask your supervisor to proxy it.',
    `Before finishing, report with orchestration.complete for Attempt ${input.attempt.id}.`,
  ].join('\n');
}

/** Runtime adapter over the existing visible PTY implementation. */
export class VisibleTerminalRuntime implements OrchestrationRuntimeAdapter {
  readonly kind: OrchestrationRuntimeAdapterKind = 'visible-terminal';

  constructor(private readonly control: TerminalControlService) {}

  async start(input: RuntimeStartRequest): Promise<RuntimeSessionBinding> {
    const taskId = input.mission.originConversationTaskId;
    if (!taskId)
      throw new Error('A visible worker requires an originating Charter conversation task.');
    const launch = launchFor(input.attempt.requestedRuntime);
    const result = (await this.control.create(
      { taskId },
      {
        root: input.workspaceRoot,
        launch,
        ...(launch !== 'shell' ? { initialText: missionWorkerPrompt(input) } : {}),
        submit: true,
        idempotencyKey: input.idempotencyKey,
        bypassLegacyBudget: true,
      },
    )) as TerminalCreateResult;
    const terminalId = result.terminal?.id;
    if (!terminalId) throw new Error('The terminal runtime did not return a terminal id.');
    return {
      runtimeSessionId: `terminal:${terminalId}`,
      terminalId,
      transport: 'terminal',
      provider: launch,
      externalSessionId: terminalId,
      capabilities: { steer: true, pause: true, resume: true, durableInboxDoorbell: true },
    };
  }

  async deliver(runtimeSessionId: string, message: string): Promise<void> {
    await this.control.notifyRuntime(this.terminalId(runtimeSessionId), message);
  }

  async steer(runtimeSessionId: string, text: string): Promise<void> {
    await this.control.sendRuntime(this.terminalId(runtimeSessionId), text);
  }

  async pause(runtimeSessionId: string): Promise<void> {
    this.control.pauseRuntime(this.terminalId(runtimeSessionId), true);
  }

  async resume(runtimeSessionId: string): Promise<void> {
    this.control.pauseRuntime(this.terminalId(runtimeSessionId), false);
  }

  async cancel(runtimeSessionId: string, reason: string): Promise<void> {
    const id = this.terminalId(runtimeSessionId);
    this.control.closeRuntime(id);
    void reason;
  }

  async inspect(runtimeSessionId: string): Promise<RuntimeObservation> {
    const id = this.terminalId(runtimeSessionId);
    const list = this.control.list({ taskId: 'system' }) as TerminalListResult;
    const terminal = list.terminals?.find((item) => item.id === id);
    return terminal ? { state: terminal.busy ? 'running' : 'waiting' } : { state: 'missing' };
  }

  async reconcile(runtimeSessionId: string): Promise<RuntimeReconciliation> {
    const observation = await this.inspect(runtimeSessionId);
    return observation.state === 'missing'
      ? { state: 'missing' }
      : {
          state: 'alive',
          binding: { runtimeSessionId, terminalId: this.terminalId(runtimeSessionId) },
        };
  }

  private terminalId(runtimeSessionId: string): string {
    return runtimeSessionId.startsWith('terminal:')
      ? runtimeSessionId.slice('terminal:'.length)
      : runtimeSessionId;
  }
}

export class ShellRuntime extends VisibleTerminalRuntime {
  override readonly kind: OrchestrationRuntimeAdapterKind = 'shell';
}
