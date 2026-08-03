import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

function createScrollableClaudeBin(): { bin: string; drawCount: () => number } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-scroll-claude-'));
  const probe = join(bin, 'draw-count');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const probe = ${JSON.stringify(probe)};`,
      'let drawCount = 0;',
      'process.stdin.setRawMode?.(true);',
      'process.stdin.resume();',
      "process.stdout.write('\\u001b[?1049h\\u001b[?1003h\\u001b[?1006h\\u001b[?25l');",
      'function render() {',
      '  drawCount += 1;',
      "  let output = '\\u001b[?2026h\\u001b[H';",
      '  for (let row = 1; row <= 44; row += 1) {',
      "    output += `\\u001b[${row};1H\\u001b[2Khistory-${drawCount}-${row} ${'x'.repeat(320)}\\r\\n`;",
      '  }',
      '  output += `\\u001b[45;1H\\u001b[2KSCROLL_DRAW_${drawCount}\\u001b[?2026l\\r\\n`;',
      '  process.stdout.write(output);',
      '  fs.writeFileSync(probe, String(drawCount));',
      '}',
      'render();',
      "process.stdin.on('data', (chunk) => {",
      "  const input = chunk.toString('binary');",
      '  const wheels = input.match(/\\u001b\\[<6[45];\\d+;\\d+[Mm]/g) ?? [];',
      '  for (const _wheel of wheels) render();',
      "  if (input.includes('\\u0003')) process.exit(0);",
      '});',
      'setTimeout(() => process.exit(0), 60_000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return {
    bin,
    drawCount: () => {
      try {
        return Number(readFileSync(probe, 'utf8')) || 0;
      } catch {
        return 0;
      }
    },
  };
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

async function terminalEventCount(page: Page, taskId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const result = (await window.product.rpc['task.get']!({ taskId: id, eventsAfter: 0 })) as {
      ok: boolean;
      error?: { userMessage?: string };
      data?: { timeline: Array<{ type: string }> };
    };
    if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.get failed');
    return result.data?.timeline.filter((event) => event.type === 'external.terminal').length ?? 0;
  }, taskId);
}

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

test('scrolling a long external TUI does not append Session timeline events', async () => {
  test.setTimeout(60_000);
  const fixture = createGitFixture();
  const fake = createScrollableClaudeBin();
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude',
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: fake.bin,
    },
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await useSoftwareTerminalRenderer(page);
    const terminalId = await page.evaluate(async () => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
      })) as { ok: boolean; data?: { id: string } };
      return result.ok ? (result.data?.id ?? null) : null;
    });
    expect(terminalId).toBeTruthy();
    await expect.poll(fake.drawCount, { timeout: 15_000 }).toBeGreaterThan(0);

    let taskId: string | null = null;
    await expect
      .poll(async () => {
        taskId = await externalTaskId(page, terminalId!);
        return taskId;
      })
      .not.toBeNull();

    await page.getByTestId(`home-task-${taskId!}`).click();
    const terminal = page.getByTestId('external-terminal-host');
    await expect(terminal).toHaveAttribute('data-terminal-id', terminalId!);
    const xterm = terminal.locator('.xterm');
    await expect(xterm).toBeVisible();

    // Let the initial paint's documentary event flush before taking the
    // baseline. Subsequent paints must still reach xterm, just not the task DB.
    await expect.poll(() => terminalEventCount(page, taskId!)).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    const baselineEvents = await terminalEventCount(page, taskId!);
    const baselineDraws = fake.drawCount();

    await xterm.hover();
    for (let index = 0; index < 40; index += 1) await page.mouse.wheel(0, -120);

    await expect.poll(fake.drawCount, { timeout: 15_000 }).toBeGreaterThan(baselineDraws + 5);
    await expect
      .poll(async () => {
        const text = (await terminal.locator('.xterm-rows').textContent()) ?? '';
        return Number(/SCROLL_DRAW_(\d+)/.exec(text)?.[1] ?? 0);
      })
      .toBeGreaterThan(baselineDraws + 5);
    await page.waitForTimeout(1_000);
    expect(await terminalEventCount(page, taskId!)).toBe(baselineEvents);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
