import { expect, test } from '@playwright/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

function createWaitingClaude(): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-handoff-agent-'));
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "console.log('handoff-claude-ready');",
      "process.stdout.write('\\u001b[?2004h');",
      'let turnStarted = false;',
      "process.stdin.on('data', () => {",
      '  if (turnStarted) return;',
      '  turnStarted = true;',
      "  process.stdout.write('\\u001b]0;⠋ Claude\\u0007');",
      "  console.log('handoff-turn-working');",
      '  setTimeout(() => {',
      "    console.log('handoff-turn-idle');",
      "    process.stdout.write('\\u001b]0;✳ Claude\\u0007');",
      '  }, 1800);',
      '});',
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
  return bin;
}

test('Sessions rail explains handoff dependencies and animates only live Agent activity', async () => {
  test.setTimeout(90_000);
  const fixture = createTsSmallFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'charter-handoff-dependencies-'));
  const bin = createWaitingClaude();
  const database = openDatabase({
    file: join(userDataDir, 'app.db'),
    backupDir: join(userDataDir, 'backups'),
    migrations: MIGRATIONS,
  });
  let missionId = '';
  let handoffAssignmentId = '';
  let handoffAttemptId = '';
  let reviewerAssignmentId = '';
  try {
    const at = new Date().toISOString();
    database.db
      .prepare(
        `INSERT INTO workspaces
         (id, canonical_path, display_name, last_opened_at, created_at)
         VALUES ('handoff-workspace', ?, ?, ?, ?)`,
      )
      .run(fixture, basename(fixture), at, at);
    database.db
      .prepare(
        `INSERT INTO tasks
         (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at)
         VALUES ('handoff-origin', 'handoff-workspace', '今天吃什么多 Agent Demo',
                 'Build the picker in dependency order.', 'edit', 'IN_PROGRESS',
                 '{"providerId":"mock","modelId":"mock-1"}', ?, ?)`,
      )
      .run(at, at);
    const repository = new MissionRepository(database.db);
    const mission = repository.createMission({
      workspaceId: 'handoff-workspace',
      workspaceRoot: fixture,
      originConversationTaskId: 'handoff-origin',
      title: '今天吃什么多 Agent Demo',
      goal: 'Build the picker in dependency order.',
      lead: {
        principalId: 'handoff-lead',
        kind: 'managed_agent',
        provider: 'managed',
        displayName: 'Codex Lead',
        runtimeSessionId: 'managed-task:handoff-origin',
        requestedRuntime: 'managed',
      },
    });
    missionId = mission.mission.id;
    const lead = mission.assignments[0]!;
    const foundation = repository.delegate({
      missionId,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Codex：随机逻辑与自动化测试',
      goal: 'Publish the picker API.',
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'read-only',
      reason: 'The UI consumes this contract.',
      idempotencyKey: 'handoff-e2e-foundation',
    });
    const handoff = repository.delegate({
      missionId,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Kimi：页面、样式和交互',
      goal: 'Build the UI after the picker API is ready.',
      acceptanceCriteria: [],
      dependencies: [foundation.task.id],
      requestedRuntime: 'kimi',
      workMode: 'shared-write',
      reason: 'The UI follows the public API.',
      idempotencyKey: 'handoff-e2e-ui',
    });
    const reviewer = repository.delegate({
      missionId,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Claude Code：代码审查与验收',
      goal: 'Review only after the UI is complete.',
      acceptanceCriteria: [],
      dependencies: [handoff.task.id],
      requestedRuntime: 'claude',
      workMode: 'read-only',
      reason: 'The reviewer needs the integrated UI.',
      idempotencyKey: 'handoff-e2e-review',
    });
    reviewerAssignmentId = reviewer.assignment.id;

    repository.bindRuntime(foundation.assignment.id, foundation.attempt.id, {
      runtimeSessionId: 'seed-foundation-runtime',
    });
    repository.completeAttempt({
      attemptId: foundation.attempt.id,
      principalId: foundation.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Picker API ready.',
    });
    const replacement = repository.reassign({
      assignmentId: handoff.assignment.id,
      actorPrincipalId: lead.assigneePrincipalId,
      assignee: {
        kind: 'external_agent',
        provider: 'claude',
        displayName: 'Claude Code',
      },
      requestedRuntime: 'claude',
      reason: 'Reassigned by user from Mission Runtime inspector',
    });
    handoffAssignmentId = replacement.assignment.id;
    handoffAttemptId = replacement.attempt.id;
  } finally {
    database.db.close();
  }

  const launched = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude,kimi',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
  });
  const pageErrors: string[] = [];
  launched.page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const running = await expect
      .poll(
        async () =>
          await launched.page.evaluate(
            async ({ targetMissionId, targetAttemptId }) => {
              const result = (await window.product.rpc['mission.list']!({ limit: 100 })) as {
                ok: true;
                data: { missions: MissionSnapshotDto[] };
              };
              const snapshot = result.data.missions.find(
                (candidate) => candidate.mission.id === targetMissionId,
              );
              const attempt = snapshot?.attempts.find(
                (candidate) => candidate.id === targetAttemptId,
              );
              return attempt?.state === 'RUNNING' && attempt.terminalId
                ? { terminalId: attempt.terminalId }
                : null;
            },
            { targetMissionId: missionId, targetAttemptId: handoffAttemptId },
          ),
        { timeout: 30_000 },
      )
      .not.toBeNull();
    void running;
    const terminalId = await launched.page.evaluate(
      async ({ targetMissionId, targetAttemptId }) => {
        const result = (await window.product.rpc['mission.list']!({ limit: 100 })) as {
          ok: true;
          data: { missions: MissionSnapshotDto[] };
        };
        return result.data.missions
          .find((candidate) => candidate.mission.id === targetMissionId)
          ?.attempts.find((candidate) => candidate.id === targetAttemptId)?.terminalId;
      },
      { targetMissionId: missionId, targetAttemptId: handoffAttemptId },
    );
    expect(terminalId).toBeTruthy();
    const taskId = await launched.page.evaluate(async (id) => {
      const result = (await window.product.rpc['task.list']!({
        filter: 'all',
        includeArchived: false,
        scope: 'all',
      })) as
        { ok: true; data: { tasks: TaskDto[] } } | { ok: false; error: { userMessage: string } };
      if (!result.ok) throw new Error(result.error.userMessage);
      return result.data.tasks.find((task) => task.external?.terminalId === id)?.id ?? null;
    }, terminalId!);
    expect(taskId).toBeTruthy();

    await launched.page.getByTestId('rail-tab-sessions').click();
    const leadRow = launched.page.getByTestId('home-task-handoff-origin');
    await expect(leadRow).toContainText('Codex Lead');
    await expect(leadRow).toContainText('Active');
    await expect(leadRow).toHaveAttribute('data-working', 'false');

    const handoffRow = launched.page.getByTestId(`home-task-${taskId}`);
    await expect(handoffRow).toContainText('Claude Code');
    await expect(handoffRow).toContainText('Kimi：页面、样式和交互');
    await expect(handoffRow).toContainText('Working');
    await expect(handoffRow).toHaveAttribute('data-working', 'true');
    await expect(handoffRow).not.toContainText('You are Assignment');

    const reviewerRow = launched.page.getByTestId(`session-mission-${reviewerAssignmentId}`);
    await expect(reviewerRow).toContainText('Claude Code：代码审查与验收');
    await expect(reviewerRow).toContainText('Waiting');
    await expect(reviewerRow).toContainText('Waiting for Kimi：页面、样式和交互');
    await expect(reviewerRow).not.toContainText('Queued');
    await expect(launched.page.getByTestId(`session-mission-${handoffAssignmentId}`)).toHaveCount(
      0,
    );

    await expect(handoffRow).toHaveAttribute('data-working', 'false', { timeout: 15_000 });
    await expect(handoffRow).toContainText('Active');
    await expect(handoffRow).not.toContainText('Working');
    const dismissToast = launched.page.getByRole('button', { name: 'Dismiss' }).last();
    if (await dismissToast.isVisible()) await dismissToast.click();

    await launched.page.setViewportSize({ width: 1440, height: 900 });
    await launched.page.screenshot({ path: '/tmp/charter-handoff-dependencies-wide.png' });
    await launched.page.setViewportSize({ width: 900, height: 760 });
    await expect(launched.page.locator('.sr-panel')).toHaveCSS('opacity', '0');
    await launched.page.getByTestId('rail-view-sessions').click();
    await expect(launched.page.locator('.sr-panel')).toHaveCSS('opacity', '1');
    await expect(handoffRow).toBeVisible();
    await expect(reviewerRow).toBeVisible();
    await launched.page.screenshot({ path: '/tmp/charter-handoff-dependencies-narrow.png' });
    await expect(launched.page.locator('vite-error-overlay')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await launched.app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
