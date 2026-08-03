import { expect, test, type Page } from '@playwright/test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture, createTsSmallFixture } from './helpers/fixtures';
import { waitForTerminalOutput } from './helpers/terminal';

const SHOTS = '/tmp/charter-terminal-replay';

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

test.describe('Terminal Replay — real PTY black box', () => {
  test('records and replays every visible user/agent exchange while compressing idle time', async () => {
    const fixture = createGitFixture();
    const bin = createReplayClaudeBin(fixture);
    const { app, page, userDataDir } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    const errors = collectRendererErrors(page);
    try {
      await useSoftwareTerminalRenderer(page);
      await page.keyboard.press('Control+`');
      const liveTerminal = page.getByTestId('terminal-host').locator('.xterm');
      await expect(liveTerminal).toBeVisible({ timeout: 15_000 });
      await liveTerminal.click();
      await page.keyboard.type(join(bin, 'claude'), { delay: 1 });
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'AGENT-READY', { timeout: 15_000 });
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude', {
        timeout: 15_000,
      });

      await liveTerminal.click();
      await page.keyboard.type('user-visible-prompt', { delay: 5 });
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'agent-visible-answer', { timeout: 15_000 });
      await expect(page.getByTestId('session-bar-files')).toContainText('1 file', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('session-bar-ended')).toBeVisible({ timeout: 30_000 });

      const recordingDir = join(userDataDir, 'terminal-recordings');
      await expect
        .poll(() => readdirSync(recordingDir).filter((name) => name.endsWith('.cast')).length)
        .toBeGreaterThan(0);
      const castName = readdirSync(recordingDir).find((name) => name.endsWith('.cast'))!;
      const cast = readFileSync(join(recordingDir, castName), 'utf8');
      const castLines = cast
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(cast).toContain('user-visible-prompt');
      expect(cast).toContain('agent-visible-answer');
      expect(
        castLines
          .filter((line): line is unknown[] => Array.isArray(line))
          .every((event) => event[1] === 'o' || event[1] === 'r'),
      ).toBe(true);

      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('terminal-replay-player')).toBeVisible();
      await expect(page.getByText('Terminal Replay', { exact: true })).toBeVisible();
      await expect(page.getByText('Recorded', { exact: true })).toBeVisible();
      await expect(page.locator('.rp-story-panel, .rp-contract, .rp-summary')).toHaveCount(0);

      await expect(page.getByTestId('replay-view')).toHaveAttribute(
        'data-analysis-status',
        'ready',
        { timeout: 20_000 },
      );
      const thinkingMarker = page.locator(
        '[data-testid="terminal-replay-marker"][data-kind="thinking"]',
      );
      await expect(thinkingMarker).toBeVisible({ timeout: 20_000 });
      const compressedMotionMs = Number(await thinkingMarker.getAttribute('data-play-duration'));
      const originalMotionMs = Number(await thinkingMarker.getAttribute('data-original-duration'));
      expect(originalMotionMs).toBeGreaterThan(3_000);
      expect(compressedMotionMs).toBeLessThan(originalMotionMs / 2);

      const replayRows = page.locator('.trp-terminal-host .xterm-rows');
      await expect
        .poll(async () => (await replayRows.textContent()) ?? '', { timeout: 15_000 })
        .toContain('user-visible-prompt');
      await expect
        .poll(async () => (await replayRows.textContent()) ?? '')
        .toContain('agent-visible-answer');

      const seek = page.getByTestId('terminal-replay-seek');
      const smartMax = Number(await seek.getAttribute('max'));
      expect(smartMax).toBeGreaterThan(0);
      await thinkingMarker.click();
      await expect(thinkingMarker).toHaveAttribute('data-expanded', 'true');
      await expect(page.getByTestId('terminal-replay-smart-chip')).toBeVisible();
      await expect
        .poll(async () => Number(await seek.getAttribute('max')))
        .toBeGreaterThan(smartMax + 1_500);
      await page.screenshot({ path: join(SHOTS, 'terminal-replay-play-original.png') });
      await page.getByTestId('terminal-replay-play-original').click();
      await expect(thinkingMarker).toHaveAttribute('data-expanded', 'false');
      await page.getByTestId('terminal-replay-preset').selectOption('original');
      await expect
        .poll(async () => Number(await seek.getAttribute('max')))
        .toBeGreaterThan(smartMax);
      await page.getByTestId('terminal-replay-preset').selectOption('smart-60');
      await page.getByTestId('terminal-replay-speed').selectOption('4');
      await expect(page.getByTestId('terminal-replay-play')).toBeEnabled();
      await page.getByTestId('terminal-replay-play').click();
      await expect(page.getByTestId('terminal-replay-play')).toHaveAttribute(
        'aria-label',
        /Pause|Play/,
      );

      await seek.evaluate((node) => {
        const input = node as HTMLInputElement;
        input.value = input.max;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });

      await page.screenshot({ path: join(SHOTS, 'terminal-replay-1440.png') });

      // Export records the actual xterm canvas, then hands the WebM bytes to
      // Main. Stub only the native save picker/Finder reveal so CI can verify
      // the complete renderer → IPC → file path without desktop interaction.
      const exportedPath = join(userDataDir, 'terminal-replay-e2e.webm');
      await app.evaluate(({ dialog, shell }, path: string) => {
        Object.defineProperty(dialog, 'showSaveDialog', {
          configurable: true,
          value: async () => ({ canceled: false, filePath: path }),
        });
        Object.defineProperty(shell, 'showItemInFolder', {
          configurable: true,
          value: () => undefined,
        });
      }, exportedPath);
      await page.getByTestId('terminal-replay-export').click();
      await expect(page.getByTestId('terminal-replay-export-webm')).toBeVisible();
      await page.getByTestId('terminal-replay-export-webm').click();
      await expect.poll(() => existsSync(exportedPath), { timeout: 30_000 }).toBe(true);
      await expect(page.locator('.trp-export-dialog')).toHaveCount(0);
      expect(readFileSync(exportedPath).subarray(0, 4).toString('hex')).toBe('1a45dfa3');

      await setWindowSize(app, 1024, 768);
      await expect(page.getByTestId('terminal-replay-player')).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: join(SHOTS, 'terminal-replay-1024.png') });
      await assertNoFrameworkOverlay(page);
      expect(errors, errors.join('\n')).toEqual([]);

      await page.getByTestId('replay-close').click();
      await expect(page.getByTestId('replay-view')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('keeps playing while a live CLI recording grows instead of restarting every poll', async () => {
    test.setTimeout(90_000);
    const fixture = createGitFixture();
    const bin = createLiveReplayClaudeBin();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    const errors = collectRendererErrors(page);
    try {
      await useSoftwareTerminalRenderer(page);
      await page.keyboard.press('Control+`');
      const liveTerminal = page.getByTestId('terminal-host').locator('.xterm');
      await expect(liveTerminal).toBeVisible({ timeout: 15_000 });
      await liveTerminal.click();
      await page.keyboard.type(join(bin, 'claude'), { delay: 1 });
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'LIVE-AGENT-READY', { timeout: 15_000 });
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude', {
        timeout: 15_000,
      });

      await liveTerminal.click();
      await page.keyboard.type('live-user-prompt', { delay: 4 });
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'LIVE-FRAME-1', { timeout: 15_000 });
      await page.getByTestId('session-bar-room').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('terminal-replay-player')).toBeVisible();
      await expect(page.getByText('Recording', { exact: true })).toBeVisible();

      const seek = page.getByTestId('terminal-replay-seek');
      await expect
        .poll(async () => Number(await seek.getAttribute('max')), { timeout: 15_000 })
        .toBeGreaterThan(300);
      const replayXterm = page.locator('.trp-terminal-host .xterm');
      await expect(replayXterm).toBeVisible();
      await replayXterm.evaluate((node) => node.setAttribute('data-live-instance', 'stable'));

      const samples = await page.evaluate(async () => {
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="terminal-replay-seek"]',
        );
        if (!input) throw new Error('replay seek control missing');
        const values: Array<{ value: number; max: number }> = [];
        const started = performance.now();
        while (performance.now() - started < 4_500) {
          values.push({ value: Number(input.value), max: Number(input.max) });
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return values;
      });

      const firstProgress = samples.findIndex((sample) => sample.value > 300);
      expect(firstProgress).toBeGreaterThanOrEqual(0);
      for (let index = Math.max(1, firstProgress + 1); index < samples.length; index += 1) {
        expect(samples[index]!.value).toBeGreaterThanOrEqual(samples[index - 1]!.value - 100);
      }
      expect(Math.max(...samples.map((sample) => sample.max))).toBeGreaterThan(
        Math.min(...samples.map((sample) => sample.max)) + 1_000,
      );
      await expect(replayXterm).toHaveAttribute('data-live-instance', 'stable');
      await expect
        .poll(
          async () => (await page.locator('.trp-terminal-host .xterm-rows').textContent()) ?? '',
        )
        .toContain('LIVE-FRAME');

      const play = page.getByTestId('terminal-replay-play');
      await expect(play).toHaveAttribute('aria-label', 'Pause replay');
      await play.click();
      await expect(play).toHaveAttribute('aria-label', 'Play replay');
      const pausedAt = Number(await seek.inputValue());
      const pausedMax = Number(await seek.getAttribute('max'));
      await page.waitForTimeout(1_600);
      expect(Math.abs(Number(await seek.inputValue()) - pausedAt)).toBeLessThanOrEqual(20);
      await expect
        .poll(async () => Number(await seek.getAttribute('max')))
        .toBeGreaterThan(pausedMax);

      await play.click();
      await expect(play).toHaveAttribute('aria-label', 'Pause replay');
      await expect
        .poll(async () => Number(await seek.inputValue()))
        .toBeGreaterThan(pausedAt + 250);
      await page.screenshot({ path: join(SHOTS, 'terminal-replay-live-append.png') });
      await assertNoFrameworkOverlay(page);
      expect(errors, errors.join('\n')).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('does not offer a fabricated terminal movie for a managed non-PTY task', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] managed task');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 40_000,
      });
      await page.getByTestId('session-more').click();
      await expect(page.getByTestId('replay-open')).toHaveCount(0);
      await expect(page.locator('.rp-story-panel, .rp-contract, .rp-summary')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

function createReplayClaudeBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-terminal-replay-bin-'));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const target = ${JSON.stringify(target)};`,
      "process.stdout.write('\\u001b[36mAGENT-READY\\u001b[0m\\r\\n');",
      "process.stdin.setEncoding('utf8');",
      'let handled = false;',
      "process.stdin.on('data', (chunk) => {",
      "  if (handled || !chunk.includes('user-visible-prompt')) return;",
      '  handled = true;',
      "  process.stdout.write('\\u001b[33mUSER: user-visible-prompt\\u001b[0m\\r\\n');",
      "  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];",
      '  let frame = 0;',
      '  const thinking = setInterval(() => {',
      '    frame += 1;',
      '    process.stdout.write(`\\r\\u001b[2K${spinner[frame % spinner.length]} Thinking ${(frame / 10).toFixed(1)}s`);',
      '  }, 100);',
      '  setTimeout(() => {',
      '    clearInterval(thinking);',
      "    fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + 'export const terminalReplayTouch = 1;\\n');",
      "    process.stdout.write('\\r\\u001b[2K\\u001b[32mAGENT: agent-visible-answer\\u001b[0m\\r\\n');",
      '  }, 4200);',
      '  setTimeout(() => process.exit(0), 5400);',
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(1), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

function createLiveReplayClaudeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-terminal-replay-live-bin-'));
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "process.stdout.write('LIVE-AGENT-READY\\r\\n');",
      "process.stdin.setEncoding('utf8');",
      'let handled = false;',
      "process.stdin.on('data', (chunk) => {",
      "  if (handled || !chunk.includes('live-user-prompt')) return;",
      '  handled = true;',
      "  process.stdout.write('USER: live-user-prompt\\r\\n');",
      '  let frame = 0;',
      '  const timer = setInterval(() => {',
      '    frame += 1;',
      '    process.stdout.write(`LIVE-FRAME-${frame}\\r\\n`);',
      '    if (frame >= 24) {',
      '      clearInterval(timer);',
      '      setTimeout(() => process.exit(0), 1000);',
      '    }',
      '  }, 700);',
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(1), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
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
  await new Promise((resolve) => setTimeout(resolve, 160));
}

async function horizontalOverflow(page: Page): Promise<number> {
  return await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
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

async function assertNoFrameworkOverlay(page: Page): Promise<void> {
  await expect(
    page.locator('vite-error-overlay, .vite-error-overlay, #webpack-dev-server-client-overlay'),
  ).toHaveCount(0);
}
