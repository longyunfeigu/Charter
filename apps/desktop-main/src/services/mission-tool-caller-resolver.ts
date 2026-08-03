import { productError, ProductFailure } from '@pi-ide/foundation';
import type { ToolCallRequest } from '@pi-ide/agent-contract';
import type { OrchestrationCallerContext, RuntimeKind } from '@pi-ide/orchestration-domain';
import type { AgentHost } from './agent-host.js';
import type { MissionOrchestrationService } from './mission-orchestration-service.js';
import type { TaskService } from './task-service.js';
import type { TerminalControlService } from './terminal-control-service.js';

/** Derives identity from Host/terminal state; tool payloads never carry authority. */
export class MissionToolCallerResolver {
  constructor(
    private readonly missions: MissionOrchestrationService,
    private readonly tasks: TaskService,
    private readonly host: AgentHost,
    private readonly terminals: TerminalControlService,
    private readonly isKnownAgent: (agentId: string) => boolean = () => false,
  ) {}

  resolve(call: ToolCallRequest): OrchestrationCallerContext {
    const hosted = this.host.orchestrationContextForCall(call);
    if (hosted) return hosted;

    const terminalId = this.terminals.callerTerminalForCall(call.callId);
    if (terminalId) {
      const assignment = this.missions.repository.getAssignmentForTerminal(terminalId);
      if (assignment) return this.missions.contextForAssignment(assignment.id, 'charter-terminal');
    }
    const runtimeSessionId = terminalId ? `terminal:${terminalId}` : `managed-run:${call.runId}`;
    const existing = this.missions.contextForRuntime(
      runtimeSessionId,
      terminalId ? 'charter-terminal' : 'managed-run',
    );
    if (existing) return existing;

    const task = this.tasks.getTask(call.taskId);
    return this.missions.adopt({
      workspaceId: task.workspaceId,
      workspaceRoot: task.worktree?.path ?? task.projectPath,
      originConversationTaskId: task.id,
      title: task.title,
      goal: task.goalMd,
      acceptanceCriteria: task.acceptance,
      principal: {
        kind: terminalId ? 'external_agent' : 'managed_agent',
        provider: task.external?.cli ?? task.model.providerId,
        externalIdentity: task.external?.sessionId ?? null,
        displayName: terminalId ? `${task.external?.cli ?? 'External'} Lead` : 'Charter Lead',
      },
      runtimeSessionId,
      ...(terminalId ? { terminalId } : {}),
      requestedRuntime: this.runtimeFor(task.external?.cli ?? null, terminalId !== null),
      requestedModel: terminalId ? null : `${task.model.providerId}::${task.model.modelId}`,
    }).caller;
  }

  private runtimeFor(cli: string | null, terminal: boolean): RuntimeKind {
    if (!terminal) return 'managed';
    if (cli && this.isKnownAgent(cli)) return cli;
    if (cli === null) return 'shell';
    throw new ProductFailure(
      productError('ORCHESTRATION_RUNTIME_UNSUPPORTED', {
        userMessage: `The external CLI ${cli} cannot join a Mission runtime yet.`,
      }),
    );
  }
}
