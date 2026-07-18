import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';

/**
 * M11-07 (PRIV-001..003): analytics needs the fields list before it can be
 * enabled; crash reports show a real redacted preview; the local-data panel
 * reports location + usage and deletes history with a two-step confirm. The
 * build has no upload transport, so the card says so plainly (rule 9 — no fake
 * "data is being sent").
 */
test.describe('M11-07 privacy settings', () => {
  test('fields gate, crash preview, honest transport note, and two-step delete', async () => {
    const { app, page } = await launchApp();
    try {
      await page.getByTestId('home-settings').click();
      await page.getByText('Privacy', { exact: true }).click();
      await expect(page.getByTestId('privacy-section')).toBeVisible();

      // Honest "no transport" statement is present (rule 9).
      await expect(page.getByTestId('privacy-section')).toContainText(
        'no telemetry or crash-report',
      );

      // PRIV-001: enabling analytics opens the fields list first.
      await page.getByTestId('privacy-analytics').click();
      await expect(page.getByTestId('privacy-modal')).toBeVisible();
      await expect(page.getByTestId('privacy-modal')).toContainText('would be sent');
      await expect(page.getByTestId('privacy-modal')).toContainText('Never sent');
      await page.getByTestId('privacy-fields-confirm').click();
      await expect(page.getByTestId('privacy-analytics')).toBeChecked();

      // PRIV-002: crash preview shows a real redacted sample.
      await page.getByTestId('privacy-crash-preview').click();
      await expect(page.getByTestId('privacy-crash-text')).toBeVisible();
      await expect(page.getByTestId('privacy-crash-text')).toContainText('Charter');
      await expect(page.getByTestId('privacy-modal')).toContainText('no crash-report upload');
      await page.getByTestId('privacy-crash-confirm').click();
      await expect(page.getByTestId('privacy-crash')).toBeChecked();

      // PRIV-003: local-data panel reports location + usage.
      await expect(page.getByTestId('privacy-data')).toBeVisible();
      await expect(page.getByTestId('privacy-data-dir')).not.toBeEmpty();

      // Two-step delete: first click arms, second confirms.
      await page.getByTestId('privacy-delete').click();
      const confirm = page.getByTestId('privacy-delete-confirm');
      await expect(confirm).toContainText('Delete history & cache');
      await confirm.click();
      await expect(confirm).toContainText('Click again');
      await confirm.click();
      await expect(page.getByTestId('privacy-modal')).toHaveCount(0);
      // A success toast confirms the deletion ran.
      await expect(page.locator('.toast')).toContainText(/Deleted/);
    } finally {
      await app.close();
    }
  });
});
