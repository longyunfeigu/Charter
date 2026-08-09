import { expect, test } from '@playwright/test';
import { appendFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';

test.describe('Project Center', () => {
  test('removes a recent project from navigation after its folder is deleted', async () => {
    const deletedProject = realpathSync(createGitFixture());
    const activeProject = realpathSync(createGitFixture());
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: deletedProject, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const userDataDir = first.userDataDir;
    await first.app.close();

    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: activeProject, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId(`home-recent-${deletedProject}`)).toBeVisible();
      await page.getByTestId('rail-view-sessions').click();

      rmSync(deletedProject, { recursive: true, force: true });
      await page.getByTestId('rail-view-projects').click();

      await expect(page.getByTestId(`home-recent-${deletedProject}`)).toHaveCount(0);
      await expect(page.getByTestId(`home-recent-${activeProject}`)).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('browses independently, reports real data, and changes context only explicitly', async () => {
    const projectA = realpathSync(createGitFixture());
    const projectB = realpathSync(createGitFixture());
    writeFileSync(join(projectA, 'AGENTS.md'), '# Project A instructions\n');
    appendFileSync(join(projectA, 'README.md'), '\nLocal project change\n');

    // Register A, then launch with B as the actual working context.
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: projectA, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const userDataDir = first.userDataDir;
    await first.app.close();

    const { app, page } = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: projectB, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1320, height: 820 });
      await page.getByTestId('rail-view-projects').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();

      // ADR-0054: opening A's center makes A the working context — the same
      // principle as entering a session (ADR-0046).
      await page.getByTestId(`home-recent-${projectA}`).click();
      await expect(page.getByTestId('project-center')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('project-center-overview')).toBeVisible();
      await expect(page.locator('.pc-identity')).toContainText(projectA.split('/').pop()!);
      await expect(page.getByTestId(`home-recent-${projectA}`).locator('..')).toHaveClass(
        /current/,
        { timeout: 15_000 },
      );
      await expect(page.getByTestId(`home-recent-${projectA}`).locator('..')).toHaveClass(
        /selected/,
      );

      // The Files tab hosts the real editor: click a file, get an editable tab.
      await page.getByTestId('project-center-tab-files').click();
      await expect(page.getByTestId('project-center-files')).toBeVisible();
      await expect(page.getByTestId('project-center-editor')).toBeVisible();
      await page.getByTestId('project-file-src').click();
      await page.getByTestId('project-file-src/index.ts').click();
      await expect(page.getByTestId('tab-src/index.ts')).toBeVisible();

      // Changes and Setup are direct observations, not inferred dashboard numbers.
      await page.getByTestId('project-center-tab-changes').click();
      await expect(page.getByTestId('project-center-changes')).toContainText('README.md');
      await page.getByTestId('project-center-tab-setup').click();
      await expect(page.getByTestId('project-setup-agentsMd')).toContainText('Detected');
      await expect(page.getByTestId('project-setup-claudeMd')).toContainText('Not found');

      // Being the working context leaves the Project Center page stable.
      await expect(page.getByTestId('project-center')).toBeVisible();
      await expect(page.locator('.pc-badge.current')).toHaveText('Current');
      await page.getByTestId('project-center-tab-overview').click();
      await expect(page.getByTestId('project-center-overview')).toBeVisible();
      await page.screenshot({ path: join(tmpdir(), 'charter-project-center-desktop.png') });

      // Narrow layout remains usable without a document-level horizontal scroll.
      await page.setViewportSize({ width: 900, height: 900 });
      const closeRail = page.getByTestId('rail-compact-close');
      if (await closeRail.isVisible()) await closeRail.click();
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('project-center')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: join(tmpdir(), 'charter-project-center-narrow.png') });

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('does not count terminal Mission children as live project Sessions', async () => {
    test.setTimeout(90_000);
    const fixture = realpathSync(createGitFixture());
    const { app, page, userDataDir } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const originTaskId = 'task_project_live_origin';
    const childTaskId = 'task_project_live_mission_child';
    const standaloneTaskId = 'task_project_live_standalone';
    const originTerminalId = 'term_project_live_origin';
    const childTerminalId = 'term_project_live_mission_child';
    const standaloneTerminalId = 'term_project_live_standalone';
    let missionId = '';

    try {
      // Seed after startup so orphan recovery cannot intentionally settle the
      // synthetic active sessions before Project Center observes them.
      const database = openDatabase({
        file: join(userDataDir, 'app.db'),
        backupDir: join(userDataDir, 'backups'),
        migrations: MIGRATIONS,
      });
      try {
        const workspace = database.db
          .prepare('SELECT id FROM workspaces WHERE canonical_path = ?')
          .get(fixture) as { id: string } | undefined;
        expect(workspace).toBeTruthy();
        const now = new Date().toISOString();
        const insertTask = database.db.prepare(
          `INSERT INTO tasks
           (id, workspace_id, title, goal_md, mode, state, model_json, external_json,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ask', 'IN_PROGRESS', ?, ?, ?, ?)`,
        );
        const addTask = (id: string, title: string, terminalId: string): void => {
          insertTask.run(
            id,
            workspace!.id,
            title,
            title,
            JSON.stringify({ providerId: 'mock', modelId: 'mock-1' }),
            JSON.stringify({
              cli: 'claude',
              terminalId,
              cwd: fixture,
              snapshotRef: null,
              status: 'active',
              captureGrade: 'observed',
              sessionId: null,
            }),
            now,
            now,
          );
        };
        database.db.transaction(() => {
          addTask(originTaskId, 'Visible Mission origin Session', originTerminalId);
          addTask(childTaskId, 'Hidden terminal Mission child', childTerminalId);
          addTask(standaloneTaskId, 'Visible standalone Session', standaloneTerminalId);
        });

        const repository = new MissionRepository(database.db);
        const mission = repository.createMission({
          workspaceId: workspace!.id,
          workspaceRoot: fixture,
          originConversationTaskId: originTaskId,
          title: 'Completed Mission with a resident child',
          goal: 'Keep resident child runtimes out of top-level Session metrics.',
          lead: {
            principalId: 'project-live-lead',
            kind: 'external_agent',
            provider: 'claude',
            displayName: 'Mission Lead',
            runtimeSessionId: `terminal:${originTerminalId}`,
            terminalId: originTerminalId,
            requestedRuntime: 'claude',
          },
        });
        missionId = mission.mission.id;
        const lead = mission.assignments[0]!;
        const leadAttempt = mission.attempts[0]!;
        const child = repository.delegate({
          missionId,
          supervisorAssignmentId: lead.id,
          actorPrincipalId: lead.assigneePrincipalId,
          title: 'Resident Mission child',
          goal: 'Remain available for Mission follow-up without becoming a top-level Session.',
          acceptanceCriteria: [],
          requestedRuntime: 'claude',
          workMode: 'read-only',
          reason: 'Project Session visibility regression',
          idempotencyKey: 'project-live-child',
        });
        repository.bindRuntime(child.assignment.id, child.attempt.id, {
          runtimeSessionId: `terminal:${childTerminalId}`,
          terminalId: childTerminalId,
        });
        repository.completeAttempt({
          attemptId: child.attempt.id,
          principalId: child.assignment.assigneePrincipalId,
          outcome: 'success',
          summary: 'Child work is complete; runtime remains resident.',
        });
        repository.completeAttempt({
          attemptId: leadAttempt.id,
          principalId: lead.assigneePrincipalId,
          outcome: 'success',
          summary: 'Mission is ready for acceptance.',
        });
        expect(repository.snapshot(missionId).mission.state).toBe('VERIFYING');
      } finally {
        database.db.close();
      }

      await page.getByTestId('rail-view-projects').click();
      await page.getByTestId(`home-recent-${fixture}`).click();
      await expect(page.getByTestId('project-center')).toBeVisible({ timeout: 15_000 });
      const refreshButton = page.getByTestId('project-refresh');
      await refreshButton.click();
      await expect(refreshButton).toHaveAttribute('aria-busy', 'true');
      await expect(refreshButton.locator('[data-icon="refresh"]')).toHaveClass(/is-spinning/);
      await expect(refreshButton).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByTestId('project-live-count')).toHaveText('3');

      const finished = await page.evaluate(async (id) => {
        return await window.product.rpc['mission.finish']!({
          missionId: id,
          outcome: 'completed',
          reason: 'Project Session visibility fixture accepted',
        });
      }, missionId);
      expect(finished.ok).toBe(true);

      // The origin and standalone Sessions remain live. The completed
      // Mission's resident child belongs to Mission History, matching the
      // Sessions rail instead of inflating this project metric to three.
      await expect(page.getByTestId('project-live-count')).toHaveText('2');
      await expect(page.getByTestId(`project-discovered-${fixture}`)).toContainText('2 live');
      await page.getByTestId('project-center-tab-sessions').click();
      await page
        .getByRole('group', { name: 'Session state' })
        .getByText('Live', { exact: true })
        .click();
      await page
        .getByRole('group', { name: 'Session source' })
        .getByText('Tracked', { exact: true })
        .click();
      await expect(page.locator('.pc-session-card')).toHaveCount(2);
      await expect(page.getByTestId(`project-session-${originTaskId}`)).toBeVisible();
      await expect(page.getByTestId(`project-session-${standaloneTaskId}`)).toBeVisible();
      await expect(page.getByTestId(`project-session-${childTaskId}`)).not.toBeAttached();

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: join(tmpdir(), 'charter-project-live-count-wide.png') });
      await page.getByTestId('project-center-tab-overview').click();
      await page.setViewportSize({ width: 900, height: 760 });
      const closeRail = page.getByTestId('rail-compact-close');
      if (await closeRail.isVisible()) await closeRail.click();
      await expect(page.getByTestId('project-live-count')).toHaveText('2');
      await page.screenshot({ path: join(tmpdir(), 'charter-project-live-count-narrow.png') });

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
      rmSync(userDataDir, { recursive: true, force: true });
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
