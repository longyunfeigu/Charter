import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AssignmentDto, MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { launchApp } from './helpers/launch';
import { terminalPtyOutput, terminalPtySnapshot } from './helpers/terminal';

const LIVE = process.env.CHARTER_LIVE_FABRIC === '1';
const WORKSPACE = process.env.CHARTER_LIVE_WORKSPACE ?? resolve('.');
const WAIT_MS = 8 * 60_000;
const CREATE_WAIT_MS = Number(process.env.CHARTER_LIVE_CREATE_TIMEOUT_MS ?? 3 * 60_000);
type LiveProvider = 'claude' | 'codex';
const forcedProvider: LiveProvider | null =
  process.env.CHARTER_LIVE_PROVIDER === 'claude' || process.env.CHARTER_LIVE_PROVIDER === 'codex'
    ? process.env.CHARTER_LIVE_PROVIDER
    : null;
const runtime = (suggested: LiveProvider): LiveProvider => forcedProvider ?? suggested;

async function missions(page: Page): Promise<MissionSnapshotDto[]> {
  return await page.evaluate(async () => {
    const response = (await window.product.rpc['mission.list']!({ limit: 50 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!response.ok) throw new Error(response.error?.userMessage ?? 'mission.list failed');
    return response.data.missions;
  });
}

async function startLead(page: Page, launch: 'claude' | 'codex', prompt: string): Promise<string> {
  return await page.evaluate(
    async ({ requestedLaunch, initialPrompt }) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: requestedLaunch,
        initialPrompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    },
    { requestedLaunch: launch, initialPrompt: prompt },
  );
}

async function confirmLiveRunIfRequested(
  page: Page,
  terminalId: string,
  initialIds: Set<string>,
  timeoutMs = 170_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await missions(page)).some((item) => !initialIds.has(item.mission.id))) return;
    const tail = (await terminalPtyOutput(page, terminalId)).slice(-16_000);
    const write = async (data: string) =>
      page.evaluate(
        async ({ id, input }) => {
          const result = (await window.product.rpc['terminal.write']!({
            id,
            data: input,
            userInitiated: true,
          })) as { ok: true } | { ok: false; error?: { userMessage?: string } };
          if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.write failed');
        },
        { id: terminalId, input: data },
      );
    if (/Update now/i.test(tail) && /2\.\s*Skip/i.test(tail)) {
      await write('\u001b[B');
      await page.waitForTimeout(200);
      await write('\r');
      await page.waitForTimeout(1_000);
      return;
    }
    if (/Do\s*you\s*trust|Press enter to continue/i.test(tail)) {
      await write('\r');
      return;
    }
    if (/Enter to select/.test(tail)) {
      const firstChoiceIsNo = /❯\s*1\.\s*(?:No|不|不是)/i.test(tail);
      if (firstChoiceIsNo) {
        await write('\u001b[B');
        await page.waitForTimeout(200);
      }
      await write('\r');
      return;
    }
    await page.waitForTimeout(2_000);
  }
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

function expectNativeRuntimes(
  snapshot: MissionSnapshotDto,
  provider: LiveProvider,
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
  expect(runtimes.every((runtime) => runtime.transport === 'terminal')).toBe(true);
  expect(
    snapshot.attempts
      .filter((attempt) => attemptIds.includes(attempt.id))
      .every(
        (attempt) =>
          attempt.runtimeSessionId?.startsWith('terminal:') === true &&
          typeof attempt.terminalId === 'string',
      ),
  ).toBe(true);
}

