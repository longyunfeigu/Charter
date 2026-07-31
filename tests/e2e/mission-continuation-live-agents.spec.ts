import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_CONTINUATION === '1';
const WORKSPACE = process.env.CHARTER_LIVE_WORKSPACE ?? resolve('.');

async function missions(page: Page): Promise<MissionSnapshotDto[]> {
  return await page.evaluate(async () => {
    const response = (await window.product.rpc['mission.list']!({ limit: 50 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!response.ok) throw new Error(response.error?.userMessage ?? 'mission.list failed');
    return response.data.missions;
  });
}

async function approveProviderPrompt(page: Page, terminalId: string): Promise<void> {
  const tail = (await terminalPtyOutput(page, terminalId)).slice(-12_000);
  if (/Do\s*you\s*trust|Press enter to continue/i.test(tail)) {
    await page.evaluate(async (id) => {
      await window.product.rpc['terminal.write']!({
        id,
        data: '\r',
        userInitiated: true,
      });
    }, terminalId);
    return;
  }
  if (/Enter to select/.test(tail)) {
    const firstChoiceIsNo = /❯\s*1\.\s*(?:No|不|不是)/i.test(tail);
    await page.evaluate(
      async ({ id, data }) => {
        await window.product.rpc['terminal.write']!({ id, data, userInitiated: true });
      },
      { id: terminalId, data: firstChoiceIsNo ? '\u001b[B\r' : '\r' },
    );
  }
}

test('real Claude Lead parks and is resumed in the same Session after real Codex completes', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_CONTINUATION=1 to spend real Claude/Codex turns');
  test.setTimeout(12 * 60_000);

  const marker = `LIVE-CONTINUATION-${Date.now()}`;
  const childTitle = `${marker} Codex child B`;
  const childGoal = [
    `You are Codex child B in Charter acceptance ${marker}.`,
    'This is read-only. Do not edit files and do not delegate.',
    'Run `charter orchestration inspect --json`.',
    `Then run \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} B COMPLETE".`,
    'Execute the commands; do not merely describe them.',
  ].join(' ');
  const leadPrompt = [
    `Run Charter durable continuation acceptance ${marker}. This is read-only; do not edit files.`,
    'Use only native `charter orchestration ... --json` CLI commands. Do not create terminals manually.',
    'Run `charter orchestration inspect --json`, retrying once if Mission attachment is still initializing.',
    'Delegate exactly one child with `charter orchestration delegate --request-json <JSON> --json` using:',
    JSON.stringify({
      title: childTitle,
      goal: childGoal,
      acceptanceCriteria: [`${marker} B COMPLETE is committed`],
      requestedRuntime: 'codex',
      workMode: 'read-only',
      reason: 'prove real cross-provider continuation resume',
      idempotencyKey: `${marker}-child`,
    }),
    'Read the returned child Assignment id.',
    'Call `charter orchestration park --request-json <JSON> --json` exactly once with mode "all", one assignment_terminal condition for that child id, timeoutMs 420000, reason "wait for real Codex child", and idempotencyKey',
    `"${marker}-park".`,
    'Immediately end your current turn after park succeeds. Do not call wait, join, inspect, complete, or any other command in that turn.',
    'Only after Charter injects a message beginning `[Charter continuation ready]`: run the exact `charter orchestration continue ...` command from that message, inspect once, verify B completed, then complete successfully with summary',
    `"${marker} A COMPLETE AFTER AUTOMATIC RESUME".`,
    'Execute every requested command rather than explaining the plan.',
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const initialMissionIds = new Set((await missions(launched.page)).map((item) => item.mission.id));
  const liveMission = (snapshots: MissionSnapshotDto[]) =>
    snapshots.find((snapshot) => !initialMissionIds.has(snapshot.mission.id));
  let missionId = '';
  try {
    const leadTerminalId = await launched.page.evaluate(async (prompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt: prompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, leadPrompt);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await launched.page.waitForTimeout(2_000);
      await approveProviderPrompt(launched.page, leadTerminalId);
      if (liveMission(await missions(launched.page))) break;
    }

    await expect
      .poll(async () => liveMission(await missions(launched.page))?.mission.id ?? null, {
        timeout: 3 * 60_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .not.toBeNull();
    missionId = liveMission(await missions(launched.page))!.mission.id;

    await expect
      .poll(
        async () => {
          const snapshot = liveMission(await missions(launched.page));
          if (!snapshot) return null;
          const continuation = snapshot.continuations?.find(
            (item) => item.ownerAssignmentId === snapshot.mission.leadAssignmentId,
          );
          const intent = snapshot.resumeIntents?.find(
            (item) => item.continuationId === continuation?.id,
          );
          return {
            taskTitles: snapshot.tasks.map((task) => task.title),
            continuationState: continuation?.state ?? null,
            intentState: intent?.state ?? null,
            assignmentStates: snapshot.assignments.map((assignment) => assignment.state),
            attemptStates: snapshot.attempts.map((attempt) => attempt.state),
          };
        },
        { timeout: 10 * 60_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toMatchObject({
        taskTitles: expect.arrayContaining([childTitle]),
        continuationState: 'CONSUMED',
        intentState: 'ACKNOWLEDGED',
        assignmentStates: ['COMPLETED', 'COMPLETED'],
        attemptStates: ['SUCCEEDED', 'SUCCEEDED'],
      });

    const final = liveMission(await missions(launched.page))!;
    expect(final.mission.state).toBe('VERIFYING');
    expect(final.continuationTargets).toContainEqual(
      expect.objectContaining({ kind: 'assignment_terminal', satisfiedAt: expect.any(String) }),
    );
    const leadOutput = await terminalPtyOutput(launched.page, leadTerminalId);
    expect(leadOutput).toContain('[Charter continuation ready]');
    expect(leadOutput).toContain(marker);
    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${missionId}`).click();
    await expect(launched.page.getByTestId('mission-state')).toHaveText('Ready to review');
    await launched.page.screenshot({ path: '/tmp/charter-live-continuation-complete.png' });
  } finally {
    if (missionId) {
      await launched.page
        .evaluate(async (id) => {
          await window.product.rpc['mission.finish']!({
            missionId: id,
            outcome: 'cancelled',
            reason: 'Live continuation test cleanup',
          });
        }, missionId)
        .catch(() => undefined);
    }
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
