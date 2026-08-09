import { expect, test } from '@playwright/test';
import { realpathSync } from 'node:fs';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

// User-found regression (2026-08-09): removing a project from the rail left
// its detail pane open on the right, still rendering the forgotten project.
test.describe('project removal', () => {
  test('removing a project closes its open detail pane', async () => {
    const fixture = realpathSync(createTsSmallFixture());
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('rail-view-projects').click();
      await page.getByTestId(`project-menu-${fixture}`).click();
      await page.getByTestId(`project-history-${fixture}`).click();
      await expect(page.getByTestId('project-center-sessions')).toBeVisible();

      await page.getByTestId(`project-menu-${fixture}`).click();
      await page.getByTestId(`project-remove-${fixture}`).click();
      await expect(page.getByTestId('project-center-sessions')).toHaveCount(0);
      await expect(page.getByTestId('project-center-overview')).toHaveCount(0);
      await expect(page.getByTestId(`project-menu-${fixture}`)).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
