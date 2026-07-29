import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

test.describe('application updates', () => {
  test('unsigned preview checks releases and offers the manual download path', async () => {
    const { app, page } = await launchApp({
      home: 'keep',
      env: { PI_IDE_E2E_UPDATE_STATE: 'available' },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const notice = page.getByTestId('update-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Charter 1.1.0-beta.1');
      await expect(page.getByTestId('update-notice-download')).toHaveText('View & download');

      // Update notices are actionable state, not ordinary four-second feedback.
      await page.waitForTimeout(4_200);
      await expect(notice).toBeVisible();

      await page.getByTestId('update-notice-open-settings').click();
      await expect(notice).toHaveCount(0);

      await expect(page.getByTestId('updates-status')).toBeVisible();
      await expect(page.getByTestId('updates-phase')).toHaveText('Update available');
      await expect(page.getByText('1.1.0-beta.1', { exact: true })).toBeVisible();
      await expect(page.getByTestId('updates-open-download')).toBeVisible();
      await expect(page.getByTestId('updates-install')).toHaveCount(0);
      await expect(page.getByTestId('updates-check')).toBeEnabled();

      await page.getByTestId('updates-channel').selectOption('beta');
      await expect(page.getByTestId('updates-channel')).toHaveValue('beta');
      await page.getByTestId('updates-auto-check').uncheck();
      await expect(page.getByTestId('updates-auto-check')).not.toBeChecked();
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('downloaded signed update remains usable at a narrower desktop viewport', async () => {
    const { app, page } = await launchApp({
      home: 'keep',
      env: { PI_IDE_E2E_UPDATE_STATE: 'downloaded' },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1060, height: 720 });
      });

      const notice = page.getByTestId('update-notice');
      await expect(notice).toBeVisible();
      await expect(page.getByTestId('update-notice-later')).toBeVisible();
      await expect(page.getByTestId('update-notice-install')).toHaveText('Restart & install');
      await expect(notice).toBeInViewport();
      await page.screenshot({ path: '/tmp/charter-update-notice-narrow.png' });

      await page.getByTestId('update-notice-later').click();
      await expect(notice).toHaveCount(0);

      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-updates').click();

      await expect(page.getByTestId('updates-phase')).toHaveText('Ready to install');
      await expect(page.getByTestId('updates-install')).toBeVisible();
      await expect(page.getByTestId('updates-status')).toBeInViewport();
      await page.screenshot({ path: '/tmp/charter-updates-narrow.png' });
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('restart action handles a downloaded update explicitly', async () => {
    const { app, page } = await launchApp({
      home: 'keep',
      env: { PI_IDE_E2E_UPDATE_STATE: 'downloaded' },
    });

    try {
      const notice = page.getByTestId('update-notice');
      await expect(notice).toBeVisible();
      await page.getByTestId('update-notice-install').click();
      await expect(notice).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
