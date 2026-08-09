/**
 * Transcript scroll/idle frame benchmark (A/B evidence harness).
 *
 * Measures real rendered-frame pacing inside the packaged-mode app on a
 * deterministic 400-event heavy-markdown transcript, in three phases:
 *   - stream: frames while a mock ask task streams to completion
 *   - idle:   frames while the long transcript sits untouched (animation cost)
 *   - scroll: frames while wheel-scrolling up and down through the transcript
 *
 * Run:  npx tsx tests/perf/ui/scroll-bench.ts --label baseline
 * Output: tests/perf/ui/results/<label>-<run>.json (one file per run)
 *
 * The mock runtime is used only as a deterministic backend (CLAUDE.md §10);
 * the same scenario and seed produce byte-identical transcripts across runs,
 * so before/after numbers are directly comparable.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from '../../e2e/helpers/launch';
import { createTsSmallFixture } from '../../e2e/helpers/fixtures';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const SEED_EVENTS = 400;

interface PhaseStats {
  frames: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  pctOver17: number;
  pctOver33: number;
  longTasks: number;
  longTaskTotalMs: number;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** Injected rAF collector: frame deltas + long tasks between start/stop. */
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

function stats(raw: { deltas: number[]; longTasks: number[] }): PhaseStats {
  const deltas = raw.deltas.slice(5); // drop warmup frames
  const sorted = [...deltas].sort((a, b) => a - b);
  const pct = (p: number): number =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : 0;
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  return {
    frames: deltas.length,
    avgMs: round(avg),
    p50Ms: round(pct(0.5)),
    p95Ms: round(pct(0.95)),
    p99Ms: round(pct(0.99)),
    maxMs: round(sorted[sorted.length - 1] ?? 0),
    pctOver17: round((100 * deltas.filter((d) => d > 17).length) / Math.max(1, deltas.length)),
    pctOver33: round((100 * deltas.filter((d) => d > 33).length) / Math.max(1, deltas.length)),
    longTasks: raw.longTasks.length,
    longTaskTotalMs: round(raw.longTasks.reduce((a, b) => a + b, 0)),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Renderer-process work counters (CDP Performance domain), per phase. */
type CdpSession = {
  send: (method: string) => Promise<{ metrics: Array<{ name: string; value: number }> }>;
};

async function perfSnapshot(cdp: CdpSession | null): Promise<Record<string, number>> {
  if (!cdp) return {};
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

function perfDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const picked = [
    'LayoutCount',
    'RecalcStyleCount',
    'LayoutDuration',
    'RecalcStyleDuration',
    'ScriptDuration',
    'TaskDuration',
  ];
  const out: Record<string, number> = {};
  for (const key of picked) {
    if (key in before && key in after) {
      const value = after[key]! - before[key]!;
      // Durations are seconds — report ms for readability.
      out[key] = key.endsWith('Duration') ? round(value * 1000) : round(value);
    }
  }
  return out;
}

/** Deterministic heavy-markdown transcript: tables, fenced code, lists. */
function seedTranscript(dbPath: string, taskId: string): void {
  const maxSeq = Number(
    execFileSync('sqlite3', [
      dbPath,
      `SELECT COALESCE(MAX(sequence),0) FROM task_events WHERE task_id='${taskId}';`,
    ])
      .toString()
      .trim(),
  );
  const lines: string[] = ['BEGIN;'];
  const base = Date.now() - SEED_EVENTS * 1000;
  for (let i = 0; i < SEED_EVENTS; i++) {
    const seq = maxSeq + 1 + i;
    const at = new Date(base + i * 1000).toISOString();
    let type: string;
    let payload: unknown;
    if (i % 13 === 12) {
      // Warn-tone milestones render the infinite pulse dot the product shows
      // for historical state transitions — part of the real idle cost.
      type = 'task.stateChanged';
      payload = { from: 'EXPLORING', to: 'IN_PROGRESS' };
    } else if (i % 10 === 9) {
      type = 'user.message';
      payload = {
        messageId: `msg_seed_u${i}`,
        text: `Follow-up question ${i}: please continue with module_${i}.`,
      };
    } else if (i % 3 === 1) {
      type = 'tool.call';
      payload = {
        callId: `ctl_seed_${i}`,
        name: 'read_file',
        risk: 'R0',
        state: 'SUCCEEDED',
        ok: true,
        summary: `Read src/module_${i}.ts (${120 + (i % 40)} lines)`,
        input: { path: `src/module_${i}.ts` },
      };
    } else {
      type = 'agent.message';
      payload = { messageId: `msg_seed_${i}`, text: heavyMarkdown(i) };
    }
    const json = JSON.stringify(payload).replace(/'/g, "''");
    lines.push(
      `INSERT INTO task_events (id, task_id, sequence, type, schema_version, payload_json, created_at) VALUES ('evt_seed_${i}', '${taskId}', ${seq}, '${type}', 1, '${json}', '${at}');`,
    );
  }
  lines.push('COMMIT;');
  const sqlFile = join(RESULTS_DIR, 'seed.sql');
  writeFileSync(sqlFile, lines.join('\n'));
  execFileSync('sqlite3', [dbPath], { input: `.read ${sqlFile}` });
}

function heavyMarkdown(i: number): string {
  // Modeled on real Claude Code transcripts: mostly medium updates with a
  // giant final-report style message every 8th event (wide table + long code).
  const giant = i % 8 === 0;
  const tableRows = Array.from(
    { length: giant ? 30 : 5 },
    (_, r) =>
      `| evt_${i}_${r} | handler_${r % 9} | ${r % 2 ? 'yes' : 'no'} | retry=${r % 5} backoff=${50 * r}ms | \`src/module_${i}_${r}.ts\` |`,
  );
  const codeLines = Array.from(
    { length: giant ? 60 : 12 },
    (_, r) =>
      `  const step${r} = await pipeline.stage(${r}, ctx, { retry: ${r % 3}, tag: 'run_${i}_${r}' });`,
  );
  return [
    `### Analysis step ${i}`,
    '',
    `Reviewing \`src/module_${i}.ts\` shows the handler wires **${3 + (i % 4)} services** together and re-exports the public surface. The retry loop bounds attempts and backs off between calls. Verification ran against fixture ${i} and the boundary errors propagate with full context attached to every failure path.`,
    '',
    '| Id | Handler | Nullable | Notes | Source |',
    '|---|---|---|---|---|',
    ...tableRows,
    '',
    '```ts',
    `export async function process${i}(input: Input): Promise<Result> {`,
    ...codeLines,
    '  return finalize(ctx);',
    '}',
    '```',
    '',
    `- verified against fixture ${i}`,
    '- boundary errors propagate with context',
    `- see also \`src/module_${i + 1}.ts\``,
  ].join('\n');
}

async function main(): Promise<void> {
  const label = arg('label', 'run');
  const runs = Number(arg('runs', '3'));
  const skin = arg('skin', 'atelier'); // match the reporting user's environment
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fixture = createTsSmallFixture();

  for (let run = 1; run <= runs; run++) {
    const result: Record<string, unknown> = { label, run, skin, at: new Date().toISOString() };

    // Pre-create the user-data dir so the skin is active from first paint.
    const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-e2e-bench-'));
    writeFileSync(join(userDataDir, 'settings.json'), JSON.stringify({ general: { skin } }));

    // ---- Launch 1: create the task via the product UI; measure streaming.
    const first = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const { page } = first;
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Perf bench transcript');
      await page.getByTestId('home-intent').fill('[scenario:ask-basic] Describe this project.');
      await page.getByTestId('home-mode-ask').click();
      // Count stream IPC events actually delivered to the renderer — the
      // direct check that main-process delta coalescing is in effect.
      await page.evaluate(() => {
        const w = window as unknown as {
          __streamEvents: number;
          product: { events: { on: (c: string, l: () => void) => void } };
        };
        w.__streamEvents = 0;
        w.product.events.on('task.stream', () => {
          w.__streamEvents += 1;
        });
        w.product.events.on('task.streamThinking', () => {
          w.__streamEvents += 1;
        });
      });
      await page.evaluate(COLLECTOR.start);
      await page.getByTestId('home-submit').click();
      await page
        .getByTestId('task-state')
        .waitFor({ state: 'visible', timeout: 20000 })
        .catch(() => undefined);
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="task-state"]')?.getAttribute('data-state') ===
          'IDLE',
        undefined,
        { timeout: 30000 },
      );
      result.stream = stats(
        (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
      );
      result.streamIpcEvents = await page.evaluate(
        () => (window as unknown as { __streamEvents: number }).__streamEvents,
      );
    } finally {
      await first.app.close();
    }

    // ---- Seed the long transcript directly into the isolated benchmark DB.
    const dbPath = join(userDataDir, 'app.db');
    const taskId = execFileSync('sqlite3', [
      dbPath,
      'SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1;',
    ])
      .toString()
      .trim();
    if (!taskId) throw new Error('benchmark task not found in seeded DB');
    seedTranscript(dbPath, taskId);

    // ---- Launch 2: reopen the seeded room; measure idle + scroll.
    const second = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const { page } = second;
      // Realistic window: the reporting user runs a full-size laptop window,
      // not the 1440×900 CI viewport.
      await second.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1720, height: 1000 });
      });
      let cdp: CdpSession | null = null;
      try {
        const session = await second.app.context().newCDPSession(page);
        await session.send('Performance.enable');
        cdp = session as unknown as CdpSession;
      } catch {
        cdp = null; // metrics are additive evidence; frame stats still collected
      }
      await page.getByTestId(`home-task-${taskId}`).click({ timeout: 15000 });
      const scroll = page.locator('.rt-scroll');
      await scroll.waitFor({ state: 'visible', timeout: 15000 });
      // Let markdown + async colorize settle before measuring.
      await page.waitForTimeout(5000);
      result.domNodes = await page.evaluate(
        () => document.querySelector('.rt-scroll')?.querySelectorAll('*').length ?? 0,
      );

      // Idle phase: nothing moves except whatever the app animates on its own.
      let snapBefore = await perfSnapshot(cdp);
      await page.evaluate(COLLECTOR.start);
      await page.waitForTimeout(3000);
      result.idle = stats(
        (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
      );
      result.idleWork = perfDelta(snapBefore, await perfSnapshot(cdp));

      // Scroll phase: wheel to top in steps, then back down.
      const box = await scroll.boundingBox();
      if (!box) throw new Error('transcript scroll container has no bounding box');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      snapBefore = await perfSnapshot(cdp);
      await page.evaluate(COLLECTOR.start);
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel(0, -1200);
        await page.waitForTimeout(25);
      }
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(25);
      }
      result.scroll = stats(
        (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
      );
      result.scrollWork = perfDelta(snapBefore, await perfSnapshot(cdp));

      // Append phase — the money scenario: an agent run (messages + a tool
      // call's full lifecycle) lands on top of the 400-event transcript. This
      // is where per-append re-render work shows up as script/task time.
      // Driven through the bridge RPC: the composer affordance is covered by
      // e2e; here only the event-append rendering cost is under measurement.
      snapBefore = await perfSnapshot(cdp);
      await page.evaluate(COLLECTOR.start);
      const sendResult = await page.evaluate(async (id) => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; error?: unknown }>>;
            };
          }
        ).product;
        return bridge.rpc['task.message']!({
          taskId: id,
          text: '[scenario:ask-with-read] [target:package.json] What does this file do?',
          during: 'followUp',
          codeRefs: [],
          fileRefs: [],
          artifactRefs: [],
        });
      }, taskId);
      if (!(sendResult as { ok: boolean }).ok) {
        throw new Error(`append send failed: ${JSON.stringify(sendResult)}`);
      }
      // The 400-event window is saturated: appends shift content without
      // changing the row count, so wait for the new final message's text.
      // Generous timeout: the unoptimized build freezes the main thread for
      // tens of seconds here — that IS the phenomenon under measurement.
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="timeline"]')
            ?.textContent?.includes('defines its scripts and dependencies'),
        undefined,
        { timeout: 120000 },
      );
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="task-state"]')?.getAttribute('data-state') ===
          'IDLE',
        undefined,
        { timeout: 45000 },
      );
      await page.waitForTimeout(400); // deferred colorize settles
      result.append = stats(
        (await page.evaluate(COLLECTOR.stop)) as { deltas: number[]; longTasks: number[] },
      );
      result.appendWork = perfDelta(snapBefore, await perfSnapshot(cdp));
    } finally {
      await second.app.close();
    }

    const outFile = join(RESULTS_DIR, `${label}-${run}.json`);
    writeFileSync(outFile, JSON.stringify(result, null, 2));
    console.log(`[bench] wrote ${outFile}`);
    console.log(
      JSON.stringify({ stream: result.stream, idle: result.idle, scroll: result.scroll }, null, 1),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
