import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

const SKINS = ['studio', 'terminal', 'archive', 'index', 'atelier', 'codex'] as const;

test.describe('Work board theme integration', () => {
  test('inherits material, typography, geometry and state colors from every application skin', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    const rendererErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    page.on('pageerror', (error) => rendererErrors.push(error.message));

    try {
      await page.setViewportSize({ width: 2048, height: 1064 });
      await page.getByTestId('rail-view-work').click();
      await expect(page.getByTestId('work-view')).toBeVisible();

      await page.getByTestId('work-new-item').click();
      await page.getByTestId('work-title').fill('Theme integration proof');
      await page.getByTestId('work-priority').click();
      await page.getByTestId('work-priority-medium').click();
      await page.getByTestId('work-page-back').click();
      await expect(page.getByTestId('work-detail-title')).toHaveText('Theme integration proof');
      await page.getByTestId('work-detail-close').click();
      await expect(page.locator('.work-card')).toHaveCount(1);

      const canvasColors = new Set<string>();
      for (const skin of SKINS) {
        await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = 'light';
        }, skin);
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin);

        const resolved = await page.evaluate(() => {
          const root = document.documentElement;
          const rootStyle = getComputedStyle(root);
          const probe = document.createElement('div');
          probe.style.position = 'fixed';
          probe.style.visibility = 'hidden';
          document.body.append(probe);
          const tokenColor = (name: string): string => {
            probe.style.background = `var(${name})`;
            return getComputedStyle(probe).backgroundColor;
          };
          const tokenFont = (): string => {
            probe.style.fontFamily = 'var(--font-ui)';
            return getComputedStyle(probe).fontFamily;
          };
          const view = document.querySelector<HTMLElement>('.work-view')!;
          const header = document.querySelector<HTMLElement>('.work-header')!;
          const card = document.querySelector<HTMLElement>('.work-card')!;
          const primary = document.querySelector<HTMLElement>('.work-header-actions .primary')!;
          const control = document.querySelector<HTMLElement>('.work-search')!;
          const result = {
            canvasToken: tokenColor('--bg-editor'),
            canvasActual: getComputedStyle(view).backgroundColor,
            headerToken: tokenColor('--bg-titlebar'),
            headerActual: getComputedStyle(header).backgroundColor,
            cardToken: tokenColor('--bg-card'),
            cardActual: getComputedStyle(card).backgroundColor,
            accentToken: tokenColor('--accent'),
            primaryActual: getComputedStyle(primary).backgroundColor,
            cardRadiusToken: rootStyle.getPropertyValue('--radius-card').trim(),
            cardRadiusActual: getComputedStyle(card).borderTopLeftRadius,
            controlRadiusToken: rootStyle.getPropertyValue('--radius-chip').trim(),
            controlRadiusActual: getComputedStyle(control).borderTopLeftRadius,
            fontToken: tokenFont(),
            fontActual: getComputedStyle(view).fontFamily,
            atelierTextureOpacity: getComputedStyle(document.body, '::after').opacity,
          };
          probe.remove();
          return result;
        });

        expect(resolved.canvasActual).toBe(resolved.canvasToken);
        expect(resolved.headerActual).toBe(resolved.headerToken);
        expect(resolved.cardActual).toBe(resolved.cardToken);
        expect(resolved.primaryActual).toBe(resolved.accentToken);
        expect(resolved.cardRadiusActual).toBe(resolved.cardRadiusToken);
        expect(resolved.controlRadiusActual).toBe(resolved.controlRadiusToken);
        expect(resolved.fontActual).toBe(resolved.fontToken);
        if (skin === 'atelier') expect(resolved.atelierTextureOpacity).not.toBe('0');
        canvasColors.add(resolved.canvasActual);
        await page.screenshot({ path: `/tmp/charter-work-theme-${skin}.png` });
      }
      expect(canvasColors.size).toBe(6);

      for (const skin of SKINS) {
        await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = 'dark';
        }, skin);
        const darkSurfaces = await page.evaluate(() => {
          const probe = document.createElement('div');
          document.body.append(probe);
          const tokenColor = (name: string): string => {
            probe.style.background = `var(${name})`;
            return getComputedStyle(probe).backgroundColor;
          };
          const result = {
            canvasToken: tokenColor('--bg-editor'),
            canvasActual: getComputedStyle(document.querySelector<HTMLElement>('.work-view')!)
              .backgroundColor,
            cardToken: tokenColor('--bg-card'),
            cardActual: getComputedStyle(document.querySelector<HTMLElement>('.work-card')!)
              .backgroundColor,
          };
          probe.remove();
          return result;
        });
        expect(darkSurfaces.canvasActual).toBe(darkSurfaces.canvasToken);
        expect(darkSurfaces.cardActual).toBe(darkSurfaces.cardToken);
        if (skin === 'codex') {
          await page.screenshot({ path: '/tmp/charter-work-theme-codex-dark.png' });
        }
      }

      await page.evaluate(() => {
        document.documentElement.dataset.skin = 'atelier';
        document.documentElement.dataset.theme = 'light';
      });
      await page.setViewportSize({ width: 1080, height: 720 });
      await expect(page.getByTestId('work-view')).toBeVisible();
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: '/tmp/charter-work-theme-atelier-narrow.png' });
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
