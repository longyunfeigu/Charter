import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { waitForTerminalOutput } from './helpers/terminal';

function createChattyClaudeBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-menu-perf-bin-'));
  const executable = join(bin, 'claude');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      'for (let i = 0; i < 3000; i += 1) console.log(`restored transcript line ${i}`);',
      "console.log('chatty claude ready');",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60_000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return bin;
}

function seedLargeSkillCatalog(userDataDir: string, count = 75): void {
  const root = join(userDataDir, 'skills');
  for (let index = 0; index < count; index += 1) {
    const name = `performance-skill-${String(index + 1).padStart(2, '0')}`;
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: Performance fixture capability number ${index + 1}.`,
        '---',
        `Follow the acceptance contract for capability ${index + 1}.`,
        '',
      ].join('\n'),
    );
  }
}

async function measureToggleToPaint(
  page: Page,
  testId: string,
  expectedExpanded: boolean,
): Promise<number> {
  return page.evaluate(
    async ({ id, expanded }) => {
      const button = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!button) throw new Error(`Missing performance target: ${id}`);
      const started = performance.now();
      button.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (button.getAttribute('aria-expanded') !== String(expanded)) {
        throw new Error(`${id} did not reach aria-expanded=${expanded}`);
      }
      return performance.now() - started;
    },
    { id: testId, expanded: expectedExpanded },
  );
}

async function measureNavigationToPaint(
  page: Page,
  triggerTestId: string,
  targetTestId: string,
): Promise<number> {
  return page.evaluate(
    async ({ triggerId, targetId }) => {
      const button = document.querySelector<HTMLElement>(`[data-testid="${triggerId}"]`);
      if (!button) throw new Error(`Missing navigation trigger: ${triggerId}`);
      const started = performance.now();
      button.click();
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (!document.querySelector(`[data-testid="${targetId}"]`)) {
        throw new Error(`${targetId} did not paint after ${triggerId}`);
      }
      return performance.now() - started;
    },
    { triggerId: triggerTestId, targetId: targetTestId },
  );
}

test('Session More menu responds within one interaction frame with a restored terminal', async () => {
  test.setTimeout(90_000);
  const fixture = realpathSync(createGitFixture());
  const bin = createChattyClaudeBin();
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_FORCE_MOCK: '1',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
    home: 'keep',
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-agent').click();
    await page.getByTestId('home-agent-claude').click();
    await page.getByTestId('home-intent').fill('Inspect a large restored transcript');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('external-terminal-column')).toBeVisible({ timeout: 20_000 });
    const terminalId = await page
      .getByTestId('external-terminal-column')
      .getAttribute('data-terminal-id');
    expect(terminalId).not.toBeNull();
    await waitForTerminalOutput(page, 'chatty claude ready', { terminalId: terminalId! });

    // Let xterm finish parsing and painting the restored transcript before the
    // menu measurement. The menu should not ask that terminal subtree to
    // reconcile just because its own popover opened.
    await page.waitForTimeout(250);
    const samples: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      samples.push(await measureToggleToPaint(page, 'session-more', true));
      samples.push(await measureToggleToPaint(page, 'session-more', false));
    }
    const worst = Math.max(...samples);
    test.info().annotations.push({
      type: 'menu-paint-ms',
      description: samples.map((sample) => sample.toFixed(1)).join(', '),
    });
    expect(
      worst,
      `menu paint samples: ${samples.map((sample) => sample.toFixed(1)).join(', ')}`,
    ).toBeLessThan(80);
  } finally {
    await app.close();
  }
});

test('Missions and a large Skills catalog stay responsive across repeated navigation', async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'charter-navigation-perf-'));
  seedLargeSkillCatalog(userDataDir);
  const fixture = realpathSync(createGitFixture());
  const { app, page } = await launchApp({
    userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });

  try {
    await page.setViewportSize({ width: 1440, height: 900 });

    // Prime only the catalog data. The view itself is unmounted again, so the
    // timed click still pays the real React/DOM mount cost.
    await page.getByTestId('rail-view-skills').click();
    await expect(page.getByTestId('skills-main-page')).toBeVisible();
    await expect(page.locator('.skills-table-frame tbody tr')).toHaveCount(12);
    await expect(page.getByTestId('skills-show-more')).toContainText(/\d+ remaining/);
    await page.getByTestId('skills-show-more').click();
    await expect(page.locator('.skills-table-frame tbody tr')).toHaveCount(36);
    await page.getByTestId('rail-view-sessions').click();

    const skillSamples: number[] = [];
    const missionSamples: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      skillSamples.push(
        await measureNavigationToPaint(page, 'rail-view-skills', 'skills-main-page'),
      );
      await expect(page.locator('.skills-table-frame tbody tr')).toHaveCount(12);
      await page.getByTestId('rail-view-sessions').click();
      missionSamples.push(
        await measureNavigationToPaint(page, 'rail-view-missions', 'mission-center'),
      );
      await page.getByTestId('rail-view-sessions').click();
    }

    test.info().annotations.push({
      type: 'skills-navigation-paint-ms',
      description: skillSamples.map((sample) => sample.toFixed(1)).join(', '),
    });
    test.info().annotations.push({
      type: 'missions-navigation-paint-ms',
      description: missionSamples.map((sample) => sample.toFixed(1)).join(', '),
    });
    expect(
      Math.max(...skillSamples),
      `Skills navigation: ${skillSamples.map((sample) => sample.toFixed(1)).join(', ')}`,
    ).toBeLessThan(120);
    expect(
      Math.max(...missionSamples),
      `Missions navigation: ${missionSamples.map((sample) => sample.toFixed(1)).join(', ')}`,
    ).toBeLessThan(120);

    await page.setViewportSize({ width: 900, height: 720 });
    await page.getByTestId('rail-view-skills').click();
    await expect(page.getByTestId('skills-main-page')).toBeVisible();
    await expect(page.locator('.skills-table-frame tbody tr')).toHaveCount(12);
    await expect(page.getByTestId('skills-show-more')).toBeVisible();
  } finally {
    await app.close();
  }
});
