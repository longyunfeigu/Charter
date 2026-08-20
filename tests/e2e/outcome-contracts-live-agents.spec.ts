import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OutcomeContract } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_OUTCOME === '1';
const AGENTS = (process.env.CHARTER_LIVE_OUTCOME_AGENTS ?? 'codex,claude')
  .split(',')
  .map((agent) => agent.trim())
  .filter(Boolean);

async function rpc<T>(page: Page, name: string, input: unknown): Promise<T> {
  return (await page.evaluate(
    async ({ channel, payload }) => {
      const handler = (window.product.rpc as Record<string, (value: unknown) => Promise<unknown>>)[
        channel
      ];
      if (!handler) throw new Error(`Missing RPC ${channel}`);
      const result = (await handler(payload)) as
        { ok: true; data: unknown } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? `${channel} failed`);
      return result.data;
    },
    { channel: name, payload: input },
  )) as T;
}

async function createFrozenAgentContract(
  page: Page,
  agent: string,
  marker: string,
): Promise<{ workItemId: string; contractId: string }> {
  const created = await rpc<{ item: { id: string } }>(page, 'workItem.create', {
    typeId: 'work-type-generic',
    title: `${marker} ${agent} independent acceptance`,
    descriptionMd:
      'Independently verify one stable repository fact without modifying the repository.',
    sourcePerson: 'Live acceptance harness',
    priority: 'high',
  });
  const loaded = await rpc<{ contract: OutcomeContract }>(page, 'outcomes.get', {
    subjectKind: 'work_item',
    subjectId: created.item.id,
  });
  const contract = loaded.contract;
  await rpc(page, 'outcomes.updateDraft', {
    contractId: contract.id,
    actor: 'Live acceptance harness',
    draft: {
      domain: 'general',
      title: contract.title,
      objective:
        'Read package.json and independently establish whether the package name is exactly pi-ide.',
      requester: 'Live acceptance harness',
      approver: 'Edy',
      openQuestions: [],
      claims: [
        {
          statement: 'The root package.json declares the package name exactly as pi-ide.',
          source: { kind: 'project_policy', reference: 'package.json name field' },
          includedScope: ['Root package.json'],
          excludedScope: ['Do not inspect credentials or user data'],
          preconditions: ['Repository is available read-only'],
          method: 'semantic',
          oracle: {
            type: 'semantic_rubric',
            rubric:
              'Read only the root package.json. PASS only if its parsed top-level name is exactly pi-ide.',
          },
          verifier: 'agent',
          severity: 'blocking',
          evidenceRequirements: [
            {
              kind: 'file',
              description: 'Reference to the root package.json and the observed name value',
              required: true,
            },
          ],
        },
      ],
    },
  });
  await rpc(page, 'outcomes.freeze', {
    contractId: contract.id,
    actor: 'Live acceptance harness',
  });
  return { workItemId: created.item.id, contractId: contract.id };
}

