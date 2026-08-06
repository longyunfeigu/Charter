import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import {
  terminalPtySnapshot,
  typeTerminalCommand,
  waitForTerminalOutput,
} from './helpers/terminal';

const REAL_CODEX = process.env.PI_IDE_REAL_EXTERNAL_CLI === '1';

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

test.describe('rich agent terminal output', () => {
  test('renders Claude and OSC file links blue with aligned Unicode tables', async () => {
    const fixture = createGitFixture();
    writeFileSync(join(fixture, 'rich-output.md'), '# Rich output\n');
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        ZDOTDIR: fixture,
        // Simulate Charter being launched from a log-oriented parent process.
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CLICOLOR: '0',
      },
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
    });

    try {
      await useSoftwareTerminalRenderer(page);
      await page.keyboard.press('Control+`');

      const xterm = page.locator('.xterm').last();
      await expect(xterm).toBeVisible({ timeout: 15_000 });
      const terminalId = (await terminalPtySnapshot(page)).items.at(-1)!.id;
      const envProbe =
        `printf '__RICH_ENV__ TERM=%s COLORTERM=%s TERM_PROGRAM=%s ` +
        `TERM_PROGRAM_VERSION=%s FORCE_HYPERLINK=%s NO_COLOR=%s FORCE_COLOR=%s CLICOLOR=%s\\n' ` +
        `"$TERM" "$COLORTERM" "$TERM_PROGRAM" "$TERM_PROGRAM_VERSION" "$FORCE_HYPERLINK" ` +
        `"\${NO_COLOR-unset}" "\${FORCE_COLOR-unset}" "\${CLICOLOR-unset}"`;
      await typeTerminalCommand(page, envProbe, { terminalId, xterm });
      await waitForTerminalOutput(
        page,
        /__RICH_ENV__ TERM=xterm-256color COLORTERM=truecolor TERM_PROGRAM=Charter TERM_PROGRAM_VERSION=\S+ FORCE_HYPERLINK=1 NO_COLOR=unset FORCE_COLOR=unset CLICOLOR=unset/,
        { terminalId },
      );

      const fileUri = `file://${join(fixture, 'rich-output.md')}`;
      const filePath = join(fixture, 'rich-output.md');
      const tableCommand =
        `printf '\\033[1mUpdate\\033[0m(\\033[4m${filePath}\\033[0m)\\n` +
        `\\033[90m\\033]8;;${fileUri}\\007rich-output.md\\033]8;;\\007 after-link\\033[0m\\n` +
        `┌────────────────┬────────────────┐\\n` +
        `│ 文件           │ 作用           │\\n` +
        `├────────────────┼────────────────┤\\n` +
        `│ rich-output.md │ 蓝色可点击     │\\n` +
        `└────────────────┴────────────────┘\\n__RICH_TABLE_DONE__\\n'`;
      await typeTerminalCommand(page, tableCommand, { terminalId, xterm });
      await waitForTerminalOutput(page, '__RICH_TABLE_DONE__', { terminalId });

      const rows = page.locator('.xterm-rows > div');
      await expect(
        rows.filter({ hasText: '┌────────────────┬────────────────┐' }).last(),
      ).toBeVisible();
      await expect(rows.filter({ hasText: '│ 文件' }).last()).toBeVisible();
      await expect(
        rows.filter({ hasText: '└────────────────┴────────────────┘' }).last(),
      ).toBeVisible();

      const claudeRow = rows.filter({ hasText: /^Update\(.+rich-output\.md\)$/ }).last();
      await expect(claudeRow).toBeVisible();
      const claudePathColors = await claudeRow
        .locator('span')
        .evaluateAll((spans) =>
          spans
            .filter((span) => span.textContent?.includes('rich-output.md'))
            .map((span) => getComputedStyle(span).color),
        );
      expect(claudePathColors).toContain('rgb(52, 101, 164)');

      const oscRow = rows.filter({ hasText: /^rich-output\.md after-link$/ }).last();
      await expect(oscRow).toBeVisible();
      const linkColors = await oscRow
        .locator('span')
        .evaluateAll((spans) =>
          spans
            .filter((span) => span.textContent?.includes('rich-output.md'))
            .map((span) => getComputedStyle(span).color),
        );
      expect(linkColors).toContain('rgb(52, 101, 164)');
      const tailColors = await oscRow
        .locator('span')
        .evaluateAll((spans) =>
          spans
            .filter((span) => span.textContent?.includes('after-link'))
            .map((span) => getComputedStyle(span).color),
        );
      expect(tailColors).toContain('rgb(85, 87, 83)');
      expect(rendererErrors).toEqual([]);

      if (process.env.PI_IDE_QA_SCREENSHOT) {
        await page.screenshot({ path: '/tmp/terminal-rich-output.png' });
        await app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 900 });
        });
        await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
        await expect(xterm).toContainText('__RICH_TABLE_DONE__');
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
        await page.screenshot({ path: '/tmp/terminal-rich-output-narrow.png' });
      }
    } finally {
      await app.close();
    }
  });

  test('real Codex launched from the Composer renders blue paths and a table', async () => {
    test.skip(!REAL_CODEX, 'set PI_IDE_REAL_EXTERNAL_CLI=1 to drive the authenticated Codex CLI');
    test.setTimeout(240_000);

    const fixture = createGitFixture();
    writeFileSync(join(fixture, 'rich-output.md'), '# Rich output\n');
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CLICOLOR: '0',
        // Reproduce an app launched from an Agent/ADE host: it suppresses
        // shell rc files and carries no usable proxy. The real Codex request
        // can pass only if Charter restores the user's zsh alias itself.
        ZDOTDIR: '/var/empty',
        CHARTER_USER_ZDOTDIR: '/var/empty',
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        ALL_PROXY: undefined,
        NO_PROXY: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        all_proxy: undefined,
        no_proxy: undefined,
      },
      home: 'keep',
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
    });

    try {
      await useSoftwareTerminalRenderer(page);
      const back = page.getByTestId('project-tool-back');
      if (await back.isVisible().catch(() => false)) await back.click();
      await expect(page.getByTestId('home-intent')).toBeVisible();

      const prompt = [
        'This is a read-only terminal rendering test. Do not call tools and do not edit files.',
        'Reply with only a short Chinese final answer, without a code fence.',
        'First show these exact relative paths as Markdown links whose label and target are identical:',
        '[rich-output.md](rich-output.md)',
        '[src/util.ts](src/util.ts)',
        '[package.json](package.json)',
        'Then render a Markdown table with columns 文件, 状态, 说明 and one row for each path.',
        'Use 存在 as every 状态 value and include 中文对齐 in every 说明 value.',
        'Finally join the fragments CHARTER, RICH, DONE with underscores and print that token.',
      ].join(' ');
      await page.getByTestId('home-agent').click();
      await page.getByTestId('home-agent-codex').click();
      await expect(page.getByTestId('home-agent')).toContainText('Codex');
      await page.getByTestId('home-intent').fill(prompt);
      await page.getByTestId('home-submit').click();

      const xterm = page.locator('.xterm').last();
      await expect(xterm).toBeVisible({ timeout: 30_000 });
      const terminalSnapshot = await terminalPtySnapshot(page);
      const terminalId = terminalSnapshot.items.at(-1)?.id;
      expect(terminalId).toBeTruthy();
      expect(terminalSnapshot.items.find((item) => item.id === terminalId)?.launch).toBe('codex');
      await expect(
        page.getByTestId('external-live').or(page.getByTestId('session-agent-status')),
      ).toBeVisible({ timeout: 45_000 });

      const terminalText = page
        .getByTestId('external-terminal-host')
        .or(page.getByTestId('session-terminal-host'))
        .or(page.getByTestId('terminal-host'));
      await expect(terminalText).toBeVisible({ timeout: 30_000 });
      await expect(terminalText).toContainText(/trust/i, { timeout: 30_000 });
      await terminalText.click();
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, /OpenAI\s*Codex/, {
        terminalId: terminalId!,
        timeout: 30_000,
      });

      await waitForTerminalOutput(page, 'CHARTER_RICH_DONE', {
        terminalId: terminalId!,
        timeout: 180_000,
      });
      await expect(terminalText).toContainText('文件');
      await expect(terminalText).toContainText('状态');
      await expect(terminalText).toContainText('中文对齐');

      const pathStyles = await xterm.locator('.xterm-rows span').evaluateAll((spans) =>
        spans
          .map((span) => ({
            text: span.textContent ?? '',
            color: getComputedStyle(span).color,
          }))
          .filter(({ text }) =>
            ['rich-output.md', 'src/util.ts', 'package.json'].some((path) => text.includes(path)),
          ),
      );
      const bluePaths = pathStyles.filter(({ color }) => {
        const channels = color.match(/\d+/g)?.map(Number) ?? [];
        const [red = 0, green = 0, blue = 0] = channels;
        return blue > red && blue >= green;
      });
      expect(bluePaths.length).toBeGreaterThanOrEqual(3);

      await page.screenshot({ path: '/tmp/terminal-real-codex-rich-output.png' });
      await page.setViewportSize({ width: 1040, height: 760 });
      await expect(terminalText).toContainText('CHARTER_RICH_DONE');
      await page.screenshot({ path: '/tmp/terminal-real-codex-rich-output-narrow.png' });
      expect(rendererErrors).toEqual([]);

      await terminalText.click();
      await page.keyboard.press('Escape');
      await page.keyboard.type('/exit');
      await page.keyboard.press('Enter');
    } finally {
      await app.close();
    }
  });
});
