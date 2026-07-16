import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('Ghostty-inspired quick console', () => {
  test('adapts its chrome to every skin while keeping one stable terminal canvas', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const rendererErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page).toHaveTitle('Charter');
      expect(page.url()).toMatch(/^app:\/\//);
      await page.getByTestId('surface-home').click();
      await expect(page.locator('#root')).not.toBeEmpty();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.keyboard.press('Alt+Space');
      const quick = page.getByTestId('quick-console');
      await expect(quick).toBeVisible();
      await expect(page.locator('[data-testid="quick-console-terminal"] .xterm')).toBeVisible({
        timeout: 15000,
      });
      await quick.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });

      const skins = ['studio', 'terminal', 'archive', 'index'] as const;
      const chrome = new Map<
        (typeof skins)[number],
        { head: string; canvas: string; radius: string; font: string }
      >();
      for (const skin of skins) {
        await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = 'light';
        }, skin);
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
        chrome.set(
          skin,
          await page.evaluate(() => {
            const panel = document.querySelector<HTMLElement>('.quick-console')!;
            const head = document.querySelector<HTMLElement>('.quick-console-head')!;
            const canvas = document.querySelector<HTMLElement>('.quick-console-terminal')!;
            return {
              head: getComputedStyle(head).backgroundColor,
              canvas: getComputedStyle(canvas).backgroundColor,
              radius: getComputedStyle(panel).borderBottomRightRadius,
              font: getComputedStyle(head).fontFamily,
            };
          }),
        );
        if (process.env.PI_IDE_QA_SCREENSHOT) {
          await page.screenshot({ path: `/tmp/quick-console-skin-${skin}.png` });
        }
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
        });
        const darkChrome = await page.evaluate(() => {
          const head = document.querySelector<HTMLElement>('.quick-console-head')!;
          const canvas = document.querySelector<HTMLElement>('.quick-console-terminal')!;
          return {
            head: getComputedStyle(head).backgroundColor,
            canvas: getComputedStyle(canvas).backgroundColor,
          };
        });
        expect(darkChrome.head).not.toBe(chrome.get(skin)?.head);
        expect(darkChrome.canvas).toBe('rgb(36, 35, 31)');
      }

      expect(new Set([...chrome.values()].map((value) => value.head)).size).toBe(4);
      expect(new Set([...chrome.values()].map((value) => value.canvas))).toEqual(
        new Set(['rgb(36, 35, 31)']),
      );
      expect(chrome.get('studio')?.radius).toBe('14px');
      expect(chrome.get('archive')?.radius).toBe('10px');
      expect(chrome.get('terminal')?.radius).toBe('3px');
      expect(chrome.get('index')?.radius).toBe('0px');
      expect(new Set([...chrome.values()].map((value) => value.font)).size).toBeGreaterThan(2);

      await page.keyboard.press('Escape');
      await expect(quick).not.toBeVisible();
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('persists one PTY across surfaces and sends terminal output into the current Room', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-ask').click();
      await page.getByTestId('home-intent').fill('[scenario:ask-basic] quick console room');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('tl-agent').first()).toBeVisible({ timeout: 30000 });

      const roomInput = page.getByTestId('agent-input');
      await roomInput.click();
      await page.keyboard.press('Alt+Space');
      const quick = page.getByTestId('quick-console');
      await expect(quick).toBeVisible();
      await expect(page.getByTestId('quick-console-context')).toContainText(
        fixture.split('/').pop()!,
      );
      await expect(page.locator('[data-testid="quick-console-terminal"] .xterm')).toBeVisible({
        timeout: 15000,
      });
      await page.keyboard.type("printf '__quick-console-ready__\\n'");
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('quick-console-terminal')).toContainText(
        '__quick-console-ready__',
      );

      await page.getByTestId('quick-console-context').click();
      await expect(page.getByTestId('quick-console-context-menu')).toBeVisible();
      await page.getByTestId('quick-console-context-scratch').click();
      await expect(page.getByTestId('quick-console-context')).toContainText('Scratch');

      await page.keyboard.type("printf 'quick-console-output-marker\\n'");
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('quick-console-terminal')).toContainText(
        'quick-console-output-marker',
        { timeout: 15000 },
      );
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/quick-console-implementation.png' });
        await page.setViewportSize({ width: 760, height: 740 });
        await page.screenshot({ path: '/tmp/quick-console-mobile.png' });
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      await page.keyboard.press('Escape');
      await expect(quick).not.toBeVisible();
      await expect(roomInput).toBeFocused();
      await page.keyboard.press('Alt+Space');
      await expect(quick).toBeVisible();
      await expect(page.getByTestId('quick-console-terminal')).toContainText(
        'quick-console-output-marker',
      );

      await page.getByTestId('quick-console-terminal').click({ button: 'right' });
      await expect(page.getByTestId('quick-console-output-menu')).toBeVisible();
      await page.getByTestId('quick-console-send-room').click();
      await expect(quick).not.toBeVisible();
      await expect(page.getByTestId('room-terminal-refs')).toContainText('速召台输出');
      await expect(page.getByTestId('agent-send')).toBeEnabled();
      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/quick-console-room-ref.png' });
      }

      await page.getByTestId('agent-send').click();
      await expect(page.getByTestId('room-terminal-refs')).toHaveCount(0);
      await expect(page.getByTestId('tl-user').last()).toContainText(
        'quick-console-output-marker',
        {
          timeout: 30000,
        },
      );

      // The quick session is not hidden infrastructure: it lives in the dock,
      // and closing it follows Ghostty's five-second undo-close contract.
      await page.keyboard.press('Control+Backquote');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      const quickTab = page
        .locator('[data-testid^="terminal-tab-"]')
        .filter({ hasText: '⌥ quick' });
      await expect(quickTab).toBeVisible();
      await expect(page.getByTestId('terminal-host')).toContainText('quick-console-output-marker');
      await quickTab.getByRole('button', { name: 'Close ⌥ quick' }).click();
      await expect(quickTab).toHaveCount(0);
      await expect(page.locator('.toasts')).toContainText('保活 5 秒');
      await page.keyboard.press(`${mod}+z`);
      await expect(quickTab).toBeVisible();
      await expect(page.getByTestId('terminal-host')).toContainText('quick-console-output-marker');
    } finally {
      await app.close();
    }
  });
});
