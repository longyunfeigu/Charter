import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';

/**
 * Project memory (ADR-0028) — review-as-learning:
 * 1. request-fix correction → distill card → rule in .charter/rules.md →
 *    injected into the next managed run (observed via injection counters).
 * 2. AGENTS.md managed-block sync: enable → write, hand edit → drift (never
 *    silently overwritten), import → candidate + rewrite.
 * 3. External private memory via a fake home (PI_IDE_MEMORY_HOME): discovery,
 *    view, promote → candidate → approved into the shared rules file.
 */

test('memory: correction → distill card → rule → injected into the next run', async () => {
  test.setTimeout(180000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  try {
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

    // ---- run an edit task to REVIEW_READY, then send a request-fix note ----
    await page.getByTestId('home-mode-auto').click();
    await page.getByTestId('home-intent').fill('[scenario:edit-hunks] two-block change');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
      timeout: 30000,
    });

    await page.getByTestId('review-bar-open').click();
    await expect(page.getByTestId('review-view')).toBeVisible();
    const modified = page.locator(
      '[data-testid="review-diff"] .monaco-diff-editor .editor.modified',
    );
    await expect(modified).toBeVisible({ timeout: 15000 });
    await modified.locator('.view-line').first().dblclick();
    await expect(page.getByTestId('review-request-fix')).toBeVisible();
    await page.getByTestId('review-request-fix').click();
    await page
      .getByTestId('request-fix-note')
      .fill('Never use default export here — named exports only.');
    await page.getByTestId('request-fix-send').click();
    await expect(page.getByTestId('task-room')).toBeVisible();

    // ---- the distill card surfaces the captured candidate inline ----
    await expect(page.getByTestId('distill-card')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('distill-text')).toHaveValue(/named exports only/i);
    await page.getByTestId('distill-approve').click();
    await expect(page.getByTestId('distill-done')).toBeVisible();

    // ---- the rule landed in the shared file and the Memory panel ----
    const rulesFile = join(fixture, '.charter', 'rules.md');
    expect(existsSync(rulesFile)).toBe(true);
    expect(readFileSync(rulesFile, 'utf8')).toContain('named exports only');

    await page.getByTestId('rail-view-memory').click();
    await expect(page.getByTestId('memory-view')).toBeVisible();
    // IA v3: rules live under the Charter agent; the current project's group
    // expands by default and its detail loads lazily.
    await page.getByTestId('memory-nav-charter').click();
    await expect(page.getByTestId('memory-rule-row').first()).toContainText('named exports only', {
      timeout: 10000,
    });
    await page.locator('.modal-close').click();

    // ---- the very next managed run carries the rule (injection recorded) ----
    await page.getByTestId('task-room-back').first().click();
    await page.getByTestId('home-mode-ask').click();
    await page.getByTestId('home-intent').fill('[scenario:ask-basic] quick question');
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 30000,
    });

    await page.getByTestId('rail-view-memory').click();
    await page.getByTestId('memory-nav-charter').click();
    await expect(page.getByTestId('memory-rule-row').first()).toContainText(
      /injected into \d+ task/,
      { timeout: 15000 },
    );
  } finally {
    await app.close();
  }
});

test('memory: AGENTS.md sync — enable writes the block, hand edits drift, import rescues them', async () => {
  test.setTimeout(150000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
  });
  try {
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

    // Add a rule through the panel (IA v3: Charter agent → current project group).
    await page.getByTestId('rail-view-memory').click();
    await expect(page.getByTestId('memory-view')).toBeVisible();
    await page.getByTestId('memory-nav-charter').click();
    await page
      .getByTestId('memory-add-rule-input')
      .fill('Always run npm run check before pushing.');
    await page.getByTestId('memory-add-rule').click();
    await expect(page.getByTestId('memory-rule-row').first()).toContainText('npm run check', {
      timeout: 10000,
    });

    // Enable the AGENTS.md projection — the managed block appears on disk
    // (Distribution lines live inside the project group now).
    await page.getByTestId('memory-sync-toggle-agents-md').click();
    await expect(page.getByTestId('memory-sync-status-agents-md')).toContainText('synced', {
      timeout: 10000,
    });
    const agentsPath = join(fixture, 'AGENTS.md');
    expect(readFileSync(agentsPath, 'utf8')).toContain('- Always run npm run check');

    // Hand-edit inside the managed block → next sync flags drift, no overwrite.
    const drifted = readFileSync(agentsPath, 'utf8').replace(
      '- Always run npm run check before pushing.',
      '- Always run npm run check before pushing.\n- Sneaky hand-added deploy convention here',
    );
    writeFileSync(agentsPath, drifted);
    await page.getByTestId('memory-sync-agents-md').getByText('Sync now').click();
    await expect(page.getByTestId('memory-sync-status-agents-md')).toContainText('hand-edited', {
      timeout: 10000,
    });
    expect(readFileSync(agentsPath, 'utf8')).toContain('Sneaky hand-added');

    // Import: hand edit becomes a candidate; the block is rewritten from source.
    await page.getByTestId('memory-drift-import-agents-md').click();
    await expect(page.getByTestId('memory-sync-status-agents-md')).toContainText('synced', {
      timeout: 10000,
    });
    expect(readFileSync(agentsPath, 'utf8')).not.toContain('Sneaky hand-added');
    await expect(page.getByTestId('memory-candidate').first()).toContainText(
      'Sneaky hand-added deploy convention',
    );
  } finally {
    await app.close();
  }
});

