import { expect, test } from '@playwright/test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

function createAgentFixture(): {
  bin: string;
  home: string;
  claudeProbe: string;
  kimiProbe: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'charter-agent-catalog-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const claudeProbe = join(root, 'claude-probe.log');
  const kimiProbe = join(root, 'kimi-probe.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const agent of ['claude', 'codex', 'kimi']) {
    const path = join(bin, agent);
    writeFileSync(
      path,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        ...(agent === 'kimi'
          ? [
              `const probe = ${JSON.stringify(kimiProbe)};`,
              'let interrupts = 0;',
              'let trusted = false;',
              "fs.appendFileSync(probe, 'argv=' + process.argv.slice(2).join(' ') + '\\n');",
              "console.log('\\u001b[?2004h Trust this folder? Kimi Code loads project-level MCP servers. Trust this folder Don\\'t trust');",
              "process.on('SIGINT', () => {",
              '  interrupts += 1;',
              "  fs.appendFileSync(probe, 'interrupt=' + interrupts + '\\n');",
              '  if (interrupts >= 3) process.exit(0);',
              '});',
              "process.stdin.on('data', (chunk) => {",
              '  const input = chunk.toString();',
              '  if (!trusted) {',
              "    if (!input.includes('\\r') && !input.includes('\\n')) return;",
              '    trusted = true;',
              "    fs.appendFileSync(probe, 'trust=accepted\\n');",
              "    console.log('\\u001b[2J Welcome to Kimi Code! Send /help for help information. No session yet — one will be created on your first message.');",
              '    return;',
              '  }',
              "  if (!input.includes('who are you')) return;",
              "  fs.appendFileSync(probe, 'prompt=who are you\\n');",
              "  console.log('Kimi prompt received');",
              '});',
            ]
          : []),
        ...(agent === 'claude'
          ? [
              `const probe = ${JSON.stringify(claudeProbe)};`,
              'let interrupts = 0;',
              "fs.appendFileSync(probe, 'started\\n');",
              "process.on('SIGINT', () => {",
              '  interrupts += 1;',
              "  fs.appendFileSync(probe, 'interrupt=' + interrupts + '\\n');",
              '});',
            ]
          : []),
        agent === 'kimi'
          ? ''
          : agent === 'claude'
            ? "console.log('\\u001b[?2004h Claude Code Welcome back! Tips for getting started');"
            : `console.log(${JSON.stringify(`${agent} ready`)});`,
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 30000);',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
  }
  return { bin, home, claudeProbe, kimiProbe };
}

test('auto-detects Agent CLIs, keeps official marks, and launches Kimi', async () => {
  test.setTimeout(90_000);
  const fixture = createGitFixture();
  const agents = createAgentFixture();
  const nodeBin = dirname(process.execPath);
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_AGENT_HOME: agents.home,
      // Product launches intentionally honor the user's interactive-shell
      // aliases. Isolate zsh startup here so a developer's real `kimi` alias
      // cannot bypass this test's trust-gate fixture.
      ZDOTDIR: agents.home,
      PATH: `${agents.bin}:${nodeBin}:/usr/bin:/bin`,
    },
    home: 'keep',
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page).toHaveTitle('Charter');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    // ADR-0054: the shell boots on Home even with a restored workspace.
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-agent').click();
    for (const agent of ['claude', 'codex', 'kimi']) {
      await expect(page.getByTestId(`home-agent-${agent}`)).toBeVisible();
    }

    const claudeMark = page.getByTestId('home-agent-claude').locator('[data-provider="claude"]');
    const codexMark = page.getByTestId('home-agent-codex').locator('[data-provider="codex"]');
    const kimiMark = page.getByTestId('home-agent-kimi').locator('[data-provider="kimi"]');
    await expect(claudeMark.locator('svg > path')).toHaveCount(1);
    await expect(codexMark.locator('svg > circle')).toHaveCount(1);
    await expect(codexMark.locator('svg > path')).toHaveCount(1);
    await expect(kimiMark.locator('svg > rect')).toHaveCount(3);
    await page.screenshot({ path: '/tmp/charter-agent-catalog-official-marks.png' });

    await page.setViewportSize({ width: 920, height: 760 });
    await expect(page.getByTestId('home-agent-menu')).toBeVisible();
    await expect(page.getByTestId('home-agent-kimi')).toBeVisible();
    await page.screenshot({ path: '/tmp/charter-agent-catalog-official-marks-narrow.png' });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByTestId('home-agent-kimi').click();
    await expect(page.getByTestId('home-agent')).toContainText('Kimi');
    await page.getByTestId('home-intent').fill('who are you');
    await page.getByTestId('home-submit').click();

    await expect
      .poll(() => (existsSync(agents.kimiProbe) ? readFileSync(agents.kimiProbe, 'utf8') : ''), {
        timeout: 20_000,
      })
      .toContain('prompt=who are you');
    expect(readFileSync(agents.kimiProbe, 'utf8')).toContain('trust=accepted');
    await expect(page.getByRole('textbox', { name: 'Terminal input' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Kimi.*who are you/ })).toBeVisible();

    await expect(page.getByTestId('rail-running-summary')).toHaveAttribute(
      'aria-label',
      '1 session running',
    );
    await page.getByTestId('rail-running-summary').click();
    await page.getByTestId('rail-stop-all-confirm-action').click();
    await expect
      .poll(() => (existsSync(agents.kimiProbe) ? readFileSync(agents.kimiProbe, 'utf8') : ''), {
        timeout: 20_000,
      })
      .toContain('interrupt=3');
    await expect(page.getByTestId('rail-running-summary')).toBeHidden({ timeout: 20_000 });
    await expect(
      page.locator('.toast.success').filter({ hasText: 'Stopped 1 running session' }),
    ).toBeVisible();

    // A stubborn Agent may ignore its trusted graceful exit sequence. The
    // globally confirmed action must force-close that exact PTY instead of
    // reporting a partial stop and leaving the process resident.
    const claudeTerminalId = await page.evaluate(async () => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt: 'stay resident for the Stop all regression',
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    });
    await expect
      .poll(
        () => (existsSync(agents.claudeProbe) ? readFileSync(agents.claudeProbe, 'utf8') : ''),
        {
          timeout: 20_000,
        },
      )
      .toContain('started');
    await expect(page.getByTestId('rail-running-summary')).toHaveAttribute(
      'aria-label',
      '1 session running',
      {
        timeout: 20_000,
      },
    );
    await page.getByTestId('rail-running-summary').click();
    await page.getByTestId('rail-stop-all-confirm-action').click();
    await expect
      .poll(
        () => (existsSync(agents.claudeProbe) ? readFileSync(agents.claudeProbe, 'utf8') : ''),
        {
          timeout: 20_000,
        },
      )
      .toContain('interrupt=2');
    await expect
      .poll(async () => {
        const result = (await page.evaluate(async () =>
          window.product.rpc['terminal.list']!({}),
        )) as { ok: true; data: { items: Array<{ id: string }> } } | { ok: false };
        return result.ok && !result.data.items.some((terminal) => terminal.id === claudeTerminalId);
      })
      .toBe(true);
    await expect(page.getByTestId('rail-running-summary')).toBeHidden({ timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
