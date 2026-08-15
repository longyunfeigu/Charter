import { expect, test } from '@playwright/test';
import type { AgentCatalogDto } from '@pi-ide/ipc-contracts';
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

function createAdapterFixture(): {
  home: string;
  bin: string;
  adapters: string;
  probe: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'charter-agent-adapter-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const adapters = join(root, 'adapters');
  const probe = join(root, 'aider-probe.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(adapters, { recursive: true });

  const executable = join(bin, 'aider');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(probe)}, process.argv.slice(2).join(' ') + '\\n');`,
      "console.log('Aider Adapter fixture ready');",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 15000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);

  writeFileSync(
    join(adapters, 'aider.json'),
    JSON.stringify({
      schemaVersion: 1,
      adapterVersion: 'e2e.1',
      engine: { min: 1, max: 1 },
      id: 'aider',
      displayName: 'Aider',
      shortName: 'Aider',
      description: 'E2E local Adapter',
      mark: 'generic',
      accent: '#345678',
      discovery: { commands: ['aider'], knownPaths: [], versionArgs: ['--version'] },
      terminal: {
        promptDelivery: 'argv',
        initialPromptArgs: ['--message', '{prompt}'],
        exitSequence: ['interrupt', 'eof'],
      },
      acp: null,
      sessions: null,
      surfaces: { skillRoots: [], instructionRoots: [], remote: false },
      capabilities: {
        terminal: true,
        acp: false,
        loadSession: false,
        sessionList: false,
        sessionResume: false,
        images: false,
        embeddedContext: false,
        mcp: false,
        exactResume: false,
        history: false,
        skills: false,
        instructions: false,
        remote: false,
        lifecycle: 'none',
      },
      lifecycle: null,
    }),
  );
  writeFileSync(join(adapters, 'broken.json'), '{ invalid');
  return { home, bin, adapters, probe };
}

test('loads one complete local Adapter, isolates a broken peer, and launches without a provider branch', async () => {
  test.setTimeout(60_000);
  const fixture = createAdapterFixture();
  const project = createGitFixture();
  const nodeBin = dirname(process.execPath);
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: project,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_AGENT_HOME: fixture.home,
      PI_IDE_AGENT_MANIFESTS: fixture.adapters,
      PATH: `${fixture.bin}:${nodeBin}:/usr/bin:/bin`,
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
    const catalog = (await page.evaluate(async () =>
      window.product.rpc['agents.list']!({ refresh: true }),
    )) as { ok: true; data: AgentCatalogDto } | { ok: false; error: unknown };
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error('agents.list failed');
    expect(catalog.data.engineVersion).toBe(1);
    expect(catalog.data.overrideEnabled).toBe(true);
    expect(catalog.data.agents.find((agent) => agent.id === 'aider')).toMatchObject({
      installed: true,
      adapter: { adapterVersion: 'e2e.1', source: 'override' },
      capabilities: { terminal: true, lifecycle: 'none' },
    });
    expect(catalog.data.diagnostics).toMatchObject([{ code: 'invalid-json', severity: 'error' }]);

    await page.getByTestId('home-settings').click();
    await page.getByTestId('settings-section-agent').click();
    await expect(page.getByTestId('agent-adapters')).toContainText('Engine 1');
    await expect(page.getByTestId('agent-adapter-aider')).toContainText('Adapter e2e.1 · override');
    await expect(page.getByTestId('agent-adapter-aider')).toContainText('Terminal');
    await expect(page.getByTestId('agent-adapter-diagnostic')).toContainText('invalid-json');
    await page.screenshot({ path: '/tmp/charter-agent-adapter-settings.png', fullPage: true });

    await page.setViewportSize({ width: 900, height: 720 });
    await expect(page.getByTestId('agent-adapter-aider')).toBeVisible();
    const adapterBox = await page.getByTestId('agent-adapter-aider').boundingBox();
    expect(adapterBox).not.toBeNull();
    expect(adapterBox!.x + adapterBox!.width).toBeLessThanOrEqual(900);
    await page.screenshot({
      path: '/tmp/charter-agent-adapter-settings-narrow.png',
      fullPage: true,
    });

    await page.getByTestId('settings-back').click();
    await page.getByTestId('home-agent').click();
    await expect(page.getByTestId('home-agent-aider')).toBeVisible();
    await page.getByTestId('home-agent-aider').click();
    await page.getByTestId('home-intent').fill('review this adapter');
    await page.getByTestId('home-submit').click();
    await expect
      .poll(() => (existsSync(fixture.probe) ? readFileSync(fixture.probe, 'utf8') : ''), {
        timeout: 15_000,
      })
      .toContain('--message review this adapter');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
