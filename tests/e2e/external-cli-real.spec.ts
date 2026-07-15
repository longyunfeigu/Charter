import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * ADR-0017 rev.2 — manual, env-gated (real-gateway.spec convention): drives the
 * REAL claude/codex CLIs installed on this machine through the embedded PTY.
 * Covers what the fake-CLI specs cannot:
 *   - claude: native installer, `claude → …/versions/<semver>` (kernel comm
 *     is the version string — the ADR-0017 amendment regression);
 *   - codex: whatever wrapper/shim the user's shell resolves;
 *   - the real TUIs actually rendering and taking keystrokes in the dock and
 *     in the user-invoked side panel (the rev.2 interaction).
 * Run: PI_IDE_REAL_EXTERNAL_CLI=1 npx playwright test external-cli-real …
 * The interactive claude test only types `/exit` (no model call); the print
 * test runs one tiny haiku task and costs real tokens.
 */
const REAL = process.env.PI_IDE_REAL_EXTERNAL_CLI === '1';
const SHOTS = '/tmp/live-e2e';
/** Optional demo capture: set to a directory to record .webm videos of the runs. */
const VIDEO_DIR = process.env.PI_IDE_E2E_VIDEO_DIR;
const recordVideo = VIDEO_DIR ? { dir: VIDEO_DIR, size: { width: 1600, height: 900 } } : undefined;

async function openLiveTerminal(page: Page): Promise<void> {
  await page.keyboard.press('Control+`');
  await expect(page.getByTestId('terminal-panel')).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
  await page.locator('.xterm').click();
  await page.keyboard.type('echo ready-marker');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('terminal-panel')).toContainText('ready-marker', {
    timeout: 15000,
  });
}

/** A fresh dir makes claude ask for folder trust; accept the default. */
async function acceptTrustPromptIfShown(page: Page, host: string): Promise<void> {
  try {
    await expect(page.getByTestId(host)).toContainText(/trust/i, { timeout: 20000 });
    await page.keyboard.press('Enter');
  } catch {
    // No trust prompt (already-trusted path shape) — fine.
  }
}

