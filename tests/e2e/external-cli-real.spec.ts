import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { terminalPtyOutput, terminalPtySnapshot, waitForTerminalOutput } from './helpers/terminal';

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
 * The interactive Claude test only uses local commands. The Codex exact-resume
 * test and Claude print test each run one tiny prompt because the CLIs do not
 * persist a resumable rollout until a real turn exists.
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
  // The default WebGL renderer paints terminal rows onto a canvas, so the
  // host-owned PTY tail is the reliable readiness signal.
  await waitForTerminalOutput(page, 'ready-marker');
}

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

async function expectExternalEndedSurface(page: Page): Promise<void> {
  const ended = page
    .getByTestId('external-panel-ended')
    .or(page.getByTestId('session-agent-status').filter({ hasText: /ended/i }));
  await expect(ended).toBeVisible({ timeout: 45_000 });
}

/** A fresh dir makes claude ask for folder trust; accept the default. */
async function acceptTrustPromptIfShown(page: Page, host: string): Promise<void> {
  try {
    await expect(page.getByTestId(host)).toContainText(/trust/i, { timeout: 20_000 });
    await page.getByTestId(host).click();
    await page.keyboard.press('Enter');
  } catch {
    // No trust prompt (already-trusted path shape) — fine.
  }
}

test.describe('ADR-0017 rev.2 real external CLIs (manual, gated)', () => {
  test.skip(!REAL, 'set PI_IDE_REAL_EXTERNAL_CLI=1 to drive the real claude/codex CLIs');
  test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

  test('real claude interactive: detect → promote → type → end from Session Rail', async () => {
    test.setTimeout(240000);
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      recordVideo,
    });
    try {
      await useSoftwareTerminalRenderer(page);
      await openLiveTerminal(page);
      await page.keyboard.type('claude');
      await page.keyboard.press('Enter');

      // Detection despite the version-named binary (kernel comm = "2.1.209").
      // rev.2: decoration only — session bar + badge, NO panel, dock intact.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText(/claude/i, {
        timeout: 30000,
      });
      await expect(page.getByTestId('terminal-session-bar')).toBeVisible();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      const terminalId = (await terminalPtySnapshot(page)).items.at(-1)?.id;
      expect(terminalId).toBeTruthy();

      // The real TUI renders in place (trust prompt for the fresh dir first).
      await acceptTrustPromptIfShown(page, 'terminal-host');
      await expect(page.getByTestId('terminal-host')).toContainText(/Claude|claude/, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('terminal-host').locator('.xterm-screen')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-detected.png') });

      // Real interactive Claude emits no JSON turn.completed edge. A local
      // slash command exercises the production observed-input/output/quiet
      // presence path without making a billed model request.
      await expect
        .poll(async () => {
          return page.evaluate(async () => {
            const bridge = (
              window as never as {
                product: {
                  rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>>;
                };
              }
            ).product;
            const tasks = await bridge.rpc['task.list']!({
              filter: 'all',
              includeArchived: false,
              scope: 'all',
            });
            return (
              tasks.data?.tasks?.find(
                (task: { external?: { cli?: string } }) => task.external?.cli === 'claude',
              )?.id ?? null
            );
          });
        })
        .not.toBeNull();
      const taskId = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        });
        return tasks.data.tasks.find(
          (task: { external?: { cli?: string } }) => task.external?.cli === 'claude',
        ).id as string;
      });
      const row = page.getByTestId(`home-task-${taskId}`);
      await page.getByTestId('terminal-host').click();
      await page.keyboard.type('/help');
      await page.keyboard.press('Enter');
      await expect(row).toHaveAttribute('data-reply', 'true', { timeout: 15000 });
      await expect(row).toHaveClass(/reply-shake/);
      await expect(row).toHaveCSS('animation-duration', '2.2s');
      const replyNotice = page.locator(
        `[data-testid="session-completion-notice"][data-kind="reply"][data-task-id="${taskId}"]`,
      );
      await expect(replyNotice).toBeVisible();
      await expect(replyNotice).toContainText('Claude reply complete');
      await expect(replyNotice).toContainText('Terminal output settled');
      await page.screenshot({ path: join(SHOTS, 'claude-observed-reply-shake.png') });
      await page.keyboard.press('Escape');

      // User-invoked promotion: the LIVE TUI moves to the side panel and keeps
      // rendering; keystrokes land in its composer (visible echo).
      await page.getByTestId('session-bar-promote').click();
      await expect(page.getByTestId('external-panel')).toBeVisible();
      await expect(page.getByTestId('external-panel-terminal')).toContainText(/Claude|claude/, {
        timeout: 15_000,
      });
      await expect(
        page.getByTestId('external-panel-terminal').locator('.xterm-screen'),
      ).toBeVisible();
      await page.getByTestId('external-panel-terminal').click();
      await page.keyboard.type('typing-probe');
      await expect(page.getByTestId('external-panel-terminal')).toContainText('typing-probe', {
        timeout: 10_000,
      });
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-promoted.png') });

      // Clear the probe, then exercise the Session Rail's product-owned end
      // action against the real TUI rather than issuing Claude's /exit command.
      for (let i = 0; i < 'typing-probe'.length; i++) await page.keyboard.press('Backspace');
      await row.hover();
      const endSession = page.getByTestId(`home-end-${taskId}`);
      await expect(endSession).toBeVisible();
      await endSession.click();
      await endSession.click();

      // Session ends: the pane STAYS in the panel (ended header), then the
      // user returns it to the dock.
      await expectExternalEndedSurface(page);
      await expect(page.getByTestId(`home-end-${taskId}`)).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-ended.png') });
      await page.getByTestId('external-return-dock').click();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('session-bar-ended')).toBeVisible();
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-returned.png') });

      // The vendor CLI's real observed session is also consumable by the same
      // semantic Replay surface used by deterministic CI coverage.
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-source')).toContainText('Claude Terminal');
      await expect(page.getByTestId('replay-source')).toContainText('Observed');
      await expect(page.getByTestId('replay-story-list')).toBeVisible();
      await expect(page.getByTestId('replay-timeline')).toBeVisible();
      await page.waitForTimeout(180);
      await page.screenshot({ path: join(SHOTS, 'claude-interactive-replay.png') });
      await page.getByTestId('replay-close').click();
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
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText(/claude/i, {
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

  test('real codex saved session: exec → exact resume → TUI input', async () => {
    test.setTimeout(240000);
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture },
      recordVideo,
    });
    try {
      await useSoftwareTerminalRenderer(page);
      await openLiveTerminal(page);
      const terminalId = (await terminalPtySnapshot(page)).items.at(-1)?.id;
      expect(terminalId).toBeTruthy();

      // JSON mode exposes the exact thread.started UUID and creates a real
      // rollout with one minimal model turn. It avoids treating an unpersisted
      // slash-command-only TUI as a resumable conversation.
      await page.keyboard.type(
        'codex exec --json --sandbox read-only --ignore-rules "Reply with exactly RESUME_FIX_READY."',
      );
      await page.keyboard.press('Enter');

      // The user's zsh function (nvm lazy-load + proxy) wraps the real CLI;
      // detection must see through whatever shim shape it resolves to.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText(/codex/i, {
        timeout: 45_000,
      });
      await expect(page.getByTestId('terminal-session-bar')).toBeVisible();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await page.screenshot({ path: join(SHOTS, 'codex-detected.png') });

      await waitForTerminalOutput(page, /"type":"turn\.completed"/, {
        terminalId,
        timeout: 180_000,
      });
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId('session-bar-ended')).toBeVisible();

      const codexTask = async (): Promise<{
        id: string;
        external: { sessionId: string | null; status: string };
      } | null> =>
        page.evaluate(async () => {
          const bridge = (
            window as never as {
              product: {
                rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>>;
              };
            }
          ).product;
          const tasks = await bridge.rpc['task.list']!({
            filter: 'all',
            includeArchived: false,
            scope: 'all',
          });
          return (
            tasks.data?.tasks?.find(
              (task: { external?: { cli?: string } }) => task.external?.cli === 'codex',
            ) ?? null
          );
        });
      await expect
        .poll(async () => (await codexTask())?.external.sessionId ?? '', { timeout: 30_000 })
        .toMatch(/^[0-9a-f-]{36}$/i);
      const taskId = (await codexTask())!.id;
      await page.screenshot({ path: join(SHOTS, 'codex-saved-session-ended.png') });

      // Resume through the same task action the user clicks. The command must
      // pin the owning Codex home; otherwise the real CLI reports the original
      // "No saved session found" failure.
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      const resumeSession = page.getByTestId('task-resume');
      await expect(resumeSession).toContainText('Resume Codex session');
      await resumeSession.click();
      await waitForTerminalOutput(page, /CODEX_HOME=.*codex resume [0-9a-f-]{36}/i, {
        terminalId,
        timeout: 30_000,
      });
      await waitForTerminalOutput(page, /Press enter to continue|OpenAI\s*Codex/, {
        terminalId,
        timeout: 30_000,
      });
      await expect(
        page
          .getByTestId('external-live')
          .or(page.getByTestId('session-agent-status').filter({ hasText: /running/i })),
      ).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      expect(await terminalPtyOutput(page, terminalId)).not.toContain('No saved session found');

      const resumedTerm = page
        .getByTestId('external-terminal-host')
        .or(page.getByTestId('session-terminal-host'));
      await expect(resumedTerm).toBeVisible();
      await resumedTerm.click();
      if (
        /Do\s*you\s*trust|Press enter to continue/.test((await resumedTerm.textContent()) ?? '')
      ) {
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1_000);
      }
      await page.keyboard.type('/status');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1_500);
      await page.screenshot({ path: join(SHOTS, 'codex-resumed-real.png') });
      await page.keyboard.press('Escape');

      // Leave no real Codex process running after the validation.
      const endResult = await page.evaluate(async (id) => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        return bridge.rpc['external.endSession']!({ taskId: id });
      }, taskId);
      expect(endResult.ok).toBe(true);
      expect(endResult.data?.ended).toBe(true);
    } finally {
      const video = page.video();
      await app.close();
      if (VIDEO_DIR && video) await video.saveAs(join(VIDEO_DIR, 'real-codex.webm'));
    }
  });
});
