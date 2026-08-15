import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionSnapshotDto, TaskDto, TimelineEventDto } from '@pi-ide/ipc-contracts';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

function createControllableClaude(): { bin: string; inputProbe: string; heartbeatProbe: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-runtime-controls-'));
  const inputProbe = join(bin, 'input.log');
  const heartbeatProbe = join(bin, 'heartbeat.log');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      `const inputProbe = ${JSON.stringify(inputProbe)};`,
      `const heartbeatProbe = ${JSON.stringify(heartbeatProbe)};`,
      'let promoted = false;',
      "console.log('controllable-claude-ready');",
      "process.stdout.write('\\u001b[?2004h');",
      "process.stdin.on('data', (chunk) => {",
      '  const input = chunk.toString();',
      '  fs.appendFileSync(inputProbe, input);',
      "  if (promoted || !input.includes('请 Mission 调度')) return;",
      '  promoted = true;',
      '  const plan = {',
      "    reason: 'The requested controllable Agent benefits from durable Mission controls.',",
      '    children: [{',
      "      key: 'observer',",
      "      title: 'Control observer',",
      "      goal: 'Remain available while the Lead exercises runtime controls.',",
      "      acceptanceCriteria: ['The runtime remains observable.'],",
      "      requestedRuntime: 'shell',",
      "      workMode: 'read-only',",
      "      reason: 'A visible observer makes the Mission control path independently inspectable.',",
      "      idempotencyKey: 'e2e-runtime-controls-observer'",
      '    }],',
      "    integration: { mode: 'none' }",
      '  };',
      "  const result = spawnSync(process.env.CHARTER_COMMAND || 'charter', ['orchestration', 'promote', '--request-json', JSON.stringify(plan), '--json'], { encoding: 'utf8', timeout: 15000 });",
      '  fs.appendFileSync(inputProbe, `\\npromote=${JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr })}\\n`);',
      '});',
      "setInterval(() => fs.appendFileSync(heartbeatProbe, '.'), 100);",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return { bin, inputProbe, heartbeatProbe };
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

async function openMission(page: Page, missionId: string): Promise<void> {
  await page.getByTestId('rail-view-missions').click();
  await expect(page.getByTestId(`mission-center-card-${missionId}`)).toBeVisible();
  await page.getByTestId(`mission-center-card-${missionId}`).click();
  await page.getByTestId('mission-view-graph').click();
  await expect(page.getByTestId('mission-work-map')).toBeVisible();
  await page.getByTestId('mission-work-map').locator('.mission-graph-node').first().click();
  await expect(page.getByTestId('mission-work-detail')).toBeVisible();
}

async function taskDetail(
  page: Page,
  taskId: string,
): Promise<{ task: TaskDto; timeline: TimelineEventDto[] }> {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['task.get']!({ taskId: id, eventsAfter: 0 })) as
      | { ok: true; data: { task: TaskDto; timeline: TimelineEventDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.get failed');
    return result.data;
  }, taskId);
}

async function missionSnapshot(page: Page, missionId: string): Promise<MissionSnapshotDto> {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['mission.list']!({ limit: 100 })) as
      | { ok: true; data: { missions: MissionSnapshotDto[] } }
      | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'mission.list failed');
    const snapshot = result.data.missions.find((item) => item.mission.id === id);
    if (!snapshot) throw new Error(`Mission ${id} not found`);
    return snapshot;
  }, missionId);
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

