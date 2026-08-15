import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createTsSmallFixture } from './helpers/fixtures';
import {
  launchApp,
  restartMainPreservingTerminals,
  shutdownPersistentTestTerminals,
} from './helpers/launch';
import { waitForTerminalOutput } from './helpers/terminal';

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

async function useSoftwareTerminalRenderer(page: Page): Promise<void> {
  // These scenarios assert the rewritten viewport through DOM rows. WebGL
  // rendering and fallback have their own dedicated Electron coverage.
  await page.getByTestId('home-settings').click();
  await page.getByTestId('settings-section-terminal').click();
  await page.getByTestId('settings-terminal-renderer').selectOption('software');
  await page.keyboard.press('Escape');
}

function pendingPermission(page: Page, toolName: string) {
  return page.getByTestId('perm-card').filter({ hasText: toolName });
}

async function openLegacyOrchestration(page: Page): Promise<void> {
  await page.getByTestId('session-more').click();
  const legacyEntry = page.getByTestId('task-open-legacy-orchestration');
  await expect(legacyEntry).toBeVisible({ timeout: 10_000 });
  await legacyEntry.click();
  await expect(page.getByTestId('task-room-fleet-tab')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('orchestration-fleet')).toBeVisible();
}

function createExternalDriver(): {
  bin: string;
  executable: string;
  probe: string;
  viewportProbe: string;
} {
  const bin = mkdtempSync(join(tmpdir(), 'charter-m13-driver-'));
  const executable = join(bin, 'codex');
  const semanticWorker = join(bin, 'claude');
  const probe = join(bin, 'result.json');
  const viewportProbe = join(bin, 'viewport.ndjson');
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  writeFileSync(
    semanticWorker,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const viewportProbe = ${JSON.stringify(viewportProbe)};`,
      "process.stdin.setEncoding('utf8');",
      'process.stdin.setRawMode?.(true);',
      'process.stdin.resume();',
      "const history = Array.from({ length: 80 }, (_, index) => `history-line-${String(index + 1).padStart(3, '0')}`);",
      'let position = 0;',
      'let pending = false;',
      'function render(status = "❯ ready") {',
      '  const end = 80 - position * 2;',
      '  const start = Math.max(0, end - 22);',
      "  const lines = ['CLAUDE TRANSCRIPT', ...history.slice(start, end), status];",
      "  process.stdout.write('\\u001b[2J\\u001b[H' + lines.join('\\r\\n'));",
      "  fs.appendFileSync(viewportProbe, JSON.stringify({ type: 'render', position, start, end, status }) + '\\n');",
      '}',
      "process.stdout.write('\\u001b[?1049h\\u001b[?1002h\\u001b[?1006h\\u001b]2;✳ Claude\\u0007');",
      'render();',
      "process.stdin.on('data', (chunk) => {",
      "  fs.appendFileSync(viewportProbe, JSON.stringify({ type: 'input', hex: Buffer.from(chunk).toString('hex') }) + '\\n');",
      '  const up = (chunk.match(/\\u001b\\[<64;/g) || []).length;',
      '  const down = (chunk.match(/\\u001b\\[<65;/g) || []).length;',
      '  if (up || down) {',
      "    fs.appendFileSync(viewportProbe, JSON.stringify({ type: 'wheel', up, down, before: position }) + '\\n');",
      '    if (up) position = Math.min(29, position + up);',
      '    if (down) position = Math.max(0, position - down);',
      '    render();',
      '    return;',
      '  }',
      '  if (pending || !/[\\r\\n]/.test(chunk)) return;',
      '  pending = true;',
      "  process.stdout.write('\\u001b]2;⠋ Claude\\u0007');",
      "  render('semantic-agent-working');",
      '  setTimeout(() => {',
      "    process.stdout.write('\\u001b]2;✳ Claude\\u0007');",
      "    position = 0; render('❯ semantic-agent-finished');",
      '    pending = false;',
      '  }, 300);',
      '});',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(semanticWorker, 0o755);
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
      '  const structured = result.structuredContent ?? JSON.parse(result.content[0].text);',
      '  return { ...structured, mcpText: result.content[0].text };',
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
      "  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-codex', version: '1' } });",
      "  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');",
      "  const listed = await rpc('tools/list');",
      '  await ready();',
      "  const created = await call('terminal_create', { launch: 'shell', submit: true });",
      '  if (!created.ok) throw new Error(JSON.stringify(created));',
      '  const id = created.data.terminal.id;',
      "  const sent = await call('terminal_send', { id, text: \"printf 'EXTERNAL_ORCH_OK\\\\n'\", submit: true });",
      "  const waited = await call('terminal_wait', { id, mode: 'command', timeoutMs: 10000, quietMs: 500 });",
      "  const read = await call('terminal_read', { id, maxBytes: 4096 });",
      "  const agentCreated = await call('terminal_create', { launch: 'claude', submit: true });",
      '  if (!agentCreated.ok) throw new Error(JSON.stringify(agentCreated));',
      '  const agentId = agentCreated.data.terminal.id;',
      '  let status = null;',
      '  for (let attempt = 0; attempt < 80; attempt += 1) {',
      "    status = await call('agent_status', { id: agentId });",
      "    if (status.ok && status.data.state === 'idle') break;",
      "    if (!status.ok && status.code !== 'AGENT_NOT_FOUND') throw new Error(JSON.stringify(status));",
      '    await pause(100);',
      '  }',
      "  if (!status?.ok || status.data.state !== 'idle') throw new Error(`Agent never became idle: ${JSON.stringify(status)}`);",
      "  const explained = await call('agent_explain', { id: agentId });",
      "  const agentScreen = await call('agent_read', { id: agentId, mode: 'screen', lines: 24, maxBytes: 65536, unwrap: true });",
      "  const agentTranscript = await call('agent_read', { id: agentId, mode: 'transcript', lines: 60, maxBytes: 65536, unwrap: true });",
      "  const prompted = await call('agent_prompt', { id: agentId, text: 'Review the semantic API.', timeoutMs: 5000 });",
      '  if (!prompted.ok) throw new Error(JSON.stringify(prompted));',
      "  const agentWaited = await call('agent_wait', { id: agentId, until: ['idle', 'blocked', 'exited'], afterSeq: prompted.data.startedStateChangeSeq, identitySeq: prompted.data.identitySeq, timeoutMs: 10000 });",
      "  const agentResult = await call('agent_result', { id: agentId, maxBytes: 65536 });",
      '  fs.writeFileSync(probe, JSON.stringify({ instructions: initialized.instructions, tools: listed.tools.map((tool) => tool.name), workerId: id, created, sent, waited, read, agentId, status, explained, agentScreen, agentTranscript, prompted, agentWaited, agentResult }));',
      "  console.log('external-orchestration-driver-done');",
      '  mcp.kill();',
      '}',
      'main().then(() => setTimeout(() => process.exit(0), 10000)).catch((error) => { console.error(error); process.exit(1); });',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { bin, executable, probe, viewportProbe };
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
      `const probe = ${JSON.stringify(probe)};`,
      'const args = process.argv.slice(2);',
      "let input = '';",
      'const save = () => fs.writeFileSync(probe, JSON.stringify({ args, input }));',
      'save();',
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; save(); });",
      "process.stdout.write('\\u001b[2J\\u001b[HSTALE_TUI_FRAME');",
      "setTimeout(() => process.stdout.write('\\u001b[H\\u001b[2KOpenAI Codex · CODEX_WORKER_READY\\n'), 50);",
      "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n'), 2000);",
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { bin, probe };
}

function createFleetResumeDriver(options?: {
  workerLifetimeMs?: number;
  commanderLifetimeMs?: number;
  workerHeartbeat?: boolean;
  workerCompletesTurn?: boolean;
}): {
  bin: string;
  codexHome: string;
  commanderSessionId: string;
  commanderArgvProbe: string;
  fleetProbe: string;
  workerArgvProbe: string;
} {
  const bin = mkdtempSync(join(tmpdir(), 'charter-m13-fleet-resume-'));
  const codexHome = join(bin, 'codex-home');
  const commanderSessionId = 'c0de0000-0000-4000-8000-000000000013';
  const commanderArgvProbe = join(bin, 'commander-argv.ndjson');
  const fleetProbe = join(bin, 'fleet.json');
  const workerArgvProbe = join(bin, 'worker-argv.ndjson');
  const workerLifetimeMs = options?.workerLifetimeMs ?? 2_200;
  const commanderLifetimeMs = options?.commanderLifetimeMs ?? 12_000;
  const workerHeartbeat = options?.workerHeartbeat ?? false;
  const workerCompletesTurn = options?.workerCompletesTurn ?? false;
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\nexport CODEX_HOME=${JSON.stringify(codexHome)}\n`,
  );
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const probe = ${JSON.stringify(workerArgvProbe)};`,
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(probe, JSON.stringify(args) + '\\n');",
      "const resumed = args.includes('--resume') || args.includes('--continue');",
      "console.log(resumed ? 'fleet-worker-resumed' : 'fleet-worker-started');",
      workerHeartbeat
        ? "setInterval(() => process.stdout.write('fleet-worker-working\\r'), 250);"
        : '',
      workerCompletesTurn
        ? "setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'fleet-worker', result: 'done' })), 2500);"
        : '',
      `setTimeout(() => process.exit(0), resumed ? 15000 : ${workerLifetimeMs});`,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { spawn } = require('node:child_process');",
      "const readline = require('node:readline');",
      `const probe = ${JSON.stringify(fleetProbe)};`,
      `const argvProbe = ${JSON.stringify(commanderArgvProbe)};`,
      `const sessionId = ${JSON.stringify(commanderSessionId)};`,
      `const codexHome = ${JSON.stringify(codexHome)};`,
      'const cliArgs = process.argv.slice(2);',
      "fs.appendFileSync(argvProbe, JSON.stringify(cliArgs) + '\\n');",
      'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
      'function config(prefix) { return cliArgs.find((arg) => arg.startsWith(prefix)); }',
      'async function main() {',
      "  if (cliArgs.includes('resume')) {",
      "    console.log('fleet-commander-resumed');",
      '    await pause(15000);',
      '    return;',
      '  }',
      '  const startedAt = new Date();',
      "  const day = [String(startedAt.getFullYear()), String(startedAt.getMonth() + 1).padStart(2, '0'), String(startedAt.getDate()).padStart(2, '0')];",
      "  const rolloutDir = path.join(codexHome, 'sessions', ...day);",
      '  fs.mkdirSync(rolloutDir, { recursive: true });',
      "  const rollout = path.join(rolloutDir, `rollout-${startedAt.toISOString().replaceAll(':', '-')}-${sessionId}.jsonl`);",
      "  fs.writeFileSync(rollout, JSON.stringify({ timestamp: startedAt.toISOString(), type: 'session_meta', payload: { id: sessionId, timestamp: startedAt.toISOString(), cwd: process.cwd() } }) + '\\n');",
      "  const commandConfig = config('mcp_servers.charter.command=');",
      "  const argsConfig = config('mcp_servers.charter.args=');",
      "  if (!commandConfig || !argsConfig) throw new Error('Charter MCP config missing');",
      "  const command = JSON.parse(commandConfig.slice(commandConfig.indexOf('=') + 1));",
      "  const mcpArgs = JSON.parse(argsConfig.slice(argsConfig.indexOf('=') + 1));",
      "  const mcp = spawn(command, mcpArgs, { stdio: ['pipe', 'pipe', 'inherit'] });",
      '  const pending = new Map();',
      '  let nextId = 1;',
      "  readline.createInterface({ input: mcp.stdout }).on('line', (line) => {",
      '    const message = JSON.parse(line);',
      '    if (message.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }',
      '  });',
      '  function rpc(method, params = {}) {',
      '    const id = nextId++;',
      "    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');",
      '    return new Promise((resolve, reject) => {',
      '      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 30000);',
      '      pending.set(id, (message) => { clearTimeout(timer); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); });',
      '    });',
      '  }',
      '  async function call(name, args) {',
      "    const result = await rpc('tools/call', { name, arguments: args });",
      '    return JSON.parse(result.content[0].text);',
      '  }',
      "  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fleet-resume-codex', version: '1' } });",
      "  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');",
      '  for (let attempt = 0; attempt < 40; attempt += 1) {',
      "    const listed = await call('terminal_list', {});",
      '    if (listed.ok) break;',
      '    await pause(100);',
      '  }',
      "  const created = await call('terminal_create', { launch: 'claude', initialText: 'Wait for the commander.', submit: true });",
      '  if (!created.ok) throw new Error(JSON.stringify(created));',
      '  fs.writeFileSync(probe, JSON.stringify({ workerId: created.data.terminal.id }));',
      "  console.log('fleet-commander-created-worker');",
      `  await pause(${commanderLifetimeMs});`,
      '  mcp.kill();',
      '}',
      'main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  chmodSync(join(bin, 'codex'), 0o755);
  return {
    bin,
    codexHome,
    commanderSessionId,
    commanderArgvProbe,
    fleetProbe,
    workerArgvProbe,
  };
}

async function killAllTerminals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const listed = (await window.product.rpc['terminal.list']!({})) as
      { ok: true; data: { items: Array<{ id: string }> } } | { ok: false };
    if (!listed.ok) return;
    for (const terminal of listed.data.items) {
      await window.product.rpc['terminal.kill']!({ id: terminal.id, force: true });
    }
  });
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
      await useSoftwareTerminalRenderer(page);
      await startOrchestrationTask(page, 'M13 direct Codex worker', 'orchestration-codex');
      await expect(pendingPermission(page, 'terminal.create')).toHaveCount(0);

      await expect.poll(() => existsSync(workerDriver.probe), { timeout: 10_000 }).toBe(true);
      await expect
        .poll(() => {
          const probe = JSON.parse(readFileSync(workerDriver.probe, 'utf8')) as {
            args: string[];
            input: string;
          };
          return probe.input;
        })
        .toContain('Report your identity and wait for the commander.');
      const workerProbe = JSON.parse(readFileSync(workerDriver.probe, 'utf8')) as {
        args: string[];
        input: string;
      };
      expect(workerProbe.args).not.toContain('Report your identity and wait for the commander.');
      expect(workerProbe.args).toEqual(
        expect.arrayContaining([
          '-c',
          'mcp_servers.charter.startup_timeout_sec=120',
          'mcp_servers.charter.tool_timeout_sec=3605',
        ]),
      );

      await expect(page.getByTestId('task-room-fleet-tab')).toHaveCount(0);
      await page.setViewportSize({ width: 1024, height: 700 });
      const identityName = await page.locator('.session-identity-name').boundingBox();
      const identityMeta = await page.locator('.session-identity-meta').boundingBox();
      const moreButton = await page.getByTestId('session-more').boundingBox();
      expect(identityName).not.toBeNull();
      expect(identityMeta).not.toBeNull();
      expect(moreButton).not.toBeNull();
      expect(Math.abs(moreButton!.y - identityMeta!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(moreButton!.height - identityMeta!.height)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: '/tmp/charter-session-header-layout.png' });
      await openLegacyOrchestration(page);
      const fleetOutput = page.getByTestId('orchestration-native-terminal').locator('.xterm-rows');
      await expect(fleetOutput).toContainText('CODEX_WORKER_READY', { timeout: 10_000 });
      await expect(fleetOutput).not.toContainText('STALE_TUI_FRAME');
      await page.getByTestId('task-room-conversation-tab').click();
      await expect(page.getByTestId('tl-tool-terminal.wait')).toHaveAttribute(
        'data-state',
        'SUCCEEDED',
        { timeout: 15_000 },
      );
      await openLegacyOrchestration(page);
      await expect(page.locator('.orch-status.completed').first()).toContainText('完成');
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

      await useSoftwareTerminalRenderer(page);
      await startOrchestrationTask(page, 'M13 orchestration');
      const taskId = await page.getByTestId('task-room').getAttribute('data-task-id');
      expect(taskId).toBeTruthy();

      await expect(pendingPermission(page, 'terminal.create')).toHaveCount(0);
      await expect(page.getByTestId('task-room-fleet-tab')).toHaveCount(0);
      await openLegacyOrchestration(page);
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

      // A normal Session click opens its conversation. The old command center
      // is now deliberately isolated behind the explicit compatibility action.
      await commanderRow.click();
      await expect(page.getByTestId('task-room-fleet-tab')).toHaveCount(0);
      await expect(page.getByTestId('orchestration-fleet')).toHaveCount(0);
      await openLegacyOrchestration(page);

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
      await openLegacyOrchestration(page);

      await expect(pendingPermission(page, 'terminal.send')).toHaveCount(0);

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
      await openLegacyOrchestration(page);
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
      // The commander is a managed ACP run, not a PTY Session. Its spawned
      // worker terminal is not misrepresented as a replay of the commander.
      await expect(page.getByTestId('replay-open')).toHaveCount(0);

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

  test('explicit Codex compatibility driver uses the authenticated socket without terminal approvals', async () => {
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
      await page.keyboard.type('echo commander-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'commander-ready');
      await page.keyboard.type('charter-codex-mcp');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'external-orchestration-driver-ready', { timeout: 20_000 });
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex', {
        timeout: 20_000,
      });
      await page.getByTestId('session-bar-room').click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      await expect.poll(() => existsSync(driver.probe), { timeout: 20_000 }).toBe(true);
      for (const toolName of ['terminal.create', 'terminal.send', 'terminal.read']) {
        await expect(pendingPermission(page, toolName)).toHaveCount(0);
      }
      const result = JSON.parse(readFileSync(driver.probe, 'utf8')) as {
        instructions: string;
        tools: string[];
        workerId: string;
        created: { ok: boolean };
        sent: { ok: boolean };
        waited: { ok: boolean; data?: { exitCode?: number } };
        read: { ok: boolean; data?: { content?: string } };
        agentId: string;
        status: {
          ok: boolean;
          data?: { state?: string; identitySeq?: number; stateChangeSeq?: number };
        };
        explained: {
          ok: boolean;
          data?: { state?: string; explanation?: { matchedRule?: unknown } };
        };
        agentScreen: {
          ok: boolean;
          data?: { mode?: string; content?: string; restored?: boolean };
        };
        agentTranscript: {
          ok: boolean;
          data?: {
            mode?: string;
            content?: string;
            restored?: boolean;
            capturedRows?: number;
          };
        };
        prompted: {
          ok: boolean;
          data?: { accepted?: boolean; identitySeq?: number; startedStateChangeSeq?: number };
        };
        agentWaited: {
          ok: boolean;
          data?: { matched?: string; presence?: { lifecycle?: string } };
        };
        agentResult: {
          ok: boolean;
          mcpText?: string;
          data?: { source?: string; fidelity?: string; answer?: string };
        };
      };
      expect(result.instructions).toContain('host-provided context');
      expect(result.instructions).toContain('orchestration_inspect');
      expect(result.instructions.toLowerCase()).toContain('do not substitute terminal_create');
      expect(result.tools).toEqual([
        'terminal_list',
        'terminal_create',
        'terminal_send',
        'terminal_wait',
        'terminal_read',
        'terminal_kill',
        'agent_status',
        'agent_explain',
        'agent_result',
        'agent_read',
        'agent_wait',
        'agent_prompt',
        'orchestration_promote',
        'orchestration_inspect',
        'orchestration_sync',
        'orchestration_delegate',
        'orchestration_delegate_many',
        'orchestration_message',
        'orchestration_request',
        'orchestration_request_decision',
        'orchestration_resolve_request',
        'orchestration_reply',
        'orchestration_ask',
        'orchestration_wait',
        'orchestration_join',
        'orchestration_park',
        'orchestration_continue',
        'orchestration_progress',
        'orchestration_complete',
        'orchestration_escalate',
        'orchestration_pause',
        'orchestration_resume',
        'orchestration_cancel',
        'orchestration_retry',
        'orchestration_steer',
        'orchestration_reassign',
      ]);
      expect(
        [result.created, result.sent, result.waited, result.read].every((entry) => entry.ok),
      ).toBe(true);
      expect(result.waited?.data?.exitCode).toBe(0);
      expect(result.read?.data?.content).toContain('EXTERNAL_ORCH_OK');
      expect(result.status).toMatchObject({ ok: true, data: { state: 'idle', identitySeq: 1 } });
      expect(result.explained).toMatchObject({ ok: true, data: { state: 'idle' } });
      expect(result.agentScreen).toMatchObject({
        ok: true,
        data: { mode: 'screen', restored: true },
      });
      expect(result.agentScreen.data?.content).toContain('history-line-080');
      expect(result.agentScreen.data?.content).not.toContain('history-line-025');
      expect(result.agentTranscript).toMatchObject({
        ok: true,
        data: { mode: 'transcript', restored: true, capturedRows: 60 },
      });
      expect(result.agentTranscript.data?.content).toContain('history-line-025');
      expect(result.agentTranscript.data?.content).toContain('history-line-080');
      expect(result.agentTranscript.data?.content?.match(/CLAUDE TRANSCRIPT/g)).toHaveLength(1);
      const viewportEvents = readFileSync(driver.viewportProbe, 'utf8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              up?: number;
              down?: number;
              position?: number;
            },
        );
      expect(viewportEvents.some((event) => event.type === 'wheel' && (event.up ?? 0) > 0)).toBe(
        true,
      );
      expect(viewportEvents.some((event) => event.type === 'wheel' && (event.down ?? 0) > 0)).toBe(
        true,
      );
      expect(viewportEvents.filter((event) => event.type === 'render').at(-1)?.position).toBe(0);
      expect(result.prompted).toMatchObject({
        ok: true,
        data: { accepted: true, identitySeq: 1, startedStateChangeSeq: expect.any(Number) },
      });
      expect(result.agentWaited).toMatchObject({
        ok: true,
        data: { matched: 'idle', presence: { lifecycle: 'idle' } },
      });
      expect(result.agentResult).toMatchObject({
        ok: true,
        data: { source: 'screen', fidelity: 'observed', answer: expect.any(String) },
      });
      expect(result.agentResult.mcpText).toBe(result.agentResult.data?.answer);
      for (const toolName of [
        'agent.status',
        'agent.explain',
        'agent.result',
        'agent.read',
        'agent.wait',
        'agent.prompt',
      ]) {
        await expect(pendingPermission(page, toolName)).toHaveCount(0);
      }
      await openLegacyOrchestration(page);
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

  test('resuming an external commander restores its ended Claude worker fleet', async () => {
    test.setTimeout(120_000);
    const fixture = createTsSmallFixture();
    const driver = createFleetResumeDriver();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'claude,codex',
        CODEX_HOME: driver.codexHome,
        PATH: `${driver.bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: driver.bin,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      const terminal = page.locator('.xterm').first();
      await expect(terminal).toBeVisible();
      await terminal.click();
      await page.keyboard.type('echo commander-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'commander-ready');
      await page.keyboard.type('charter-codex-mcp');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'fleet-commander-created-worker', { timeout: 30_000 });
      await expect(page.getByTestId('terminal-session-bar')).toContainText('Codex', {
        timeout: 20_000,
      });
      await page.getByTestId('session-bar-room').click();
      const room = page.getByTestId('task-room');
      await expect(room).toBeVisible();
      const commanderTaskId = await room.getAttribute('data-task-id');
      expect(commanderTaskId).toBeTruthy();

      await expect.poll(() => existsSync(driver.fleetProbe), { timeout: 20_000 }).toBe(true);
      const originalWorkerId = (
        JSON.parse(readFileSync(driver.fleetProbe, 'utf8')) as { workerId: string }
      ).workerId;
      await expect
        .poll(
          () =>
            existsSync(driver.workerArgvProbe)
              ? readFileSync(driver.workerArgvProbe, 'utf8').trim().split('\n').filter(Boolean)
                  .length
              : 0,
          { timeout: 20_000 },
        )
        .toBe(1);
      const firstWorkerArgs = JSON.parse(
        readFileSync(driver.workerArgvProbe, 'utf8').trim().split('\n')[0]!,
      ) as string[];
      const sessionFlag = firstWorkerArgs.indexOf('--session-id');
      expect(sessionFlag).toBeGreaterThanOrEqual(0);
      const workerSessionId = firstWorkerArgs[sessionFlag + 1];
      expect(workerSessionId).toMatch(/^[0-9a-f-]{36}$/);

      const resume = page.getByTestId('task-resume');
      await expect(resume).toBeVisible({ timeout: 30_000 });
      await resume.click();
      await expect(page.locator('.toast').filter({ hasText: 'Restored 1 worker' })).toBeVisible({
        timeout: 30_000,
      });
      await expect
        .poll(
          () =>
            readFileSync(driver.commanderArgvProbe, 'utf8').trim().split('\n').filter(Boolean)
              .length,
          { timeout: 20_000 },
        )
        .toBe(2);
      const resumedCommanderArgs = JSON.parse(
        readFileSync(driver.commanderArgvProbe, 'utf8').trim().split('\n')[1]!,
      ) as string[];
      expect(resumedCommanderArgs).toEqual(
        expect.arrayContaining(['resume', driver.commanderSessionId]),
      );
      expect(resumedCommanderArgs).not.toContain('--last');
      await expect
        .poll(
          () =>
            readFileSync(driver.workerArgvProbe, 'utf8').trim().split('\n').filter(Boolean).length,
          { timeout: 20_000 },
        )
        .toBe(2);
      const resumedWorkerArgs = JSON.parse(
        readFileSync(driver.workerArgvProbe, 'utf8').trim().split('\n')[1]!,
      ) as string[];
      expect(resumedWorkerArgs).toEqual(expect.arrayContaining(['--resume', workerSessionId]));

      const state = await page.evaluate(async () => {
        return window.product.rpc['orchestration.getState']!({});
      });
      const commanderWorkers = (
        state.data as {
          workers: Array<{ terminalId: string; commanderTaskId: string; taskId: string | null }>;
        }
      ).workers.filter((worker) => worker.commanderTaskId === commanderTaskId);
      expect(commanderWorkers).toHaveLength(1);
      expect(commanderWorkers[0]?.terminalId).not.toBe(originalWorkerId);
      expect(commanderWorkers[0]?.taskId).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  test('keeps a live daemon worker nested and working after Electron restarts', async () => {
    test.setTimeout(120_000);
    const fixture = createTsSmallFixture();
    const driver = createFleetResumeDriver({
      workerLifetimeMs: 40_000,
      commanderLifetimeMs: 40_000,
      workerHeartbeat: true,
    });
    const environment = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
      PI_IDE_TERMINAL_PERSIST: '1',
      PI_IDE_VISIBLE_MCP: '1',
      CODEX_HOME: driver.codexHome,
      PATH: `${driver.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: driver.bin,
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;
    let userDataDir: string | null = null;
    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      userDataDir = first.userDataDir;
      await first.page.keyboard.press('Control+`');
      await expect(first.page.getByTestId('terminal-panel')).toBeVisible();
      await first.page.getByTestId('terminal-new-menu').click();
      await first.page.getByTestId('terminal-type-codex').click();
      await first.page.getByTestId('terminal-create-submit').click();
      await expect(first.page.getByTestId('terminal-session-bar')).toContainText('Codex', {
        timeout: 20_000,
      });
      await first.page.getByTestId('session-bar-room').click();
      const commanderTaskId = await first.page
        .getByTestId('task-room')
        .getAttribute('data-task-id');
      expect(commanderTaskId).toBeTruthy();
      await expect.poll(() => existsSync(driver.fleetProbe), { timeout: 20_000 }).toBe(true);
      const workerId = (JSON.parse(readFileSync(driver.fleetProbe, 'utf8')) as { workerId: string })
        .workerId;

      await expect
        .poll(async () => {
          const state = await first.page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as { workers: Array<{ terminalId: string; commanderTaskId: string }> }
          ).workers.find((worker) => worker.terminalId === workerId)?.commanderTaskId;
        })
        .toBe(commanderTaskId);

      await restartMainPreservingTerminals(first.app);
      firstApp = null;

      const second = await launchApp({ userDataDir: first.userDataDir, env: environment });
      secondApp = second.app;
      await expect
        .poll(async () => {
          const state = await second.page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as {
              workers: Array<{
                terminalId: string;
                commanderTaskId: string;
                taskId: string | null;
                status: string;
              }>;
            }
          ).workers.find((worker) => worker.terminalId === workerId);
        })
        .toMatchObject({ commanderTaskId, status: 'streaming' });
      const state = await second.page.evaluate(async () => {
        return window.product.rpc['orchestration.getState']!({});
      });
      const restored = (
        state.data as {
          workers: Array<{
            terminalId: string;
            commanderTaskId: string;
            taskId: string | null;
            status: string;
          }>;
        }
      ).workers.find((worker) => worker.terminalId === workerId);
      expect(restored).toMatchObject({ commanderTaskId, status: 'streaming' });
      if (!restored?.taskId)
        throw new Error('The restored worker did not retain its Session task.');

      const workerRow = second.page.getByTestId(`home-task-${restored.taskId}`);
      await expect(workerRow).toBeVisible();
      await expect(workerRow.locator('xpath=..')).toHaveClass(/sr-orch-worker/);
      await expect(workerRow).toHaveAttribute('data-working', 'true');
    } finally {
      if (firstApp) {
        const page = firstApp.windows()[0];
        if (page) await killAllTerminals(page).catch(() => undefined);
        await firstApp.close().catch(() => undefined);
      }
      if (secondApp) {
        const page = secondApp.windows()[0];
        if (page) await killAllTerminals(page).catch(() => undefined);
        await secondApp.close().catch(() => undefined);
      }
      if (userDataDir) await shutdownPersistentTestTerminals(userDataDir).catch(() => undefined);
    }
  });

  test('stops animating an idle daemon worker after restart replay settles', async () => {
    test.setTimeout(120_000);
    const fixture = createTsSmallFixture();
    const driver = createFleetResumeDriver({
      workerLifetimeMs: 40_000,
      commanderLifetimeMs: 40_000,
      workerHeartbeat: false,
      workerCompletesTurn: true,
    });
    const environment = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex',
      PI_IDE_TERMINAL_PERSIST: '1',
      PI_IDE_VISIBLE_MCP: '1',
      CODEX_HOME: driver.codexHome,
      PATH: `${driver.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: driver.bin,
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;
    let userDataDir: string | null = null;
    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      userDataDir = first.userDataDir;
      await first.page.keyboard.press('Control+`');
      await expect(first.page.getByTestId('terminal-panel')).toBeVisible();
      await first.page.getByTestId('terminal-new-menu').click();
      await first.page.getByTestId('terminal-type-codex').click();
      await first.page.getByTestId('terminal-create-submit').click();
      await expect(first.page.getByTestId('terminal-session-bar')).toContainText('Codex', {
        timeout: 20_000,
      });
      await first.page.getByTestId('session-bar-room').click();
      const commanderTaskId = await first.page
        .getByTestId('task-room')
        .getAttribute('data-task-id');
      expect(commanderTaskId).toBeTruthy();
      await expect.poll(() => existsSync(driver.fleetProbe), { timeout: 20_000 }).toBe(true);
      const workerId = (JSON.parse(readFileSync(driver.fleetProbe, 'utf8')) as { workerId: string })
        .workerId;

      // The worker emitted its one startup line and then settled while its CLI
      // process stayed alive. Persist that completed turn before restarting.
      await expect
        .poll(async () => {
          const state = await first.page.evaluate(async () => {
            return window.product.rpc['orchestration.getState']!({});
          });
          return (
            state.data as { workers: Array<{ terminalId: string; status: string }> }
          ).workers.find((worker) => worker.terminalId === workerId)?.status;
        })
        .toBe('completed');

      await restartMainPreservingTerminals(first.app);
      firstApp = null;

      const second = await launchApp({ userDataDir: first.userDataDir, env: environment });
      secondApp = second.app;
      await expect
        .poll(
          async () => {
            const state = await second.page.evaluate(async () => {
              return window.product.rpc['orchestration.getState']!({});
            });
            return (
              state.data as {
                workers: Array<{
                  terminalId: string;
                  commanderTaskId: string;
                  taskId: string | null;
                  status: string;
                }>;
              }
            ).workers.find((worker) => worker.terminalId === workerId);
          },
          { timeout: 20_000 },
        )
        .toMatchObject({ commanderTaskId, status: 'quiet' });

      const state = await second.page.evaluate(async () => {
        return window.product.rpc['orchestration.getState']!({});
      });
      const worker = (
        state.data as {
          workers: Array<{ terminalId: string; taskId: string | null; status: string }>;
        }
      ).workers.find((candidate) => candidate.terminalId === workerId);
      if (!worker?.taskId) throw new Error('The restored idle worker lost its Session task.');

      const workerRow = second.page.getByTestId(`home-task-${worker.taskId}`);
      await expect(workerRow).toBeVisible();
      await expect(workerRow).toHaveAttribute('data-working', 'false');
      await expect(workerRow.locator('.sr-provider')).not.toHaveClass(/is-working/);
    } finally {
      if (firstApp) {
        const page = firstApp.windows()[0];
        if (page) await killAllTerminals(page).catch(() => undefined);
        await firstApp.close().catch(() => undefined);
      }
      if (secondApp) {
        const page = secondApp.windows()[0];
        if (page) await killAllTerminals(page).catch(() => undefined);
        await secondApp.close().catch(() => undefined);
      }
      if (userDataDir) await shutdownPersistentTestTerminals(userDataDir).catch(() => undefined);
    }
  });
});
