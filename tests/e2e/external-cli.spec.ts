import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { terminalPtySnapshot, waitForTerminalOutput } from './helpers/terminal';

async function switchReplayDepth(page: Page, depth: 'recap' | 'explore' | 'verify') {
  await page.getByTestId('replay-menu-toggle').click();
  await page.getByTestId(`replay-depth-${depth}`).click();
}

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

/**
 * ADR-0017 — external CLI agent sessions. A fake agent CLI (a node script, so
 * detection exercises the interpreter/descendant-scan path like an
 * npm-installed claude) runs inside a REAL embedded PTY, edits a workspace
 * file and exits. The product must detect the session, badge the terminal,
 * account the change, offer the session room and land in REVIEW_READY.
 */

function createFakeAgentBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-fakebin-'));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  const generated = join(fixture, 'dist/bundle.js').replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'fakeagent'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const target = ${JSON.stringify(target)};`,
      `const generated = ${JSON.stringify(generated)};`,
      "console.log('✳ fake agent session started');",
      'setTimeout(() => {',
      "  const src = fs.readFileSync(target, 'utf8');",
      "  fs.writeFileSync(target, src + 'export const externalTouch = 1;\\n');",
      "  fs.mkdirSync(require('path').dirname(generated), { recursive: true });",
      "  fs.writeFileSync(generated, 'generated build output\\n');",
      "  console.log('✏ edited src/util.ts');",
      '}, 1500);',
      // Long enough to promote the pane and type into the live PTY mid-session.
      'setTimeout(() => process.exit(0), 12000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'fakeagent'), 0o755);
  return bin;
}

function pinFixtureCliPath(bin: string): void {
  // The embedded zsh intentionally sources the user's login files. A machine
  // with a real Claude/Codex install may prepend its own bin directory there,
  // so give these deterministic CLI tests an isolated user ZDOTDIR.
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
}

function createResumableClaudeBin(initialDurationMs = 3500): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-resume-bin-'));
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const resumed = process.argv.includes('--continue');",
      "console.log(resumed ? 'resumed-original-session' : 'original-session-started');",
      "console.log(resumed ? 'resume-arg=--continue' : 'resume-arg=none');",
      `setTimeout(() => process.exit(0), resumed ? 6000 : ${initialDurationMs});`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return bin;
}

/** First run edits a file (so review has something to accept) and exits;
 * a resumed run prints its marker and stays up long enough to observe. */
function createHistoryClaudeBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-history-bin-'));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const target = ${JSON.stringify(target)};`,
      "const resumed = process.argv.includes('--continue') || process.argv.includes('--resume');",
      "console.log(resumed ? 'resumed-original-session' : 'original-session-started');",
      'if (!resumed) {',
      '  setTimeout(() => {',
      "    fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + 'export const externalTouch = 1;\\n');",
      '  }, 900);',
      '}',
      'setTimeout(() => process.exit(0), resumed ? 8000 : 3500);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return bin;
}

function createActiveEditingCodexBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-active-codex-bin-'));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const target = ${JSON.stringify(target)};`,
      "console.log('active-codex-started');",
      'setTimeout(() => {',
      "  fs.writeFileSync(target, fs.readFileSync(target, 'utf8') + 'export const activeCodexTouch = 1;\\n');",
      '}, 900);',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'codex'), 0o755);
  pinFixtureCliPath(bin);
  return bin;
}

function createComposerClaudeBin(): { bin: string; probe: string } {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-composer-bin-'));
  const probe = join(bin, 'probe.log');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const probe = ${JSON.stringify(probe)};`,
      "fs.appendFileSync(probe, 'argv=' + process.argv.slice(2).join(' ') + '\\n');",
      "console.log('fake-claude-tui-ready');",
      "process.stdin.on('data', (chunk) => {",
      "  if (chunk.toString().includes('hi from composer')) {",
      '    // Canonical-mode PTY stdin only releases a line once Enter arrives —',
      '    // seeing the prompt here proves the paste AND the separate Enter.',
      "    fs.appendFileSync(probe, 'got-prompt-line\\n');",
      '    setTimeout(() => process.exit(0), 3000);',
      '  }',
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return { bin, probe };
}

function createSilentWritingClaudeBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-silent-write-bin-'));
  const target = join(fixture, 'silent-new.html').replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const target = ${JSON.stringify(target)};`,
      'let started = false;',
      "console.log('silent-claude-ready');",
      "process.stdin.on('data', (chunk) => {",
      "  if (started || !chunk.toString().includes('build silent file')) return;",
      '  started = true;',
      "  console.log('prompt-accepted-before-silence');",
      // Longer than the historical 1s quiet + 2s fs grace window.
      '  setTimeout(() => {',
      "    fs.writeFileSync(target, '<!doctype html><title>silent write</title>\\n');",
      '  }, 4500);',
      "  setTimeout(() => console.log('silent-write-complete'), 4800);",
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return bin;
}

function createParallelAgentBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-parallel-bin-'));
  for (const cli of ['claude', 'codex']) {
    writeFileSync(
      join(bin, cli),
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${cli}-parallel-started`)});`,
        `console.log(${JSON.stringify(`${cli}-pty-live`)});`,
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 30000);',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, cli), 0o755);
  }
  pinFixtureCliPath(bin);
  return bin;
}

