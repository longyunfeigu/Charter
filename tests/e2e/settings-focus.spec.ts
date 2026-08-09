import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';

async function modelPickerGeometry(page: Page): Promise<{
  canvasTop: number;
  canvasRight: number;
  popTop: number;
  popRight: number;
  effortBottom: number;
  listClientHeight: number;
  listScrollHeight: number;
} | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="home-view"]');
    const pop = document.querySelector<HTMLElement>('[data-testid="home-modeleffort-pop"]');
    const modelList = pop?.querySelector<HTMLElement>('.me-list');
    const effort = pop?.querySelector<HTMLElement>('.me-eff');
    if (!canvas || !pop || !modelList || !effort) return null;
    const canvasBox = canvas.getBoundingClientRect();
    const popBox = pop.getBoundingClientRect();
    const effortBox = effort.getBoundingClientRect();
    return {
      canvasTop: canvasBox.top,
      canvasRight: canvasBox.right,
      popTop: popBox.top,
      popRight: popBox.right,
      effortBottom: effortBox.bottom,
      listClientHeight: modelList.clientHeight,
      listScrollHeight: modelList.scrollHeight,
    };
  });
}

test.describe('Settings route and model picker focus', () => {
  test('long model picker stays inside the visible Home canvas', async () => {
    const { app, page } = await launchApp({
      home: 'keep',
      env: { PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.setViewportSize({ width: 1368, height: 737 });
      await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('home-model').click();
      const popover = page.getByTestId('home-modeleffort-pop');
      const list = popover.locator('.me-list');
      await expect(popover).toBeVisible();

      // The mock catalogue is intentionally small. Expand the rendered list
      // to the same long-menu geometry as a verified gateway without coupling
      // this layout regression to credentials or remote model discovery.
      await list.evaluate((element) => {
        const row = element.querySelector<HTMLElement>('.me-row');
        if (!row) throw new Error('model row fixture missing');
        for (let index = 0; index < 18; index += 1) {
          const clone = row.cloneNode(true) as HTMLElement;
          clone.removeAttribute('data-testid');
          clone.setAttribute('aria-checked', 'false');
          clone.classList.remove('on');
          const name = clone.querySelector<HTMLElement>('.mname');
          if (name) name.textContent = `Verified model ${index + 2}`;
          element.appendChild(clone);
        }
      });

      const geometry = await modelPickerGeometry(page);
      expect(geometry).not.toBeNull();
      expect(geometry!.popTop).toBeGreaterThanOrEqual(geometry!.canvasTop + 7);
      expect(geometry!.popRight).toBeLessThanOrEqual(geometry!.canvasRight);
      expect(geometry!.effortBottom).toBeLessThanOrEqual(737);
      expect(geometry!.listScrollHeight).toBeGreaterThan(geometry!.listClientHeight);
      await page.screenshot({ path: '/tmp/charter-model-picker-visible-boundary.png' });

      await page.setViewportSize({ width: 980, height: 650 });
      await expect
        .poll(async () => {
          const next = await modelPickerGeometry(page);
          return next ? Math.floor(next.popTop - next.canvasTop) : -1;
        })
        .toBeGreaterThanOrEqual(7);
      const compactGeometry = await modelPickerGeometry(page);
      expect(compactGeometry).not.toBeNull();
      expect(compactGeometry!.popRight).toBeLessThanOrEqual(compactGeometry!.canvasRight);
      expect(compactGeometry!.effortBottom).toBeLessThanOrEqual(650);
      expect(compactGeometry!.listScrollHeight).toBeGreaterThan(compactGeometry!.listClientHeight);
      await page.screenshot({ path: '/tmp/charter-model-picker-visible-boundary-compact.png' });
    } finally {
      await app.close();
    }
  });

  test('Escape and Back return routed Settings to the opener', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      const model = page.getByTestId('home-model');
      await expect(model).toContainText('No model', { timeout: 15_000 });
      await model.click();
      await expect(page.getByTestId('home-modeleffort-pop')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('home-modeleffort-pop')).toHaveCount(0);
      await expect(model).toBeFocused();

      await model.click();
      await page.getByTestId('home-model-settings').click();
      const settingsPage = page.getByTestId('settings-page');
      await expect(settingsPage).toBeVisible();
      await expect(page.getByTestId('settings-section-models')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByTestId('settings-back')).toBeFocused();
      await expect(page.locator('.modal-backdrop')).toHaveCount(0);
      await expect(page.getByTestId('home-view')).toBeHidden();

      await page.keyboard.press('Escape');
      await expect(settingsPage).toHaveCount(0);
      await expect(model).toBeFocused();

      const settings = page.getByTestId('home-settings');
      await settings.click();
      await page.getByTestId('settings-back').click();
      await expect(page.getByTestId('settings-page')).toHaveCount(0);
      await expect(settings).toBeFocused();
    } finally {
      await app.close();
    }
  });
});
