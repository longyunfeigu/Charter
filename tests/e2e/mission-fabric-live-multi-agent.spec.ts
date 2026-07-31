import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssignmentDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput, terminalPtySnapshot } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_FABRIC === '1';
const WORKSPACE = process.env.CHARTER_LIVE_WORKSPACE ?? resolve('.');
const WAIT_MS = 8 * 60_000;

async function missions(page: Page): Promise<MissionSnapshotDto[]> {
  return await page.evaluate(async () => {
    const response = (await window.product.rpc['mission.list']!({ limit: 50 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!response.ok) throw new Error(response.error?.userMessage ?? 'mission.list failed');
    return response.data.missions;
  });
}

async function startLead(page: Page, launch: 'claude' | 'codex', prompt: string): Promise<void> {
  await page.evaluate(
    async ({ requestedLaunch, initialPrompt }) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: requestedLaunch,
        initialPrompt,
      })) as { ok: true } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
    },
    { requestedLaunch: launch, initialPrompt: prompt },
  );
}

function assignmentForTitle(snapshot: MissionSnapshotDto, title: string): AssignmentDto {
  const task = snapshot.tasks.find((candidate) => candidate.title === title);
  expect(task, `missing Task ${title}`).toBeTruthy();
  const assignment = snapshot.assignments.find((candidate) => candidate.taskId === task!.id);
  expect(assignment, `missing Assignment ${title}`).toBeTruthy();
  return assignment!;
}

function expectObserved(snapshot: MissionSnapshotDto, messageIds: string[]): void {
  for (const messageId of messageIds) {
    expect(snapshot.messageDeliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          messageId,
          state: 'observed',
        }),
      ]),
    );
  }
}

function expectProviderPool(
  snapshot: MissionSnapshotDto,
  provider: 'claude' | 'codex',
  assignments: AssignmentDto[],
): void {
  const attemptIds = snapshot.attempts
    .filter((attempt) => assignments.some((assignment) => assignment.id === attempt.assignmentId))
    .map((attempt) => attempt.id);
  const runtimes = (snapshot.runtimeSessions ?? []).filter((runtime) =>
    attemptIds.includes(runtime.attemptId),
  );
  expect(runtimes).toHaveLength(assignments.length);
  expect(runtimes.every((runtime) => runtime.provider === provider)).toBe(true);
  expect(runtimes.every((runtime) => runtime.transport === 'acp')).toBe(true);
  expect(new Set(runtimes.map((runtime) => runtime.processKey)).size).toBe(1);
}

