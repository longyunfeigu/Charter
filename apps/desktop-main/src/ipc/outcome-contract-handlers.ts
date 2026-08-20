import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import type { OutcomeDomain } from '@pi-ide/ipc-contracts';
import type { Logger } from '@pi-ide/foundation';
import { registerHandlers } from './router.js';
import type { OutcomeContractService } from '../services/outcome-contract-service.js';
import type { TaskService } from '../services/task-service.js';
import type { WorkItemService } from '../services/work-item-service.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { AgentSemanticControlService } from '../services/agent-semantic-control-service.js';

function domainForWorkType(typeId: string): OutcomeDomain {
  if (typeId === 'work-type-product') return 'product';
  if (typeId === 'work-type-finance') return 'finance';
  if (typeId === 'work-type-data' || typeId === 'work-type-research') return 'data';
  if (typeId === 'work-type-content') return 'content';
  if (typeId === 'work-type-operations') return 'operations';
  if (typeId === 'work-type-engineering') return 'software';
  return 'general';
}

export function registerOutcomeContractHandlers(
  outcomes: OutcomeContractService,
  tasks: TaskService,
  workItems: WorkItemService,
  agents: AgentRegistry,
  semanticAgents: AgentSemanticControlService | null,
  logger: Logger,
): void {
  registerHandlers(
    {
      'outcomes.packs': async () => ({ packs: [...outcomes.packs()] }),
      'outcomes.summaries': async () => ({ contracts: outcomes.summaries() }),
      'outcomes.get': async ({ subjectKind, subjectId }) => {
        if (subjectKind === 'task') {
          const task = tasks.getTask(subjectId);
          return {
            contract: outcomes.getOrCreate('task', subjectId, {
              title: task.title,
              objective: task.goalMd,
              domain: 'software',
              acceptance: task.acceptance,
              commands: task.verification.map((command) => ({ label: command.label })),
            }),
          };
        }
        const detail = workItems.detail(subjectId);
        const item = detail.item;
        const approverValue = item.customFields.approval_owner ?? item.customFields.decision_owner;
        return {
          contract: outcomes.getOrCreate('work_item', subjectId, {
            title: item.title,
            objective: item.descriptionMd,
            domain: domainForWorkType(item.typeId),
            requester: item.sourcePerson,
            approver: typeof approverValue === 'string' ? approverValue : '',
            acceptance: item.acceptance.map((entry) => entry.text),
          }),
        };
      },
      'outcomes.history': async ({ contractId }) => ({ versions: outcomes.history(contractId) }),
      'outcomes.updateDraft': async ({ contractId, draft, actor }) => ({
        contract: outcomes.updateDraft(contractId, draft, actor),
      }),
      'outcomes.applyPack': async ({ contractId, domain, actor }) => ({
        contract: outcomes.applyPack(contractId, domain, actor),
      }),
      'outcomes.freeze': async ({ contractId, actor }) => ({
        contract: outcomes.freeze(contractId, actor),
      }),
      'outcomes.revise': async ({ contractId, actor, reason }) => ({
        contract: outcomes.revise(contractId, actor, reason),
      }),
      'outcomes.observe': async ({ contractId, claimId, value, actor, evidence }) => ({
        contract: outcomes.recordObservation(contractId, claimId, value, actor, evidence),
      }),
      'outcomes.reviewClaim': async ({
        contractId,
        claimId,
        status,
        actual,
        note,
        actor,
        evidence,
      }) => ({
        contract: outcomes.reviewClaim(contractId, claimId, {
          status,
          actual,
          note,
          actor,
          evidence,
        }),
      }),
      'outcomes.runCommands': async ({ contractId }) => {
        let contract = outcomes.get(contractId);
        let taskId: string | null = null;
        if (contract.subjectKind === 'task') taskId = contract.subjectId;
        else {
          const primary = workItems
            .detail(contract.subjectId)
            .executions.find(
              (execution) =>
                execution.targetKind === 'session' &&
                execution.targetId &&
                execution.role === 'primary',
            );
          taskId = primary?.targetId ?? null;
        }
        if (!taskId) return { contract, ran: 0 };
        const labels = [
          ...new Set(
            contract.claims.flatMap((claim) =>
              claim.verifier === 'automatic' && claim.oracle.type === 'command'
                ? [claim.oracle.commandLabel]
                : [],
            ),
          ),
        ];
        let ran = 0;
        for (const label of labels) {
          const results = await tasks.runVerifications(taskId, { label, initiator: 'user' });
          for (const result of results ?? []) {
            contract = outcomes.recordCommand(contract.id, result.label, {
              state: result.state,
              exitCode: result.exitCode,
              outputExcerpt: result.outputExcerpt,
              stale: result.stale,
            });
            ran += 1;
          }
        }
        return { contract, ran };
      },
      'outcomes.agent.begin': async ({ contractId, agentId, actor }) => {
        const detected = agents.catalog().agents.find((candidate) => candidate.id === agentId);
        if (!detected?.installed || !detected.capabilities.terminal) {
          throw new Error(
            `${detected?.displayName ?? agentId} is not available as a local terminal Agent.`,
          );
        }
        return outcomes.beginAgent(contractId, agentId, actor);
      },
      'outcomes.agent.attach': async ({ contractId, runId, terminalId }) => ({
        contract: outcomes.attachAgent(contractId, runId, terminalId),
      }),
      'outcomes.agent.collect': async ({ contractId, runId }) => {
        const current = outcomes.get(contractId);
        const run = current.agentRuns.find((candidate) => candidate.id === runId);
        if (!run?.terminalId || !semanticAgents)
          return { contract: current, collected: false, waiting: true };
        const caller = {
          taskId: current.subjectKind === 'task' ? current.subjectId : `outcome:${current.id}`,
        };
        let status: { state?: unknown };
        try {
          status = semanticAgents.status(caller, { id: run.terminalId }) as {
            state?: unknown;
          };
        } catch (error) {
          logger.debug('outcome Agent is not semantically identifiable yet', {
            contractId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { contract: current, collected: false, waiting: true };
        }
        if (
          status.state === 'working' ||
          status.state === 'blocked' ||
          status.state === 'unknown'
        ) {
          return { contract: current, collected: false, waiting: true };
        }
        let result: Record<string, unknown>;
        try {
          result = (await semanticAgents.result(
            caller,
            { id: run.terminalId, maxBytes: 64 * 1024 },
            new AbortController().signal,
          )) as Record<string, unknown>;
        } catch (error) {
          logger.debug('outcome Agent result is not settled yet', {
            contractId,
            runId,
            error: error instanceof Error ? error.message : String(error),
          });
          return { contract: current, collected: false, waiting: true };
        }
        if (
          typeof result.answer !== 'string' ||
          (result.source !== 'native_history' && result.source !== 'screen') ||
          (result.fidelity !== 'native' && result.fidelity !== 'observed') ||
          typeof result.agent !== 'string'
        ) {
          return { contract: current, collected: false, waiting: false };
        }
        // Screen reconstruction is useful for presence and user visibility, but it is
        // neither an exact Agent result nor necessarily settled. Keep waiting for the
        // adapter's native history instead of prematurely closing a still-working run
        // as UNVERIFIED.
        if (
          result.source !== 'native_history' ||
          result.fidelity !== 'native' ||
          result.settled !== true
        ) {
          return { contract: current, collected: false, waiting: true };
        }
        return {
          contract: outcomes.importAgentResult(contractId, runId, {
            answer: result.answer,
            source: result.source,
            fidelity: result.fidelity,
            settled: true,
            agent: result.agent,
          }),
          collected: true,
          waiting: false,
        };
      },
      'outcomes.agent.cancel': async ({ contractId, runId, actor }) => ({
        contract: outcomes.cancelAgent(contractId, runId, actor),
      }),
      'outcomes.decide': async ({ contractId, decision, actor, role, note, override }) => ({
        contract: outcomes.decide(contractId, { decision, actor, role, note, override }),
      }),
      'outcomes.export': async ({ contractId }) => {
        const report = outcomes.export(contractId);
        let markdownPath: string | null;
        if (process.env.PI_IDE_E2E) {
          markdownPath = join(app.getPath('userData'), `${report.suggestedName}.md`);
        } else {
          const chosen = await dialog.showSaveDialog({
            title: 'Export acceptance contract',
            defaultPath: join(app.getPath('downloads'), `${report.suggestedName}.md`),
            filters: [{ name: 'Markdown report', extensions: ['md'] }],
          });
          markdownPath = chosen.canceled || !chosen.filePath ? null : chosen.filePath;
        }
        if (!markdownPath) return { markdownPath: null, jsonPath: null };
        const jsonPath = markdownPath.replace(/\.md$/i, '') + '.json';
        writeFileSync(markdownPath, report.markdown, { mode: 0o600 });
        writeFileSync(jsonPath, report.json, { mode: 0o600 });
        logger.info('acceptance contract exported', { contractId, markdownPath, jsonPath });
        return { markdownPath, jsonPath };
      },
    },
    logger,
  );
}
