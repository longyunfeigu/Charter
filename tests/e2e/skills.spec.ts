import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

/**
 * Skills (ADR-0015): managed store + Settings manager + composer "/" picker.
 * Skills are pre-seeded into the managed store (userData/skills) — the product
 * itself never scans project folders for skills (AG-014).
 */

function seedSkill(
  skillsDir: string,
  name: string,
  options: { description: string; explicitOnly?: boolean; script?: boolean } = {
    description: '',
  },
): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${options.description}`,
      ...(options.explicitOnly ? ['disable-model-invocation: true'] : []),
      '---',
      `You are using the ${name} skill. Follow its steps carefully.`,
      '',
    ].join('\n'),
  );
  if (options.script) {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'run.py'), 'print("hi")\n');
  }
}

test('skills: manager (toggle/audit) + "/" picker + /skill: task through the mock runtime', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-skills-'));
  const skillsDir = join(userDataDir, 'skills');
  seedSkill(skillsDir, 'pdf-fill', {
    description: 'Fill and extract fields from PDF forms.',
    script: true,
  });
  seedSkill(skillsDir, 'deploy-staging', {
    description: 'Deploy the current branch to staging.',
    explicitOnly: true,
  });

  const fixture = createGitFixture();
  const { app, page } = await launchApp({
    userDataDir,
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  try {
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

    // ---- composer "/" picker: only enabled skills, filter + insert ----
    const intent = page.getByTestId('home-intent');
    await intent.click();
    await intent.press('/');
    await expect(page.getByTestId('home-skill-picker')).toBeVisible();
    await expect(page.getByTestId('home-skill-item-pdf-fill')).toBeVisible();
    // The explicit-only skill still appears in "/" — that is its invocation path.
    await expect(page.getByTestId('home-skill-item-deploy-staging')).toContainText('explicit-only');
    // Typing filters; Enter inserts the /skill: command.
    await intent.pressSequentially('pdf');
    await expect(page.getByTestId('home-skill-item-deploy-staging')).toHaveCount(0);
    await intent.press('Enter');
    await expect(intent).toHaveValue('/skill:pdf-fill ');
    await expect(page.getByTestId('home-skill-picker')).toHaveCount(0);

    // ---- a /skill: task runs (mock scenario tag rides in the args) ----
    await page.getByTestId('home-mode-ask').click();
    await intent.pressSequentially('[scenario:ask-basic] what is this project?');
    await intent.press('Enter');
    await expect(page.getByTestId('tl-answered')).toBeVisible({ timeout: 30000 });
    // The timeline shows what the user typed — the raw command, not the expansion.
    await expect(page.getByTestId('task-room')).toContainText('/skill:pdf-fill');
    await page.getByTestId('task-room-back').click();

    // ---- Settings → Agent → Skills manager ----
    await page.getByTestId('home-settings').click();
    await page.locator('.st-nav-item', { hasText: 'Agent' }).click();
    const row = page.getByTestId('skill-row-pdf-fill');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Fill and extract fields');
    await expect(row).toContainText('1 script');
    await expect(page.getByTestId('skill-row-deploy-staging')).toContainText('explicit-only');

    // Audit view: SKILL.md + bundled files, scripts flagged.
    await page.getByTestId('skill-audit-pdf-fill').click();
    const audit = page.getByTestId('skill-audit-panel-pdf-fill');
    await expect(audit).toBeVisible();
    await expect(audit).toContainText('You are using the pdf-fill skill');
    await expect(audit).toContainText('scripts/run.py');
    await expect(audit).toContainText('Permission Engine');

    // Toggle Off: the row dims…
    await page.getByTestId('skill-off-pdf-fill').click();
    await expect(row).toHaveClass(/off/);

    // …and the skill vanishes from the "/" picker immediately.
    await page.getByTestId('overlay-settings').getByLabel('Close').click();
    await intent.click();
    await intent.press('/');
    await expect(page.getByTestId('home-skill-picker')).toBeVisible();
    await expect(page.getByTestId('home-skill-item-deploy-staging')).toBeVisible();
    await expect(page.getByTestId('home-skill-item-pdf-fill')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