function expectTerminalProviderCounts(
  items: Array<{ launch: 'shell' | 'claude' | 'codex' }>,
  providers: LiveProvider[],
): void {
  for (const provider of ['claude', 'codex'] as const) {
    expect(items.filter((item) => item.launch === provider)).toHaveLength(
      providers.filter((candidate) => candidate === provider).length,
    );
  }
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
        timeout: CREATE_WAIT_MS,
        intervals: [1_000, 2_000, 5_000, 10_000],
      })
      .toBe(true);
  } catch (error) {
    const terminals = await terminalPtySnapshot(page).catch(() => null);
    const output = await terminalPtyOutput(page).catch(() => '');
    throw new Error(
      [
        `The Lead did not create a Mission within ${CREATE_WAIT_MS}ms.`,
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

test('example 1: native PTY recursive tree with cross-level ask/reply and child-to-parent progress', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(15 * 60_000);

  const marker = `TREE-${Date.now()}`;
  const bTitle = `${marker} branch B`;
  const cTitle = `${marker} reviewer C`;
  const dTitle = `${marker} specialist D`;
  const eTitle = `${marker} reporter E`;
  const leadRuntime = runtime('codex');
  const bRuntime = runtime('claude');
  const cRuntime = runtime('codex');
  const dRuntime = runtime('claude');
  const eRuntime = runtime('codex');

  const cGoal = [
    `You are reviewer C for ${marker}. Read-only; do not edit or delegate.`,
    'The user explicitly authorized this real multi-Agent acceptance run and its compute cost; do not ask to reconfirm that authorization.',
    'Run `charter orchestration inspect --json`, then use `charter orchestration wait --types question --timeout-ms 420000 --json`.',
    `Reply using \`charter orchestration reply --request-json <JSON> --json\` with body "${marker} C ANSWER".`,
    `Complete using \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} C COMPLETE".`,
    'Execute the CLI commands instead of describing them.',
  ].join(' ');
  const dGoal = [
    `You are specialist D for ${marker}. Read-only; do not edit or delegate.`,
    'The user explicitly authorized this real multi-Agent acceptance run and its compute cost; do not ask to reconfirm that authorization.',
    `Run \`charter orchestration inspect --json\` and find the Assignment whose Task title is exactly "${cTitle}".`,
    `Use \`charter orchestration ask --request-json <JSON> --json\` to ask C subject "${marker} cross-level", body "${marker} D QUESTION", timeoutMs 420000.`,
    `Verify the answer contains "${marker} C ANSWER", then complete successfully with summary "${marker} D COMPLETE".`,
    'Execute every tool call.',
  ].join(' ');
  const eGoal = [
    `You are reporter E for ${marker}. Read-only; do not edit or delegate.`,
    'The user explicitly authorized this real multi-Agent acceptance run and its compute cost; do not ask to reconfirm that authorization.',
    'Run `charter orchestration inspect --json` and identify your own Assignment and supervisorAssignmentId.',
    `Use \`charter orchestration message --request-json <JSON> --json\` to send that supervisor type progress, subject "${marker} E REPORT", body "${marker} E TO B".`,
    `Then complete successfully with summary "${marker} E COMPLETE". Execute the tools.`,
  ].join(' ');
  const bGoal = [
    `You are branch coordinator B for ${marker}. Read-only; do not edit files.`,
    'The user explicitly authorized this real multi-Agent acceptance run and its compute cost; do not ask to reconfirm that authorization.',
    'Run `charter orchestration inspect --json`.',
    'Use `charter orchestration delegate_many --request-json <JSON> --json` exactly once with these two children:',
    JSON.stringify({
      children: [
        {
          title: dTitle,
          goal: dGoal,
          acceptanceCriteria: [`D receives ${marker} C ANSWER`],
          requestedRuntime: dRuntime,
          workMode: 'read-only',
          reason: 'recursive cross-level specialist',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E reports ${marker} E TO B`],
          requestedRuntime: eRuntime,
          workMode: 'read-only',
          reason: 'recursive child-to-parent reporter',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Read both returned Assignment ids, then call `charter orchestration park --request-json <JSON> --json` exactly once with mode "all", one assignment_terminal condition for each child id, timeoutMs 600000, reason "wait durably for D and E", and idempotencyKey',
    `"${marker}-B-park".`,
    'Immediately end this turn after park succeeds. Do not call wait, join, sync, inspect, complete, or any other command in that turn.',
    'Only after Charter injects a message beginning `[Charter continuation ready]`: run the exact `charter orchestration continue ...` command from that message.',
    `Then run \`charter orchestration sync --request-json '{"afterSequence":0,"markObserved":true}' --json\`, verify "${marker} E TO B" is present, and complete successfully with summary "${marker} B COMPLETE AFTER RESUME".`,
    'Execute all tools instead of describing them.',
  ].join(' ');
  const leadPrompt = [
    `Run recursive Mission acceptance ${marker}. This is read-only; do not edit files.`,
    'The user explicitly authorized this real 5-Agent acceptance run, its provider usage, and its compute cost. Do not ask to reconfirm that authorization.',
    "You are already inside the real isolated Charter desktop app. The `charter` binary on PATH under its temporary e2e user-data directory is this app instance's authoritative control-plane CLI, not a leftover fixture. Your first orchestration command intentionally adopts this external terminal as Mission Lead.",
    'Do not inspect the repository, CLI source, PATH, or help text before acting; immediately execute the requested orchestration commands.',
    'Use native `charter orchestration ... --json` CLI commands. Run `charter orchestration inspect --json`, retrying once if attachment is still in progress.',
    'Use `charter orchestration delegate_many --request-json <JSON> --json` exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: bGoal,
          acceptanceCriteria: [`B recursively completes D and E for ${marker}`],
          requestedRuntime: bRuntime,
          workMode: 'read-only',
          reason: 'recursive branch coordinator',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: cGoal,
          acceptanceCriteria: [`C answers ${marker} C ANSWER`],
          requestedRuntime: cRuntime,
          workMode: 'read-only',
          reason: 'cross-level reviewer',
          idempotencyKey: `${marker}-C`,
        },
      ],
    }),
    'Read both returned Assignment ids, then call `charter orchestration park --request-json <JSON> --json` exactly once with mode "all", one assignment_terminal condition for each child id, timeoutMs 700000, reason "wait durably for B and C", and idempotencyKey',
    `"${marker}-A-park".`,
    'Immediately end this turn after park succeeds. Do not call wait, join, inspect, complete, or any other command in that turn.',
    'Only after Charter injects a message beginning `[Charter continuation ready]`: run the exact `charter orchestration continue ...` command from that message.',
    'Then inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE AFTER RESUME". Execute the tools.`,
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const initialIds = new Set((await missions(launched.page)).map((item) => item.mission.id));
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const leadTerminalId = await startLead(launched.page, leadRuntime, leadPrompt);
    await confirmLiveRunIfRequested(launched.page, leadTerminalId, initialIds);
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
    expect(snapshot.continuations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ownerAssignmentId: root.id, state: 'CONSUMED' }),
        expect.objectContaining({ ownerAssignmentId: b.id, state: 'CONSUMED' }),
      ]),
    );
    const consumedContinuationIds = (snapshot.continuations ?? [])
      .filter(
        (continuation) =>
          continuation.state === 'CONSUMED' &&
          (continuation.ownerAssignmentId === root.id || continuation.ownerAssignmentId === b.id),
      )
      .map((continuation) => continuation.id);
    expect(consumedContinuationIds).toHaveLength(2);
    expect(
      (snapshot.resumeIntents ?? []).filter(
        (intent) =>
          consumedContinuationIds.includes(intent.continuationId) &&
          intent.state === 'ACKNOWLEDGED',
      ),
    ).toHaveLength(2);

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
    expectNativeRuntimes(snapshot, bRuntime, [b]);
    expectNativeRuntimes(snapshot, cRuntime, [c]);
    expectNativeRuntimes(snapshot, dRuntime, [d]);
    expectNativeRuntimes(snapshot, eRuntime, [e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expectTerminalProviderCounts(terminals.items, [
      leadRuntime,
      bRuntime,
      cRuntime,
      dRuntime,
      eRuntime,
    ]);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-1-tree.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('example 2: native PTY durable four-stage handoff chain across Claude and Codex', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(18 * 60_000);

  const marker = `CHAIN-${Date.now()}`;
  const bTitle = `${marker} source B`;
  const cTitle = `${marker} relay C`;
  const dTitle = `${marker} relay D`;
  const eTitle = `${marker} sink E`;
  const leadRuntime = runtime('codex');
  const bRuntime = runtime('claude');
  const cRuntime = runtime('codex');
  const dRuntime = runtime('claude');
  const eRuntime = runtime('codex');
  const complete = (actor: string) =>
    `Use \`charter orchestration complete --request-json <JSON> --json\` with outcome success and summary "${marker} ${actor} COMPLETE".`;
  const bGoal = [
    `You are source B for ${marker}. Read-only; do not edit or delegate.`,
    `Run \`charter orchestration inspect --json\` and find Assignment "${cTitle}".`,
    `Use \`charter orchestration message --request-json <JSON> --json\` to send C type handoff, subject "${marker} STEP 1", body "${marker} B TO C".`,
    complete('B'),
    'Execute all tools.',
  ].join(' ');
  const cGoal = [
    `You are relay C for ${marker}. Read-only; do not edit or delegate.`,
    'Use `charter orchestration wait --types handoff --timeout-ms 420000 --json`, then sync with markObserved true.',
    `Verify "${marker} B TO C", inspect and find Assignment "${dTitle}".`,
    `Use \`charter orchestration message --request-json <JSON> --json\` to send D a handoff subject "${marker} STEP 2" and body "${marker} C TO D".`,
    complete('C'),
    'Execute all tools.',
  ].join(' ');
  const dGoal = [
    `You are relay D for ${marker}. Read-only; do not edit or delegate.`,
    'Use `charter orchestration wait --types handoff --timeout-ms 420000 --json`, then sync with markObserved true.',
    `Verify "${marker} C TO D", inspect and find Assignment "${eTitle}".`,
    `Use \`charter orchestration message --request-json <JSON> --json\` to send E a handoff subject "${marker} STEP 3" and body "${marker} D TO E".`,
    complete('D'),
    'Execute all tools.',
  ].join(' ');
  const eGoal = [
    `You are sink E for ${marker}. Read-only; do not edit or delegate.`,
    'Use `charter orchestration wait --types handoff --timeout-ms 420000 --json`, then sync with markObserved true.',
    `Verify "${marker} D TO E".`,
    complete('E'),
    'Execute all tools.',
  ].join(' ');
  const leadPrompt = [
    `Run durable handoff-chain Mission ${marker}. Read-only; do not edit files.`,
    'Run `charter orchestration inspect --json`, retrying once if needed, then use `charter orchestration delegate_many --request-json <JSON> --json` exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: bGoal,
          acceptanceCriteria: [`B sends ${marker} B TO C`],
          requestedRuntime: bRuntime,
          workMode: 'read-only',
          reason: 'handoff source',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: cGoal,
          acceptanceCriteria: [`C relays ${marker} C TO D`],
          requestedRuntime: cRuntime,
          workMode: 'read-only',
          reason: 'first durable relay',
          idempotencyKey: `${marker}-C`,
        },
        {
          title: dTitle,
          goal: dGoal,
          acceptanceCriteria: [`D relays ${marker} D TO E`],
          requestedRuntime: dRuntime,
          workMode: 'read-only',
          reason: 'second durable relay',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E receives ${marker} D TO E`],
          requestedRuntime: eRuntime,
          workMode: 'read-only',
          reason: 'handoff sink',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Do not use one long join command for this serial pipeline.',
    'Use `charter orchestration wait --types completion --timeout-ms 420000 --json`, with unreadOnly true and markRead true in request JSON when needed.',
    'Repeat that wait until you have observed four distinct child completion messages; a single wait may return more than one.',
    'Inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE". Execute every tool.`,
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const initialIds = new Set((await missions(launched.page)).map((item) => item.mission.id));
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await startLead(launched.page, leadRuntime, leadPrompt);
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
    expectNativeRuntimes(snapshot, bRuntime, [b]);
    expectNativeRuntimes(snapshot, cRuntime, [c]);
    expectNativeRuntimes(snapshot, dRuntime, [d]);
    expectNativeRuntimes(snapshot, eRuntime, [e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expectTerminalProviderCounts(terminals.items, [
      leadRuntime,
      bRuntime,
      cRuntime,
      dRuntime,
      eRuntime,
    ]);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-2-chain.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});

test('example 3: native PTY three-to-one fan-in followed by an upward completion message', async () => {
  test.skip(!LIVE, 'set CHARTER_LIVE_FABRIC=1 to run real multi-agent turns');
  test.setTimeout(15 * 60_000);

  const marker = `FANIN-${Date.now()}`;
  const bTitle = `${marker} contributor B`;
  const cTitle = `${marker} contributor C`;
  const dTitle = `${marker} contributor D`;
  const eTitle = `${marker} aggregator E`;
  const leadRuntime = runtime('claude');
  const bRuntime = runtime('codex');
  const cRuntime = runtime('claude');
  const dRuntime = runtime('codex');
  const eRuntime = runtime('claude');
  const contributorGoal = (actor: string, aggregatorTitle: string) =>
    [
      `You are contributor ${actor} for ${marker}. Read-only; do not edit or delegate.`,
      `Run \`charter orchestration inspect --json\` and find Assignment "${aggregatorTitle}".`,
      `Use \`charter orchestration message --request-json <JSON> --json\` to send it type handoff, subject "${marker} INPUT ${actor}", body "${marker} ${actor} RESULT".`,
      `Complete successfully with summary "${marker} ${actor} COMPLETE". Execute all tools.`,
    ].join(' ');
  const eGoal = [
    `You are aggregator E for ${marker}. Read-only; do not edit or delegate.`,
    `Use \`charter orchestration wait --types handoff --timeout-ms 420000 --json\` repeatedly until you have three unique bodies:`,
    `"${marker} B RESULT", "${marker} C RESULT", and "${marker} D RESULT".`,
    'Use unreadOnly true so each wait consumes only new messages.',
    'Run `charter orchestration inspect --json` and find the root Assignment whose supervisorAssignmentId is null.',
    `Use \`charter orchestration message --request-json <JSON> --json\` to send the root type completion, subject "${marker} AGGREGATED", body "${marker} E AGGREGATED B+C+D".`,
    `Complete successfully with summary "${marker} E COMPLETE". Execute all tools.`,
  ].join(' ');
  const leadPrompt = [
    `Run fan-in Mission ${marker}. Read-only; do not edit files.`,
    'Run `charter orchestration inspect --json`, retrying once if necessary, then use `charter orchestration delegate_many --request-json <JSON> --json` exactly once with:',
    JSON.stringify({
      children: [
        {
          title: bTitle,
          goal: contributorGoal('B', eTitle),
          acceptanceCriteria: [`B submits ${marker} B RESULT`],
          requestedRuntime: bRuntime,
          workMode: 'read-only',
          reason: 'parallel fan-in contributor B',
          idempotencyKey: `${marker}-B`,
        },
        {
          title: cTitle,
          goal: contributorGoal('C', eTitle),
          acceptanceCriteria: [`C submits ${marker} C RESULT`],
          requestedRuntime: cRuntime,
          workMode: 'read-only',
          reason: 'parallel fan-in contributor C',
          idempotencyKey: `${marker}-C`,
        },
        {
          title: dTitle,
          goal: contributorGoal('D', eTitle),
          acceptanceCriteria: [`D submits ${marker} D RESULT`],
          requestedRuntime: dRuntime,
          workMode: 'read-only',
          reason: 'parallel fan-in contributor D',
          idempotencyKey: `${marker}-D`,
        },
        {
          title: eTitle,
          goal: eGoal,
          acceptanceCriteria: [`E aggregates all three ${marker} inputs`],
          requestedRuntime: eRuntime,
          workMode: 'read-only',
          reason: 'fan-in aggregator',
          idempotencyKey: `${marker}-E`,
        },
      ],
    }),
    'Join all four returned Assignment ids with `charter orchestration join --request-json <JSON> --json` and timeoutMs 700000.',
    `Run \`charter orchestration sync --request-json '{"afterSequence":0,"markObserved":true}' --json\` and verify "${marker} E AGGREGATED B+C+D".`,
    'Inspect and verify all five Assignments succeeded.',
    `Complete successfully with summary "${marker} A COMPLETE". Execute every tool.`,
  ].join(' ');

  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: WORKSPACE,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
    },
  });
  const initialIds = new Set((await missions(launched.page)).map((item) => item.mission.id));
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const leadTerminalId = await startLead(launched.page, leadRuntime, leadPrompt);
    await confirmLiveRunIfRequested(launched.page, leadTerminalId, initialIds);
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
    expectNativeRuntimes(snapshot, bRuntime, [b]);
    expectNativeRuntimes(snapshot, cRuntime, [c]);
    expectNativeRuntimes(snapshot, dRuntime, [d]);
    expectNativeRuntimes(snapshot, eRuntime, [e]);

    const terminals = await terminalPtySnapshot(launched.page);
    expectTerminalProviderCounts(terminals.items, [
      leadRuntime,
      bRuntime,
      cRuntime,
      dRuntime,
      eRuntime,
    ]);
    await captureMission(launched.page, snapshot, '/tmp/charter-fabric-example-3-fanin.png');
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
  }
});
