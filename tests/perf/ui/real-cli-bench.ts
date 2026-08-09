/**
 * Real-CLI end-to-end performance validation (tuned build).
 *
 * Drives the REAL `claude` CLI (and a `codex` probe when present) through the
 * embedded PTY exactly like a user session, then measures the same frame and
 * renderer-work metrics as scroll-bench.ts on the live surfaces:
 *   - claudeStream: frames while the real model turn streams into the PTY
 *   - roomIdle / roomScroll: the accounted session's room after it ends
 *
 * This intentionally spends one cheap real model call (haiku, print mode) on
 * the operator's own credentials — it validates the true detection →
 * accounting → room → replay pipeline, not a simulation of it.
 *
 * Run:  npx tsx tests/perf/ui/real-cli-bench.ts
 * Output: tests/perf/ui/results/real-cli.json + screenshots + video
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { launchApp } from '../../e2e/helpers/launch';
import { createGitFixture } from '../../e2e/helpers/fixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const SHOTS = join(RESULTS_DIR, 'real');

const COLLECTOR = {
  start: `(() => {
    const state = { deltas: [], longTasks: [], running: true, last: 0 };
    window.__benchState = state;
    const loop = (t) => {
      if (!state.running) return;
      if (state.last > 0) state.deltas.push(t - state.last);
      state.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      state.obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      });
      state.obs.observe({ entryTypes: ['longtask'] });
    } catch {}
  })()`,
  stop: `(() => {
    const state = window.__benchState;
    state.running = false;
    state.obs && state.obs.disconnect();
    return { deltas: state.deltas, longTasks: state.longTasks };
  })()`,
};

function stats(raw: { deltas: number[]; longTasks: number[] }): Record<string, number> {
  const deltas = raw.deltas.slice(5);
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const r = (n: number): number => Math.round(n * 100) / 100;
  return {
    frames: deltas.length,
    avgMs: r(avg),
    p95Ms: r(pct(0.95)),
    p99Ms: r(pct(0.99)),
    maxMs: r(sorted[sorted.length - 1] ?? 0),
    pctOver17: r((100 * deltas.filter((d) => d > 17).length) / Math.max(1, deltas.length)),
    pctOver33: r((100 * deltas.filter((d) => d > 33).length) / Math.max(1, deltas.length)),
    longTasks: raw.longTasks.length,
    longTaskTotalMs: r(raw.longTasks.reduce((a, b) => a + b, 0)),
  };
}

async function taskByCli(page: Page, cli: string): Promise<{ id: string; state: string } | null> {
  return page.evaluate(async (wanted) => {
    interface TaskRow {
      id: string;
      state: string;
      external?: { cli?: string };
    }
    const bridge = (
      window as never as {
        product: {
          rpc: Record<
            string,
            (p: unknown) => Promise<{ ok: boolean; data?: { tasks?: TaskRow[] } }>
          >;
        };
      }
    ).product;
    const tasks = await bridge.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    });
    const hit = (tasks.data?.tasks ?? []).find((task) => task.external?.cli === wanted);
    return hit ? { id: hit.id, state: hit.state } : null;
  }, cli);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const fixture = createGitFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-e2e-realcli-'));
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ general: { skin: 'atelier' } }),
  );

  const result: Record<string, unknown> = { at: new Date().toISOString(), fixture };
  const { app, page } = await launchApp({
    userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture },
    recordVideo: { dir: SHOTS, size: { width: 1600, height: 900 } },
  });
  try {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1720, height: 1000 });
    });

    // ---- Live terminal, real claude in print mode.
    await page.keyboard.press('Control+`');
    await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('.xterm').first().click();
    const prompt =
      'Write a detailed markdown engineering report of about 250 lines analyzing a retry ' +
      'pipeline design: include three GFM tables of 15 rows each, four typescript code ' +
      'blocks of about 25 lines each, and bullet lists. Output only the markdown.';
    await page.keyboard.type(`claude --model haiku --dangerously-skip-permissions -p "${prompt}"`, {
      delay: 1,
    });

    // Frame collection while the real model turn streams into the PTY.
    await page.evaluate(COLLECTOR.start);
    await page.keyboard.press('Enter');

    // Detection: the session bar decorates in place.
    await page
      .locator('[data-testid^="terminal-agent-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 45000 });
    await page.screenshot({ path: join(SHOTS, '01-claude-detected.png') });

    // -p exits on its own when the turn completes.
    await page
      .locator('[data-testid^="terminal-agent-"]')
      .waitFor({ state: 'detached', timeout: 240000 });
    result.claudeStream = stats(
      (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
    );
    await page.screenshot({ path: join(SHOTS, '02-claude-ended.png') });

    // ---- The accounted session's room.
    let task = await taskByCli(page, 'claude');
    for (let i = 0; i < 30 && !task; i++) {
      await page.waitForTimeout(1000);
      task = await taskByCli(page, 'claude');
    }
    if (!task) throw new Error('real claude session was not accounted as a task');
    result.claudeTask = task;

    const reviewButton = page.getByTestId('session-bar-review');
    if (await reviewButton.isVisible().catch(() => false)) {
      await reviewButton.click();
    } else {
      await page.getByTestId(`home-task-${task.id}`).click();
    }
    await page.getByTestId('task-room').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(SHOTS, '03-claude-room.png') });

    const scroll = page.locator('.rt-scroll');
    if (await scroll.isVisible().catch(() => false)) {
      result.roomDomNodes = await page.evaluate(
        () => document.querySelector('.rt-scroll')?.querySelectorAll('*').length ?? 0,
      );
      await page.evaluate(COLLECTOR.start);
      await page.waitForTimeout(3000);
      result.roomIdle = stats(
        (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
      );
      const box = await scroll.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.evaluate(COLLECTOR.start);
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, -900);
          await page.waitForTimeout(25);
        }
        for (let i = 0; i < 40; i++) {
          await page.mouse.wheel(0, 900);
          await page.waitForTimeout(25);
        }
        result.roomScroll = stats(
          (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
        );
      }
      await page.screenshot({ path: join(SHOTS, '04-claude-room-scrolled.png') });
    }

    // ---- Optional codex probe (correctness, not perf): detection + account.
    // codex may be a shell alias/function — only the PTY's login shell can
    // resolve it, so attempt unconditionally and tolerate failure.
    {
      await page.keyboard.press('Control+`');
      await page.locator('.xterm').first().click();
      await page.keyboard.type(
        'codex exec --json --sandbox read-only "Reply with exactly PERF_PROBE_OK."',
        { delay: 1 },
      );
      await page.keyboard.press('Enter');
      try {
        await page
          .locator('[data-testid^="terminal-agent-"]')
          .first()
          .waitFor({ state: 'visible', timeout: 60000 });
        await page
          .locator('[data-testid^="terminal-agent-"]')
          .waitFor({ state: 'detached', timeout: 180000 });
        const codexTask = await taskByCli(page, 'codex');
        result.codex = codexTask
          ? { detected: true, taskId: codexTask.id, state: codexTask.state }
          : { detected: true, accounted: false };
        await page.screenshot({ path: join(SHOTS, '05-codex-probe.png') });
      } catch (error) {
        result.codex = `codex probe failed: ${String(error)}`;
      }
    }
  } finally {
    const video = page.video();
    await app.close();
    if (video) await video.saveAs(join(SHOTS, 'real-cli-session.webm')).catch(() => undefined);
  }

  const outFile = join(RESULTS_DIR, 'real-cli.json');
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  console.log(`[real-cli] wrote ${outFile}`);
  console.log(JSON.stringify(result, null, 1));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
