import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

interface WorkExample {
  title: string;
  typeId: string;
  description: string;
  sourcePerson?: string;
  sourceChannel?: string;
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  acceptance?: string;
  deliverables?: string;
  custom?: Record<string, string | boolean>;
}

async function createWork(page: Page, example: WorkExample): Promise<void> {
  await page.getByTestId('work-new-item').click();
  await expect(page.getByTestId('work-item-form')).toBeVisible();
  await page.getByTestId('work-title').fill(example.title);
  await page.getByTestId('work-type').selectOption(example.typeId);
  await page.getByTestId('work-description').fill(example.description);
  if (example.sourcePerson) await page.getByTestId('work-source-person').fill(example.sourcePerson);
  if (example.sourceChannel)
    await page.getByTestId('work-source-channel').fill(example.sourceChannel);
  if (example.priority) await page.getByTestId('work-priority').selectOption(example.priority);
  if (example.acceptance) await page.getByTestId('work-acceptance').fill(example.acceptance);
  if (example.deliverables) await page.getByTestId('work-deliverables').fill(example.deliverables);
  for (const [key, value] of Object.entries(example.custom ?? {})) {
    const field = page.getByTestId(`work-custom-${key}`);
    if (typeof value === 'boolean') {
      if (value) await field.check();
    } else {
      await field.fill(value);
    }
  }
  await page.getByTestId('work-form-submit').click();
  await expect(page.getByTestId('work-item-form')).toBeHidden();
  await expect(page.getByTestId('work-detail-title')).toHaveText(example.title);
}

function captureErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