test.describe('ADR-0017 rev.2 real external CLIs (manual, gated)', () => {
  test.skip(!REAL, 'set PI_IDE_REAL_EXTERNAL_CLI=1 to drive the real claude/codex CLIs');
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

  test('real claude interactive: detect in place → promote → keystrokes → /exit → return', async () => {
    test.setTimeout(240000);
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      recordVideo,
    });
    try {
      await openLiveTerminal(page);
      await page.keyboard.type('claude');
      await page.keyboard.press('Enter');

      // Detection despite the version-named binary (kernel comm = "2.1.209").
      // rev.2: decoration only — session bar + badge, NO panel, dock intact.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('claude', {
        timeout: 30000,
      });
      await expect(page.getByTestId('terminal-session-bar')).toBeVisible();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();

      // The real TUI renders in place (trust prompt for the fresh dir first).
      await acceptTrustPromptIfShown(page, 'terminal-host');
      await expect(page.getByTestId('terminal-host')).toContainText(/Claude|claude/, {
        timeout: 30000,
      });
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-detected.png') });

      // User-invoked promotion: the LIVE TUI moves to the side panel and keeps
      // rendering; keystrokes land in its composer (visible echo).
      await page.getByTestId('session-bar-promote').click();
      await expect(page.getByTestId('external-panel')).toBeVisible();
      await expect(page.getByTestId('external-panel-terminal')).toContainText(/Claude|claude/, {
        timeout: 15000,
      });
      await page.getByTestId('external-panel-terminal').click();
      await page.keyboard.type('typing-probe');
      await expect(page.getByTestId('external-panel-terminal')).toContainText('typing-probe', {
        timeout: 10000,
      });
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-promoted.png') });

      // Clear the probe, quit the TUI without a model call.
      for (let i = 0; i < 'typing-probe'.length; i++) await page.keyboard.press('Backspace');
      await page.keyboard.type('/exit');
      await page.keyboard.press('Enter');

      // Session ends: the pane STAYS in the panel (ended header), then the
      // user returns it to the dock.
      await expect(page.getByTestId('external-panel-ended')).toBeVisible({ timeout: 45000 });
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-ended.png') });
      await page.getByTestId('external-return-dock').click();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('session-bar-ended')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-returned.png') });
    } finally {
      const video = page.video();
      await app.close();
      if (VIDEO_DIR && video) await video.saveAs(join(VIDEO_DIR, 'real-claude-interactive.webm'));
    }
  });

  test('real claude -p: edit accounted → REVIEW_READY (decoration only, no panel)', async () => {
    test.setTimeout(240000); // a real model round-trip sits in the middle
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      recordVideo,
    });
    try {
      await openLiveTerminal(page);

      // Print mode: one deterministic tiny edit, cheap fast model, no
      // interactive permission stops, scoped to the throwaway git fixture.
      await page.keyboard.type(
        'claude --model haiku --dangerously-skip-permissions -p ' +
          '"Create a file named e2e-touch.txt containing exactly: external e2e ok"',
      );
      await page.keyboard.press('Enter');

      // rev.2: the session decorates in place; nothing moves on detection.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('claude', {
        timeout: 30000,
      });
      await expect(page.getByTestId('terminal-session-bar')).toBeVisible();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, 'claude-p-detected.png') });

      // -p exits on its own; the badge clears and the bar flips to ended.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(0, {
        timeout: 180000,
      });
      await expect(page.getByTestId('session-bar-ended')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'claude-p-ended.png') });

      // The real edit is on disk and accounted; the task landed in review.
      expect(readFileSync(join(fixture, 'e2e-touch.txt'), 'utf8')).toContain('external e2e ok');
      const result = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const external = tasks.data?.tasks?.find((t: { external: unknown }) => t.external);
        if (!external) return null;
        const cs = await bridge.rpc['task.changeSet']!({ taskId: external.id });
        return { state: external.state as string, changeSet: cs.data?.changeSet ?? null };
      });
      expect(result).not.toBeNull();
      expect(result!.state).toBe('REVIEW_READY');
      const touched = (
        result!.changeSet as { files: Array<{ path: string; status: string }> }
      ).files.find((f) => f.path === 'e2e-touch.txt');
      expect(touched?.status).toBe('created');
    } finally {
      const video = page.video();
      await app.close();
      if (VIDEO_DIR && video) await video.saveAs(join(VIDEO_DIR, 'real-claude.webm'));
    }
  });

  test('real codex interactive: detect → promote → TUI renders and takes keystrokes', async () => {
    test.setTimeout(120000);
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      recordVideo,
    });
    try {
      await openLiveTerminal(page);
      await page.keyboard.type('codex');
      await page.keyboard.press('Enter');

      // The user's zsh function (nvm lazy-load + proxy) wraps the real CLI;
      // detection must see through whatever shim shape it resolves to.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('codex', {
        timeout: 45000,
      });
      await expect(page.getByTestId('terminal-session-bar')).toBeVisible();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, 'codex-detected.png') });

      // Promote by intent; the real codex TUI must render in the panel and
      // show typed characters in its composer.
      await page.getByTestId('session-bar-promote').click();
      await expect(page.getByTestId('external-panel')).toBeVisible();
      const panelTerm = page.getByTestId('external-panel-terminal');
      await expect(panelTerm).toContainText(/codex|Codex|OpenAI|Update available/, {
        timeout: 20000,
      });
      await panelTerm.click();
      // codex opens through a gauntlet of startup prompts whose shapes vary by
      // run: a self-update MENU ("› 1. Update now / 2. Skip …" — decline it),
      // a non-interactive update notice box (ignore), and the fresh-dir trust
      // prompt ("› 1. Yes, continue" — accept it). Handle whatever appears
      // until the TUI proper is up; these keystrokes landing correctly is
      // itself the point of the test.
      let handledUpdateMenu = false;
      let handledTrust = false;
      for (let i = 0; i < 60; i++) {
        const text = (await panelTerm.textContent()) ?? '';
        if (!handledUpdateMenu && /1\. Update now/.test(text) && /2\. Skip/.test(text)) {
          await page.keyboard.press('ArrowDown'); // › 2. Skip
          await page.keyboard.press('Enter');
          handledUpdateMenu = true;
        } else if (!handledTrust && /Do you trust/.test(text) && /1\. Yes/.test(text)) {
          await page.keyboard.press('Enter'); // default selection: Yes, continue
          handledTrust = true;
        } else if (
          text.trim().length > 0 &&
          !/Update now|Do you trust|Press enter/.test(text) &&
          (handledTrust || !/Update available/.test(text))
        ) {
          break; // alternate screen took over — the TUI proper is rendering
        }
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);
      await page.keyboard.type('typing-probe');
      await expect(panelTerm).toContainText('typing-probe', {
        timeout: 10000,
      });
      await page.screenshot({ path: join(SHOTS, 'codex-promoted.png') });

      // An external task exists for the session (accounting armed).
      const hasExternal = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return Boolean(tasks.data?.tasks?.some((t: { external: unknown }) => t.external));
      });
      expect(hasExternal).toBe(true);
      // Closing the app kills the PTY, which fires the session-exit edge
      // (fireAgentExitIfActive) — quitting the TUI itself is not under test.
    } finally {
      const video = page.video();
      await app.close();
      if (VIDEO_DIR && video) await video.saveAs(join(VIDEO_DIR, 'real-codex.webm'));
    }
  });
});
