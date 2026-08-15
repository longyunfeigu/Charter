import { expect, test, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';
import { waitForTerminalOutput } from './helpers/terminal';

function createBackgroundClaude(fixture: string): { bin: string; marker: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-background-agent-'));
  const target = join(fixture, 'src', 'util.ts');
  const marker = join(bin, 'background-change.done');
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
      `const marker = ${JSON.stringify(marker)};`,
      "console.log('background-agent-ready');",
      "process.stdin.setEncoding('utf8');",
      'let scheduled = false;',
      "process.stdin.on('data', (input) => {",
      "  if (scheduled || !input.includes('continue-in-background')) return;",
      '  scheduled = true;',
      "  console.log('background-change-armed');",
      '  setTimeout(() => {',
      "    fs.appendFileSync(target, 'export const backgroundAgentTouch = 1;\\n');",
      "    fs.writeFileSync(marker, 'done\\n');",
      "    console.log('background-change-finished');",
      '  }, 1200);',
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return { bin, marker };
}

async function externalTaskId(page: Page, terminalId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const result = (await window.product.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    })) as {
      ok: boolean;
      data?: { tasks: Array<{ id: string; external: { terminalId: string } | null }> };
    };
    return result.data?.tasks.find((task) => task.external?.terminalId === id)?.id ?? null;
  }, terminalId);
}

test('a hidden Charter window keeps the Agent, accounting, and original Session alive', async () => {
  test.setTimeout(90_000);
  const fixture = createGitFixture();
  const fake = createBackgroundClaude(fixture);
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude',
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: fake.bin,
    },
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  try {
    await page.getByTestId('home-settings').click();
    const closeBehavior = page.getByTestId('settings-background-on-close');
    await expect(closeBehavior).toBeVisible();
    await closeBehavior.selectOption('keep-running');
    await expect
      .poll(async () => {
        const result = (await page.evaluate(async () =>
          window.product.rpc['settings.get']!({}),
        )) as { ok: boolean; data?: { effective?: { general?: { backgroundOnClose?: string } } } };
        return result.data?.effective?.general?.backgroundOnClose;
      })
      .toBe('keep-running');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 980, height: 720 });
    });
    await closeBehavior.scrollIntoViewIfNeeded();
    await expect(closeBehavior).toBeInViewport();
    await page.screenshot({ path: '/tmp/charter-background-settings-narrow.png' });
    await page.getByTestId('settings-back').click();

    const terminalId = await page.evaluate(async () => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
      })) as { ok: boolean; data?: { id: string } };
      return result.ok ? (result.data?.id ?? null) : null;
    });
    expect(terminalId).not.toBeNull();
    await waitForTerminalOutput(page, 'background-agent-ready', {
      terminalId: terminalId!,
      timeout: 20_000,
    });
    let taskId: string | null = null;
    await expect
      .poll(async () => {
        taskId = await externalTaskId(page, terminalId!);
        return taskId;
      })
      .not.toBeNull();
    await expect
      .poll(async () => {
        const result = (await page.evaluate(async () =>
          window.product.rpc['app.getBackgroundActivity']!({}),
        )) as { ok: boolean; data?: { agentCount?: number; background?: boolean } };
        return result.data;
      })
      .toMatchObject({ agentCount: 1, background: false });

    await page.evaluate(async (id) => {
      await window.product.rpc['terminal.write']!({
        id,
        data: 'continue-in-background\r',
        userInitiated: true,
      });
    }, terminalId!);
    await waitForTerminalOutput(page, 'background-change-armed', { terminalId: terminalId! });

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
      )
      .toBe(false);
    await expect.poll(() => existsSync(fake.marker), { timeout: 15_000 }).toBe(true);
    expect(readFileSync(join(fixture, 'src', 'util.ts'), 'utf8')).toContain('backgroundAgentTouch');

    const hiddenStatus = (await page.evaluate(async () =>
      window.product.rpc['app.getBackgroundActivity']!({}),
    )) as { ok: boolean; data?: { background?: boolean; agentCount?: number } };
    expect(hiddenStatus.data).toMatchObject({ background: true, agentCount: 1 });

    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('activate');
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
      )
      .toBe(true);
    await waitForTerminalOutput(page, 'background-change-finished', { terminalId: terminalId! });
    const changeSet = (await page.evaluate(
      async (id) => window.product.rpc['task.changeSet']!({ taskId: id }),
      taskId!,
    )) as {
      ok: boolean;
      data?: { changeSet?: { files?: Array<{ path: string }> } };
    };
    expect(changeSet.ok).toBe(true);
    expect(changeSet.data?.changeSet?.files?.map((file) => file.path)).toContain('src/util.ts');
    await expect
      .poll(async () => {
        const result = (await page.evaluate(async () =>
          window.product.rpc['app.getBackgroundActivity']!({}),
        )) as { ok: boolean; data?: { background?: boolean } };
        return result.data?.background;
      })
      .toBe(false);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
