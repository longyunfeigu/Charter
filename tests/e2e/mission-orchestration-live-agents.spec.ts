import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput, terminalPtySnapshot } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_MISSION === '1';
const WORKSPACE = process.env.CHARTER_LIVE_WORKSPACE ?? resolve('.');

async function missionSnapshots(page: Page): Promise<MissionSnapshotDto[]> {
  return await page.evaluate(async () => {
    const result = (await window.product.rpc['mission.list']!({ limit: 20 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'mission.list failed');
    return result.data.missions;
  });
}

async function taskIdForTerminal(page: Page, terminalId: string): Promise<string | null> {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    })) as
      { ok: true; data: { tasks: TaskDto[] } } | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.list failed');
    return result.data.tasks.find((task) => task.external?.terminalId === id)?.id ?? null;
  }, terminalId);
}

test('real Claude A recursively delegates to real Codex B which delegates to real Claude D', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_MISSION=1 to spend real Claude/Codex turns');
  test.setTimeout(15 * 60_000);

  const marker = `LIVE-${Date.now()}`;
  const dTitle = `${marker} Claude verifier D`;
  const bTitle = `${marker} Codex coordinator B`;
  const dGoal = [
    `You are the leaf verifier D in real acceptance run ${marker}.`,
    'Do not edit files and do not create another child.',
    'Use native `charter orchestration ... --json` CLI commands.',
    'Run `charter orchestration inspect --json`, then progress with phase "live-leaf" using request JSON.',
    `Finally use \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} D COMPLETE".`,
  ].join(' ');
  const bGoal = [
    `You are coordinator B in real acceptance run ${marker}. Do not edit files.`,
    'Use native `charter orchestration ... --json` CLI commands.',
    'First run `charter orchestration inspect --json`.',
    'Then you, B, must directly run `charter orchestration delegate --request-json <JSON> --json` exactly once; do not ask A to proxy it.',
    `Create title "${dTitle}", requestedRuntime "claude", workMode "read-only",`,
    `goal ${JSON.stringify(dGoal)}, acceptanceCriteria ["D reports ${marker} D COMPLETE"],`,
    `expectedArtifacts ["structured completion"], reason "prove recursive B to D delegation", and idempotencyKey "${marker}-b-to-d".`,
    'Report phase "live-recursion" with `charter orchestration progress --request-json <JSON> --json` after delegating.',
    'Wait event-first using `charter orchestration wait --types completion --timeout-ms 600000 --json`.',
    'Inspect again and confirm D succeeded.',
    `Then use \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} B COMPLETE AFTER D".`,
  ].join(' ');
  const leadPrompt = [
    `Run the real Charter recursive Mission acceptance scenario ${marker}.`,
    'This is read-only: do not edit files, do not run implementation work, and do not use terminal_create.',
    'Use native `charter orchestration ... --json` CLI commands.',
    'First run `charter orchestration inspect --json`. If the external Session is still attaching, retry it.',
    'Then run `charter orchestration delegate --request-json <JSON> --json` exactly once with:',
    `title "${bTitle}", requestedRuntime "codex", workMode "read-only",`,
    `goal ${JSON.stringify(bGoal)}, acceptanceCriteria ["B creates D itself", "B completes only after D"],`,
    `expectedArtifacts ["recursive Mission history"], reason "prove real Claude to Codex recursive delegation", and idempotencyKey "${marker}-a-to-b".`,
    'Report phase "live-lead" with `charter orchestration progress --request-json <JSON> --json`.',
    'Wait event-first using `charter orchestration wait --types completion --timeout-ms 600000 --json`.',
    'Inspect again and verify that both B and D succeeded.',
    `Finally use \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} A COMPLETE AFTER B AND D".`,
    'Do not merely describe these actions: execute every CLI command.',
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  const initialMissionIds = new Set<string>();
  const liveMission = (missions: MissionSnapshotDto[]) =>
    missions.find((snapshot) => !initialMissionIds.has(snapshot.mission.id));

  try {
    for (const snapshot of await missionSnapshots(launched.page)) {
      initialMissionIds.add(snapshot.mission.id);
    }

    const leadTerminalId = await launched.page.evaluate(async (prompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt: prompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, leadPrompt);

    await expect
      .poll(
        async () => {
          const missions = await missionSnapshots(launched.page);
          return liveMission(missions) ?? null;
        },
        { timeout: 3 * 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .not.toBeNull();

    await expect
      .poll(
        async () => {
          const missions = await missionSnapshots(launched.page);
          return (
            liveMission(missions)
              ?.tasks.map((task) => task.title)
              .sort() ?? []
          );
        },
        { timeout: 10 * 60_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toEqual(expect.arrayContaining([bTitle, dTitle]));

    await expect
      .poll(
        async () => {
          const missions = await missionSnapshots(launched.page);
          const mission = liveMission(missions);
          if (!mission) return null;
          return {
            state: mission.mission.state,
            allAssignmentsCompleted: mission.assignments.every(
              (assignment) => assignment.state === 'COMPLETED',
            ),
            allAttemptsSucceeded: mission.attempts.every(
              (attempt) => attempt.state === 'SUCCEEDED',
            ),
          };
        },
        { timeout: 12 * 60_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toMatchObject({
        state: 'VERIFYING',
        allAssignmentsCompleted: true,
        allAttemptsSucceeded: true,
      });

    const finalMissions = await missionSnapshots(launched.page);
    const finalMission = liveMission(finalMissions)!;
    const lead = finalMission.assignments.find(
      (assignment) => assignment.id === finalMission.mission.leadAssignmentId,
    )!;
    const bTask = finalMission.tasks.find((task) => task.title === bTitle)!;
    const dTask = finalMission.tasks.find((task) => task.title === dTitle)!;
    const b = finalMission.assignments.find((assignment) => assignment.taskId === bTask.id)!;
    const d = finalMission.assignments.find((assignment) => assignment.taskId === dTask.id)!;
    expect(b.supervisorAssignmentId).toBe(lead.id);
    expect(d.supervisorAssignmentId).toBe(b.id);
    expect(finalMission.attempts.every((attempt) => attempt.state === 'SUCCEEDED')).toBe(true);
    const bAttempt = finalMission.attempts.find((attempt) => attempt.assignmentId === b.id)!;
    const dAttempt = finalMission.attempts.find((attempt) => attempt.assignmentId === d.id)!;
    expect(JSON.stringify(bAttempt.result)).toContain(marker);
    expect(dAttempt.result).toMatchObject({ summary: `${marker} D COMPLETE` });
    const completionMessages = finalMission.messages.filter(
      (message) => message.type === 'completion',
    );
    expect(completionMessages).toHaveLength(3);
    expect(completionMessages.filter((message) => message.toAssignmentId !== null)).toHaveLength(2);
    expect(completionMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromAssignmentId: d.id, toAssignmentId: b.id }),
        expect.objectContaining({ fromAssignmentId: b.id, toAssignmentId: lead.id }),
      ]),
    );

    const terminals = await terminalPtySnapshot(launched.page);
    expect(terminals.items.filter((item) => item.launch === 'claude')).toHaveLength(2);
    expect(terminals.items.filter((item) => item.launch === 'codex')).toHaveLength(1);
    expect(await terminalPtyOutput(launched.page, leadTerminalId)).toContain(marker);

    const settledTerminalIds = [bAttempt.terminalId, dAttempt.terminalId].filter(
      (id): id is string => id !== null,
    );
    const settledTaskIds = await launched.page.evaluate(async (terminalIds) => {
      const result = (await window.product.rpc['task.list']!({
        filter: 'all',
        includeArchived: false,
        scope: 'all',
      })) as
        { ok: true; data: { tasks: TaskDto[] } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.list failed');
      return result.data.tasks
        .filter((task) => task.external && terminalIds.includes(task.external.terminalId))
        .map((task) => task.id);
    }, settledTerminalIds);
    expect(settledTaskIds).toHaveLength(2);
    await launched.page.getByTestId('rail-view-sessions').click();
    for (const taskId of settledTaskIds) {
      const row = launched.page.getByTestId(`home-task-${taskId}`);
      await expect(row).toHaveAttribute('data-working', 'false');
      await expect(row).toContainText('Done');
    }

    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${finalMission.mission.id}`).click();
    await expect(launched.page.getByTestId('mission-view')).toBeVisible();
    await launched.page.getByTestId('mission-tab-work').click();
    await expect(launched.page.getByTestId('mission-work-map')).toContainText(bTitle);
    await expect(launched.page.getByTestId('mission-work-map')).toContainText(dTitle);
    await launched.page.screenshot({ path: '/tmp/charter-live-recursive-mission.png' });
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('Runtime Inspector controls a real user-started Claude Lead and replaces it with Codex', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_MISSION=1 to spend real Claude/Codex turns');
  test.setTimeout(12 * 60_000);

  const marker = `LIVE-CONTROLS-${Date.now()}`;
  const initialSummary = `${marker} READY FOR GUIDANCE`;
  const guidedSummary = `${marker} GUIDANCE DELIVERED`;
  const initialPrompt = [
    `Join a Charter Mission for the live Runtime Inspector acceptance ${marker}.`,
    'Do not edit files and do not delegate.',
    'Use native `charter orchestration ... --json` CLI commands.',
    'Run `charter orchestration inspect --json`, retrying once if the external Session is still attaching.',
    `Then use \`charter orchestration progress --request-json <JSON> --json\` with phase "ready-for-guidance" and summary "${initialSummary}".`,
    'Do not complete the Assignment. End this turn after reporting progress and wait for a user follow-up.',
  ].join(' ');
  const guidance = [
    `This is the held UI guidance for ${marker}.`,
    `Use \`charter orchestration progress --request-json <JSON> --json\` with phase "guided-by-user" and summary "${guidedSummary}".`,
    'Do not edit files, delegate, or complete the Assignment. End the turn after reporting progress.',
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const initialMissionIds = new Set<string>();
  let missionId = '';
  let replacementTerminalId: string | null = null;
  try {
    for (const snapshot of await missionSnapshots(launched.page)) {
      initialMissionIds.add(snapshot.mission.id);
    }
    const leadTerminalId = await launched.page.evaluate(async () => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    });
    await expect
      .poll(async () => taskIdForTerminal(launched.page, leadTerminalId), {
        timeout: 60_000,
        intervals: [500, 1_000, 2_000],
      })
      .not.toBeNull();
    const leadTaskId = (await taskIdForTerminal(launched.page, leadTerminalId))!;
    if (
      /Do\s*you\s*trust|Press enter to continue/i.test(
        await terminalPtyOutput(launched.page, leadTerminalId),
      )
    ) {
      await launched.page.evaluate(async (terminalId) => {
        await window.product.rpc['terminal.write']!({
          id: terminalId,
          data: '\r',
          userInitiated: true,
        });
      }, leadTerminalId);
      await launched.page.waitForTimeout(1_000);
    }
    await launched.page.evaluate(
      async ({ terminalId, prompt }) => {
        await window.product.rpc['terminal.write']!({
          id: terminalId,
          data: prompt,
          userInitiated: true,
        });
        await window.product.rpc['terminal.write']!({
          id: terminalId,
          data: '\r',
          userInitiated: true,
        });
      },
      { terminalId: leadTerminalId, prompt: initialPrompt },
    );

    const liveMission = (missions: MissionSnapshotDto[]) =>
      missions.find((snapshot) => !initialMissionIds.has(snapshot.mission.id));
    await expect
      .poll(async () => liveMission(await missionSnapshots(launched.page))?.mission.id ?? null, {
        timeout: 2 * 60_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .not.toBeNull();
    missionId = liveMission(await missionSnapshots(launched.page))!.mission.id;
    await expect
      .poll(
        async () => {
          const mission = liveMission(await missionSnapshots(launched.page));
          return (
            mission?.messages.some((message) => message.body.includes(initialSummary)) ?? false
          );
        },
        { timeout: 5 * 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(true);

    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${missionId}`).click();
    const details = launched.page.getByTestId('mission-work-detail');
    await expect(details.getByRole('button', { name: 'Hold new input' })).toBeVisible();

    await details.getByRole('button', { name: 'Open working session' }).click();
    await expect(launched.page.getByTestId('task-room')).toHaveAttribute(
      'data-task-id',
      leadTaskId,
    );
    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${missionId}`).click();

    await details.getByRole('button', { name: 'Hold new input' }).click();
    await expect(details.getByRole('button', { name: 'Release input' })).toBeVisible();
    await details
      .getByPlaceholder('Add context, change direction, or share a constraint…')
      .fill(guidance);
    await details.getByRole('button', { name: 'Send guidance' }).click();

    await launched.page.waitForTimeout(2_000);
    expect(await terminalPtyOutput(launched.page, leadTerminalId)).not.toContain(guidedSummary);
    expect(
      (await missionSnapshots(launched.page))
        .find((snapshot) => snapshot.mission.id === missionId)
        ?.messages.some((message) => message.body.includes(guidedSummary)),
    ).toBe(false);

    await details.getByRole('button', { name: 'Release input' }).click();
    await expect
      .poll(
        async () =>
          (await missionSnapshots(launched.page))
            .find((snapshot) => snapshot.mission.id === missionId)
            ?.messages.some((message) => message.body.includes(guidedSummary)) ?? false,
        { timeout: 5 * 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(true);

    await details.getByRole('button', { name: 'Change owner' }).click();
    await details.getByLabel('Agent runtime').selectOption('codex');
    await details.getByLabel('Display name').fill('Replacement Codex Lead');
    await details.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(details).toContainText('Replacement Codex Lead');

    await expect
      .poll(
        async () => {
          const snapshot = (await missionSnapshots(launched.page)).find(
            (item) => item.mission.id === missionId,
          );
          const lead = snapshot?.assignments.find(
            (assignment) => assignment.id === snapshot.mission.leadAssignmentId,
          );
          const attempt = snapshot?.attempts.find((item) => item.id === lead?.activeAttemptId);
          replacementTerminalId = attempt?.terminalId ?? null;
          return {
            ordinal: attempt?.ordinal,
            runtime: attempt?.requestedRuntime,
            hasReplacementTerminal: Boolean(replacementTerminalId),
          };
        },
        { timeout: 3 * 60_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toEqual({ ordinal: 2, runtime: 'codex', hasReplacementTerminal: true });
    expect(replacementTerminalId).not.toBe(leadTerminalId);
    await expect
      .poll(async () => (await terminalPtySnapshot(launched.page)).items.map((item) => item.id), {
        timeout: 30_000,
      })
      .not.toContain(leadTerminalId);

    await details.getByRole('button', { name: 'Open working session' }).click();
    await expect
      .poll(() => taskIdForTerminal(launched.page, replacementTerminalId!), {
        timeout: 30_000,
      })
      .not.toBeNull();
    const replacementTaskId = await taskIdForTerminal(launched.page, replacementTerminalId!);
    await expect(launched.page.getByTestId('task-room')).toHaveAttribute(
      'data-task-id',
      replacementTaskId!,
    );
  } finally {
    if (missionId) {
      await launched.page
        .evaluate(async (id) => {
          await window.product.rpc['mission.finish']!({
            missionId: id,
            outcome: 'cancelled',
            reason: 'Live Runtime Inspector acceptance cleanup',
          });
        }, missionId)
        .catch(() => undefined);
    }
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
