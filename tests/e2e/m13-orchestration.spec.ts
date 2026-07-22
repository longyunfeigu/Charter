import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createTsSmallFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

async function startOrchestrationTask(
  page: Page,
  title: string,
  scenario = 'orchestration-shell',
): Promise<void> {
  await page.getByTestId('surface-home').click();
  await page.getByTestId('home-advanced-toggle').click();
  await page.getByTestId('home-adv-title').fill(title);
  await page.getByTestId('home-intent').fill(`[scenario:${scenario}] direct a worker`);
  await page.getByTestId('home-mode-edit').click();
  await expect(page.getByTestId('home-model')).toContainText(/mock/i);
  await page.getByTestId('home-submit').click();
  await expect(page.getByTestId('task-room')).toBeVisible();
}

function pendingPermission(page: Page, toolName: string) {
  return page.getByTestId('perm-card').filter({ hasText: toolName });
}

function createExternalDriver(): { bin: string; executable: string; probe: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-m13-driver-'));
  const executable = join(bin, 'codex');
  const probe = join(bin, 'result.json');
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const readline = require('node:readline');",
      `const probe = ${JSON.stringify(probe)};`,
      'const cliArgs = process.argv.slice(2);',
      'function config(prefix) { return cliArgs.find((arg) => arg.startsWith(prefix)); }',
      "const commandConfig = config('mcp_servers.charter.command=');",
      "const argsConfig = config('mcp_servers.charter.args=');",
      "if (!commandConfig || !argsConfig) throw new Error('Charter MCP config was not injected');",
      "const command = JSON.parse(commandConfig.slice(commandConfig.indexOf('=') + 1));",
      "const mcpArgs = JSON.parse(argsConfig.slice(argsConfig.indexOf('=') + 1));",
      "const mcp = spawn(command, mcpArgs, { stdio: ['pipe', 'pipe', 'inherit'] });",
      'const pending = new Map();',
      'let nextId = 1;',
      "readline.createInterface({ input: mcp.stdout }).on('line', (line) => {",
      '  const message = JSON.parse(line);',
      '  if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }',
      '});',
      'function rpc(method, params = {}) {',
      '  const id = nextId++;',
      "  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');",
      '  return new Promise((resolve, reject) => {',
      '    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30000);',
      '    pending.set(id, (message) => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); });',
      '  });',
      '}',
      'async function call(name, args) {',
      "  const result = await rpc('tools/call', { name, arguments: args });",
      '  return JSON.parse(result.content[0].text);',
      '}',
      'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
      'async function ready() {',
      '  for (let attempt = 0; attempt < 40; attempt += 1) {',
      "    const result = await call('terminal_list', {});",
      '    if (result.ok) return;',
      "    if (result.code !== 'CTL_CALLER_NOT_READY') throw new Error(JSON.stringify(result));",
      '    await pause(100);',
      '  }',
      "  throw new Error('caller never became ready');",
      '}',
      'async function main() {',
      "  console.log('external-orchestration-driver-ready');",
      "  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '1' } });",
      "  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');",
      "  const listed = await rpc('tools/list');",
      '  await ready();',
      "  const created = await call('terminal_create', { launch: 'shell', submit: true });",
      '  if (!created.ok) throw new Error(JSON.stringify(created));',
      '  const id = created.data.terminal.id;',
      "  const sent = await call('terminal_send', { id, text: \"printf 'EXTERNAL_ORCH_OK\\\\n'\", submit: true });",
      "  const waited = await call('terminal_wait', { id, mode: 'command', timeoutMs: 10000, quietMs: 500 });",
      "  const read = await call('terminal_read', { id, maxBytes: 4096 });",
      '  fs.writeFileSync(probe, JSON.stringify({ tools: listed.tools.map((tool) => tool.name), workerId: id, created, sent, waited, read }));',
      "  console.log('external-orchestration-driver-done');",
      '  mcp.kill();',
      '}',
      'main().then(() => setTimeout(() => process.exit(0), 500)).catch((error) => { console.error(error); process.exit(1); });',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { bin, executable, probe };
}

function createDirectCodexWorker(): { bin: string; probe: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-m13-direct-worker-'));
  const executable = join(bin, 'codex');
  const probe = join(bin, 'argv.json');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write('\\u001b[2J\\u001b[HSTALE_TUI_FRAME');",
      "setTimeout(() => process.stdout.write('\\u001b[H\\u001b[2KCODEX_WORKER_READY\\n'), 50);",
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { bin, probe };
}

