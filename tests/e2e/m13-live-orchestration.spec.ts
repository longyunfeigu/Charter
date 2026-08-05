import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * M13 live-model orchestration (manual, env-gated — real-gateway.spec
 * convention): proves a REAL model maps a colloquial "开另外一个终端…" intent
 * onto terminal.create → send → wait → read with no [scenario:*] steering.
 * This is the tool-selection layer the mock-driven m13-orchestration.spec
 * cannot cover: the mock runtime is scripted, so it never tests whether a
 * model actually chooses the orchestration tools from natural language.
 * Requires CHARTER_TEST_KEY and CHARTER_TEST_BASEURL; skips otherwise.
 * The worker is a plain shell (not claude/codex) so the run needs no second
 * logged-in CLI; the claude-worker variant stays a manual check.
 */
const KEY = process.env.CHARTER_TEST_KEY ?? '';
const BASEURL = process.env.CHARTER_TEST_BASEURL ?? '';
const MODEL = process.env.CHARTER_TEST_MODEL ?? 'claude-haiku-4-5-20251001';
const SHOTS = '/tmp/charter-m13-live';

// The %s form keeps the probe string OUT of the command echo: a match on
// ORCH_LIVE_OK can only come from the worker actually executing the command.
const INTENT =
  "开另外一个终端窗口,在那个新窗口里运行 printf 'ORCH_LIVE_%s\\n' OK ,等命令跑完之后把输出读回来告诉我。不要在当前会话里自己运行这个命令。";

/** Approve the plan gate; terminal.* calls themselves are prompt-free. */
async function approveCurrentGate(page: Page): Promise<void> {
  const plan = page.getByTestId('plan-approve');
  if (await plan.isVisible().catch(() => false)) {
    await plan.click().catch(() => undefined);
    return;
  }
}

async function openLegacyOrchestration(page: Page): Promise<void> {
  await page.getByTestId('session-more').click();
  const legacyEntry = page.getByTestId('task-open-legacy-orchestration');
  await expect(legacyEntry).toBeVisible({ timeout: 10_000 });
  await legacyEntry.click();
  await expect(page.getByTestId('orchestration-fleet')).toBeVisible();
}

test('live model: colloquial intent alone drives terminal.create → send/wait/read', async () => {
  test.skip(!KEY || !BASEURL, 'no real credentials in env');
  test.setTimeout(600_000);
  mkdirSync(SHOTS, { recursive: true });
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
  try {
    // 1) Real provider through Settings → Models (real-gateway.spec steps).
    await page.getByTestId('home-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await page.getByTestId('provider-key-input').fill(KEY);
    await page.getByTestId('provider-baseurl-input').fill(BASEURL);
    await page.getByTestId('provider-key-save').click();
    await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
    await page.getByTestId('provider-fetch-anthropic').click();
    await expect(page.locator('.toast').filter({ hasText: 'models verified' })).toBeVisible({
      timeout: 180000,
    });
    await page.keyboard.press('Escape');

    // 2) Edit-mode task carrying ONLY the colloquial intent.
    await page.getByTestId('surface-home').click();
    await page.getByTestId('home-model').click();
    await page.getByTestId(`home-model-opt-anthropic::${MODEL}`).click();
    await page.getByTestId('home-mode-edit').click();
    await page.getByTestId('home-intent').fill(INTENT);
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-room')).toBeVisible();

    // 3) THE assertion this spec exists for: the model must reach for
    // terminal.create on its own. The worker appearing is the observable proof;
    // terminal calls no longer pause on a permission card.
    await expect
      .poll(
        async () => {
          const snapshot = await page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          if (snapshot.ok && (snapshot.data as { workers: Array<unknown> }).workers.length > 0) {
            return true;
          }
          await approveCurrentGate(page);
          const state = await page
            .getByTestId('task-state')
            .getAttribute('data-state')
            .catch(() => null);
          if (state === 'FAILED' || state === 'REVIEW_READY') {
            throw new Error(`task ended (${state}) without ever calling terminal.create`);
          }
          return false;
        },
        { timeout: 300_000, intervals: [1000] },
      )
      .toBe(true);
    await expect(page.getByTestId('perm-card').filter({ hasText: 'terminal.' })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/1-worker-created.png` });

    // 4) Worker appears in the fleet; keep approving send-class gates until
    // the probe output lands in the worker pty.
    await openLegacyOrchestration(page);
    const workerScreen = page
      .getByTestId('orchestration-fleet')
      .getByTestId('orchestration-native-terminal')
      .first()
      .locator('.xterm-rows');
    await expect
      .poll(
        async () => {
          await approveCurrentGate(page);
          return (await workerScreen.textContent().catch(() => '')) ?? '';
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toContain('ORCH_LIVE_OK');
    await page.screenshot({ path: `${SHOTS}/2-worker-output.png` });

    // 5) The run reads the result back and completes for review.
    await expect
      .poll(
        async () => {
          await approveCurrentGate(page);
          return page
            .getByTestId('task-state')
            .getAttribute('data-state')
            .catch(() => null);
        },
        { timeout: 180_000, intervals: [1000] },
      )
      .toMatch(/REVIEW_READY|ACCEPTED/);
    await page.screenshot({ path: `${SHOTS}/3-review-ready.png` });
  } finally {
    await app.close();
  }
});
