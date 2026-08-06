import {
  _electron as electron,
  chromium,
  type Browser,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
}

export interface LaunchedPackagedApp {
  browser: Browser;
  page: Page;
  process: ChildProcessWithoutNullStreams;
  userDataDir: string;
  output: () => string;
  close: () => Promise<void>;
}

const root = join(__dirname, '../../..');

/**
 * Most renderer specs exercise the complete Agent catalog without invoking a
 * real third-party CLI. Hosted runners intentionally have neither Claude nor
 * Codex installed, so give those specs inert executables instead of making
 * catalog coverage depend on the developer machine that happens to run them.
 * Specs that provide their own PATH still win because their bins are searched
 * before this fallback directory.
 */
function createCatalogAgentBins(userDataDir: string): string {
  const bin = join(userDataDir, 'e2e-agent-bin');
  mkdirSync(bin, { recursive: true });
  for (const agent of ['claude', 'codex']) {
    const executable = join(bin, agent);
    writeFileSync(
      executable,
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${agent} e2e fixture ready`)});`,
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 60_000);',
        '',
      ].join('\n'),
    );
    chmodSync(executable, 0o755);
  }
  return bin;
}

export function packagedExecutablePath(): string {
  const explicit = process.env.CHARTER_PACKAGED_EXECUTABLE;
  if (explicit) return explicit;
  const candidates =
    process.platform === 'darwin'
      ? [
          join(root, 'release/mac-arm64/Charter.app/Contents/MacOS/Charter'),
          join(root, 'release/mac/Charter.app/Contents/MacOS/Charter'),
        ]
      : process.platform === 'win32'
        ? [join(root, 'release/win-unpacked/Charter.exe')]
        : [join(root, 'release/linux-unpacked/charter')];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Packaged Charter executable not found. Checked: ${candidates.join(', ')}. Run npm run package first.`,
    );
  }
  return found;
}

/** Launch the packaged-mode app (app:// protocol, production CSP) with an isolated user-data dir. */
export async function launchApp(
  options: {
    userDataDir?: string;
    env?: Record<string, string | undefined>;
    /** Dual-form shell: 'dismiss' (default) lands tests in the IDE surface; 'keep' stays on Home. */
    home?: 'dismiss' | 'keep';
    /** Record a video of the run (demo/evidence captures). */
    recordVideo?: { dir: string; size?: { width: number; height: number } };
  } = {},
): Promise<LaunchedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'pi-ide-e2e-'));
  const catalogAgentBin = createCatalogAgentBins(userDataDir);
  const inheritedPath = options.env?.PATH ?? process.env.PATH ?? '';
  const app = await electron.launch({
    args: ['.'],
    cwd: root,
    recordVideo: options.recordVideo,
    env: {
      ...process.env,
      PI_IDE_USER_DATA: userDataDir,
      PI_IDE_E2E: '1',
      PATH: `${inheritedPath}${delimiter}${catalogAgentBin}`,
      ...options.env,
    },
  });
  // Drain main-process stdio. The pipes are never consumed otherwise, so once
  // the 64KB kernel buffer fills, every console.log in main BLOCKS the event
  // loop — the app half-freezes mid-test (events stop broadcasting) and specs
  // fail in ways that track total log volume, not the code under test.
  app.process().stdout?.resume();
  app.process().stderr?.resume();

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Deterministic viewport: hosted CI displays are smaller than the product's
  // default bounds (GitHub macOS runners emulate ~1176×885), so macOS clamps
  // the window at creation and the cramped layout overlaps panes. PI_IDE_E2E
  // sets enableLargerThanScreen in main; size the window explicitly here.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  });

  if (options.home !== 'keep') {
    if (options.env?.PI_IDE_OPEN_WORKSPACE) {
      // Opening a workspace auto-switches to the IDE surface (PIVOT-006).
      await page
        .getByTestId('home-view')
        .waitFor({ state: 'hidden', timeout: 15000 })
        .catch(() => undefined);
    } else {
      // ADR-0008 entry consolidation: the sidebar "Editor" row is the way in.
      const enter = page.getByTestId('home-open-ide');
      await enter.waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined);
      if (await enter.isVisible().catch(() => false)) {
        await enter.click().catch(() => undefined);
      }
    }
  }
  return { app, page, userDataDir };
}

/** Launch the actual electron-builder output, never the repository Electron shim. */
export async function launchPackagedApp(
  options: {
    executablePath?: string;
    userDataDir?: string;
    env?: Record<string, string>;
  } = {},
): Promise<LaunchedPackagedApp> {
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'charter-packaged-e2e-'));
  const executablePath = options.executablePath ?? packagedExecutablePath();
  const child = spawn(executablePath, ['--remote-debugging-port=0'], {
    cwd: root,
    env: {
      ...process.env,
      PI_IDE_USER_DATA: userDataDir,
      PI_IDE_E2E: '1',
      ...options.env,
    },
  });
  let output = '';
  const devtoolsUrl = await new Promise<string>((resolveUrl, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Packaged app did not expose DevTools within 30s.\n${output}`));
    }, 30_000);
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-20_000);
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      const url = match?.[1];
      if (url) {
        clearTimeout(timeout);
        resolveUrl(url);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(`Packaged app exited before DevTools was ready (${code ?? signal}).\n${output}`),
      );
    });
  });
  const browser = await chromium.connectOverCDP(devtoolsUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error(`Packaged app exposed no browser context.\n${output}`);
  const page = context.pages()[0] ?? (await context.waitForEvent('page'));
  await page.waitForLoadState('domcontentloaded');
  const enter = page.getByTestId('home-open-ide');
  await enter.waitFor({ state: 'visible', timeout: 4000 }).catch(() => undefined);
  if (await enter.isVisible().catch(() => false)) await enter.click();
  return {
    browser,
    page,
    process: child,
    userDataDir,
    output: () => output,
    close: async () => {
      await browser.close().catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolveExit) => {
          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolveExit();
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timeout);
            resolveExit();
          });
        });
      }
    },
  };
}