test.describe('M13 session orchestration', () => {
  test('direct-spawns a Codex worker and renders its rewritten TUI screen', async () => {
    test.setTimeout(60_000);
    const fixture = createTsSmallFixture();
    const workerDriver = createDirectCodexWorker();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_FORCE_MOCK: '1',
        PATH: `${workerDriver.bin}:${process.env.PATH ?? ''}`,
      },
    });
    try {
      await startOrchestrationTask(page, 'M13 direct Codex worker', 'orchestration-codex');
      const createPermission = pendingPermission(page, 'terminal.create').first();
      await expect(createPermission).toBeVisible({ timeout: 20_000 });
      await createPermission.getByTestId('perm-allow-once').click();

      await expect.poll(() => existsSync(workerDriver.probe), { timeout: 10_000 }).toBe(true);
      const args = JSON.parse(readFileSync(workerDriver.probe, 'utf8')) as string[];
      expect(args.slice(-2)).toEqual(['--', 'Report your identity and wait for the commander.']);

      await expect(page.getByTestId('task-room-fleet-tab')).toContainText('编队 1');
      await page.getByTestId('task-room-fleet-tab').click();
      const fleetOutput = page.getByTestId('orchestration-native-terminal').locator('.xterm-rows');
      await expect(fleetOutput).toContainText('CODEX_WORKER_READY', { timeout: 10_000 });
      await expect(fleetOutput).not.toContainText('STALE_TUI_FRAME');
    } finally {
      await app.close();
    }
  });

  test('managed driver closes the loop, renders its fleet, and the master switch is inert', async () => {
    test.setTimeout(120_000);
    const fixture = createTsSmallFixture();
    const { app, page, userDataDir } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const socketPath = join(userDataDir, 'ctl.sock');
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      await expect(page).toHaveTitle(/Charter/i);
      await expect(page.getByTestId('workbench')).toBeVisible();
      await expect.poll(() => existsSync(socketPath)).toBe(true);

      await startOrchestrationTask(page, 'M13 orchestration');
      const taskId = await page.getByTestId('task-room').getAttribute('data-task-id');
      expect(taskId).toBeTruthy();

      const createPermission = pendingPermission(page, 'terminal.create');
      await expect(createPermission.first()).toBeVisible({ timeout: 20_000 });
      await expect(createPermission.first().getByTestId('perm-risk')).toHaveText('R2');
      await createPermission.first().getByTestId('perm-allow-once').click();

      await expect(page.getByTestId('task-room-fleet-tab')).toContainText('编队 1');
      await expect(page.getByTestId('task-room-conversation-tab')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await page.getByTestId('task-room-fleet-tab').click();
      const fleet = page.getByTestId('orchestration-fleet');
      await expect(fleet).toBeVisible();
      await expect(fleet.getByTestId('orchestration-native-terminal')).toBeVisible();
      await expect(fleet.locator('.orch-tile')).toHaveCount(1);

      const snapshot = await page.evaluate(async () => {
        const bridge = (
          window as unknown as {
            product: {
              rpc: Record<string, (payload: unknown) => Promise<{ ok: boolean; data?: unknown }>>;
            };
          }
        ).product;
        return bridge.rpc['orchestration.getState']!({});
      });
      expect(snapshot.ok).toBe(true);
      const worker = (
        snapshot.data as { workers: Array<{ terminalId: string; commanderTaskId: string }> }
      ).workers[0]!;
      expect(worker.commanderTaskId).toBe(taskId);

      const workerRow = page.getByTestId(`session-terminal-${worker.terminalId}`);
      await expect(workerRow).toBeVisible();
      await expect(workerRow.locator('xpath=..')).toHaveClass(/sr-orch-worker/);
      const commanderRow = page.getByTestId(`home-task-${taskId!}`);
      const fleetShortcut = page.getByTestId(`home-fleet-${taskId!}`);
      await expect(fleetShortcut).toContainText('1');

      // A normal Session click still opens its conversation. Only the separate
      // Fleet shortcut opens the Session-local command center.
      await commanderRow.click();
      await expect(page.getByTestId('task-room-conversation-tab')).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page.getByTestId('orchestration-fleet')).toHaveCount(0);
      await fleetShortcut.click();
      await expect(page.getByTestId('task-room-fleet-tab')).toHaveAttribute('aria-current', 'page');

      // Switching and focusing workers are observation-only. Neither action
      // emits the user-input provenance that marks a terminal as taken over.
      await fleet.locator('.orch-tile').first().click();
      await page.getByTestId('orchestration-focus-open').click();
      await expect(page.getByTestId('orchestration-focus')).toContainText('原生终端 · 未接管');
      await expect
        .poll(async () => {
          const state = await page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as { workers: Array<{ terminalId: string; takeover: boolean }> }
          ).workers.find((candidate) => candidate.terminalId === worker.terminalId)?.takeover;
        })
        .toBe(false);
      await page.getByTestId('orchestration-focus-back').click();

      await workerRow.click();
      await expect(page.getByTestId('orchestration-worker-band')).toBeVisible();
      await page.getByTestId('orchestration-worker-band').getByRole('button').first().click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', taskId!);
      await expect(page.getByTestId('task-room-fleet-tab')).toHaveAttribute('aria-current', 'page');

      // The semantic right rail owns the pending decision while Fleet is open.
      const sendPermission = pendingPermission(page, 'terminal.send');
      await expect(sendPermission).toHaveCount(1, { timeout: 20_000 });
      await expect(fleetShortcut.locator('i')).toHaveText('1');
      await sendPermission.getByTestId('perm-allow-once').click();
      await expect(sendPermission).toHaveCount(0);

      const nativeRows = fleet.getByTestId('orchestration-native-terminal').locator('.xterm-rows');
      await expect(nativeRows).toContainText('ORCH_OK', {
        timeout: 20_000,
      });

      // Fleet mounts the real PTY, so Claude/Codex slash commands, @files and
      // shell input use the native terminal path. Actual keyboard input (and
      // only keyboard input) marks takeover.
      await fleet.getByTestId('orchestration-native-terminal').click();
      await page.keyboard.type("printf 'NATIVE_FLEET_OK\\n'");
      await page.keyboard.press('Enter');
      await expect(nativeRows).toContainText('NATIVE_FLEET_OK', { timeout: 10_000 });
      await expect
        .poll(async () => {
          const state = await page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as { workers: Array<{ terminalId: string; takeover: boolean }> }
          ).workers.find((candidate) => candidate.terminalId === worker.terminalId)?.takeover;
        })
        .toBe(true);
      await page.getByTestId('orchestration-focus-open').click();
      await page.getByRole('button', { name: '交还给 Commander' }).click();
      await page.getByTestId('orchestration-focus-back').click();

      // A full-screen TUI rewrites cells in place. The fleet must show xterm's
      // rendered screen, not both ANSI-stripped repaint fragments appended.
      await page.evaluate(async (terminalId) => {
        await window.product.rpc['terminal.write']!({
          id: terminalId,
          data: "printf '\\033[2J\\033[HTUI_FRAME_OLD'; sleep 0.1; printf '\\033[H\\033[2KTUI_FRAME_NEW\\n'\r",
          userInitiated: false,
        });
      }, worker.terminalId);
      await expect(nativeRows).toContainText('TUI_FRAME_NEW');
      await expect(nativeRows).not.toContainText('TUI_FRAME_OLD');

      const protocolWrite = await page.evaluate(async (terminalId) => {
        const bridge = (
          window as unknown as {
            product: {
              rpc: Record<string, (payload: unknown) => Promise<{ ok: boolean; data?: unknown }>>;
            };
          }
        ).product;
        return bridge.rpc['terminal.write']!({
          id: terminalId,
          data: "printf '\\033[c'; printf 'PROTOCOL_PROBE_DONE\\n'\r",
          userInitiated: false,
        });
      }, worker.terminalId);
      expect(protocolWrite.ok).toBe(true);
      await expect(nativeRows).toContainText('PROTOCOL_PROBE_DONE');
      await expect
        .poll(async () => {
          const state = await page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as { workers: Array<{ terminalId: string; takeover: boolean }> }
          ).workers.find((candidate) => candidate.terminalId === worker.terminalId)?.takeover;
        })
        .toBe(false);

      await workerRow.click();
      const workerBand = page.getByTestId('orchestration-worker-band');
      await expect(workerBand).toBeVisible();
      await expect(workerBand).not.toContainText('你已接管');
      await page.evaluate(async (terminalId) => {
        await window.product.rpc['terminal.write']!({
          id: terminalId,
          data: 'x',
          userInitiated: true,
        });
      }, worker.terminalId);
      await expect(workerBand).toContainText('你已接管');
      await workerBand.getByRole('button', { name: '交还控制' }).click();
      await expect(workerBand).not.toContainText('你已接管');
      await workerBand.getByRole('button').first().click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', taskId!);

      const readPermission = pendingPermission(page, 'terminal.read');
      await expect(readPermission.first()).toBeVisible({ timeout: 20_000 });
      await expect(readPermission.first().getByTestId('perm-risk')).toHaveText('R1');
      await readPermission.first().getByTestId('perm-allow-once').click();

      await page.getByTestId('task-room-conversation-tab').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('tl-agent').last()).toContainText('remains open for follow-up');
      await expect(pendingPermission(page, 'terminal.kill')).toHaveCount(0);
      for (const toolName of [
        'terminal.create',
        'terminal.send',
        'terminal.wait',
        'terminal.read',
      ]) {
        await expect(page.getByTestId(`tl-tool-${toolName}`)).toHaveAttribute(
          'data-state',
          'SUCCEEDED',
        );
      }
      await expect(page.getByTestId('tl-tool-terminal.kill')).toHaveCount(0);
      await expect(workerRow).toBeVisible();
      await page.getByTestId('task-room-fleet-tab').click();
      await expect(fleet.locator('.orch-tile')).toHaveCount(1);
      await expect(fleet.locator('.orch-signal-card.done')).toContainText('worker 仍保持打开');
      const completedState = await page.evaluate(async () => {
        return window.product.rpc['orchestration.getState']!({});
      });
      expect(
        (completedState.data as { workers: Array<{ terminalId: string }> }).workers.some(
          (candidate) => candidate.terminalId === worker.terminalId,
        ),
      ).toBe(true);

      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-story-list')).toContainText('⌁');
      await page.getByTestId('replay-close').click();

      await page.setViewportSize({ width: 900, height: 720 });
      const fleetBox = await fleet.boundingBox();
      expect(fleetBox).not.toBeNull();
      expect(fleetBox!.x).toBeGreaterThanOrEqual(0);
      expect(fleetBox!.x + fleetBox!.width).toBeLessThanOrEqual(900);
      await page.screenshot({ path: '/tmp/charter-m13-orchestration-narrow.png' });

      await page.getByTestId('home-settings').click();
      await page.getByTestId('settings-section-agent').click();
      const toggle = page.getByTestId('settings-orchestration');
      await expect(toggle).toBeChecked();
      await toggle.uncheck();
      await expect.poll(() => existsSync(socketPath)).toBe(false);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('orchestration-fleet')).toHaveCount(0);

      await page.getByTestId('task-room-back').click();
      await startOrchestrationTask(page, 'M13 disabled');
      await expect(page.getByTestId('tl-tool-terminal.create')).toHaveAttribute(
        'data-state',
        'FAILED',
        { timeout: 20_000 },
      );
      await expect(page.getByTestId('orchestration-fleet')).toHaveCount(0);
      expect(existsSync(socketPath)).toBe(false);

      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('external Codex-shaped driver uses the authenticated socket and shared approvals', async () => {
    test.setTimeout(90_000);
    const fixture = createTsSmallFixture();
    const driver = createExternalDriver();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude,codex',
        PATH: `${driver.bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: driver.bin,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      const terminal = page.locator('.xterm').first();
      await expect(terminal).toBeVisible();
      await terminal.click();
      await page.keyboard.type('codex');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex', {
        timeout: 20_000,
      });
      await page.getByTestId('session-bar-room').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      for (const [toolName, risk] of [
        ['terminal.create', 'R2'],
        ['terminal.send', 'R2'],
        ['terminal.read', 'R1'],
      ] as const) {
        const permission = pendingPermission(page, toolName).first();
        await expect(permission).toBeVisible({ timeout: 20_000 });
        await expect(permission.getByTestId('perm-risk')).toHaveText(risk);
        await permission.getByTestId('perm-allow-once').click();
      }

      await expect.poll(() => existsSync(driver.probe), { timeout: 20_000 }).toBe(true);
      const result = JSON.parse(readFileSync(driver.probe, 'utf8')) as {
        tools: string[];
        workerId: string;
        created: { ok: boolean };
        sent: { ok: boolean };
        waited: { ok: boolean; data?: { exitCode?: number } };
        read: { ok: boolean; data?: { content?: string } };
      };
      expect(result.tools).toEqual([
        'terminal_list',
        'terminal_create',
        'terminal_send',
        'terminal_wait',
        'terminal_read',
        'terminal_kill',
      ]);
      expect(
        [result.created, result.sent, result.waited, result.read].every((entry) => entry.ok),
      ).toBe(true);
      expect(result.waited?.data?.exitCode).toBe(0);
      expect(result.read?.data?.content).toContain('EXTERNAL_ORCH_OK');
      await page.getByTestId('task-room-fleet-tab').click();
      await expect(page.getByTestId('orchestration-fleet')).toBeVisible();
      await expect(pendingPermission(page, 'terminal.kill')).toHaveCount(0);
      const state = await page.evaluate(async () => {
        return window.product.rpc['orchestration.getState']!({});
      });
      expect(
        (state.data as { workers: Array<{ terminalId: string }> }).workers.some(
          (candidate) => candidate.terminalId === result.workerId,
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
