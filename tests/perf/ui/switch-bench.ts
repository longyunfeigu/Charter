/**
 * Session-switch latency bench (ADR-0055 evidence harness).
 *
 * Two heavy 400-event transcripts (A and B); measures, in one app instance:
 *   - coldA / coldB: first open of each room (fetch + full build)
 *   - warmA / warmB / warmA2: switching back to an already-visited room
 *
 * "Open" is timed from the rail click until the OTHER task's content marker
 * disappears AND this task's marker is visible in the transcript — i.e. the
 * user can actually read the right conversation.
 *
 * Run:  npx tsx tests/perf/ui/switch-bench.ts --label <name> --runs 3
 * Output: tests/perf/ui/results/<label>-switch-<run>.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { launchApp } from '../../e2e/helpers/launch';
import { createTsSmallFixture } from '../../e2e/helpers/fixtures';
import { seedTranscript } from './seed-lib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function createTask(page: Page, title: string): Promise<void> {
  await page.getByTestId('surface-home').click();
  await page.getByTestId('home-advanced-toggle').click();
  await page.getByTestId('home-adv-title').fill(title);
  await page.getByTestId('home-intent').fill(`[scenario:ask-basic] Describe ${title}.`);
  await page.getByTestId('home-mode-ask').click();
  await page.getByTestId('home-submit').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="task-state"]')?.getAttribute('data-state') === 'IDLE',
    undefined,
    { timeout: 30000 },
  );
}

/** Ms from rail click until the target marker is readable in the transcript. */
async function timedSwitch(page: Page, taskId: string, marker: string): Promise<number> {
  const start = performance.now();
  await page.getByTestId(`home-task-${taskId}`).click();
  await page.waitForFunction(
    (text) =>
      document.querySelector('[data-testid="timeline"]')?.textContent?.includes(text as string) ??
      false,
    marker,
    { timeout: 120000, polling: 'raf' },
  );
  return Math.round(performance.now() - start);
}

async function main(): Promise<void> {
  const label = arg('label', 'switch');
  const runs = Number(arg('runs', '3'));
  mkdirSync(RESULTS_DIR, { recursive: true });

  for (let run = 1; run <= runs; run++) {
    const fixture = createTsSmallFixture();
    const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-e2e-switch-'));
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ general: { skin: 'atelier' } }),
    );

    // Pass 1: create two tasks, then seed both transcripts offline.
    const first = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await createTask(first.page, 'Switch bench A');
      await createTask(first.page, 'Switch bench B');
    } finally {
      await first.app.close();
    }
    const dbPath = join(userDataDir, 'app.db');
    const [taskB, taskA] = execFileSync('sqlite3', [
      dbPath,
      'SELECT id FROM tasks ORDER BY created_at DESC LIMIT 2;',
    ])
      .toString()
      .trim()
      .split('\n') as [string, string];
    seedTranscript(dbPath, taskA, 'alpha', RESULTS_DIR);
    seedTranscript(dbPath, taskB, 'beta', RESULTS_DIR);
    // Last agent.message in the seed sequence (399 is a user turn).
    const markerA = 'alpha analysis step 398';
    const markerB = 'beta analysis step 398';

    // Pass 2: measure cold opens and warm switches.
    const second = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const { page } = second;
      await second.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1720, height: 1000 });
      });
      await page.getByTestId(`home-task-${taskA}`).waitFor({ state: 'visible', timeout: 15000 });

      const result: Record<string, unknown> = { label, run, at: new Date().toISOString() };
      result.coldA = await timedSwitch(page, taskA, markerA);
      await page.waitForTimeout(1500); // colorize settle
      result.coldB = await timedSwitch(page, taskB, markerB);
      await page.waitForTimeout(1500);
      result.warmA = await timedSwitch(page, taskA, markerA);
      await page.waitForTimeout(500);
      result.warmB = await timedSwitch(page, taskB, markerB);
      await page.waitForTimeout(500);
      result.warmA2 = await timedSwitch(page, taskA, markerA);

      const outFile = join(RESULTS_DIR, `${label}-switch-${run}.json`);
      writeFileSync(outFile, JSON.stringify(result, null, 2));
      console.log(`[switch] ${JSON.stringify(result)}`);
    } finally {
      await second.app.close();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
