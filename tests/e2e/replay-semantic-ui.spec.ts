import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures';

const SHOTS = '/tmp/charter-replay-semantic';
const SKINS = ['studio', 'terminal', 'archive', 'index'] as const;

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test.describe('Semantic Replay UI — real Electron surface', () => {
  test('Pi session follows all four shell backgrounds and the complete playback path works', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const errors = collectRendererErrors(page);
    try {
      await setWindowSize(app, 1600, 969);
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('修复登录态刷新与重试');
      await page
        .getByTestId('home-intent')
        .fill('[scenario:verify-fail-fix] 修复刷新失败后的重试并完成验证');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 40000,
      });

      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-source')).toContainText('Pi Home');
      await expect(page.getByTestId('replay-story-list')).toBeVisible();
      await expect(page.getByTestId('replay-step')).toBeVisible();
      await expect(page.getByTestId('replay-timeline')).toBeVisible();
      await expect(page.locator('.rp-story-event.active')).toHaveCount(1);
      await expect(page.locator('.rp-story-list [data-provider="pi"]').first()).toBeVisible();

      // Select a material change through the result summary, inspect its
      // evidence, then return to the selected before/after artifact.
      await page.locator('.rp-summary-changed button').first().click();
      await expect(page.getByTestId('replay-detail-layer')).toBeVisible();
      await expect(page.getByTestId('replay-evidence-list')).toContainText('change:');
      await page.getByTestId('replay-detail-layer').getByLabel('关闭步骤详情').last().click();
      await expect(page.getByTestId('replay-detail-layer')).toHaveCount(0);
      await expect(page.getByTestId('replay-step')).toHaveAttribute(
        'data-renderer',
        /file|document/,
      );
      await expect(page.getByTestId('replay-step')).toContainText('之前');
      await expect(page.getByTestId('replay-step')).toContainText('之后');

      // Expanding context is honest recorded context, and keeps one selected
      // semantic node rather than inventing hidden model reasoning.
      const collapsedCount = await page.locator('.rp-story-event').count();
      await page.getByTestId('replay-show-context').click();
      await expect(page.getByTestId('replay-show-context')).toHaveAttribute('aria-pressed', 'true');
      expect(await page.locator('.rp-story-event').count()).toBeGreaterThanOrEqual(collapsedCount);
      await expect(page.locator('.rp-story-event.active')).toHaveCount(1);

      // The four appearance languages must resolve Replay surfaces from the
      // same root tokens used by the main shell, not from a replay-only white.
      for (const skin of SKINS) {
        await page.evaluate((nextSkin) => {
          document.documentElement.dataset.skin = nextSkin;
          document.documentElement.dataset.theme = nextSkin === 'terminal' ? 'dark' : 'light';
        }, skin);
        await expect(page.locator('html')).toHaveAttribute('data-skin', skin);
        const surfaces = await replaySurfaceColors(page);
        expect(surfaces.root, `${skin}: Replay root follows --bg-editor`).toBe(
          surfaces.tokens.editor,
        );
        expect(surfaces.story, `${skin}: story rail follows --bg-sidebar`).toBe(
          surfaces.tokens.sidebar,
        );
        expect(surfaces.now, `${skin}: artifact area follows --bg-editor`).toBe(
          surfaces.tokens.editor,
        );
        expect(surfaces.timeline, `${skin}: timeline follows --bg-panel`).toBe(
          surfaces.tokens.panel,
        );
        await expect(page.getByTestId('replay-view')).toHaveAttribute('data-depth', 'recap');
        await page.screenshot({ path: join(SHOTS, `pi-${skin}.png`) });
      }

      // Playback, idle compression, menu navigation and result jump are all
      // live controls on the actual Electron page.
      await page.getByTestId('replay-play').click();
      await expect(page.getByTestId('replay-play')).toContainText('Pause');
      await page.getByTestId('replay-play').click();
      await page.getByTestId('replay-skip-idle').click();
      await expect(page.getByTestId('replay-skip-idle')).toHaveAttribute('aria-pressed', 'false');
      await switchDepth(page, 'explore');
      await expect(page.getByTestId('replay-event-list')).toBeVisible();
      await switchDepth(page, 'verify');
      await expect(page.getByTestId('replay-receipt')).toBeVisible();
      await page.getByTestId('replay-jump-result').click();
      await expect(page.getByTestId('replay-view')).toHaveAttribute('data-depth', 'recap');

      // A narrower supported desktop viewport retains both semantic columns,
      // transport controls and page identity without horizontal overflow.
      await setWindowSize(app, 1024, 768);
      await expect(page.getByText('对话与操作', { exact: true })).toBeVisible();
      // V3.1: the right column is the result card (conclusion + return line),
      // not the removed "what the agent was doing" header.
      await expect(page.getByTestId('replay-summary')).toBeVisible();
      await expect(page.getByTestId('replay-to-room')).toBeVisible();
      await expect(page.getByTestId('replay-play')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(SHOTS, 'pi-narrow-1024.png') });
      await assertNoFrameworkOverlay(page);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close();
    }
  });

  for (const provider of ['claude', 'codex'] as const) {
    test(`${provider} session traverses a real PTY, accounting ledger and Replay evidence`, async () => {
      const fixture = createGitFixture();
      const bin = createObservedAgentBin(provider, fixture);
      const { app, page } = await launchApp({
        env: {
          PI_IDE_OPEN_WORKSPACE: fixture,
          PI_IDE_EXTERNAL_CLIS: provider,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });
      const errors = collectRendererErrors(page);
      try {
        await setWindowSize(app, 1440, 900);
        await page.keyboard.press('Control+`');
        await expect(page.getByTestId('terminal-panel')).toBeVisible();
        await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
        await page.locator('.xterm').click();
        await page.keyboard.type('echo replay-ready');
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('terminal-panel')).toContainText('replay-ready', {
          timeout: 15000,
        });
        // Use the absolute fixture executable so user shell functions/aliases
        // for the installed vendor CLIs cannot bypass this deterministic run.
        await page.keyboard.type(join(bin, provider));
        await page.keyboard.press('Enter');

        await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText(
          provider === 'claude' ? /claude/i : /codex/i,
          { timeout: 15000 },
        );
        await expect(page.getByTestId('session-bar-files')).toContainText('1 file', {
          timeout: 20000,
        });
        await expect(page.getByTestId('session-bar-ended')).toBeVisible({ timeout: 30000 });
        await page.getByTestId('session-bar-review').click();
        await expect(page.getByTestId('task-room')).toBeVisible();
        await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY');

        await page.getByTestId('session-more').click();
        await page.getByTestId('replay-open').click();
        await expect(page.getByTestId('replay-view')).toBeVisible();
        await expect(page.getByTestId('replay-source')).toContainText(
          provider === 'claude' ? 'Claude Terminal' : 'Codex Terminal',
        );
        await expect(page.getByTestId('replay-source')).toContainText('观察记录');

        await page.locator('.rp-summary-changed button').first().click();
        await expect(page.getByTestId('replay-diff')).toContainText(`${provider}ReplayTouch`);
        await expect(page.getByTestId('replay-fact-level')).toContainText('观察记录');
        await expect(page.getByTestId('replay-boundary')).toBeVisible();
        await page.screenshot({ path: join(SHOTS, `${provider}-recap-evidence.png`) });

        await page.getByTestId('replay-detail-layer').getByLabel('关闭步骤详情').last().click();
        await expect(page.getByTestId('replay-detail-layer')).toHaveCount(0);
        await page.waitForTimeout(180);
        await page.screenshot({ path: join(SHOTS, `${provider}-recap.png`) });
        await switchDepth(page, 'explore');
        await page.getByTestId('replay-search').fill(`${provider}-visible-output`);
        await page.getByTestId('replay-event-list').locator('button').first().click();
        await expect(page.getByTestId('replay-step')).toContainText(`${provider}-visible-output`);
        await expect(page.getByTestId('replay-fact-level')).toContainText('观察记录');
        await expect(page.getByTestId('replay-boundary')).toBeVisible();
        await page.waitForTimeout(180);
        await page.screenshot({ path: join(SHOTS, `${provider}-explore.png`) });

        expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
        await assertNoFrameworkOverlay(page);
        expect(errors, errors.join('\n')).toEqual([]);
      } finally {
        await app.close();
      }
    });
  }
});

