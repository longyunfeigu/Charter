import { expect, test } from '@playwright/test';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

test.describe('Signal Desk product visual structure', () => {
  test('keeps the product identity unmistakable across wide and narrow Electron layouts', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.locator('.tb-brand-lockup')).toContainText('Agent operations');
      await expect(page.getByTestId('rail-view-sessions')).toContainText('Sessions');
      await expect(page.getByTestId('rail-view-missions')).toContainText('Missions');
      await expect(page.locator('.hm-eyebrow')).toHaveText(/New session brief/i);
      await expect(page.locator('.hm-hero h1')).toHaveText('What should we build?');
      await expect(page.getByTestId('home-intent')).toBeVisible();
      await expect(page.locator('.titlebar')).toHaveCSS('height', '52px');
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '312px');
      await expect(page.locator('.sr-activity')).toHaveCSS('width', '78px');

      const skinChrome = await page.evaluate(() => {
        const titlebar = document.querySelector<HTMLElement>('.titlebar')!;
        const activity = document.querySelector<HTMLElement>('.sr-activity')!;
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg-titlebar)';
        document.body.append(probe);
        const result = {
          titlebar: getComputedStyle(titlebar).backgroundColor,
          activity: getComputedStyle(activity).backgroundColor,
          skinTitlebar: getComputedStyle(probe).backgroundColor,
          color: getComputedStyle(titlebar).color,
        };
        probe.remove();
        return result;
      });
      expect(skinChrome.titlebar).toBe(skinChrome.skinTitlebar);
      expect(skinChrome.activity).toBe(skinChrome.skinTitlebar);
      expect(skinChrome.color).not.toBe(skinChrome.titlebar);
      await page.screenshot({ path: '/tmp/charter-signal-desk-home-wide.png' });

      const skinBackgrounds: string[] = [];
      for (const skin of ['studio', 'archive', 'atelier', 'terminal', 'index']) {
        const resolved = await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = 'light';
          const titlebar = document.querySelector<HTMLElement>('.titlebar')!;
          const activity = document.querySelector<HTMLElement>('.sr-activity')!;
          const probe = document.createElement('div');
          probe.style.background = 'var(--bg-titlebar)';
          document.body.append(probe);
          const result = {
            titlebar: getComputedStyle(titlebar).backgroundColor,
            activity: getComputedStyle(activity).backgroundColor,
            skinTitlebar: getComputedStyle(probe).backgroundColor,
          };
          probe.remove();
          return result;
        }, skin);
        expect(resolved.titlebar).toBe(resolved.skinTitlebar);
        expect(resolved.activity).toBe(resolved.skinTitlebar);
        skinBackgrounds.push(resolved.titlebar);
        await page.screenshot({ path: `/tmp/charter-signal-desk-${skin}-light.png` });
      }
      expect(new Set(skinBackgrounds).size).toBe(5);
      await page.evaluate(() => {
        document.documentElement.dataset.skin = 'studio';
        document.documentElement.dataset.theme = 'light';
      });

      await page.getByTestId('rail-view-skills').click();
      await expect(page.getByTestId('skills-main-page')).toBeVisible();
      await expect(page.locator('.skills-page-head')).toContainText('Skills');
      await page.screenshot({ path: '/tmp/charter-signal-desk-skills-wide.png' });

      await page.getByTestId('rail-view-memory').click();
      await expect(page.getByTestId('memory-rail-panel')).toBeVisible();
      await expect(page.getByTestId('memory-view')).toBeVisible();
      await expect(page.getByTestId('surface-home')).toContainText('Memory');
      await expect(page.getByTestId('surface-home')).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('rail-view-memory')).toHaveClass(/active/);
      await expect(page.getByTestId('overlay-memory')).toHaveCount(0);
      await expect(page.locator('.modal-backdrop')).toHaveCount(0);
      await page.screenshot({ path: '/tmp/charter-signal-desk-memory-wide.png' });

      // Every primary destination replaces the complete contextual workspace;
      // nothing from the previous page remains layered into the titlebar or main area.
      await page.getByTestId('rail-view-remotes').click();
      await expect(page.getByTestId('remote-explorer-rail')).toBeVisible();
      await expect(page.getByTestId('surface-home')).toContainText('Remote Explorer');
      await expect(page.getByTestId('memory-view')).toHaveCount(0);
      await expect(page.locator('.tb-history-origin')).toHaveCount(0);
      await expect(page.getByTestId('workspace-chip')).toHaveCount(0);

      await page.getByTestId('rail-view-memory').click();
      await expect(page.getByTestId('memory-rail-panel')).toBeVisible();
      await expect(page.getByTestId('memory-view')).toBeVisible();
      await expect(page.getByTestId('remote-explorer-rail')).toHaveCount(0);

      await page.getByTestId('rail-view-sessions').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.setViewportSize({ width: 960, height: 720 });
      await expect(page.locator('.sr-rail')).toHaveCSS('width', '78px');
      await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
      await expect(page.getByTestId('rail-view-sessions')).toContainText('Sessions');
      await page.screenshot({ path: '/tmp/charter-signal-desk-home-narrow.png' });

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
