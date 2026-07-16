import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

const OUT = '/tmp/charter-room-conversation-qa';

test('task room prioritizes the conversation and folds execution metadata', async () => {
  test.setTimeout(120000);
  mkdirSync(OUT, { recursive: true });
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
    await page.getByTestId('home-mode-auto').click();
    await page
      .getByTestId('home-intent')
      .fill('[scenario:edit-basic] 把 src/index.ts 中的提示文字改得更清楚。');
    await page.getByTestId('home-submit').click();

    await expect(page.getByTestId('task-room')).toBeVisible();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });
    await expect(page.getByTestId('review-bar')).toBeVisible();

    const user = page.getByTestId('tl-user').first();
    const agent = page.getByTestId('tl-agent').last();
    await expect(user).toContainText('你');
    await expect(agent).toContainText('Charter');
    const positions = await Promise.all([user.boundingBox(), agent.boundingBox()]);
    expect(positions[0]).not.toBeNull();
    expect(positions[1]).not.toBeNull();
    expect(positions[0]!.x).toBeLessThan(positions[1]!.x);

    const presentation = await page.locator('.rt-col').evaluate((column) => {
      const pseudo = getComputedStyle(column, '::before');
      const userMessage = document.querySelector('[data-testid="tl-user"]');
      const agentMessage = document.querySelector('[data-testid="tl-agent"]');
      return {
        spineWidth: pseudo.width,
        spineContent: pseudo.content,
        userFont: userMessage ? getComputedStyle(userMessage).fontFamily : '',
        agentFont: agentMessage ? getComputedStyle(agentMessage).fontFamily : '',
      };
    });
    expect(presentation.spineWidth).not.toBe('1px');
    expect(presentation.spineContent).not.toBe('""');
    expect(presentation.agentFont).toBe(presentation.userFont);

    await expect(page.getByText('Explored the codebase', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Wrote a plan', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Worked', { exact: true })).toHaveCount(0);

    const context = page.getByTestId('tl-task-context').first();
    await expect(context).toContainText('未提供验收条件');
    await expect(user).not.toContainText('No acceptance criteria were provided');

    const plan = page.getByTestId('plan-card-static').first();
    const planToggle = plan.locator('button').first();
    await expect(planToggle).toHaveAttribute('aria-expanded', 'false');
    await planToggle.click();
    await expect(planToggle).toHaveAttribute('aria-expanded', 'true');
    await planToggle.focus();
    expect(await planToggle.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    );

    await expect(page.getByTestId('tl-usage')).toHaveCount(0);
    const details = page.getByTestId('tl-run-details');
    await expect(details).toBeVisible();
    await details.locator('summary').click();
    await expect(details).toContainText('Token');

    const activityToggle = page.getByTestId('tl-worklog-toggle').first();
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'false');
    await activityToggle.click();
    await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-testid^="tl-tool-"]').first()).toBeVisible();

    await expect(page.getByTestId('review-bar-open')).toContainText('查看改动');
    await expect(page.getByTestId('review-bar-accept')).toContainText('接受');
    await page.getByTestId('review-bar-open').click();
    await expect(page.getByTestId('review-view')).toBeVisible();
    await page.getByTestId('review-close').click();
    await expect(page.getByTestId('review-view')).toHaveCount(0);

    await activityToggle.click();
    await details.locator('summary').click();
    await planToggle.click();

    await page.screenshot({ path: `${OUT}/desktop.png` });

    await page.setViewportSize({ width: 900, height: 760 });
    await expect(page.getByTestId('task-room')).toBeVisible();
    const narrowOverflow = await page.locator('.tr-main').evaluate((main) => ({
      clientWidth: main.clientWidth,
      scrollWidth: main.scrollWidth,
    }));
    expect(narrowOverflow.scrollWidth).toBeLessThanOrEqual(narrowOverflow.clientWidth + 1);
    await page.screenshot({ path: `${OUT}/narrow.png` });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