test('Runtime Inspector opens, updates, pauses, resumes, and hands off managed work', async () => {
  test.setTimeout(120_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  let missionId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Runtime control seed');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] establish a session');
    await first.page.getByTestId('home-mode-ask').click();
    await first.page.getByTestId('home-submit').click();
    taskId = (await first.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    expect(taskId).not.toBe('');
    await expect(first.page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 20_000,
    });
  } finally {
    await first.app.close();
  }

  const database = openDatabase({
    file: join(first.userDataDir, 'app.db'),
    backupDir: join(first.userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  try {
    const workspace = database.db
      .prepare('SELECT workspace_id AS id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string } | undefined;
    expect(workspace).toBeTruthy();
    const created = new MissionRepository(database.db).createMission({
      workspaceId: workspace!.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Runtime controls acceptance',
      goal: 'Prove every Runtime Inspector control through the Electron UI.',
      acceptanceCriteria: ['all user controls reach their runtime'],
      lead: {
        principalId: 'runtime-control-lead',
        kind: 'managed_agent',
        provider: 'managed',
        displayName: 'Original Lead',
        runtimeSessionId: `managed-task:${taskId}`,
        requestedRuntime: 'managed',
        requestedModel: 'mock::mock-1',
      },
    });
    missionId = created.mission.id;
  } finally {
    database.db.close();
  }

  const second = await launchApp({
    userDataDir: first.userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  const pageErrors: string[] = [];
  second.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await openMission(second.page, missionId);
    const details = second.page.getByTestId('mission-work-detail');

    await details.getByTestId('mission-open-agent-session').click();
    await expect(second.page.getByTestId('task-room')).toHaveAttribute('data-task-id', taskId);
    await expect(second.page.getByTestId('rail-tab-sessions')).toContainText('Sessions');
    await expect(second.page.getByTestId('mission-rail-panel')).not.toBeVisible();
    await expect(second.page.getByTestId('task-room-back')).toHaveAttribute(
      'aria-label',
      'Back to Mission',
    );
    await expect(second.page.getByTestId('session-agent-chip')).not.toBeAttached();
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await second.page.screenshot({ path: '/tmp/charter-session-header-clean-wide.png' });
    await second.page.setViewportSize({ width: 900, height: 760 });
    await expect(second.page.getByTestId('task-room-back')).toBeVisible();
    const compactClose = second.page.getByTestId('rail-compact-close');
    if (await compactClose.isVisible()) await compactClose.click();
    await second.page.waitForTimeout(250);
    await second.page.screenshot({ path: '/tmp/charter-session-header-clean-narrow.png' });
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await second.page.getByTestId('session-more').click();
    await second.page.getByTestId('session-more-details').click();
    await expect(second.page.getByTestId('session-agent-chip')).toContainText('Charter');
    await expect(second.page.getByTestId('task-room-external-chip')).toHaveText('Charter managed');
    await second.page.getByTestId('session-more').click();
    await second.page.getByTestId('task-room-back').click();
    await expect(second.page.getByTestId('mission-work-map')).toBeVisible();
    await expect(details).toBeVisible();

    await details.getByRole('button', { name: 'Pause Agent', exact: true }).click();
    await expect(details.getByText('Paused', { exact: true })).toBeVisible();
    await expect(details.getByRole('button', { name: 'Resume Agent', exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Resume Agent', exact: true }).click();
    await expect(details.getByRole('button', { name: 'Pause Agent', exact: true })).toBeVisible();
    await expect
      .poll(async () => (await taskDetail(second.page, taskId)).task.state, { timeout: 20_000 })
      .toBe('IDLE');

    const guidance = `GUIDANCE-${Date.now()} use the revised acceptance criteria`;
    await details
      .getByPlaceholder('Add context, change direction, or share a constraint…')
      .fill(guidance);
    await details.getByTestId('mission-send-guidance').click();
    await expect
      .poll(
        async () =>
          (await taskDetail(second.page, taskId)).timeline.some((event) => {
            const payload = event.payload as { text?: unknown };
            return (
              event.type === 'user.message' &&
              typeof payload.text === 'string' &&
              payload.text.includes(guidance)
            );
          }),
        { timeout: 20_000 },
      )
      .toBe(true);
    await expect
      .poll(async () => (await taskDetail(second.page, taskId)).task.state, { timeout: 20_000 })
      .toBe('IDLE');

    await details.getByTestId('mission-change-owner').click();
    await details.getByLabel('Agent name').fill('Replacement Lead');
    await details.getByTestId('mission-reassign-submit').click();
    await expect(details).toContainText('Replacement Lead');
    await expect
      .poll(
        async () => {
          const snapshot = await missionSnapshot(second.page, missionId);
          const lead = snapshot.assignments.find(
            (assignment) => assignment.id === snapshot.mission.leadAssignmentId,
          );
          const attempt = snapshot.attempts.find((item) => item.id === lead?.activeAttemptId);
          const principal = snapshot.principals.find(
            (item) => item.id === lead?.assigneePrincipalId,
          );
          return {
            owner: principal?.displayName,
            ordinal: attempt?.ordinal,
            runtimeSessionId: attempt?.runtimeSessionId,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        owner: 'Replacement Lead',
        ordinal: 2,
        runtimeSessionId: expect.stringMatching(/^managed-task:/),
      });

    await details.getByTestId('mission-open-agent-session').click();
    await expect(second.page.getByTestId('rail-tab-sessions')).toContainText('Sessions');
    await expect(second.page.getByTestId('mission-rail-panel')).not.toBeVisible();
    const replacementTaskId =
      (await second.page.getByTestId('task-room').getAttribute('data-task-id')) ?? '';
    expect(replacementTaskId).not.toBe('');
    expect(replacementTaskId).not.toBe(taskId);

    // The Sessions rail stops Mission members one by one. Once the final live
    // Assignment disappears, the durable aggregate must leave RUNNING too.
    await second.page.getByTestId('rail-running-summary').click();
    await expect(second.page.getByTestId('rail-stop-all-confirm')).toBeVisible();
    await second.page.getByTestId('rail-stop-all-confirm-action').click();
    await expect
      .poll(async () => (await missionSnapshot(second.page, missionId)).mission.state, {
        timeout: 20_000,
      })
      .toBe('CANCELLED');
    await second.page.getByTestId('task-room-back').click();
    await expect(second.page.getByTestId('mission-state')).toHaveText('Cancelled');
    await expect(second.page.getByTestId('mission-cancel')).not.toBeAttached();
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('visible Mission controls hold real PTY input, keep the turn alive, and hand off', async () => {
  test.setTimeout(120_000);
  const fixture = createTsSmallFixture();
  const { bin, inputProbe, heartbeatProbe } = createControllableClaude();
  const initialPrompt = '请 Mission 调度一个可控 Agent，并等待人工调整。';
  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
  });
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    const terminalId = await launched.page.evaluate(async (initialPrompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, initialPrompt);

    await expect
      .poll(
        async () =>
          await launched.page.evaluate(async (id) => {
            const tasks = (await window.product.rpc['task.list']!({
              filter: 'all',
              includeArchived: false,
              scope: 'all',
            })) as { ok: true; data: { tasks: TaskDto[] } };
            const task = tasks.data.tasks.find(
              (candidate) => candidate.external?.terminalId === id,
            );
            if (!task) return null;
            const result = (await window.product.rpc['mission.forConversation']!({
              taskId: task.id,
            })) as { ok: true; data: { snapshot: MissionSnapshotDto | null } };
            return result.data.snapshot;
          }, terminalId),
        { timeout: 20_000 },
      )
      .not.toBeNull();
    const snapshot = await launched.page.evaluate(async (id) => {
      const result = (await window.product.rpc['mission.list']!({ limit: 100 })) as {
        ok: true;
        data: { missions: MissionSnapshotDto[] };
      };
      return result.data.missions.find((item) =>
        item.attempts.some((attempt) => attempt.terminalId === id),
      )!;
    }, terminalId);
    const missionId = snapshot.mission.id;
    const leadAssignmentId = snapshot.mission.leadAssignmentId!;

    await openMission(launched.page, missionId);
    const details = launched.page.getByTestId('mission-work-detail');
    const missionPresence = details.getByTestId(`agent-presence-${terminalId}`);
    await expect(missionPresence).toBeVisible();
    await expect(missionPresence).toHaveAttribute('data-lifecycle', /^(working|unknown)$/);
    await missionPresence.click();
    await expect(details.getByTestId('agent-presence-explain')).toContainText('manifest');
    await missionPresence.click();
    await expect(details.getByText('Adjust direction', { exact: true })).toBeVisible();
    await expect(details.getByTestId('mission-open-agent-session')).toHaveText(
      /Open Agent session/,
    );
    await expect(details.getByTestId('mission-hold-input')).toHaveText(/Hold new instructions/);
    await expect(details.getByTestId('mission-change-owner')).toHaveText(
      /Hand off to another Agent/,
    );
    await expect(details.getByTestId('mission-hold-input-note')).toContainText(
      'Current turn will continue',
    );

    const dismissToast = launched.page.getByRole('button', { name: 'Dismiss' }).last();
    if (await dismissToast.isVisible()) await dismissToast.click();

    await launched.page.setViewportSize({ width: 1440, height: 900 });
    await launched.page.screenshot({ path: '/tmp/charter-mission-controls-wide.png' });
    await launched.page.setViewportSize({ width: 900, height: 760 });
    await expect(details.getByTestId('mission-change-owner')).toBeVisible();
    const actionBounds = await details.locator('.mission-detail-actions').boundingBox();
    expect(actionBounds).not.toBeNull();
    expect(actionBounds!.x).toBeGreaterThanOrEqual(0);
    expect(actionBounds!.x + actionBounds!.width).toBeLessThanOrEqual(900);
    const actionButtonBounds = await details
      .locator('.mission-detail-actions button')
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right };
        }),
      );
    expect(actionButtonBounds.every((bounds) => bounds.left >= 0 && bounds.right <= 900)).toBe(
      true,
    );
    await launched.page.screenshot({ path: '/tmp/charter-mission-controls-narrow.png' });
    await launched.page.setViewportSize({ width: 1440, height: 900 });

    await details.getByTestId('mission-open-agent-session').click();
    const leadTaskId = await taskIdForTerminal(launched.page, terminalId);
    expect(leadTaskId).not.toBeNull();
    await expect(launched.page.getByTestId('task-room')).toHaveAttribute(
      'data-task-id',
      leadTaskId!,
    );
    await expect(launched.page.getByTestId('external-terminal-column')).toHaveAttribute(
      'data-terminal-id',
      terminalId,
    );
    await launched.page.getByTestId('task-room-back').click();
    await expect(launched.page.getByTestId('mission-work-map')).toBeVisible();
    await expect(details).toBeVisible();

    await expect.poll(() => readOptional(inputProbe), { timeout: 20_000 }).toContain(initialPrompt);
    await expect.poll(() => readOptional(heartbeatProbe).length).toBeGreaterThan(2);

    await details.getByTestId('mission-hold-input').click();
    await expect(details.getByTestId('mission-hold-input')).toHaveText(/Release instructions/);
    const heartbeatBefore = readOptional(heartbeatProbe).length;
    const guidance = `PTY-GUIDANCE-${Date.now()} keep the current implementation boundary`;
    await details
      .getByPlaceholder('Add context, change direction, or share a constraint…')
      .fill(guidance);
    await details.getByTestId('mission-send-guidance').click();
    await launched.page.waitForTimeout(900);
    expect(readOptional(inputProbe)).not.toContain(guidance);
    expect(readOptional(heartbeatProbe).length).toBeGreaterThan(heartbeatBefore);

    await details.getByTestId('mission-hold-input').click();
    await expect.poll(() => readOptional(inputProbe), { timeout: 20_000 }).toContain(guidance);
    await expect(details.getByTestId('mission-hold-input')).toHaveText(/Hold new instructions/);

    await details.getByTestId('mission-change-owner').click();
    await expect(details.getByTestId('mission-reassign')).toContainText(
      'current attempt stays in history',
    );
    await details.getByLabel('Agent runtime').selectOption('shell');
    await details.getByLabel('Agent name').fill('Shell replacement');
    await details.getByTestId('mission-reassign-submit').click();

    await expect
      .poll(
        async () => {
          const current = await missionSnapshot(launched.page, missionId);
          const lead = current.assignments.find((item) => item.id === leadAssignmentId);
          const attempt = current.attempts.find((item) => item.id === lead?.activeAttemptId);
          const principal = current.principals.find(
            (item) => item.id === lead?.assigneePrincipalId,
          );
          return {
            owner: principal?.displayName ?? null,
            ordinal: attempt?.ordinal ?? null,
            runtime: attempt?.requestedRuntime ?? null,
            terminalId: attempt?.terminalId ?? null,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        owner: 'Shell replacement',
        ordinal: 2,
        runtime: 'shell',
        terminalId: expect.stringMatching(/^term_/),
      });
    const replacementSnapshot = await missionSnapshot(launched.page, missionId);
    const replacementLead = replacementSnapshot.assignments.find(
      (item) => item.id === leadAssignmentId,
    )!;
    const replacementAttempt = replacementSnapshot.attempts.find(
      (item) => item.id === replacementLead.activeAttemptId,
    )!;
    expect(replacementAttempt.terminalId).not.toBe(terminalId);
    await expect(details).toContainText('Shell replacement');
    await details.getByTestId('mission-open-agent-session').click();
    await expect(launched.page.getByTestId('session-terminal-view')).toHaveAttribute(
      'data-terminal-id',
      replacementAttempt.terminalId!,
    );

    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
