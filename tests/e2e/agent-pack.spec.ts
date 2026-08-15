import { expect, test } from '@playwright/test';
import type { AgentCatalogDto } from '@pi-ide/ipc-contracts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

function createPackFixture(): {
  root: string;
  home: string;
  bin: string;
  packFile: string;
  argsProbe: string;
  inputProbe: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'charter-agent-pack-e2e-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const argsProbe = join(root, 'args.log');
  const inputProbe = join(root, 'input.bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'fixture-agent');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(argsProbe)}, process.argv.slice(2).join(' ') + '\\n');`,
      'process.stdin.setRawMode?.(true);',
      `process.stdin.on('data', chunk => fs.appendFileSync(${JSON.stringify(inputProbe)}, chunk));`,
      "console.log('Aider Pack fixture ready');",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  const packFile = join(root, 'fixture-agent.charter-agent-pack.json');
  writeFileSync(
    packFile,
    JSON.stringify({
      schemaVersion: 1,
      id: 'fixture-agent-pack',
      version: '1.0.0',
      displayName: 'Fixture Agent Adapter Pack',
      publisher: 'Charter E2E',
      engine: { min: 1, max: 1 },
      adapters: [
        {
          schemaVersion: 1,
          adapterVersion: '1.0.0',
          engine: { min: 1, max: 1 },
          id: 'fixture-agent',
          displayName: 'Fixture Agent',
          shortName: 'Fixture',
          description: 'E2E Pack Agent',
          mark: 'generic',
          accent: '#345678',
          discovery: { commands: ['fixture-agent'], knownPaths: [], versionArgs: ['--version'] },
          terminal: {
            promptDelivery: 'argv',
            initialPromptArgs: ['--message', '{prompt}'],
            exitSequence: ['interrupt', 'eof'],
          },
          acp: null,
          sessions: null,
          surfaces: { skillRoots: [], instructionRoots: [], remote: true },
          capabilities: {
            terminal: true,
            acp: false,
            loadSession: false,
            sessionList: false,
            sessionResume: false,
            images: true,
            embeddedContext: false,
            mcp: false,
            exactResume: false,
            history: false,
            skills: false,
            instructions: false,
            remote: true,
            lifecycle: 'none',
          },
          lifecycle: null,
        },
      ],
    }),
  );
  return { root, home, bin, packFile, argsProbe, inputProbe };
}

test('loads and hot-toggles a user Agent Pack, then image-path pastes into its live terminal', async () => {
  test.setTimeout(90_000);
  const fixture = createPackFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-e2e-agent-pack-'));
  const versionsDir = join(userDataDir, 'agent-packs', 'fixture-agent-pack', 'versions');
  mkdirSync(versionsDir, { recursive: true });
  writeFileSync(join(versionsDir, '1.0.0.json'), readFileSync(fixture.packFile));
  writeFileSync(
    join(userDataDir, 'agent-packs', 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      packs: {
        'fixture-agent-pack': {
          enabled: true,
          currentVersion: '1.0.0',
          previousVersion: null,
          installedAt: new Date(0).toISOString(),
          trust: 'local',
        },
      },
    }),
  );
  const project = createGitFixture();
  const { app, page } = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: project,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_AGENT_HOME: fixture.home,
      PATH: `${fixture.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    await page.getByTestId('home-settings').click();
    await page.getByTestId('settings-section-agent').click();
    await expect(page.getByTestId('agent-pack-install')).toBeVisible();
    const packRow = page.getByTestId('agent-pack-fixture-agent-pack');
    await expect(packRow).toContainText('Fixture Agent Adapter Pack');
    await expect(packRow).toContainText('local');
    await expect(page.getByTestId('agent-adapter-fixture-agent')).toContainText(
      'Adapter 1.0.0 · pack',
    );

    await page.getByTestId('agent-pack-toggle-fixture-agent-pack').click();
    await expect(packRow).toContainText('Disabled');
    await expect(page.getByTestId('agent-adapter-fixture-agent')).toHaveCount(0);
    await page.getByTestId('agent-pack-toggle-fixture-agent-pack').click();
    await expect(packRow).toContainText('Enabled');
    await expect(page.getByTestId('agent-adapter-fixture-agent')).toBeVisible();

    await page.setViewportSize({ width: 900, height: 720 });
    const rowBox = await packRow.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(900);
    await page.screenshot({ path: '/tmp/charter-agent-pack-settings-narrow.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const catalog = (await page.evaluate(async () =>
      window.product.rpc['agents.list']!({ refresh: true }),
    )) as { ok: true; data: AgentCatalogDto } | { ok: false; error: unknown };
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) throw new Error('agents.list failed');
    expect(catalog.data.agents.find((agent) => agent.id === 'fixture-agent')?.adapter.source).toBe(
      'pack',
    );

    await page.getByTestId('settings-back').click();
    await page.getByTestId('home-agent').click();
    await page.getByTestId('home-agent-fixture-agent').click();
    await page.getByTestId('home-intent').fill('review this pack');
    await page.getByTestId('home-submit').click();
    await expect
      .poll(() => (existsSync(fixture.argsProbe) ? readFileSync(fixture.argsProbe, 'utf8') : ''), {
        timeout: 15_000,
      })
      .toContain('--message review this pack');
    const imageButton = page.getByTestId('session-bar-paste-image');
    await expect(imageButton).toBeVisible({ timeout: 15_000 });

    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await app.evaluate(({ clipboard, nativeImage }, data) => {
      const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
      if (image.isEmpty()) throw new Error('PNG fixture did not decode');
      clipboard.writeImage(image);
    }, pngBase64);
    await imageButton.click();
    await expect(page.locator('.toast').last()).toContainText(/path pasted|image/i, {
      timeout: 5_000,
    });
    await expect
      .poll(
        () => (existsSync(fixture.inputProbe) ? readFileSync(fixture.inputProbe, 'utf8') : ''),
        { timeout: 15_000 },
      )
      .toContain('\x1b[200~');
    const pasted = readFileSync(fixture.inputProbe, 'utf8');
    expect(pasted).toMatch(/^\x1b\[200~(.+\.png)\x1b\[201~$/);
    expect(pasted).not.toContain('\r');
    const stagedPath = pasted.slice(6, -6);
    expect(existsSync(stagedPath)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(stagedPath).mode & 0o777).toBe(0o600);

    const terminalId = await page
      .getByTestId('external-terminal-host')
      .getAttribute('data-terminal-id');
    expect(terminalId).toBeTruthy();
    await page.evaluate(
      async (id) => window.product.rpc['terminal.kill']!({ id: id!, force: true }),
      terminalId,
    );
    await expect.poll(() => existsSync(stagedPath)).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