function createReloadTuiClaudeBin(): { bin: string; freeze: string; frozen: string } {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-reload-tui-bin-'));
  const freeze = join(bin, 'freeze');
  const frozen = join(bin, 'frozen');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const freeze = ${JSON.stringify(freeze)};`,
      `const frozen = ${JSON.stringify(frozen)};`,
      'let isFrozen = false;',
      'let frozenCols = 0;',
      "function draw(label = 'RELOAD_TUI_BOTTOM') {",
      '  const cols = process.stdout.columns || 80;',
      '  const rows = process.stdout.rows || 24;',
      "  process.stdout.write('\\u001b[?1049h\\u001b[2J\\u001b[HRELOAD_TUI_TOP');",
      '  process.stdout.write(`\\u001b[${rows};1H${label} rows=${rows} cols=${cols}`);',
      '}',
      'const timer = setInterval(() => {',
      '  if (fs.existsSync(freeze)) {',
      '    clearInterval(timer);',
      '    isFrozen = true;',
      '    frozenCols = process.stdout.columns || 80;',
      "    fs.writeFileSync(frozen, 'frozen');",
      '    return;',
      '  }',
      '  draw();',
      '}, 100);',
      "process.on('SIGWINCH', () => {",
      '  if (!isFrozen) return;',
      "  if ((process.stdout.columns || 80) !== frozenCols) draw('RELOAD_TUI_RECOVERED');",
      '});',
      'draw();',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return { bin, freeze, frozen };
}

function createDecReplayClaudeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-dec-replay-bin-'));
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      // Keep G0 in DEC Special Graphics while the raw tail crosses 64 KiB.
      // A renderer that adopts this PTY without the restored designation
      // renders the final box as literal l/q/k/x/m/j characters.
      "console.log('DEC AGENT READY');",
      'setTimeout(() => {',
      "  process.stdout.write('\\u001b(0' + 'q'.repeat(70 * 1024));",
      "  process.stdout.write('\\u001b[2J\\u001b[HDEC REPLAY TOP\\r\\nlqqqqqqk\\r\\nx      x\\r\\nmqqqqqqj');",
      '}, 1500);',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  pinFixtureCliPath(bin);
  return bin;
}

async function tuiMarkerPosition(page: Page): Promise<{ index: number; rows: number }> {
  const lines = await page
    .getByTestId('external-terminal-host')
    .locator('.xterm-rows > div')
    .allTextContents();
  return {
    index: lines.findIndex(
      (line) => line.includes('RELOAD_TUI_BOTTOM') || line.includes('RELOAD_TUI_RECOVERED'),
    ),
    rows: lines.length,
  };
}

interface E2ETerminalInfo {
  id: string;
  pid: number;
  cwd: string;
  projectPath: string | null;
}

type E2ETerminalListResult =
  { ok: true; data: { items: E2ETerminalInfo[] } } | { ok: false; data?: undefined };

test.describe('ADR-0017 external CLI agent sessions', () => {
  test('a live external terminal reconnects after the renderer reloads', async () => {
    const fixture = createGitFixture();
    const tui = createReloadTuiClaudeBin();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${tui.bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: tui.bin,
      },
    });
    try {
      await useSoftwareTerminalRenderer(page);
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('terminal-host').locator('.xterm').click();
      await page.keyboard.type(join(tui.bin, 'claude'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude', {
        timeout: 15_000,
      });

      const beforeReload = await page.evaluate(async () => {
        const terminalResult = (await window.product.rpc['terminal.list']!(
          {},
        )) as E2ETerminalListResult;
        const taskResult = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
        })) as {
          ok: true;
          data: { tasks: Array<{ id: string; external: { terminalId: string } | null }> };
        };
        const task = taskResult.data.tasks.find((candidate) => candidate.external);
        return {
          terminalId: terminalResult.ok ? terminalResult.data.items[0]?.id : null,
          taskId: task?.id ?? null,
        };
      });
      expect(beforeReload.terminalId).toBeTruthy();
      expect(beforeReload.taskId).toBeTruthy();

      const rowBeforeReload = page.getByTestId(`home-task-${beforeReload.taskId}`);
      await expect(rowBeforeReload).toBeVisible({ timeout: 15_000 });
      await rowBeforeReload.click();
      await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
        'data-terminal-id',
        beforeReload.terminalId!,
      );
      await expect
        .poll(() => tuiMarkerPosition(page), { timeout: 15_000 })
        .toMatchObject({ index: expect.any(Number), rows: expect.any(Number) });
      await expect
        .poll(async () => {
          const marker = await tuiMarkerPosition(page);
          return marker.index >= marker.rows - 2;
        })
        .toBe(true);
      writeFileSync(tui.freeze, 'freeze');
      await expect.poll(() => existsSync(tui.frozen)).toBe(true);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const rowAfterReload = page.getByTestId(`home-task-${beforeReload.taskId}`);
      await expect(rowAfterReload).toBeVisible({ timeout: 15_000 });
      await rowAfterReload.click();
      await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
        'data-terminal-id',
        beforeReload.terminalId!,
        { timeout: 15_000 },
      );
      await expect(page.getByTestId('external-terminal-gone')).toHaveCount(0);
      await expect(page.getByTestId('external-terminal-host').locator('.xterm-rows')).toContainText(
        'RELOAD_TUI_RECOVERED',
      );
      await expect
        .poll(async () => {
          const marker = await tuiMarkerPosition(page);
          return marker.index >= marker.rows - 2;
        })
        .toBe(true);
    } finally {
      await app.close();
    }
  });

  test('a truncated DEC line-drawing tail survives renderer reload', async () => {
    const fixture = createGitFixture();
    const bin = createDecReplayClaudeBin();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      await useSoftwareTerminalRenderer(page);
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('terminal-host').locator('.xterm').click();
      await page.keyboard.type(join(bin, 'claude'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude', {
        timeout: 15_000,
      });

      const session = await page.evaluate(async () => {
        const terminalResult = (await window.product.rpc['terminal.list']!(
          {},
        )) as E2ETerminalListResult;
        const taskResult = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
        })) as {
          ok: true;
          data: { tasks: Array<{ id: string; external: { terminalId: string } | null }> };
        };
        const task = taskResult.data.tasks.find((candidate) => candidate.external);
        return {
          terminalId: terminalResult.ok ? terminalResult.data.items[0]?.id : null,
          taskId: task?.id ?? null,
        };
      });
      expect(session.terminalId).toBeTruthy();
      expect(session.taskId).toBeTruthy();
      await waitForTerminalOutput(page, 'DEC REPLAY TOP', {
        terminalId: session.terminalId!,
      });

      const openSession = async (): Promise<void> => {
        const row = page.getByTestId(`home-task-${session.taskId}`);
        await expect(row).toBeVisible({ timeout: 15_000 });
        await row.click();
        await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
          'data-terminal-id',
          session.terminalId!,
        );
      };
      const screen = page.getByTestId('external-terminal-host').locator('.xterm-rows');

      await openSession();
      await expect(screen).toContainText('DEC REPLAY TOP');
      await expect(screen).toContainText('┌──────┐');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await openSession();
      await expect(screen).toContainText('DEC REPLAY TOP');
      await expect(screen).toContainText('┌──────┐');
      await expect(screen).not.toContainText('lqqqqqqk');
    } finally {
      await app.close();
    }
  });

  test('Codex and Claude survive editor focus changes and atomically swap the side slot', async () => {
    const charter = createGitFixture();
    const writing = createGitFixture();
    const charterCanonical = realpathSync(charter);
    const writingCanonical = realpathSync(writing);
    const bin = createParallelAgentBin();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: charter,
        PI_IDE_EXTERNAL_CLIS: 'claude,codex',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    const captureVisuals = process.env.PI_IDE_CAPTURE_TERMINAL_VNEXT === '1';
    const visualDir = join(process.cwd(), 'docs/design/audit');
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo codex-shell-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'codex-shell-ready');
      await page.keyboard.type(join(bin, 'codex'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Codex', {
        timeout: 15000,
      });

      const first = await page.evaluate(async () => {
        const result = (await window.product.rpc['terminal.list']!({})) as E2ETerminalListResult;
        return result.ok ? result.data.items[0] : null;
      });
      expect(first?.projectPath).toBe(charterCanonical);

      // Editor focus moves to another project. The first PTY and its external
      // accounting watcher remain bound to Charter's host-resolved context.
      await page.evaluate(async (path) => {
        await window.product.rpc['workspace.open']!({ path });
      }, writing);
      await expect(page.getByTestId('workspace-chip')).toContainText('fixture');
      const afterFocusChange = await page.evaluate(async () => {
        const result = (await window.product.rpc['terminal.list']!({})) as E2ETerminalListResult;
        return result.ok ? result.data.items : [];
      });
      expect(afterFocusChange).toHaveLength(1);
      expect(afterFocusChange[0]?.id).toBe(first?.id);
      expect(afterFocusChange[0]?.pid).toBe(first?.pid);

      await page.getByTestId('terminal-new').click();
      await expect
        .poll(async () => {
          return page.evaluate(async () => {
            const result = (await window.product.rpc['terminal.list']!(
              {},
            )) as E2ETerminalListResult;
            return result.ok ? result.data.items.length : 0;
          });
        })
        .toBe(2);
      await page.getByTestId('terminal-host').locator('.xterm').click();
      await page.keyboard.type('echo claude-shell-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'claude-shell-ready');
      await page.keyboard.type(join(bin, 'claude'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(2, {
        timeout: 15000,
      });

      const terminals = await page.evaluate(async () => {
        const result = (await window.product.rpc['terminal.list']!({})) as E2ETerminalListResult;
        return result.ok ? result.data.items : [];
      });
      const codex = terminals.find((terminal) => terminal.projectPath === charterCanonical)!;
      const claude = terminals.find((terminal) => terminal.projectPath === writingCanonical)!;
      expect(codex.cwd).toBe(charterCanonical);
      expect(claude.cwd).toBe(writingCanonical);

      if (captureVisuals) {
        mkdirSync(visualDir, { recursive: true });
        await page.getByTestId(`terminal-tab-${codex.id}`).click();
        await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex');
        await page
          .getByRole('button', { name: 'Dismiss' })
          .evaluateAll((buttons) =>
            buttons.forEach((button) => (button as HTMLButtonElement).click()),
          );
        await page.screenshot({
          path: join(visualDir, 'terminal-vnext-implementation-01-bottom.png'),
        });
        await page.getByTestId(`terminal-tab-${claude.id}`).click();
        await expect(page.getByTestId('terminal-session-bar')).toContainText('Claude Code');
      }

      // Claude moves right; Codex remains selected and live in the Bottom Panel.
      await page.getByTestId('session-bar-promote').click();
      await expect(page.getByTestId('external-panel')).toContainText('claude');
      await expect(page.getByTestId('external-panel-terminal')).toHaveAttribute(
        'data-terminal-id',
        claude.id,
      );
      await expect(
        page.getByTestId('external-panel-terminal').locator('.xterm-screen'),
      ).toBeVisible();
      await waitForTerminalOutput(page, 'claude-parallel-started', { terminalId: claude.id });
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex');
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);

      // The row itself is the switcher. One click swaps the same two xterms:
      // no small secondary target, no kill/create and both scrollbacks remain.
      await page.getByTestId(`terminal-tab-${codex.id}`).click();
      await expect(page.getByTestId('external-panel')).toContainText('codex');
      await expect(page.getByTestId('external-panel-terminal')).toHaveAttribute(
        'data-terminal-id',
        codex.id,
      );
      await waitForTerminalOutput(page, 'codex-parallel-started', { terminalId: codex.id });
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Claude Code');
      await expect(page.getByTestId(`terminal-tab-${codex.id}`)).toContainText('IN SIDE');
      await expect(page.getByTestId(`terminal-tab-${codex.id}`)).toHaveClass(/selected/);
      await expect(page.getByTestId(`terminal-tab-${claude.id}`)).toHaveClass(/dock-active/);
      const afterSwap = await page.evaluate(async () => {
        const result = (await window.product.rpc['terminal.list']!({})) as E2ETerminalListResult;
        return result.ok ? result.data.items : [];
      });
      expect(afterSwap.map((terminal) => [terminal.id, terminal.pid])).toEqual(
        terminals.map((terminal) => [terminal.id, terminal.pid]),
      );

      // At the narrow laptop layout reported in the field, the terminal list
      // compacts and the remounted xterm stays inside its real host bounds.
      await page.setViewportSize({ width: 1024, height: 720 });
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
      if (process.env.PI_IDE_CAPTURE_TERMINAL_FIX === '1') {
        await page.screenshot({ path: join(tmpdir(), 'pi-ide-terminal-switch-fix.png') });
      }
      await expect
        .poll(async () => {
          const geometry = await page.evaluate(() => {
            const host = document.querySelector<HTMLElement>('[data-testid="terminal-host"]');
            const screen = host?.querySelector<HTMLElement>('.xterm-screen');
            const main = document.querySelector<HTMLElement>('.terminal-main-pane');
            const panel = document.querySelector<HTMLElement>('[data-testid="terminal-panel"]');
            const list = document.querySelector<HTMLElement>('.terminal-list');
            const action = document.querySelector<HTMLElement>(
              '[data-testid="session-bar-promote"]',
            );
            if (!host || !screen || !main || !panel || !list || !action) return null;
            const hostBox = host.getBoundingClientRect();
            const screenBox = screen.getBoundingClientRect();
            const mainBox = main.getBoundingClientRect();
            const panelBox = panel.getBoundingClientRect();
            const listBox = list.getBoundingClientRect();
            const actionBox = action.getBoundingClientRect();
            return {
              screenRightInside: screenBox.right <= hostBox.right + 1,
              screenBottomInside: screenBox.bottom <= hostBox.bottom + 1,
              actionInside: actionBox.right <= mainBox.right + 1,
              panelWidth: Math.round(panelBox.width),
              mainWidth: Math.round(mainBox.width),
              listWidth: Math.round(listBox.width),
              hostRight: Math.round(hostBox.right),
              screenRight: Math.round(screenBox.right),
              hostBottom: Math.round(hostBox.bottom),
              screenBottom: Math.round(screenBox.bottom),
              mainRight: Math.round(mainBox.right),
              actionRight: Math.round(actionBox.right),
            };
          });
          if (geometry?.screenRightInside && geometry.screenBottomInside && geometry.actionInside) {
            return 'inside';
          }
          return JSON.stringify(geometry);
        })
        .toBe('inside');
      await page.getByTestId(`terminal-tab-${claude.id}`).click();
      await expect(page.getByTestId('external-panel')).toContainText('claude');
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex');
      await expect(page.getByTestId(`terminal-tab-${claude.id}`)).toHaveClass(/selected/);
      await expect(page.getByTestId(`terminal-tab-${codex.id}`)).toHaveClass(/dock-active/);
      await page.getByTestId(`terminal-tab-${codex.id}`).click();
      await expect(page.getByTestId('external-panel')).toContainText('codex');
      await page.setViewportSize({ width: 1440, height: 900 });
      if (process.env.PI_IDE_CAPTURE_TERMINAL_FIX === '1') {
        await page.screenshot({ path: join(tmpdir(), 'pi-ide-terminal-focus-color-fix.png') });
      }
      if (captureVisuals) {
        await page.screenshot({
          path: join(visualDir, 'terminal-vnext-implementation-02-codex-side.png'),
        });
      }

      await page.getByTestId('external-return-dock').click();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId(`terminal-tab-${codex.id}`)).not.toContainText('IN SIDE');
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await expect(page.getByTestId('sidebar')).toHaveCount(0);

      // Seed the fourth context kind used by the approved visual: a real
      // isolated Task worktree. Returning editor focus to Charter makes
      // Writing the recent project without changing either live terminal.
      await page.evaluate(
        async ({ projectPath }) => {
          await window.product.rpc['task.create']!({
            title: 'Terminal resize',
            goalMd: 'Verify terminal resize behavior.',
            acceptance: ['Terminal remains live while its panel resizes.'],
            mode: 'edit',
            model: { providerId: 'mock', modelId: 'mock-default' },
            verification: [],
            projectPath,
            isolation: 'worktree',
            conversationRefTaskIds: [],
          });
          await window.product.rpc['workspace.open']!({ path: projectPath });
        },
        { projectPath: charter },
      );

      await page.getByTestId('terminal-new-menu').click();
      const chooser = page.getByTestId('terminal-create-dialog');
      await expect(chooser).toBeVisible();
      await page.getByTestId('terminal-type-codex').click();
      await page.getByTestId('terminal-context-recent').click();
      await expect(chooser).toContainText('Editor focus');
      await expect(chooser).toContainText('RECENT PROJECT');
      await expect(chooser).toContainText('ISOLATED');
      await expect(chooser).toContainText('Create Codex');
      if (captureVisuals) {
        await page.getByTestId('terminal-type-claude').click();
        await expect(chooser).toContainText('Create Claude Code');
        await page.screenshot({
          path: join(visualDir, 'terminal-vnext-implementation-03-new-terminal.png'),
        });
      }
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('composer launch: pre-assigned id, auto-sent first message, named session, exact resume', async () => {
    const fixture = createGitFixture();
    const { bin, probe } = createComposerClaudeBin();
    const readProbe = (): string => {
      try {
        return readFileSync(probe, 'utf8');
      } catch {
        return '';
      }
    };
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      // Product launch path (Home composer → Claude backend): the first
      // message rides terminal.create; the renderer writes no PTY bytes.
      const terminalId = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: { id: string } }>>;
            };
          }
        ).product;
        const res = await bridge.rpc['terminal.create']!({
          context: { kind: 'focused' },
          launch: 'claude',
          initialPrompt: 'hi from composer',
        });
        return res.ok ? (res.data?.id ?? null) : null;
      });
      expect(terminalId).not.toBeNull();

      // The launch pre-assigns the conversation id (`--session-id <uuid>`).
      // The terminal-control wrapper prepends `--mcp-config=…` (session
      // orchestration), so the id flag is asserted anywhere in the argv line.
      await expect
        .poll(readProbe, { timeout: 20000 })
        .toMatch(/argv=.*--session-id [0-9a-f][0-9a-f-]{34}[0-9a-f]/);
      const sessionId = /--session-id ([0-9a-f-]{36})/.exec(readProbe())![1]!;

      // The first message is delivered by the host and actually submitted.
      await expect.poll(readProbe, { timeout: 20000 }).toContain('got-prompt-line');

      // The Session is named by the user's message and resumable by exact id.
      const task = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{
                  data?: {
                    tasks?: Array<{
                      id: string;
                      title: string;
                      external: { sessionId: string | null } | null;
                    }>;
                  };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return result.data?.tasks?.find((candidate) => candidate.external) ?? null;
      });
      expect(task).not.toBeNull();
      expect(task!.title).toBe('hi from composer');
      expect(task!.external?.sessionId).toBe(sessionId);

      const row = page.getByTestId(`home-task-${task!.id}`);
      await expect(row).toContainText('hi from composer');
      await expect(row).toHaveAttribute('data-working', 'true');
      await expect(row.locator('.sr-provider')).toHaveClass(/is-working/);

      // CLI exit closes the session as "Ended", never "Answered" — and an
      // ended session with nothing to decide parks under History in the rail.
      const historyToggle = page.getByTestId('rail-group-history');
      await expect(historyToggle).toBeVisible({ timeout: 25000 });
      if ((await historyToggle.getAttribute('aria-expanded')) !== 'true') {
        await historyToggle.click();
      }
      await expect(row).toHaveAttribute('data-state', 'REVIEW_READY', { timeout: 25000 });
      await expect(row).toHaveAttribute('data-working', 'false');
      await expect(row).toContainText('Ended');
      await expect(row).toContainText('Session ended · no file changes');

      // Resume targets THIS conversation, not "whatever ran here last".
      const resumeOk = await page.evaluate(
        async (payload) => {
          const bridge = (
            window as never as {
              product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean }>> };
            }
          ).product;
          const res = await bridge.rpc['external.resumeSession']!(payload);
          return res.ok;
        },
        { taskId: task!.id, terminalId: terminalId! },
      );
      expect(resumeOk).toBe(true);
      // Same wrapper tolerance: `--mcp-config=…` may precede the resume flag.
      await expect
        .poll(readProbe, { timeout: 20000 })
        .toMatch(new RegExp(`argv=.*--resume ${sessionId}`));
    } finally {
      await app.close();
    }
  });

  test('a file created after observed terminal quiet stays live in Summary and Diff', async () => {
    const fixture = createGitFixture();
    const bin = createSilentWritingClaudeBin(fixture);
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      const terminalId = await page.evaluate(async () => {
        const result = (await window.product.rpc['terminal.create']!({
          context: { kind: 'focused' },
          launch: 'claude',
          initialPrompt: 'build silent file',
        })) as { ok: boolean; data?: { id: string } };
        return result.ok ? (result.data?.id ?? null) : null;
      });
      expect(terminalId).not.toBeNull();
      await waitForTerminalOutput(page, 'prompt-accepted-before-silence', {
        terminalId: terminalId!,
        timeout: 20_000,
      });

      const readTaskId = (): Promise<string | null> =>
        page.evaluate(async () => {
          const result = (await window.product.rpc['task.list']!({
            filter: 'all',
            includeArchived: false,
          })) as {
            ok: boolean;
            data?: { tasks: Array<{ id: string; external: unknown }> };
          };
          return result.ok ? (result.data?.tasks.find((task) => task.external)?.id ?? null) : null;
        });
      await expect.poll(readTaskId, { timeout: 20_000 }).not.toBeNull();
      const taskId = await readTaskId();
      expect(taskId).not.toBeNull();

      const row = page.getByTestId(`home-task-${taskId!}`);
      await expect(row).toHaveAttribute('data-working', 'false', { timeout: 10_000 });
      await row.click();
      const tools = page.getByTestId('session-tools-open');
      if (await tools.isVisible()) await tools.click();

      const tile = page.getByTestId('live-tile-silent-new.html');
      await expect(tile).toBeVisible({ timeout: 15_000 });
      await expect(tile).toContainText('observed');
      await expect(page.getByTestId('session-summary')).toContainText('changes/min');
      await page.waitForTimeout(250);
      await page.screenshot({ path: '/tmp/charter-external-delayed-write-summary.png' });

      const diff = page.getByTestId('session-tool-diff');
      await expect(diff).toBeEnabled();
      await diff.click();
      await expect(page.getByTestId('session-diff-file-silent-new.html')).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('session-inline-diff')).toContainText('silent write');
      await page.waitForTimeout(250);
      await page.screenshot({ path: '/tmp/charter-external-delayed-write-diff.png' });
    } finally {
      await app.close();
    }
  });

  test('ended Claude session resumes in the same Task and terminal', async () => {
    const fixture = createGitFixture();
    const bin = createResumableClaudeBin();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo ready-marker');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'ready-marker');
      await page.keyboard.type(join(bin, 'claude'));
      await page.keyboard.press('Enter');

      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude Code', {
        timeout: 15000,
      });
      await expect(page.getByTestId('session-bar-ended')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      const resume = page.getByTestId('task-resume');
      await expect(resume).toContainText('Resume Claude session');

      const taskIdBefore = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (payload: unknown) => Promise<{
                  data?: { tasks?: Array<{ id: string; external: unknown }> };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return result.data?.tasks?.find((task) => task.external)?.id ?? null;
      });
      expect(taskIdBefore).not.toBeNull();

      await resume.click();
      await waitForTerminalOutput(page, 'resumed-original-session', { timeout: 20_000 });
      await waitForTerminalOutput(page, 'resume-arg=--continue');
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IN_PROGRESS');

      const externalTasksAfter = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (payload: unknown) => Promise<{
                  data?: { tasks?: Array<{ id: string; external: unknown }> };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return (result.data?.tasks ?? []).filter((task) => task.external).map((task) => task.id);
      });
      expect(externalTasksAfter).toEqual([taskIdBefore]);

      await expect(page.getByTestId('external-ended')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY');
      await expect(page.getByTestId('task-resume')).toContainText('Resume Claude session');
    } finally {
      await app.close();
    }
  });

  test('a settled Claude session stays a live conversation and resumes in the SAME task', async () => {
    test.setTimeout(180000);
    const fixture = createGitFixture();
    const bin = createHistoryClaudeBin(fixture);
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type(join(bin, 'claude'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Claude Code', {
        timeout: 15000,
      });
      await expect(page.getByTestId('session-bar-ended')).toBeVisible({ timeout: 25000 });

      // The session edited one file → review it and accept.
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 20000,
      });
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-view')).toBeVisible();
      await page.getByTestId('review-accept-all').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 20000,
      });
      // Settling returns to the conversation. The external terminal replaces
      // the normal timeline, so its durable PR draft is an explicit Tools action.
      await expect(page.getByTestId('pr-draft-card')).toHaveCount(0);
      await page.getByTestId('session-tools-open').click();
      await page.getByTestId('settled-pr-draft-open').click();
      await expect(page.getByTestId('pr-draft-card')).toBeVisible();
      await page.getByTestId('pr-draft-dismiss').click();
      await expect(page.getByTestId('settled-pr-draft-open')).toBeVisible();

      const listExternal = async (): Promise<Array<{ id: string; state: string }>> =>
        page.evaluate(async () => {
          const bridge = (
            window as never as {
              product: {
                rpc: Record<
                  string,
                  (payload: unknown) => Promise<{
                    data?: { tasks?: Array<{ id: string; state: string; external: unknown }> };
                  }>
                >;
              };
            }
          ).product;
          const result = await bridge.rpc['task.list']!({
            filter: 'all',
            includeArchived: false,
          });
          return (result.data?.tasks ?? [])
            .filter((task) => task.external)
            .map((task) => ({ id: task.id, state: task.state }));
        });
      const before = await listExternal();
      expect(before).toHaveLength(1);
      const settledId = before[0]!.id;

      // ADR-0032: the settled Session is a live conversation — it stays in
      // its project group (History is for archived rows), badged Settled.
      await page.getByTestId('surface-home').click();
      const row = page.getByTestId(`home-task-${settledId}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Settled');
      await expect(page.getByTestId('rail-group-history')).toHaveCount(0);

      // ↻ Resume continues the SAME task (same baseline, same ledger, same
      // CLI conversation) — no continuation task is created.
      await row.hover();
      await page.getByTestId(`home-resume-${settledId}`).click();
      await expect(page.getByTestId('task-room')).toBeVisible({ timeout: 30000 });
      await waitForTerminalOutput(page, 'resumed-original-session', { timeout: 30_000 });

      const after = await listExternal();
      expect(after).toHaveLength(1);
      expect(after[0]!.id).toBe(settledId);
      expect(['IN_PROGRESS', 'IDLE'].includes(after[0]!.state)).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('an interrupted Claude session recovers after restart and resumes in a new terminal', async () => {
    const fixture = createGitFixture();
    const bin = createResumableClaudeBin(20000);
    const env = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    };
    const first = await launchApp({ env });
    let second: Awaited<ReturnType<typeof launchApp>> | null = null;
    try {
      await first.page.keyboard.press('Control+`');
      await expect(first.page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await first.page.locator('.xterm').click();
      await first.page.keyboard.type('echo restart-ready');
      await first.page.keyboard.press('Enter');
      await waitForTerminalOutput(first.page, 'restart-ready');
      await first.page.keyboard.type(join(bin, 'claude'));
      await first.page.keyboard.press('Enter');
      await expect(first.page.locator('[data-testid^="terminal-agent-"]')).toContainText(
        'Claude Code',
        { timeout: 15000 },
      );

      const taskId = await first.page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (payload: unknown) => Promise<{
                  data?: { tasks?: Array<{ id: string; external: unknown }> };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return result.data?.tasks?.find((task) => task.external)?.id ?? null;
      });
      expect(taskId).not.toBeNull();

      const closed = first.app.waitForEvent('close');
      first.app.process().kill('SIGKILL');
      await closed;

      // Reproduce the historical split-brain row from the field report:
      // external process bookkeeping had ended, generic task recovery had not.
      execFileSync('/usr/bin/sqlite3', [
        join(first.userDataDir, 'app.db'),
        `UPDATE tasks SET external_json = json_set(external_json, '$.status', 'ended'), state = 'INTERRUPTED' WHERE id = '${taskId!}'`,
      ]);

      second = await launchApp({ userDataDir: first.userDataDir, env });
      await second.page.getByTestId('surface-home').click();
      const row = second.page.getByTestId(`home-task-${taskId!}`);
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row).toHaveAttribute('data-state', 'REVIEW_READY');
      await row.click();
      await expect(second.page.getByTestId('task-resume')).toContainText('Resume Claude session');

      await second.page.getByTestId('task-resume').click();
      await waitForTerminalOutput(second.page, 'resumed-original-session', {
        timeout: 20_000,
      });
      await waitForTerminalOutput(second.page, 'resume-arg=--continue');

      const resumed = await second.page.evaluate(async (expectedTaskId) => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (payload: unknown) => Promise<{
                  data?: {
                    tasks?: Array<{ id: string; state: string; external: unknown }>;
                  };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const external = (result.data?.tasks ?? []).filter((task) => task.external);
        return {
          ids: external.map((task) => task.id),
          state: external.find((task) => task.id === expectedTaskId)?.state ?? null,
        };
      }, taskId);
      expect(resumed.ids).toEqual([taskId]);
      expect(resumed.state).toBe('IN_PROGRESS');
    } finally {
      if (second) await second.app.close();
    }
  });

  test('an active Codex session does not offer Resume while its task awaits review', async () => {
    const fixture = createGitFixture();
    const bin = createActiveEditingCodexBin(fixture);
    const { app, page, userDataDir } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'codex',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type(join(bin, 'codex'));
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('Codex', {
        timeout: 15000,
      });
      await expect(page.getByTestId('session-bar-files')).toContainText('1 file', {
        timeout: 15000,
      });

      const taskId = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (payload: unknown) => Promise<{
                  data?: { tasks?: Array<{ id: string; external: unknown }> };
                }>
              >;
            };
          }
        ).product;
        const result = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        return result.data?.tasks?.find((task) => task.external)?.id ?? null;
      });
      expect(taskId).not.toBeNull();

      // Reproduce a stale review projection while the renderer still has an
      // authoritative active session for this terminal.
      execFileSync('/usr/bin/sqlite3', [
        join(userDataDir, 'app.db'),
        `UPDATE tasks SET external_json = json_set(external_json, '$.status', 'ended'), state = 'REVIEW_READY' WHERE id = '${taskId!}'`,
      ]);
      await page.reload();
      await page.getByTestId('surface-home').click();
      const row = page.getByTestId(`home-task-${taskId!}`);
      await expect(row).toHaveAttribute('data-state', 'REVIEW_READY', { timeout: 15000 });
      await row.click();

      await expect(page.getByTestId('external-live')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('task-resume')).toHaveCount(0);
      await expect(page.getByTestId('task-rollback')).toBeVisible();
      await expect(page.getByTestId('review-bar-accept')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-active-codex-review-no-resume.png' });

      await row.hover();
      const endSession = page.getByTestId(`home-end-${taskId!}`);
      await expect(endSession).toBeVisible();
      await expect(endSession).not.toHaveAttribute('title', /.+/);
      await expect(endSession.locator('[data-icon="circleStop"]')).toBeVisible();
      await expect(endSession).toHaveCSS('width', '28px');
      await endSession.hover();
      await expect(page.getByRole('tooltip')).toHaveText('End session');
      const endSessionBox = await endSession.boundingBox();
      const endTooltipBox = await page.getByRole('tooltip').boundingBox();
      expect(endSessionBox).not.toBeNull();
      expect(endTooltipBox).not.toBeNull();
      expect(endTooltipBox!.x + endTooltipBox!.width).toBeLessThan(endSessionBox!.x);
      await expect(page.getByTestId(`home-archive-${taskId!}`)).toHaveCount(0);
      await page.screenshot({ path: '/tmp/charter-active-session-end-action.png' });
      await endSession.click();
      await endSession.click();

      await expect(page.getByTestId('external-ended')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('external-terminal-readonly')).toContainText('Session stopped');
      await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
        'data-terminal-readonly',
        'true',
      );
      await expect(page.getByTestId('external-terminal-readonly-resume')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-stopped-session-readonly.png' });
      await row.hover();
      await expect(page.getByTestId(`home-end-${taskId!}`)).toHaveCount(0);
      const resume = page.getByTestId(`home-resume-${taskId!}`);
      const archive = page.getByTestId(`home-archive-${taskId!}`);
      await expect(resume).toBeVisible();
      await expect(archive).toBeVisible();
      await expect(row.locator('.sr-state.review')).toHaveCSS('visibility', 'hidden');

      const titleBox = await row.locator('.sr-session-title b').boundingBox();
      const resumeBox = await resume.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(resumeBox).not.toBeNull();
      expect(titleBox!.x + titleBox!.width).toBeLessThan(resumeBox!.x);

      await page.screenshot({ path: '/tmp/charter-ended-session-actions-no-overlap.png' });
      await page.mouse.move(700, 600);
      await expect(row.locator('.sr-state.review')).toHaveCSS('visibility', 'visible');
    } finally {
      await app.close();
    }
  });

  test('detect → badge → account → session room → REVIEW_READY', async () => {
    const fixture = createGitFixture();
    writeFileSync(join(fixture, '.gitignore'), 'dist/\n');
    execFileSync('git', ['add', '.gitignore'], { cwd: fixture });
    execFileSync('git', ['commit', '-qm', 'ignore generated output'], { cwd: fixture });
    const bin = createFakeAgentBin(fixture);
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'fakeagent',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    try {
      // Open a terminal on the IDE surface and start the fake agent.
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      // zsh init can drop very-early keystrokes — prove the prompt is live first.
      await page.keyboard.type('echo ready-marker');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'ready-marker');
      const terminalId = (await terminalPtySnapshot(page)).items[0]!.id;
      await page.keyboard.type('fakeagent');
      await page.keyboard.press('Enter');

      // Detection = decoration in place (ADR-0017 rev.2): badge + session bar
      // appear, but NOTHING moves — no side panel, the dock stays put.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('fakeagent', {
        timeout: 15000,
      });
      const bar = page.getByTestId('terminal-session-bar');
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('fakeagent');
      await expect(bar).toContainText('EXT');
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
      await expect(page.locator('[data-testid^="terminal-open-room-"]')).toBeVisible({
        timeout: 15000,
      });

      // The CLI's edit lands in the bar's live counter.
      await expect(page.getByTestId('session-bar-files')).toContainText('1 file', {
        timeout: 15000,
      });

      // 「意图升格」: moving to the side panel is the user's click. Same
      // xterm/PTY — the scrollback must actually render in the panel, and the
      // dock (whose only terminal this was) collapses as a consequence of the
      // user's own action.
      await page.getByTestId('session-bar-promote').click();
      const panel = page.getByTestId('external-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('fakeagent');
      await expect(page.getByTestId('external-panel-terminal')).toHaveAttribute(
        'data-terminal-id',
        terminalId,
      );
      await expect(
        page.getByTestId('external-panel-terminal').locator('.xterm-screen'),
      ).toBeVisible();
      await waitForTerminalOutput(page, 'fake agent session started', { terminalId });
      await expect(page.getByTestId('bottom-panel')).toHaveCount(0);
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await expect(page.getByTestId('session-terminal-manager-status')).toHaveText('Live');
      await expect(page.getByTestId('session-terminal-manager-footer')).toContainText(
        'live sessions · 1 active',
      );
      // The generic-panel shortcut cannot create a second right rail while
      // the external terminal owns that placement.
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+l' : 'Control+l');
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await panel.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });

      // The editor/session boundary is a real, forgiving splitter — not a
      // decorative hairline. Dragging it right shrinks the side panel while
      // pointer capture keeps working across Monaco/xterm.
      const resizeHandle = page.getByRole('separator', { name: 'Resize session panel' });
      const handleBox = await resizeHandle.boundingBox();
      expect(handleBox).not.toBeNull();
      expect(handleBox!.width).toBeGreaterThanOrEqual(12);
      const widthBeforeDrag = (await panel.boundingBox())!.width;
      await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 120);
      await page.mouse.down();
      await page.mouse.move(handleBox!.x + 100, handleBox!.y + 120, { steps: 8 });
      await page.mouse.up();
      await expect
        .poll(async () => (await panel.boundingBox())!.width)
        .toBeLessThan(widthBeforeDrag - 60);
      const widthAfterDrag = (await panel.boundingBox())!.width;
      await resizeHandle.focus();
      await expect(resizeHandle).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect
        .poll(async () => (await panel.boundingBox())!.width)
        .toBeGreaterThan(widthAfterDrag + 10);
      if (process.env.CHARTER_CAPTURE_EXTERNAL_RESIZE === '1') {
        await page.screenshot({ path: '/tmp/charter-external-panel-resized.png' });
      }

      // The promoted terminal is ALIVE: keystrokes reach the PTY and echo back
      // (the exact failure of the original 决策 4 implementation).
      await page.getByTestId('external-panel-terminal').click();
      await page.keyboard.type('promoted-echo-ok');
      await waitForTerminalOutput(page, 'promoted-echo-ok', { terminalId });

      // The panel carries the live "session changes" strip with a diffstat.
      const stripRow = page.getByTestId('external-strip-file-src/util.ts');
      await expect(stripRow).toBeVisible({ timeout: 15000 });
      await expect(stripRow).toContainText('+1');

      // Session end: the pane STAYS where the user put it (no auto-return);
      // the panel header flips to the ended state with a Review entry.
      await expect(page.getByTestId('external-panel-ended')).toBeVisible({ timeout: 25000 });
      await expect(page.getByTestId('external-panel')).toBeVisible();
      await expect(page.getByTestId('external-panel-review')).toBeVisible();

      // 「归位」is the user's click too: the dock comes back, the SAME terminal
      // returns with the unique echo we typed (earlier visual rows can move out
      // of xterm's rendered viewport after a width reflow), and the bar keeps
      // its ended state with the Review entry.
      await page.getByTestId('external-return-dock').click();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await expect(page.getByTestId('agent-panel')).toHaveCount(0);
      await expect(page.getByTestId('sidebar')).toHaveCount(0);
      await expect(page.getByTestId('terminal-host')).toHaveAttribute(
        'data-terminal-id',
        terminalId,
      );
      await waitForTerminalOutput(page, 'promoted-echo-ok', { terminalId });
      await expect(page.getByTestId('session-bar-ended')).toContainText('1 file');

      // Review from the bar opens the session room: terminal column (content
      // follows the instance), rail row, review entry; rail row click peeks.
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('session-agent-chip')).not.toBeAttached();
      await page.getByTestId('session-more').click();
      await page.getByTestId('session-more-details').click();
      await expect(page.getByTestId('session-agent-chip')).toContainText('fakeagent');
      await expect(page.getByTestId('task-room-external-chip')).toHaveText('External CLI');
      await page.getByTestId('session-more').click();
      await expect(page.getByTestId('external-terminal-column')).toBeVisible();
      await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
        'data-terminal-id',
        terminalId,
      );
      await expect(
        page.getByTestId('external-terminal-host').locator('.xterm-screen'),
      ).toBeVisible();
      await waitForTerminalOutput(page, 'fake agent session started', { terminalId });
      await expect(page.getByTestId('external-ended')).toBeVisible();
      await expect(page.getByTestId('task-room-file-src/util.ts')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('session-tool-review')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page.getByTestId('session-action-dock')).toBeVisible();
      await page.getByTestId('task-room-file-src/util.ts').click();
      await expect(page.getByTestId('session-diff-review')).toBeVisible();
      await page.getByTestId('session-tool-file').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId('peek-tab-src/util.ts')).toBeVisible();
      await page.getByTestId('session-tool-review').click();
      await expect(page.getByTestId('review-bar')).toBeVisible();

      // The same external task now has a durable Replay V3: observed
      // provenance, per-fact evidence levels and a per-write evidence frame.
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-source')).toContainText('External Terminal');
      await expect(page.getByTestId('replay-source')).toContainText('Observed');
      // Result-first: the changed line seeks to the observed file write.
      await page.locator('.rp-summary-changed button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('src/util.ts');
      await expect(page.getByTestId('replay-diff')).toContainText('externalTouch');
      if (process.env.CHARTER_CAPTURE_EXTERNAL_REPLAY === '1') {
        await page.waitForTimeout(150);
        await page.screenshot({ path: '/tmp/replay-prod-external-recap.png' });
      }
      // Explore finds the observed terminal output by content; the boundary
      // note states that a plain TUI cannot be semantically confirmed.
      await switchReplayDepth(page, 'explore');
      await page.getByTestId('replay-search').fill('promoted-echo-ok');
      await page.getByTestId('replay-event-list').locator('button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('promoted-echo-ok');
      await expect(page.getByTestId('replay-fact-level')).toContainText('Observed');
      await expect(page.getByTestId('replay-boundary')).toBeVisible();
      if (process.env.CHARTER_CAPTURE_EXTERNAL_REPLAY === '1') {
        await page.waitForTimeout(150);
        await page.screenshot({ path: '/tmp/replay-prod-external-explore.png' });
        await switchReplayDepth(page, 'verify');
        await page.waitForTimeout(150);
        await page.screenshot({ path: '/tmp/replay-prod-external-verify.png' });
        await switchReplayDepth(page, 'explore');
      }
      await page.getByTestId('replay-close').click();

      // The accounted baseline is the PRE-session content: the diff must show
      // exactly the line the fake agent appended.
      const cs = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{
                  ok: boolean;
                  data?: {
                    changeSet: {
                      files: Array<{ path: string; status: string; additions: number }>;
                    };
                  };
                }>
              >;
            };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const list = (tasks as { data?: { tasks: Array<{ id: string; external: unknown }> } }).data
          ?.tasks;
        const external = list?.find((t) => t.external);
        if (!external) return null;
        const res = await bridge.rpc['task.changeSet']!({ taskId: external.id });
        return res.data?.changeSet ?? null;
      });
      expect(cs).not.toBeNull();
      const utilFile = cs!.files.find((f) => f.path === 'src/util.ts');
      expect(utilFile?.status).toBe('modified');
      expect(utilFile?.additions).toBe(1);
      expect(cs!.files.find((f) => f.path === 'dist/bundle.js')).toBeUndefined();

      // Disk really has the CLI's edit (the session was real, not simulated).
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('externalTouch');
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('detects the native-installer shape: version-named binary behind a CLI symlink', async () => {
    // Installer shapes hide the CLI name from the foreground title: the native
    // installer links `claude → …/versions/2.1.209`, the npm install links
    // `claude → …/bin/claude.exe` (Bun-compiled) — either way the kernel short
    // name is not `claude`, and only the argv process-tree fallback sees the
    // session. The fixture binary is a copy of the running node executable:
    // copying /bin/zsh looks simpler but macOS AMFI SIGKILLs copies of Apple
    // platform binaries, so that shape can never run.
    test.skip(process.platform !== 'darwin', 'kernel comm shape under test is darwin-specific');
    const fixture = createGitFixture();
    const bin = mkdtempSync(join(tmpdir(), 'pi-ide-fakebin-'));
    mkdirSync(join(bin, 'versions'));
    copyFileSync(process.execPath, join(bin, 'versions', '9.9.9'));
    chmodSync(join(bin, 'versions', '9.9.9'), 0o755);
    symlinkSync(join(bin, 'versions', '9.9.9'), join(bin, 'fakeclaude'));
    const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
    writeFileSync(
      join(bin, 'agent.js'),
      [
        "const fs = require('fs');",
        "console.log('✳ fake versioned agent started');",
        'setTimeout(() => {',
        `  fs.appendFileSync(${JSON.stringify(target)}, 'export const externalTouch = 1;\\n');`,
        "  console.log('✏ edited src/util.ts');",
        '}, 2000);',
        'setTimeout(() => process.exit(0), 3500);',
        '',
      ].join('\n'),
    );

    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'fakeclaude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo ready-marker');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'ready-marker');
      await page.keyboard.type(`fakeclaude ${join(bin, 'agent.js')}`);
      await page.keyboard.press('Enter');

      // Detection despite the foreground title reading "9.9.9".
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('fakeclaude', {
        timeout: 15000,
      });

      // Script exit ends the session (badge clears after the grace streak).
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(0, {
        timeout: 20000,
      });

      // The edit was accounted against an external task.
      const cs = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const external = tasks.data?.tasks?.find((t: { external: unknown }) => t.external);
        if (!external) return null;
        const res = await bridge.rpc['task.changeSet']!({ taskId: external.id });
        return res.data?.changeSet ?? null;
      });
      expect(cs).not.toBeNull();
      const utilFile = (cs as { files: Array<{ path: string; status: string }> }).files.find(
        (f) => f.path === 'src/util.ts',
      );
      expect(utilFile?.status).toBe('modified');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('externalTouch');
    } finally {
      await app.close();
    }
  });
});