test('memory: external private memory (fake home) — discover, view, promote, approve', async () => {
  test.setTimeout(150000);
  const fixture = createTsSmallFixture();
  const fakeHome = mkdtempSync(join(tmpdir(), 'pi-ide-memory-home-'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-memory-userdata-'));
  // Claude Code's auto-memory dir for this project: munged realpath, like the CLI.
  const munged = realpathSync(fixture).replace(/[^a-zA-Z0-9]/g, '-');
  const memDir = join(fakeHome, '.claude', 'projects', munged, 'memory');
  mkdirSync(memDir, { recursive: true });
  mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', 'CLAUDE.md'), '# Global hand-written instructions\n');
  writeFileSync(join(memDir, 'MEMORY.md'), '# Memory Index\n- habits\n');
  writeFileSync(
    join(memDir, 'habits.md'),
    '---\nname: habits\n---\nAlways verify the build output before claiming done.\n',
  );

  const { app, page } = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_MEMORY_HOME: fakeHome,
    },
  });
  try {
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });

    await page.getByTestId('rail-view-memory').click();
    await expect(page.getByTestId('memory-view')).toBeVisible();
    await page.getByTestId('memory-nav-claude').click();

    // Discovery: global instructions + index + note, all read-only surfaced.
    const files = page.getByTestId('memory-external-file');
    await expect(files).toHaveCount(3, { timeout: 10000 });
    await expect(files.filter({ hasText: 'CLAUDE.md' }).first()).toContainText('global');
    const habits = files.filter({ hasText: 'habits.md' }).first();
    await expect(habits).toContainText('verify the build');

    // View opens a dialog: frontmatter strip + rendered markdown body.
    await habits.getByText('View', { exact: true }).click();
    await expect(page.getByTestId('memory-file-dialog')).toBeVisible();
    await expect(page.getByTestId('memory-external-viewer')).toContainText(
      'Always verify the build output',
    );
    await expect(page.getByTestId('memory-external-viewer')).toContainText('name: habits');
    await page.getByTestId('memory-file-close').click();
    await expect(page.getByTestId('memory-file-dialog')).not.toBeVisible();

    // Escape closes only the file dialog — the memory overlay stays open.
    await habits.getByText('View', { exact: true }).click();
    await expect(page.getByTestId('memory-file-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('memory-file-dialog')).not.toBeVisible();
    await expect(page.getByTestId('memory-view')).toBeVisible();

    // Promote copies (one-way) into that project's Charter rule candidates.
    await habits.getByTestId('memory-external-promote').click();
    await page.getByTestId('memory-nav-charter').click();
    const candidate = page.getByTestId('memory-candidate').first();
    await expect(candidate).toContainText('verify the build output');
    await candidate.getByTestId('memory-candidate-approve').click();
    await expect(page.getByTestId('memory-rule-row').first()).toContainText('verify the build', {
      timeout: 10000,
    });
    expect(readFileSync(join(fixture, '.charter', 'rules.md'), 'utf8')).toContain(
      'verify the build output',
    );
    // The original private note is untouched (promotion is a copy).
    expect(existsSync(join(memDir, 'habits.md'))).toBe(true);

    // Delete backs up first (backup lands under userData/memory/trash).
    await page.getByTestId('memory-nav-claude').click();
    await habits.getByTestId('memory-external-delete').click();
    await habits.getByTestId('memory-external-delete').click(); // two-step confirm
    await expect(files).toHaveCount(2, { timeout: 10000 });
    expect(existsSync(join(memDir, 'habits.md'))).toBe(false);
    const trashDir = join(userDataDir, 'memory', 'trash');
    expect(readdirSync(trashDir).some((name) => name.endsWith('habits.md'))).toBe(true);
  } finally {
    await app.close();
  }
});