function createObservedAgentBin(provider: 'claude' | 'codex', fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), `charter-replay-${provider}-`));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  writeFileSync(
    join(bin, provider),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const target = ${JSON.stringify(target)};`,
      `console.log(${JSON.stringify(`${provider}-visible-output`)});`,
      'setTimeout(() => {',
      "  const source = fs.readFileSync(target, 'utf8');",
      `  fs.writeFileSync(target, source + ${JSON.stringify(`export const ${provider}ReplayTouch = 1;\n`)});`,
      `  console.log(${JSON.stringify(`${provider}-edit-recorded`)});`,
      '}, 1800);',
      // Keep the genuine PTY process alive while the accounting watcher
      // captures its post-write state; ending too early intentionally yields
      // a zero-change observed session.
      'setTimeout(() => process.exit(0), 6500);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, provider), 0o755);
  return bin;
}

async function switchDepth(page: Page, depth: 'recap' | 'explore' | 'verify'): Promise<void> {
  await page.getByTestId('replay-menu-toggle').click();
  await page.getByTestId(`replay-depth-${depth}`).click();
}

async function setWindowSize(
  app: Awaited<ReturnType<typeof launchApp>>['app'],
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size: { width: number; height: number }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setMinimumSize(320, 480);
      window?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

function collectRendererErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function assertNoFrameworkOverlay(page: Page): Promise<void> {
  await expect(
    page.locator('vite-error-overlay, .vite-error-overlay, #webpack-dev-server-client-overlay'),
  ).toHaveCount(0);
}

async function replaySurfaceColors(page: Page): Promise<{
  root: string;
  story: string;
  now: string;
  timeline: string;
  tokens: { editor: string; sidebar: string; panel: string };
}> {
  return page.evaluate(() => {
    const colorOf = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return getComputedStyle(element).backgroundColor;
    };
    const resolveToken = (token: string) => {
      const probe = document.createElement('i');
      probe.style.position = 'fixed';
      probe.style.backgroundColor = `var(${token})`;
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    return {
      root: colorOf('.rp-root'),
      story: colorOf('.rp-story-panel'),
      now: colorOf('.rp-now-panel'),
      timeline: colorOf('.rp-timeline'),
      tokens: {
        editor: resolveToken('--bg-editor'),
        sidebar: resolveToken('--bg-sidebar'),
        panel: resolveToken('--bg-panel'),
      },
    };
  });
}