test.describe('Role-neutral Work board', () => {
  test('handles product, operations and research outcomes through capture, review, workflow and persistence', async () => {
    const first = await launchApp({ home: 'keep' });
    const { app, page, userDataDir } = first;
    const errors = captureErrors(page);
    try {
      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-view')).toBeVisible();
      await expect(page.getByTestId('work-board')).toBeVisible();
      await expect(page.locator('.work-column')).toHaveCount(5);
      await expect(page.getByTestId('work-first-run')).toHaveCount(0);
      await expect(page.getByTestId('work-rail-panel')).toHaveCount(0);
      await expect(page.getByTestId('home-sidebar')).toHaveCSS('width', '78px');

      await page.getByTestId('work-new-item').click();
      await expect(page.getByTestId('work-assignee')).toHaveCount(0);
      await expect(page.getByTestId('work-column')).toHaveCount(0);
      await page.getByTestId('work-form-close').click();

      await createWork(page, {
        title: 'Validate onboarding problem before Q4 planning',
        typeId: 'work-type-product',
        description: 'Decide whether first-run setup is the primary activation bottleneck.',
        sourcePerson: 'Lina · Product lead',
        sourceChannel: 'Monday product review',
        priority: 'high',
        acceptance: 'Interview evidence is cited\nDecision and success metric are explicit',
        deliverables: 'Discovery brief\nRecommendation for Q4 roadmap',
        custom: {
          user_problem: 'New workspace admins abandon setup before inviting their team.',
          target_users: 'First-time workspace administrators',
          success_metric: 'Increase setup completion from 54% to 70%',
        },
      });
      await expect(page.getByTestId('work-detail-stage')).toHaveValue('work-col-inbox');
      await expect(page.getByTestId('work-detail-source')).toContainText('Monday product review');
      await expect(page.locator('.work-custom-values')).toContainText(
        'New workspace admins abandon setup',
      );

      // Review evidence and checklist settlement are real durable mutations.
      await page.getByTestId('work-evidence-kind').selectOption('link');
      await page.getByTestId('work-evidence-label').fill('Interview synthesis with citations');
      await page
        .getByTestId('work-evidence-value')
        .fill('https://example.com/research/onboarding-synthesis');
      await page.getByTestId('work-evidence-add').click();
      await expect(page.getByTestId('work-evidence')).toContainText(
        'Interview synthesis with citations',
      );
      await page.locator('.work-checklists label').first().locator('input').check();
      await expect(page.locator('.work-checklists label').first()).toHaveClass(/checked/);
      await page.getByTestId('work-detail-close').click();

      await createWork(page, {
        title: 'Run enterprise webinar follow-up campaign',
        typeId: 'work-type-operations',
        description: 'Send approved follow-up and hand qualified responses to sales operations.',
        sourcePerson: 'Alicia · Growth',
        sourceChannel: 'Launch room #enterprise-webinar',
        priority: 'urgent',
        acceptance: 'Legal approves final copy\nEvery send has an auditable campaign receipt',
        deliverables: 'Final audience segment\nApproved email copy\nCampaign report',
        custom: {
          channel: 'Lifecycle email + CRM',
          audience: 'Enterprise webinar attendees',
          runbook: 'Dry run, legal approval, scheduled send, receipt capture, CRM handoff.',
          external_action: true,
          approval_owner: 'Morgan · Legal',
        },
      });
      await expect(page.locator('.work-custom-values')).toContainText('External action');
      await expect(page.locator('.work-custom-values')).toContainText('Yes');
      await page.getByTestId('work-detail-close').click();

      await createWork(page, {
        title: 'Research APAC competitor packaging',
        typeId: 'work-type-research',
        description: 'Compare packaging and support claims before the regional pricing decision.',
        sourcePerson: 'Jun · Regional GM',
        sourceChannel: 'APAC planning memo',
        priority: 'medium',
        acceptance: 'At least five primary sources\nConflicting claims are called out',
        deliverables: 'Source table\nPricing recommendation',
        custom: {
          question: 'Which enterprise packaging choices most affect APAC conversion?',
          source_standard: 'Primary pricing pages and current customer interviews',
          decision: 'Whether to launch a regional enterprise package in Q4',
        },
      });
      await page.getByTestId('work-detail-close').click();

      // Filter semantics are type-aware, not hard-wired to software work.
      await page.getByTestId('work-type-filter').selectOption('work-type-operations');
      await expect(page.locator('.work-card')).toHaveCount(1);
      await expect(page.locator('.work-card')).toContainText('webinar follow-up');
      await page.getByTestId('work-type-filter').selectOption('all');
      await page.getByTestId('work-search').fill('APAC');
      await expect(page.locator('.work-card')).toHaveCount(1);
      await expect(page.locator('.work-card')).toContainText('competitor packaging');
      await page.getByTestId('work-search').fill('');

      // Trello-style status movement uses the real persisted board mutation.
      const operations = page.locator('.work-card').filter({ hasText: 'enterprise webinar' });
      const activeColumn = page.getByTestId('work-column-work-col-active');
      await operations.dragTo(activeColumn);
      await expect(activeColumn).toContainText('enterprise webinar');
      await operations.click();
      await page.getByTestId('work-detail-stage').selectOption('work-col-review');
      await expect(page.getByTestId('work-detail-stage')).toHaveValue('work-col-review');
      await page.getByTestId('work-detail-close').click();

      // The five built-in stages must fit the standard desktop Work surface
      // without forcing horizontal navigation.
      await page.setViewportSize({ width: 1280, height: 800 });
      const defaultBoardOverflow = await page.getByTestId('work-board').evaluate((board) => {
        return board.scrollWidth - board.clientWidth;
      });
      expect(defaultBoardOverflow).toBeLessThanOrEqual(1);
      const compactCardHeights = await page
        .locator('.work-card')
        .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
      expect(Math.max(...compactCardHeights)).toBeLessThanOrEqual(130);
      writeFileSync(join(tmpdir(), 'charter-work-board-wide.png'), await page.screenshot());

      // Teams can extend both task schema and workflow without changing core code.
      await page.getByTestId('work-manage-types').click();
      await page.getByTestId('work-new-type-name').fill('Customer escalation');
      await page.getByTestId('work-new-field-label').fill('Affected account');
      await page.getByRole('button', { name: 'Add field' }).click();
      await page.getByTestId('work-new-type-submit').click();
      await expect(page.getByTestId('work-type-filter')).toContainText('Customer escalation');
      await page.getByTestId('work-add-stage').click();
      await page.getByTestId('work-new-stage-name').fill('Legal review');
      await page.getByTestId('work-new-stage-submit').click();
      await expect(page.locator('.work-column').last()).toContainText('Legal review');

      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }

    // Local-first durability: restart the entire Electron app, not just React.
    const restarted = await launchApp({ userDataDir, home: 'keep' });
    const restartErrors = captureErrors(restarted.page);
    try {
      await restarted.page.getByTestId('rail-view-work').click();
      await expect(restarted.page.locator('.work-card')).toHaveCount(3);
      await expect(restarted.page.getByTestId('work-board')).toContainText(
        'Validate onboarding problem before Q4 planning',
      );
      await expect(restarted.page.getByTestId('work-board')).toContainText(
        'Run enterprise webinar follow-up campaign',
      );
      await expect(restarted.page.getByTestId('work-type-filter')).toContainText(
        'Customer escalation',
      );
      await expect(restarted.page.locator('.work-column').last()).toContainText('Legal review');

      // Real narrow desktop QA: board scrolls horizontally while chrome remains bounded.
      await restarted.page.setViewportSize({ width: 900, height: 760 });
      const compactClose = restarted.page.getByTestId('rail-compact-close');
      if (await compactClose.isVisible()) await compactClose.click();
      await expect(restarted.page.getByTestId('work-view')).toBeVisible();
      const overflow = await restarted.page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      writeFileSync(
        join(tmpdir(), 'charter-work-board-narrow.png'),
        await restarted.page.screenshot(),
      );
      expect(restartErrors).toEqual([]);
    } finally {
      await restarted.app.close();
    }
  });

  test('fires a real in-app reminder, snoozes durably, and routes back to the exact task', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    const errors = captureErrors(page);
    try {
      await page.getByTestId('rail-view-work').click();
      await page.getByTestId('work-new-item').click();
      await page.getByTestId('work-title').fill('Approve Monday partner announcement');
      await page
        .getByTestId('work-description')
        .fill('Confirm claims, partner attribution, and the exact scheduled payload.');
      await page.getByTestId('work-source-person').fill('Partner success lead');
      await page.getByTestId('work-priority').selectOption('urgent');
      const pastLocal = await page.evaluate(() => {
        const date = new Date(Date.now() - 60_000);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
      });
      await page.getByTestId('work-reminder-at').fill(pastLocal);
      await page.getByTestId('work-form-submit').click();

      // A due event can arrive while creation is still settling. Synchronize
      // with the durable detail selection before asserting that snooze keeps it.
      await expect(page.getByTestId('work-item-form')).toBeHidden();
      await expect(page.getByTestId('work-detail-title')).toHaveText(
        'Approve Monday partner announcement',
      );
      await expect(page.getByTestId('work-reminder-popup')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('work-reminder-popup')).toContainText(
        'Approve Monday partner announcement',
      );
      await page.getByTestId('work-reminder-snooze-10').click();
      await expect(page.getByTestId('work-reminder-popup')).toBeHidden();
      await expect(page.getByTestId('work-reminders')).toContainText('Snoozed');

      // A second immediately due reminder proves View routes from any surface.
      await page.getByTestId('work-detail-reminder-at').fill(pastLocal);
      await page
        .getByTestId('work-detail-reminder-message')
        .fill('Partner announcement still needs final approval');
      await page.getByTestId('work-detail-reminder-add').click();
      await expect(page.getByTestId('work-reminder-popup')).toBeVisible({ timeout: 10_000 });
      await page.getByTestId('rail-view-sessions').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('work-reminder-view').click();
      await expect(page.getByTestId('work-view')).toBeVisible();
      await expect(page.getByTestId('work-detail-title')).toHaveText(
        'Approve Monday partner announcement',
      );
      await expect(page.getByTestId('work-attention-filter')).toContainText('1');
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('hands a non-code work item to different agent sessions and keeps all executions together', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors = captureErrors(page);
    try {
      await page.getByTestId('rail-view-work').click();
      await createWork(page, {
        title: 'Draft and review customer advisory for billing migration',
        typeId: 'work-type-content',
        description:
          'Produce a customer-safe advisory, verify migration claims, and prepare the final publishing payload.',
        sourcePerson: 'Customer operations',
        sourceChannel: 'Billing migration war room',
        priority: 'high',
        acceptance:
          'Claims match the migration runbook\nLegal reviewer approves final copy\nPublishing payload is recorded',
        deliverables: 'Customer advisory\nReview notes\nFinal publishing payload',
        custom: {
          format: 'Customer advisory email',
          audience: 'Accounts migrating billing plans',
          approval_owner: 'Morgan · Legal',
        },
      });

      // First execution: the built-in Charter Agent receives the complete card context.
      await page.getByTestId('work-start-agent').click();
      await expect(page.getByTestId('home-intent')).toContainText(
        'Draft and review customer advisory for billing migration',
      );
      await expect(page.getByTestId('home-intent')).toContainText('Billing migration war room');
      await expect(page.getByTestId('home-adv-criteria')).toContainText(
        'Legal reviewer approves final copy',
      );
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-item-detail')).toBeVisible();
      await expect(page.getByTestId('work-executions')).toContainText('Charter Agent');

      // Second execution: a different installed agent gets the same context;
      // its native terminal is preserved and linked as an alternative attempt.
      await page.getByTestId('work-start-agent').click();
      await page.getByTestId('home-agent').click();
      await page.getByTestId('home-agent-codex').click();
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 20_000 });
      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-executions')).toContainText('Codex');
      await expect(page.locator('.work-execution-row')).toHaveCount(2);

      // Human review belongs in the same execution lineage instead of a note
      // pretending to be agent work.
      await page.getByTestId('work-link-execution').click();
      await expect(page.getByTestId('work-execution-picker')).toBeVisible();
      await page.getByTestId('work-execution-role').selectOption('reviewer');
      await page.getByTestId('work-execution-approach').fill('Legal and brand review');
      await page.getByTestId('work-manual-label').fill('Morgan · Legal reviewer');
      await page.getByTestId('work-link-manual').click();
      await expect(page.getByTestId('work-executions')).toContainText('Morgan · Legal reviewer');
      await expect(page.locator('.work-execution-row')).toHaveCount(3);

      // Session remains navigable from the card and Back returns to Work.
      await page
        .locator('.work-execution-row')
        .filter({ hasText: 'Charter Agent' })
        .locator('.work-execution-main')
        .click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('navigation-back').click();
      await expect(page.getByTestId('work-view')).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
