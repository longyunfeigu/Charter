import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

const root = join(__dirname, '../../..');

/** Launch the packaged-mode app (app:// protocol, production CSP) with an isolated user-data dir. */
export async function launchApp(
  options: { userDataDir?: string; env?: Record<string, string> } = {},
): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'pi-ide-e2e-'));
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    env: {
      ...process.env,
      PI_IDE_USER_DATA: userDataDir,
      PI_IDE_E2E: '1',
      ...options.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userDataDir };
}
