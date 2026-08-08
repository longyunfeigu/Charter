import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../packages/persistence/src/database';
import { MIGRATIONS } from '../../packages/persistence/src/migrations';
import { MissionRepository } from '../../packages/persistence/src/mission-repository';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test('Mission Experience separates Agent requests from user actions and persists acceptance', async () => {
  test.setTimeout(90_000);
  const fixture = createTsSmallFixture();
  const first = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  let taskId = '';
  let createdMissionId = '';
  let bAssignmentId = '';
  let dAssignmentId = '';
  let agentRequestMessageId = '';
  let userActionRequestId = '';
  try {
    await first.page.getByTestId('surface-home').click();
    await first.page.getByTestId('home-advanced-toggle').click();
    await first.page.getByTestId('home-adv-title').fill('Mission V2 release');
    await first.page.getByTestId('home-intent').fill('[scenario:ask-basic] prepare a release');
    await first.page.getByTestId('home-mode-ask').click();
    await first.page.getByTestId('home-submit').click();
    await expect(first.page.getByTestId('task-room')).toBeVisible();
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
    database.db.prepare("UPDATE tasks SET state = 'AWAITING_USER' WHERE id = ?").run(taskId);

    const repository = new MissionRepository(database.db);
    const created = repository.createMission({
      workspaceId: workspace!.id,
      workspaceRoot: fixture,
      originConversationTaskId: taskId,
      title: 'Ship Mission Orchestration V2',
      goal: 'Deliver a recursive, durable Agent team and verify the release.',
      acceptanceCriteria: ['recursive delegation works', 'the user can accept the Mission'],
      lead: {
        principalId: 'e2e-principal-a',
        kind: 'managed_agent',
        displayName: 'Lead agent A',
        runtimeSessionId: taskId,
        requestedRuntime: 'managed',
      },
    });
    createdMissionId = created.mission.id;
    const lead = created.assignments[0]!;
    const leadAttempt = created.attempts[0]!;
    const b = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Persistence specialist B',
      goal: 'Implement the durable Mission repository.',
      acceptanceCriteria: ['migration and repository tests pass'],
      expectedArtifacts: ['migration', 'repository tests'],
      requestedRuntime: 'codex',
      workMode: 'isolated-write',
      reason: 'Own the persistence workstream.',
      idempotencyKey: 'e2e-persistence-b',
    });
    bAssignmentId = b.assignment.id;
    repository.bindRuntime(b.assignment.id, b.attempt.id, {
      runtimeSessionId: 'runtime-b',
      terminalId: 'terminal-b',
    });
    const c = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: lead.id,
      actorPrincipalId: lead.assigneePrincipalId,
      title: 'Accessibility specialist C',
      goal: 'Verify the release flow remains understandable and keyboard accessible.',
      acceptanceCriteria: ['the Mission flow is understandable without inspecting raw events'],
      expectedArtifacts: ['accessibility review'],
      requestedRuntime: 'kimi',
      workMode: 'read-only',
      reason: 'Give the Lead two sibling workstreams so delegation renders as a real branch.',
      idempotencyKey: 'e2e-accessibility-c',
    });
    repository.bindRuntime(c.assignment.id, c.attempt.id, {
      runtimeSessionId: 'runtime-c',
      terminalId: 'terminal-c',
    });
    for (const outbox of repository.listPendingOutbox()) repository.completeOutbox(outbox.id);
    repository.completeAttempt({
      attemptId: c.attempt.id,
      principalId: c.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'The release flow is understandable and keyboard accessible.',
    });
    const d = repository.delegate({
      missionId: created.mission.id,
      supervisorAssignmentId: b.assignment.id,
      actorPrincipalId: b.assignment.assigneePrincipalId,
      title: 'Migration investigator D',
      goal: 'Review the schema and report migration risks to B.',
      acceptanceCriteria: ['schema risks are documented'],
      expectedArtifacts: ['migration review'],
      dependencies: [c.task.id],
      requestedRuntime: 'claude',
      workMode: 'read-only',
      reason: 'B needs a bounded independent schema review.',
      idempotencyKey: 'e2e-investigator-d',
    });
    dAssignmentId = d.assignment.id;
    repository.bindRuntime(d.assignment.id, d.attempt.id, {
      runtimeSessionId: 'runtime-d',
      terminalId: 'terminal-d',
    });
    const dRuntime = repository.upsertRuntimeSession({
      id: `runtime:${d.attempt.id}`,
      attemptId: d.attempt.id,
      provider: 'claude',
      transport: 'acp',
      externalSessionId: 'claude-session-d',
      processKey: 'claude:fixture-process',
      state: 'WAITING',
      cwd: fixture,
      capabilities: { loadSession: true },
    });
    repository.appendRuntimeEvent(dRuntime.id, d.attempt.id, 'acp.agent_message_chunk', {
      text: 'review complete',
    });
    for (const outbox of repository.listPendingOutbox()) repository.completeOutbox(outbox.id);

    repository.recordProgress({
      attemptId: b.attempt.id,
      principalId: b.assignment.assigneePrincipalId,
      phase: 'implementation',
      summary: 'Repository schema and lifecycle are implemented.',
      completed: ['schema', 'state transitions'],
      remaining: ['migration review'],
    });
    const agentRequest = repository.createActionRequest({
      missionId: created.mission.id,
      relatedTaskId: b.task.id,
      createdByPrincipalId: d.assignment.assigneePrincipalId,
      createdByAssignmentId: d.assignment.id,
      assignedToPrincipalId: b.assignment.assigneePrincipalId,
      assignedToAssignmentId: b.assignment.id,
      kind: 'information',
      responseType: 'text',
      priority: 'high',
      title: 'Schema ownership check',
      context: 'Should Assignment or Attempt own the runtime session?',
      blockingScope: 'assignment',
      idempotencyKey: 'schema-ownership-request',
    });
    agentRequestMessageId = agentRequest.message.id;
    repository.resolveActionRequest({
      requestId: agentRequest.request.id,
      resolvedByPrincipalId: b.assignment.assigneePrincipalId,
      resolvedByAssignmentId: b.assignment.id,
      outcome: 'answered',
      body: 'Attempt owns replaceable runtime identity.',
      idempotencyKey: 'schema-ownership-resolution',
    });
    const userAction = repository.createActionRequest({
      missionId: created.mission.id,
      relatedTaskId: lead.taskId,
      createdByPrincipalId: lead.assigneePrincipalId,
      createdByAssignmentId: lead.id,
      assignedToPrincipalId: 'user',
      assignedToAssignmentId: null,
      kind: 'choice',
      responseType: 'choice',
      title: 'Choose the release window',
      context: 'The architecture is ready. Choose when the release should proceed.',
      options: [
        {
          id: 'release-now',
          label: 'Release now',
          description: 'Proceed after reviewing the recorded evidence.',
          recommended: true,
        },
        {
          id: 'hold-release',
          label: 'Hold release',
          description: 'Keep deployment paused for another review.',
        },
      ],
      recommendation: 'Release now after accepting the recorded evidence.',
      impact: 'This determines whether deployment proceeds today.',
      priority: 'high',
      blockingScope: 'none',
      idempotencyKey: 'release-window-decision',
    });
    userActionRequestId = userAction.request.id;
    repository.completeAttempt({
      attemptId: d.attempt.id,
      principalId: d.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Schema review complete; Attempt owns replaceable runtime identity.',
      artifacts: [
        {
          kind: 'report',
          label: 'Migration review',
          reference: { uri: 'mission://migration-review' },
        },
      ],
      verification: [{ id: 'verify-schema', label: 'Schema checks', state: 'passed' }],
      filesModified: ['packages/persistence/src/migrations.ts'],
    });
    repository.completeAttempt({
      attemptId: b.attempt.id,
      principalId: b.assignment.assigneePrincipalId,
      outcome: 'success',
      summary: 'Durable Mission repository implemented and verified.',
    });
    repository.completeAttempt({
      attemptId: leadAttempt.id,
      principalId: lead.assigneePrincipalId,
      outcome: 'success',
      summary: 'Mission V2 is ready for user acceptance.',
    });
    expect(repository.snapshot(created.mission.id).mission.state).toBe('VERIFYING');
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
    await expect(second.page.getByTestId('rail-view-missions')).toBeVisible({ timeout: 15_000 });
    await second.page.getByTestId('rail-view-sessions').click();
    const bSession = second.page.getByTestId(`session-mission-${bAssignmentId}`);
    const dSession = second.page.getByTestId(`session-mission-${dAssignmentId}`);
    await expect(second.page.getByTestId(`home-task-${taskId}`)).toBeVisible();
    await expect(bSession).toBeVisible();
    await expect(dSession).toBeVisible();
    await expect(bSession.locator('..')).toHaveAttribute('style', /--sr-depth:\s*1/);
    await expect(dSession.locator('..')).toHaveAttribute('style', /--sr-depth:\s*2/);
    await second.page.screenshot({ path: '/tmp/charter-mission-session-hierarchy.png' });
    await dSession.click();
    await expect(second.page.getByTestId('mission-runtime-session')).toBeVisible();
    await expect(second.page.getByTestId('mission-runtime-session')).toContainText(
      'review complete',
    );

    await second.page.getByTestId('rail-view-missions').click();
    await second.page.getByTestId('mission-overview-link').click();
    await expect(second.page.getByTestId('mission-center')).toBeVisible();
    await expect(second.page.getByTestId(`mission-center-card-${createdMissionId}`)).toContainText(
      'Ship Mission Orchestration V2',
    );
    await second.page.getByTestId('rail-view-sessions').click();
    await expect(second.page.getByTestId('mission-center')).toBeHidden();
    await expect(second.page.getByTestId('rail-view-sessions')).toHaveClass(/active/);
    await second.page.getByTestId(`home-task-${taskId}`).click();
    const strip = second.page.getByTestId('mission-status-strip');
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute('aria-label', /Ship Mission Orchestration V2/);
    await expect(strip).toContainText('4 of 4 work items done');
    await expect(strip).toContainText('Open your actions');
    await strip.click();

    const mission = second.page.getByTestId('mission-view');
    await expect(mission).toBeVisible();
    await expect(mission).toContainText('Ship Mission Orchestration V2');
    await expect(second.page.getByTestId('mission-state')).toHaveText('Ready to review');
    await expect(second.page.getByTestId('mission-user-actions')).toBeVisible();
    await expect(second.page.getByTestId('mission-work-map')).toBeVisible();
    await expect(second.page.getByTestId('mission-view-outline')).toHaveClass(/active/);

    const workMap = second.page.getByTestId('mission-work-map');
    await expect(workMap.locator('.mission-work-card')).toHaveCount(4);
    await expect(workMap.locator('.mission-work-children .mission-work-children')).toHaveCount(1);
    const selectedOutlineWork = workMap.locator('.mission-work-card[aria-current="true"]');
    await expect(selectedOutlineWork).toHaveCount(1);
    await expect(selectedOutlineWork).toContainText('Lead agent A');
    await second.page.getByTestId('mission-view-graph').click();
    await expect(workMap.locator('.mission-graph-node')).toHaveCount(4);
    await expect(workMap).toContainText('Lead agent A');
    await expect(workMap).toContainText('Persistence specialist B');
    await expect(workMap).toContainText('Accessibility specialist C');
    await expect(workMap).toContainText('Migration investigator D');
    await expect(second.page.getByTestId('mission-graph-human')).toBeVisible();
    await expect(workMap.locator('.mission-graph-edge.dependency')).toHaveCount(1);
    await expect(workMap.locator('.mission-delegation-tree')).toHaveCount(2);
    await expect(workMap.locator('.mission-delegation-tree .label')).toHaveText([
      'Delegated work',
      'Delegated work',
    ]);
    await expect(workMap.locator('.mission-delegation-tree .branch')).toHaveCount(3);
    await expect(workMap.locator('.mission-graph-edge.communication')).toHaveCount(0);
    await expect(workMap.locator('.mission-edge-attention')).toContainText('1 for you');
    const communicationLayer = workMap.getByRole('button', { name: 'Communication' });
    await expect(communicationLayer).toHaveAttribute('aria-pressed', 'false');
    await communicationLayer.click();
    await expect(communicationLayer).toHaveAttribute('aria-pressed', 'true');
    await expect(workMap.locator('.mission-graph-edge.communication')).toHaveCount(3);
    await expect(
      workMap.locator('.mission-graph-edge.communication .mission-edge-attention'),
    ).toHaveCount(0);
    await communicationLayer.click();
    await expect(workMap.locator('.mission-graph-edge.communication')).toHaveCount(0);
    await expect(second.page.getByTestId('mission-graph-timeline')).toContainText('Live');
    await expect(second.page.getByTestId('mission-graph-detail-drawer')).not.toBeVisible();

    const graphLayout = second.page.locator('.mission-work-layout-graph');
    const fullscreenButton = second.page.getByTestId('mission-graph-fullscreen');
    const graphLayoutBeforeFullscreen = await graphLayout.boundingBox();
    await expect(fullscreenButton).toContainText('Full screen');
    await fullscreenButton.click();
    await expect(graphLayout).toHaveClass(/graph-fullscreen/);
    await expect(fullscreenButton).toContainText('Exit full screen');
    const graphLayoutFullscreen = await graphLayout.boundingBox();
    expect(graphLayoutFullscreen?.width ?? 0).toBeGreaterThan(
      (graphLayoutBeforeFullscreen?.width ?? 0) + 80,
    );
    expect(graphLayoutFullscreen?.height ?? 0).toBeGreaterThan(700);
    await expect
      .poll(() =>
        second.page.evaluate(() =>
          Boolean(
            document
              .elementFromPoint(24, 120)
              ?.closest('.mission-work-layout-graph.graph-fullscreen'),
          ),
        ),
      )
      .toBe(true);
    await second.page.screenshot({ path: '/tmp/charter-mission-graph-fullscreen.png' });
    await expect
      .poll(() =>
        second.page.evaluate(() =>
          [
            '.titlebar',
            '.titlebar .tb-brand-lockup',
            '.titlebar .tb-spacer',
            '[data-testid="mission-graph-fullscreen"]',
          ].map((selector) => {
            const element = document.querySelector(selector);
            return element
              ? getComputedStyle(element).getPropertyValue('-webkit-app-region')
              : null;
          }),
        ),
      )
      .toEqual(['no-drag', 'no-drag', 'no-drag', 'no-drag']);
    const fullscreenExitBox = await fullscreenButton.boundingBox();
    expect(fullscreenExitBox).not.toBeNull();
    await second.page.mouse.click(
      fullscreenExitBox!.x + fullscreenExitBox!.width / 2,
      fullscreenExitBox!.y + fullscreenExitBox!.height / 2,
    );
    await expect(graphLayout).not.toHaveClass(/graph-fullscreen/);
    await expect(fullscreenButton).toContainText('Full screen');
    await fullscreenButton.click();
    await expect(graphLayout).toHaveClass(/graph-fullscreen/);
    await second.page.keyboard.press('Escape');
    await expect(graphLayout).not.toHaveClass(/graph-fullscreen/);
    await expect(fullscreenButton).toContainText('Full screen');

    const graphViewport = second.page.getByTestId('mission-graph-viewport');
    const graphScene = second.page.getByTestId('mission-graph-scene');
    await second.page.waitForTimeout(180);
    const blankCanvasPoint = await graphViewport.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      for (let y = bounds.top + 32; y < bounds.bottom - 32; y += 18) {
        for (let x = bounds.left + 32; x < bounds.right - 32; x += 18) {
          const target = document.elementFromPoint(x, y);
          if (
            target?.closest('.mission-graph-scene') &&
            !target.closest(
              '.mission-graph-node, .mission-graph-human, .mission-graph-edge.communication, .mission-graph-edge.human',
            )
          ) {
            return { x, y };
          }
        }
      }
      return null;
    });
    expect(blankCanvasPoint).not.toBeNull();
    const sceneBeforePan = await graphScene.evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });
    await second.page.mouse.move(blankCanvasPoint!.x, blankCanvasPoint!.y);
    await second.page.mouse.down();
    await expect(graphViewport).toHaveClass(/panning/);
    await second.page.mouse.move(blankCanvasPoint!.x + 72, blankCanvasPoint!.y + 44, { steps: 4 });
    await second.page.mouse.up();
    await expect(graphViewport).not.toHaveClass(/panning/);
    const sceneAfterPan = await graphScene.evaluate((element) => {
      const matrix = new DOMMatrix(getComputedStyle(element).transform);
      return { x: matrix.e, y: matrix.f };
    });
    expect(sceneAfterPan.x - sceneBeforePan.x).toBeGreaterThan(60);
    expect(sceneAfterPan.y - sceneBeforePan.y).toBeGreaterThan(32);

    await second.page.mouse.move(blankCanvasPoint!.x + 72, blankCanvasPoint!.y + 44);
    await second.page.mouse.wheel(0, -120);
    await expect
      .poll(async () =>
        graphScene.evaluate((element) => new DOMMatrix(getComputedStyle(element).transform).a),
      )
      .toBeGreaterThan(sceneBeforePan.scale);

    const persistenceNode = workMap
      .locator('.mission-graph-node')
      .filter({ hasText: 'Persistence specialist B' });
    const migrationNode = workMap
      .locator('.mission-graph-node')
      .filter({ hasText: 'Migration investigator D' });
    const persistenceNodeBeforeDrag = await persistenceNode.evaluate((element) => ({
      left: Number.parseFloat((element as HTMLElement).style.left),
      top: Number.parseFloat((element as HTMLElement).style.top),
    }));
    const persistenceNodeBox = await persistenceNode.boundingBox();
    expect(persistenceNodeBox).not.toBeNull();
    await second.page.mouse.move(
      persistenceNodeBox!.x + persistenceNodeBox!.width / 2,
      persistenceNodeBox!.y + persistenceNodeBox!.height / 2,
    );
    await second.page.mouse.down();
    await second.page.mouse.move(
      persistenceNodeBox!.x + persistenceNodeBox!.width / 2 + 54,
      persistenceNodeBox!.y + persistenceNodeBox!.height / 2 + 28,
      { steps: 4 },
    );
    await second.page.mouse.up();
    const persistenceNodeAfterDrag = await persistenceNode.evaluate((element) => ({
      left: Number.parseFloat((element as HTMLElement).style.left),
      top: Number.parseFloat((element as HTMLElement).style.top),
    }));
    expect(persistenceNodeAfterDrag.left).toBeGreaterThan(persistenceNodeBeforeDrag.left + 25);
    expect(persistenceNodeAfterDrag.top).toBeGreaterThan(persistenceNodeBeforeDrag.top + 12);
    await expect(second.page.getByTestId('mission-graph-detail-drawer')).not.toBeVisible();
    await persistenceNode.click();
    await expect(workMap.locator('.mission-graph-edge.communication')).toHaveCount(2);
    const graphDrawer = second.page.getByTestId('mission-graph-detail-drawer');
    await expect(graphDrawer).toBeVisible();
    await expect(graphDrawer.getByTestId('mission-work-detail')).toContainText(
      'Persistence specialist B',
    );
    await migrationNode.click();
    await expect(graphDrawer.getByTestId('mission-work-detail')).toContainText(
      'Migration investigator D',
    );
    await graphDrawer.getByTestId('mission-open-agent-session').click();
    await expect(graphDrawer.getByTestId('mission-runtime-session')).toContainText(
      'review complete',
    );
    await second.page.screenshot({ path: '/tmp/charter-mission-agent-session.png' });
    await expect(second.page.getByTestId('mission-graph-detail-expand')).toContainText('Restore');
    await second.page.getByTestId('mission-graph-detail-expand').click();
    await second.page.getByTestId('mission-inspector-tab-conversation').click();
    await expect(graphDrawer).toContainText('Schema ownership check');
    const drawerBeforeExpand = await graphDrawer.boundingBox();
    expect(drawerBeforeExpand?.width ?? 0).toBeGreaterThan(560);
    await second.page.screenshot({ path: '/tmp/charter-mission-graph-detail.png' });
    await second.page.getByTestId('mission-graph-detail-expand').click();
    const drawerAfterExpand = await graphDrawer.boundingBox();
    expect(drawerAfterExpand?.width ?? 0).toBeGreaterThan(drawerBeforeExpand?.width ?? 0);
    await second.page.getByTestId('mission-graph-detail-close').click();
    await expect(graphDrawer).not.toBeVisible();

    await second.page.waitForTimeout(300);
    await second.page.screenshot({ path: '/tmp/charter-mission-graph-wide.png' });
    await workMap.screenshot({ path: '/tmp/charter-mission-graph-canvas-wide.png' });
    const wideViewport = second.page.viewportSize();
    await second.page.setViewportSize({ width: 900, height: 760 });
    await expect(workMap.locator('.mission-graph-node')).toHaveCount(4);
    expect(
      await communicationLayer.evaluate((element) => getComputedStyle(element).fontSize),
    ).not.toBe('0px');
    await second.page.waitForTimeout(300);
    await second.page.screenshot({ path: '/tmp/charter-mission-graph-narrow.png' });
    await workMap.screenshot({ path: '/tmp/charter-mission-graph-canvas-narrow.png' });
    await fullscreenButton.click();
    await expect(graphLayout).toHaveClass(/graph-fullscreen/);
    await expect(second.page.getByTestId('mission-graph-viewport')).toBeVisible();
    await second.page.screenshot({ path: '/tmp/charter-mission-graph-fullscreen-narrow.png' });
    await second.page.keyboard.press('Escape');
    await expect(graphLayout).not.toHaveClass(/graph-fullscreen/);
    if (wideViewport) await second.page.setViewportSize(wideViewport);

    await second.page.getByTestId('mission-view-outline').click();
    await expect(workMap.locator('.mission-work-card')).toHaveCount(4);
    await expect(workMap.locator('.mission-work-children .mission-work-children')).toHaveCount(1);
    await expect(workMap).toContainText('Review the schema and report migration risks to B.');

    const actions = second.page.getByTestId('mission-user-actions');
    await expect(actions).toContainText('Choose the release window');
    await expect(actions).toContainText('Team recommendation');
    await expect(actions).toContainText('Proceed after reviewing the recorded evidence.');
    await expect(actions).not.toContainText('Schema ownership check');
    const releaseNow = second.page.getByTestId(
      `mission-action-option-${userActionRequestId}-release-now`,
    );
    const holdRelease = second.page.getByTestId(
      `mission-action-option-${userActionRequestId}-hold-release`,
    );
    await expect(releaseNow).toHaveClass(/mission-primary/);
    await expect(releaseNow).toContainText('Recommended');
    await expect(holdRelease).not.toHaveClass(/mission-primary/);
    const actionViewport = second.page.viewportSize();
    await second.page.setViewportSize({ width: 1440, height: 900 });
    await actions.scrollIntoViewIfNeeded();
    const wideActionBox = await actions.boundingBox();
    expect(wideActionBox).not.toBeNull();
    expect(wideActionBox!.x + wideActionBox!.width).toBeLessThanOrEqual(1440);
    await second.page.screenshot({ path: '/tmp/charter-mission-your-actions-wide.png' });
    await second.page.setViewportSize({ width: 900, height: 760 });
    const compactClose = second.page.getByTestId('rail-compact-close');
    if (await compactClose.isVisible()) await compactClose.click();
    await actions.scrollIntoViewIfNeeded();
    const actionBox = await actions.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox!.x).toBeGreaterThanOrEqual(0);
    expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(900);
    const narrowReleaseBox = await releaseNow.boundingBox();
    expect(narrowReleaseBox).not.toBeNull();
    expect(narrowReleaseBox!.x).toBeGreaterThanOrEqual(0);
    expect(narrowReleaseBox!.x + narrowReleaseBox!.width).toBeLessThanOrEqual(900);
    await second.page.waitForTimeout(300);
    await second.page.screenshot({ path: '/tmp/charter-mission-your-actions-narrow.png' });
    if (actionViewport) await second.page.setViewportSize(actionViewport);

    await second.page.getByTestId('mission-tab-activity').click();
    const activity = second.page.getByTestId('mission-activity-view');
    await expect(activity).toContainText('Team activity');
    await expect(activity).toContainText('Schema ownership check');
    await expect(activity).toContainText('Request resolved');
    await second.page.getByTestId('mission-activity-filter-requests').click();
    await expect(activity).toContainText('Schema ownership check');
    await expect(activity).not.toContainText('Repository schema and lifecycle are implemented.');
    const agentRequestItem = second.page.getByTestId(
      `mission-activity-item-${agentRequestMessageId}`,
    );
    const requestToggle = second.page.getByTestId(
      `mission-activity-toggle-${agentRequestMessageId}`,
    );
    await expect(requestToggle).toHaveAttribute('aria-expanded', 'false');
    await requestToggle.click();
    await expect(requestToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(agentRequestItem).toContainText('Priority');
    await expect(agentRequestItem).toContainText('information · resolved');
    await second.page.screenshot({
      path: '/tmp/charter-mission-activity-request-expanded.png',
    });
    await second.page.getByTestId('mission-activity-filter-progress').click();
    await expect(activity).toContainText('Repository schema and lifecycle are implemented.');
    await expect(activity).not.toContainText('Schema ownership check');
    await second.page.screenshot({ path: '/tmp/charter-mission-activity-progressive.png' });
    await second.page.getByTestId('mission-tab-work').click();
    await releaseNow.click();
    await expect(actions).not.toBeVisible();

    await second.page.getByTestId('mission-tab-work').click();
    await second.page.getByTestId('mission-view-outline').click();
    await workMap.getByRole('button', { name: /Migration investigator D/ }).click();
    const details = second.page.getByTestId('mission-work-detail');
    await expect(details).toContainText('Schema review complete');
    await second.page.getByTestId('mission-inspector-tab-evidence').click();
    await expect(second.page.getByTestId('mission-artifacts')).toContainText('Migration review');
    await expect(second.page.getByTestId('mission-artifacts')).toContainText('Schema checks');
    await expect(second.page.getByTestId('mission-artifacts')).toContainText(
      'packages/persistence/src/migrations.ts',
    );
    await second.page.getByTestId('mission-inspector-tab-attempts').click();
    await details.getByText('Advanced controls and runtime details').click();
    await expect(details).toContainText('SUCCEEDED');
    await expect(details).toContainText('runtime-d');
    await expect(details).toContainText('ACP · WAITING');
    await expect(details).toContainText('claude:fixture-process');
    await expect(details).toContainText('acp.agent_message_chunk');
    await second.page.screenshot({ path: '/tmp/charter-mission-workbench.png' });

    await second.page.getByTestId('mission-tab-results').click();
    await expect(second.page.getByTestId('mission-results')).toContainText('Schema checks');
    await expect(second.page.getByTestId('mission-results')).toContainText(
      'packages/persistence/src/migrations.ts',
    );
    await second.page.setViewportSize({ width: 780, height: 720 });
    const missionBox = await mission.boundingBox();
    expect(missionBox).not.toBeNull();
    expect(missionBox!.x).toBeGreaterThanOrEqual(0);
    expect(missionBox!.x + missionBox!.width).toBeLessThanOrEqual(780);
    await second.page.screenshot({ path: '/tmp/charter-mission-results-narrow.png' });
    await second.page.getByTestId('mission-finish').click();
    await expect(second.page.getByTestId('mission-state')).toHaveText('Accepted');
    await expect(second.page.getByTestId('mission-results')).toContainText(
      'This Mission is complete.',
    );
    const persisted = await second.page.evaluate(async (originTaskId) => {
      return window.product.rpc['mission.forConversation']!({ taskId: originTaskId });
    }, taskId);
    expect(persisted.ok).toBe(true);
    expect(
      (persisted.data as { snapshot: { mission: { state: string } } }).snapshot.mission.state,
    ).toBe('COMPLETED');
    expect(pageErrors).toEqual([]);
  } finally {
    await second.app.close();
    rmSync(first.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
