import { test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

/** TEMP visual check — "Open in Browser" in the explorer context menu.
 * Gated behind CHARTER_SHOTS; screenshots to /tmp/ui-shots/open-in-browser-*.png. */
test.skip(!process.env.CHARTER_SHOTS, 'set CHARTER_SHOTS=1 to capture');

const OUT = '/tmp/ui-shots';

test('explorer context menu — html vs non-html', async () => {
  test.setTimeout(120000);
  const fixture = createTsSmallFixture();
  writeFileSync(join(fixture, 'index.html'), '<!doctype html><title>shot page</title>\n');
  const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
  try {
    await page.getByTestId('tree-item-index.html').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in Browser' }).waitFor();
    await page.screenshot({ path: join(OUT, 'open-in-browser-html.png') });
    await page.locator('.overlay-backdrop').click();
    await page.locator('.overlay-backdrop').waitFor({ state: 'detached' });
    await page.getByTestId('tree-item-README.md').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename…' }).waitFor();
    await page.screenshot({ path: join(OUT, 'open-in-browser-md.png') });
  } finally {
    await app.close();
  }
});