test('real Codex and Claude independently verify a frozen Outcome Contract', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_OUTCOME=1 to spend real Codex/Claude turns');
  test.setTimeout(12 * 60_000);

  const marker = `LIVE-OUTCOME-${Date.now()}`;
  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: resolve('.'),
      PI_IDE_EXTERNAL_CLIS: AGENTS.join(','),
    },
  });
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await launched.page.getByTestId('rail-view-work').click();
    for (const agent of AGENTS) {
      const { workItemId, contractId } = await createFrozenAgentContract(
        launched.page,
        agent,
        marker,
      );
      await rpc(launched.page, 'workItem.snapshot', { includeArchived: false });
      await launched.page.getByTestId('rail-view-work').click();
      await expect
        .poll(
          async () =>
            await launched.page
              .locator('.work-card')
              .filter({ hasText: `${agent} independent acceptance` })
              .count(),
        )
        .toBe(1);
      await launched.page
        .locator('.work-card')
        .filter({ hasText: `${agent} independent acceptance` })
        .click();
      const panel = launched.page.getByTestId('outcome-contract-panel');
      await expect(panel.getByTestId('outcome-contract-frozen')).toBeVisible();
      await panel.getByLabel('Independent Agent').selectOption(agent);
      await panel.getByTestId('outcome-start-agent').click();

      const terminalId = await expect
        .poll(
          async () => {
            const current = await rpc<{ contract: OutcomeContract }>(
              launched.page,
              'outcomes.get',
              { subjectKind: 'work_item', subjectId: workItemId },
            );
            return current.contract.agentRuns.at(-1)?.terminalId ?? null;
          },
          { timeout: 30_000, intervals: [250, 500, 1_000] },
        )
        .not.toBeNull()
        .then(async () => {
          const current = await rpc<{ contract: OutcomeContract }>(launched.page, 'outcomes.get', {
            subjectKind: 'work_item',
            subjectId: workItemId,
          });
          return current.contract.agentRuns.at(-1)!.terminalId!;
        });

      await launched.page.waitForTimeout(1_500);
      if (
        /Do\s*you\s*trust|Press enter to continue|trust this folder/i.test(
          await terminalPtyOutput(launched.page, terminalId),
        )
      ) {
        await rpc(launched.page, 'terminal.write', {
          id: terminalId,
          data: '\r',
          userInitiated: true,
        });
      }

      const deadline = Date.now() + 4 * 60_000;
      let settled: OutcomeContract | null = null;
      while (Date.now() < deadline) {
        const current = await rpc<{ contract: OutcomeContract }>(launched.page, 'outcomes.get', {
          subjectKind: 'work_item',
          subjectId: workItemId,
        });
        const run = current.contract.agentRuns.at(-1);
        if (run?.terminalId && (run.status === 'running' || run.status === 'needs_user')) {
          await rpc(launched.page, 'outcomes.agent.collect', {
            contractId,
            runId: run.id,
          });
        }
        const refreshed = await rpc<{ contract: OutcomeContract }>(launched.page, 'outcomes.get', {
          subjectKind: 'work_item',
          subjectId: workItemId,
        });
        const refreshedRun = refreshed.contract.agentRuns.at(-1);
        if (refreshed.contract.lifecycle === 'verified') {
          settled = refreshed.contract;
          break;
        }
        if (refreshedRun && ['completed', 'failed', 'cancelled'].includes(refreshedRun.status)) {
          const output = (await terminalPtyOutput(launched.page, terminalId)).slice(-8_000);
          throw new Error(
            `${agent} settled without verification:\n${JSON.stringify(
              {
                lifecycle: refreshed.contract.lifecycle,
                run: refreshedRun,
                claims: refreshed.contract.claims.map((claim) => ({
                  id: claim.id,
                  status: claim.status,
                  note: claim.note,
                  actual: claim.actual,
                  evidenceIds: claim.evidenceIds,
                })),
              },
              null,
              2,
            )}\nTerminal tail:\n${output}`,
          );
        }
        await launched.page.waitForTimeout(1_000);
      }
      if (!settled) {
        throw new Error(`${agent} did not settle the frozen contract within four minutes.`);
      }

      const final = await rpc<{ contract: OutcomeContract }>(launched.page, 'outcomes.get', {
        subjectKind: 'work_item',
        subjectId: workItemId,
      });
      expect(final.contract.claims[0]).toMatchObject({ status: 'passed', verifiedBy: agent });
      expect(final.contract.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'file', source: 'agent', fidelity: 'native' }),
          expect.objectContaining({ kind: 'agent_report', source: 'agent', fidelity: 'native' }),
        ]),
      );
      expect(final.contract.acceptanceState).toBe('pending');
      await expect(panel).toContainText('Verified · Verified');
      await panel
        .getByLabel('Decision rationale')
        .fill(`Accepted after independent ${agent} verification.`);
      await panel.getByTestId('outcome-accept').click();
      await expect(panel).toContainText('Accepted · accepted');
      await launched.page.getByTestId('work-detail-close').click();
    }
    await launched.page.screenshot({ path: '/tmp/charter-live-outcome-contracts.png' });
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