async function waitForMission(
  page: Page,
  initialIds: Set<string>,
  expectedAssignments: number,
  timeoutMs = WAIT_MS,
): Promise<MissionSnapshotDto> {
  const current = () =>
    missions(page).then((items) => items.find((item) => !initialIds.has(item.mission.id)));
  try {
    await expect
      .poll(async () => Boolean(await current()), {
        timeout: 3 * 60_000,
        intervals: [1_000, 2_000, 5_000, 10_000],
      })
      .toBe(true);
  } catch (error) {
    const terminals = await terminalPtySnapshot(page).catch(() => null);
    const output = await terminalPtyOutput(page).catch(() => '');
    throw new Error(
      [
        'The Lead did not create a Mission within three minutes.',
        `Terminals: ${JSON.stringify(terminals?.items ?? [])}`,
        `PTY tail:\n${output.slice(-12_000)}`,
        `Original assertion: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n'),
    );
  }
  await expect
    .poll(
      async () => {
        const snapshot = await current();
        return snapshot
          ? {
              missionState: snapshot.mission.state,
              assignmentCount: snapshot.assignments.length,
              completed: snapshot.assignments.filter((item) => item.state === 'COMPLETED').length,
              succeeded: snapshot.attempts.filter((item) => item.state === 'SUCCEEDED').length,
            }
          : null;
      },
      { timeout: timeoutMs, intervals: [1_000, 2_000, 5_000, 10_000] },
    )
    .toEqual({
      missionState: 'VERIFYING',
      assignmentCount: expectedAssignments,
      completed: expectedAssignments,
      succeeded: expectedAssignments,
    });
  return (await current())!;
}

async function captureMission(
  page: Page,
  snapshot: MissionSnapshotDto,
  path: string,
): Promise<void> {
  await page.getByTestId('rail-view-missions').click();
  await page.getByTestId(`mission-rail-${snapshot.mission.id}`).click();
  await expect(page.getByTestId('mission-view')).toBeVisible();
  const workTab = page.getByTestId('mission-tab-work');
  await workTab.click();
  await expect(workTab).toContainText(
    `${snapshot.assignments.length}/${snapshot.assignments.length}`,
  );
  await expect(page.getByTestId('mission-work-map')).toBeVisible();
  await page.screenshot({ path });
}

test.describe.configure({ mode: 'serial' });

test('example 1: recursive tree with cross-level ask/reply and child-to-parent progress', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(15 * 60_000);

  const marker = `TREE-${Date.now()}`;
  const bTitle = `${marker} branch B`;
  const cTitle = `${marker} reviewer C`;
  const dTitle = `${marker} specialist D`;
  const eTitle = `${marker} reporter E`;

  const cGoal = [
    `You are Claude reviewer C for ${marker}. Read-only; do not edit or delegate.`,
    'Call orchestration_inspect, then orchestration_wait for type question with timeoutMs 420000 and markRead true.',
    `Reply to the received question using orchestration_reply with body "${marker} C ANSWER".`,
    `Call orchestration_complete with outcome success and summary "${marker} C COMPLETE".`,
    'Execute the tools instead of describing them.',
  ].join(' ');
  const dGoal = [
    `You are Codex specialist D for ${marker}. Read-only; do not edit or delegate.`,
    `Call orchestration_inspect and find the Assignment whose Task title is exactly "${cTitle}".`,
    `Call orchestration_ask to C with subject "${marker} cross-level", body "${marker} D QUESTION", and timeoutMs 420000.`,
    `Verify the answer contains "${marker} C ANSWER", then complete successfully with summary "${marker} D COMPLETE".`,
    'Execute every tool call.',
  ].join(' ');
  const eGoal = [
    `You are Claude reporter E for ${marker}. Read-only; do not edit or delegate.`,
    'Call orchestration_inspect and identify your own Assignment and its supervisorAssignmentId.',
    `Call orchestration_message to that supervisor with type progress, subject "${marker} E REPORT", and body "${marker} E TO B".`,
    `Then complete successfully with summary "${marker} E COMPLETE". Execute the tools.`,
  ].join(' ');
  const bGoal = [
    `You are Codex branch coordinator B for ${marker}. Read-only; do not edit files.`,
    'Call orchestration_inspect.',
    'Call orchestration_delegate_many exactly once with these two children:',
    JSON.stringify({
      children: [
        {
          title: dTitle,
          goal: dGoal,
          acceptanceCriteria: [`D receives ${marker} C ANSWER`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'recursive cross-level specialist',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E reports ${marker} E TO B`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'recursive child-to-parent reporter',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Call orchestration_join for both returned Assignment ids with timeoutMs 600000.',
    `Call orchestration_sync from sequence 0 with markObserved true and verify "${marker} E TO B" is present.`,
    `Complete successfully with summary "${marker} B COMPLETE". Execute all tools.`,
  ].join(' ');
  const leadPrompt = [
    `Run recursive Mission acceptance ${marker}. This is read-only; do not edit files.`,
    'Use Charter orchestration MCP tools. Call orchestration_inspect, retrying once if attachment is still in progress.',
    'Call orchestration_delegate_many exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: bGoal,
          acceptanceCriteria: [`B recursively completes D and E for ${marker}`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'recursive branch coordinator',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: cGoal,
          acceptanceCriteria: [`C answers ${marker} C ANSWER`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'cross-level reviewer',
          idempotencyKey: `${marker}-C`,
        },
      ],
    }),
    'Join both returned Assignments with timeoutMs 700000.',
    'Inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE". Execute the tools.`,
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
    await startLead(launched.page, 'claude', leadPrompt);
    const snapshot = await waitForMission(launched.page, initialIds, 5);
    const root = snapshot.assignments.find((item) => item.supervisorAssignmentId === null)!;
    const b = assignmentForTitle(snapshot, bTitle);
    const c = assignmentForTitle(snapshot, cTitle);
    const d = assignmentForTitle(snapshot, dTitle);
    const e = assignmentForTitle(snapshot, eTitle);
    expect(b.supervisorAssignmentId).toBe(root.id);
    expect(c.supervisorAssignmentId).toBe(root.id);
    expect(d.supervisorAssignmentId).toBe(b.id);
    expect(e.supervisorAssignmentId).toBe(b.id);

    const question = snapshot.messages.find(
      (message) =>
        message.fromAssignmentId === d.id &&
        message.toAssignmentId === c.id &&
        message.type === 'question',
    )!;
    const answer = snapshot.messages.find(
      (message) =>
        message.fromAssignmentId === c.id &&
        message.toAssignmentId === d.id &&
        message.type === 'answer',
    )!;
    const report = snapshot.messages.find(
      (message) =>
        message.fromAssignmentId === e.id &&
        message.toAssignmentId === b.id &&
        message.type === 'progress',
    )!;
    expect(question.body).toContain(`${marker} D QUESTION`);
    expect(answer.body).toContain(`${marker} C ANSWER`);
    expect(answer.threadId).toBe(question.id);
    expect(report.body).toContain(`${marker} E TO B`);
    expectObserved(snapshot, [question.id, answer.id, report.id]);
    expectProviderPool(snapshot, 'codex', [b, d]);
    expectProviderPool(snapshot, 'claude', [c, e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expect(terminals.items.filter((item) => item.launch === 'claude')).toHaveLength(1);
    expect(terminals.items.filter((item) => item.launch === 'codex')).toHaveLength(0);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-1-tree.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('example 2: durable four-stage handoff chain across Claude and Codex', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(18 * 60_000);

  const marker = `CHAIN-${Date.now()}`;
  const bTitle = `${marker} source B`;
  const cTitle = `${marker} relay C`;
  const dTitle = `${marker} relay D`;
  const eTitle = `${marker} sink E`;
  const complete = (actor: string) =>
    `Call orchestration_complete with outcome success and summary "${marker} ${actor} COMPLETE".`;
  const bGoal = [
    `You are Claude source B for ${marker}. Read-only; do not edit or delegate.`,
    `Inspect and find Assignment "${cTitle}".`,
    `Send orchestration_message to C with type handoff, subject "${marker} STEP 1", body "${marker} B TO C".`,
    complete('B'),
    'Execute all tools.',
  ].join(' ');
  const cGoal = [
    `You are Codex relay C for ${marker}. Read-only; do not edit or delegate.`,
    'Call orchestration_wait for type handoff with timeoutMs 420000 and markRead true.',
    `Verify "${marker} B TO C", inspect and find Assignment "${dTitle}".`,
    `Send a handoff message to D with subject "${marker} STEP 2" and body "${marker} C TO D".`,
    complete('C'),
    'Execute all tools.',
  ].join(' ');
  const dGoal = [
    `You are Claude relay D for ${marker}. Read-only; do not edit or delegate.`,
    'Call orchestration_wait for type handoff with timeoutMs 420000 and markRead true.',
    `Verify "${marker} C TO D", inspect and find Assignment "${eTitle}".`,
    `Send a handoff message to E with subject "${marker} STEP 3" and body "${marker} D TO E".`,
    complete('D'),
    'Execute all tools.',
  ].join(' ');
  const eGoal = [
    `You are Codex sink E for ${marker}. Read-only; do not edit or delegate.`,
    'Call orchestration_wait for type handoff with timeoutMs 420000 and markRead true.',
    `Verify "${marker} D TO E".`,
    complete('E'),
    'Execute all tools.',
  ].join(' ');
  const leadPrompt = [
    `Run durable handoff-chain Mission ${marker}. Read-only; do not edit files.`,
    'Call orchestration_inspect, retrying once if needed, then orchestration_delegate_many exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: bGoal,
          acceptanceCriteria: [`B sends ${marker} B TO C`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'handoff source',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: cGoal,
          acceptanceCriteria: [`C relays ${marker} C TO D`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'first durable relay',
          idempotencyKey: `${marker}-C`,
        },
        {
          title: dTitle,
          goal: dGoal,
          acceptanceCriteria: [`D relays ${marker} D TO E`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'second durable relay',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E receives ${marker} D TO E`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'handoff sink',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Do not use one long orchestration_join for this serial pipeline.',
    'Call orchestration_wait for type completion with unreadOnly true, markRead true, and timeoutMs 420000.',
    'Repeat that wait until you have observed four distinct child completion messages; a single wait may return more than one.',
    'Inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE". Execute every tool.`,
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
    await startLead(launched.page, 'codex', leadPrompt);
    const snapshot = await waitForMission(launched.page, initialIds, 5, 12 * 60_000);
    const b = assignmentForTitle(snapshot, bTitle);
    const c = assignmentForTitle(snapshot, cTitle);
    const d = assignmentForTitle(snapshot, dTitle);
    const e = assignmentForTitle(snapshot, eTitle);
    const expected = [
      { from: b.id, to: c.id, body: `${marker} B TO C` },
      { from: c.id, to: d.id, body: `${marker} C TO D` },
      { from: d.id, to: e.id, body: `${marker} D TO E` },
    ];
    const handoffs = expected.map(({ from, to, body }) => {
      const message = snapshot.messages.find(
        (candidate) =>
          candidate.fromAssignmentId === from &&
          candidate.toAssignmentId === to &&
          candidate.type === 'handoff',
      )!;
      expect(message.body).toContain(body);
      return message;
    });
    expectObserved(
      snapshot,
      handoffs.map((message) => message.id),
    );
    expectProviderPool(snapshot, 'claude', [b, d]);
    expectProviderPool(snapshot, 'codex', [c, e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expect(terminals.items.filter((item) => item.launch === 'codex')).toHaveLength(1);
    expect(terminals.items.filter((item) => item.launch === 'claude')).toHaveLength(0);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-2-chain.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('example 3: three-to-one fan-in followed by an upward completion message', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(15 * 60_000);

  const marker = `FANIN-${Date.now()}`;
  const bTitle = `${marker} contributor B`;
  const cTitle = `${marker} contributor C`;
  const dTitle = `${marker} contributor D`;
  const eTitle = `${marker} aggregator E`;
  const contributorGoal = (actor: string, aggregatorTitle: string) =>
    [
      `You are contributor ${actor} for ${marker}. Read-only; do not edit or delegate.`,
      `Call orchestration_inspect and find Assignment "${aggregatorTitle}".`,
      `Send orchestration_message to it with type handoff, subject "${marker} INPUT ${actor}", and body "${marker} ${actor} RESULT".`,
      `Complete successfully with summary "${marker} ${actor} COMPLETE". Execute all tools.`,
    ].join(' ');
  const eGoal = [
    `You are Claude aggregator E for ${marker}. Read-only; do not edit or delegate.`,
    `Call orchestration_wait for type handoff, timeoutMs 420000, markRead true, repeatedly until you have three unique bodies:`,
    `"${marker} B RESULT", "${marker} C RESULT", and "${marker} D RESULT".`,
    'Use unreadOnly true so each wait consumes only new messages.',
    'Call orchestration_inspect and find the root Assignment whose supervisorAssignmentId is null.',
    `Send orchestration_message to the root with type completion, subject "${marker} AGGREGATED", and body "${marker} E AGGREGATED B+C+D".`,
    `Complete successfully with summary "${marker} E COMPLETE". Execute all tools.`,
  ].join(' ');
  const leadPrompt = [
    `Run fan-in Mission ${marker}. Read-only; do not edit files.`,
    'Call orchestration_inspect, retrying once if necessary, then orchestration_delegate_many exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: contributorGoal('B', eTitle),
          acceptanceCriteria: [`B submits ${marker} B RESULT`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'parallel fan-in contributor B',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: contributorGoal('C', eTitle),
          acceptanceCriteria: [`C submits ${marker} C RESULT`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'parallel fan-in contributor C',
          idempotencyKey: `${marker}-C`,
        },
        {
          title: dTitle,
          goal: contributorGoal('D', eTitle),
          acceptanceCriteria: [`D submits ${marker} D RESULT`],
          requestedRuntime: 'codex',
          workMode: 'read-only',
          reason: 'parallel fan-in contributor D',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E aggregates all three ${marker} inputs`],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'fan-in aggregator',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Join all four returned Assignment ids with timeoutMs 700000.',
    `Call orchestration_sync from sequence 0 with markObserved true and verify "${marker} E AGGREGATED B+C+D".`,
    'Inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE". Execute every tool.`,
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
    await startLead(launched.page, 'claude', leadPrompt);
    const snapshot = await waitForMission(launched.page, initialIds, 5);
    const root = snapshot.assignments.find((item) => item.supervisorAssignmentId === null)!;
    const b = assignmentForTitle(snapshot, bTitle);
    const c = assignmentForTitle(snapshot, cTitle);
    const d = assignmentForTitle(snapshot, dTitle);
    const e = assignmentForTitle(snapshot, eTitle);
    const contributors = [
      { assignment: b, body: `${marker} B RESULT` },
      { assignment: c, body: `${marker} C RESULT` },
      { assignment: d, body: `${marker} D RESULT` },
    ];
    const inputs = contributors.map(({ assignment, body }) => {
      const message = snapshot.messages.find(
        (candidate) =>
          candidate.fromAssignmentId === assignment.id &&
          candidate.toAssignmentId === e.id &&
          candidate.type === 'handoff',
      )!;
      expect(message.body).toContain(body);
      return message;
    });
    const aggregate = snapshot.messages.find(
      (message) =>
        message.fromAssignmentId === e.id &&
        message.toAssignmentId === root.id &&
        message.type === 'completion',
    )!;
    expect(aggregate.body).toContain(`${marker} E AGGREGATED B+C+D`);
    expectObserved(snapshot, [...inputs.map((message) => message.id), aggregate.id]);
    expectProviderPool(snapshot, 'codex', [b, d]);
    expectProviderPool(snapshot, 'claude', [c, e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expect(terminals.items.filter((item) => item.launch === 'claude')).toHaveLength(1);
    expect(terminals.items.filter((item) => item.launch === 'codex')).toHaveLength(0);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-3-fanin.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
