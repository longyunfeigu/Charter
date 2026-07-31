import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtySnapshot } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_FABRIC === '1';
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

test('real Claude Lead starts parallel Codex B/C ACP sessions and B asks C directly', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real Claude + Codex ACP turns');
  test.setTimeout(12 * 60_000);

  const marker = `FABRIC-${Date.now()}`;
  const bTitle = `${marker} coordinator B`;
  const cTitle = `${marker} reviewer C`;
  const cGoal = [
    `You are reviewer C in Mission acceptance ${marker}. Do not edit files or delegate.`,
    'Use Charter orchestration MCP tools. Call orchestration_inspect.',
    'Then call orchestration_wait for type question, timeoutMs 300000, markRead true.',
    `Reply to the received message with orchestration_reply and body "${marker} C ANSWER".`,
    `Finally call orchestration_complete with outcome success and summary "${marker} C COMPLETE".`,
    'Execute the tools; do not only describe them.',
  ].join(' ');
  const bGoal = [
    `You are coordinator B in Mission acceptance ${marker}. Do not edit files or delegate.`,
    'Use orchestration_inspect and find the Assignment whose task title exactly matches',
    `"${cTitle}".`,
    'Call orchestration_ask to that Assignment with subject "Cross-agent check",',
    `body "${marker} B QUESTION", timeoutMs 300000, and verify the answer contains "${marker} C ANSWER".`,
    `Then call orchestration_complete with outcome success and summary "${marker} B COMPLETE AFTER C".`,
    'Execute the tools; do not only describe them.',
  ].join(' ');
  const leadPrompt = [
    `Run Mission Fabric acceptance ${marker}. This is read-only; do not edit files.`,
    'Use Charter orchestration MCP tools whose names start with orchestration_.',
    'Call orchestration_inspect, retrying once if this external Session is still attaching.',
    'Call orchestration_delegate_many exactly once with two children:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: bGoal,
          acceptanceCriteria: [`B receives ${marker} C ANSWER`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'prove direct B to C coordination',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: cGoal,
          acceptanceCriteria: [`C replies ${marker} C ANSWER`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'parallel independent reviewer',
          idempotencyKey: `${marker}-C`,
        },
      ],
    }),
    'Capture both returned assignment ids and call orchestration_join for both with timeoutMs 600000.',
    'Inspect and verify B and C succeeded.',
    `Finally call orchestration_complete with outcome success and summary "${marker} A COMPLETE".`,
    'Execute every tool call; do not merely explain the plan.',
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
      PI_IDE_ACP: '1',
    },
  });
  const initialIds = new Set((await missions(launched.page)).map((item) => item.mission.id));
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await launched.page.evaluate(async (prompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt: prompt,
      })) as { ok: true } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
    }, leadPrompt);

    const current = () =>
      missions(launched.page).then((items) =>
        items.find((item) => !initialIds.has(item.mission.id)),
      );
    await expect
      .poll(async () => (await current())?.tasks.map((task) => task.title) ?? [], {
        timeout: 8 * 60_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toEqual(expect.arrayContaining([bTitle, cTitle]));
    await expect
      .poll(
        async () => {
          const snapshot = await current();
          if (!snapshot) return null;
          return {
            state: snapshot.mission.state,
            assignments: snapshot.assignments.map((item) => item.state),
            attempts: snapshot.attempts.map((item) => item.state),
          };
        },
        { timeout: 10 * 60_000, intervals: [2_000, 5_000, 10_000] },
      )
      .toMatchObject({
        state: 'VERIFYING',
        assignments: ['COMPLETED', 'COMPLETED', 'COMPLETED'],
        attempts: ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'],
      });

    const snapshot = (await current())!;
    const bTask = snapshot.tasks.find((task) => task.title === bTitle)!;
    const cTask = snapshot.tasks.find((task) => task.title === cTitle)!;
    const b = snapshot.assignments.find((item) => item.taskId === bTask.id)!;
    const c = snapshot.assignments.find((item) => item.taskId === cTask.id)!;
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromAssignmentId: b.id,
          toAssignmentId: c.id,
          type: 'question',
        }),
        expect.objectContaining({
          fromAssignmentId: c.id,
          toAssignmentId: b.id,
          type: 'answer',
        }),
      ]),
    );
    const childAttempts = snapshot.attempts.filter((item) =>
      [b.id, c.id].includes(item.assignmentId),
    );
    const childRuntimes = (snapshot.runtimeSessions ?? []).filter((item) =>
      childAttempts.some((attempt) => attempt.id === item.attemptId),
    );
    expect(childRuntimes).toHaveLength(2);
    expect(childRuntimes.every((item) => item.transport === 'acp')).toBe(true);
    expect(new Set(childRuntimes.map((item) => item.processKey)).size).toBe(1);
    expect((snapshot.runtimeEvents ?? []).some((event) => event.kind === 'turn.stopped')).toBe(
      true,
    );

    const terminals = await terminalPtySnapshot(launched.page);
    expect(terminals.items.filter((item) => item.launch === 'claude')).toHaveLength(1);
    expect(terminals.items.filter((item) => item.launch === 'codex')).toHaveLength(0);

    await launched.page.getByTestId('rail-view-missions').click();
    await launched.page.getByTestId(`mission-center-card-${snapshot.mission.id}`).click();
    await launched.page.getByTestId('mission-tab-work').click();
    await launched.page
      .getByTestId('mission-work-map')
      .getByRole('button', { name: new RegExp(bTitle) })
      .click();
    const detail = launched.page.getByTestId('mission-work-detail');
    await expect(detail).toContainText('ACP event stream');
    await detail.getByText('Advanced controls and runtime details').click();
    await expect(detail).toContainText('ACP · WAITING');
    await launched.page.screenshot({ path: '/tmp/charter-mission-fabric-real-acp.png' });
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
