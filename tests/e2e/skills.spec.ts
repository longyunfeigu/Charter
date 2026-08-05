import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

/**
 * Skills: managed store + main-page usage manager + composer "/" picker.
 * Skills are pre-seeded into the managed store (userData/skills) — the product
 * itself never scans project folders for skills (AG-014).
 */

function seedSkill(
  skillsDir: string,
  name: string,
  options: { description: string; explicitOnly?: boolean; script?: boolean; body?: string } = {
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
      options.body ?? `You are using the ${name} skill. Follow its steps carefully.`,
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
    const picker = page.getByTestId('home-skill-picker');
    // Skills load asynchronously from the main process. Repeat the harmless
    // empty-composer shortcut until that catalog is ready instead of racing it.
    await expect
      .poll(async () => {
        await intent.fill('');
        await intent.press('/');
        return picker.isVisible().catch(() => false);
      })
      .toBe(true);
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
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 30000,
    });
    await expect(page.getByTestId('tl-answered')).toHaveCount(0);
    // The timeline shows what the user typed — the raw command, not the expansion.
    await expect(page.getByTestId('task-room')).toContainText('/skill:pdf-fill');
    await page.getByTestId('task-room-back').click();

    // ---- Skills main page: grouped catalog + per-Agent management ----
    await page.getByTestId('rail-view-skills').click();
    await expect(page.getByTestId('skills-main-page')).toBeVisible();
    await expect(page.getByTestId('skills-run')).toHaveCount(0);
    await expect(page.locator('.skills-stats')).toHaveCount(0);
    await expect(page.getByTestId('skills-rail-panel')).toContainText('Observed use');
    await expect(page.getByTestId('skills-rail-panel')).not.toContainText('not tracked');
    await expect(
      page
        .getByTestId('skills-rail-panel')
        .locator('.skills-rail-coverage > div', { hasText: 'Codex' }),
    ).toContainText('transcript-derived');
    await expect(page.locator('thead')).toContainText('45-day observation window');
    await expect(page.getByText('Future adapters', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Sources & trust', { exact: true })).toHaveCount(0);
    const row = page.locator('tbody tr', { hasText: 'pdf-fill' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Fill and extract fields');
    await expect(row.locator('.skills-usage-rollup .pi b')).toHaveText('1');
    await expect(row).not.toContainText('no observed use');
    await expect(page.getByTestId('skills-rail-active').locator('b')).toHaveText('1');
    const explicitRow = page.locator('tbody tr', { hasText: 'deploy-staging' });
    await expect(explicitRow).toContainText('explicit');
    await expect(explicitRow).toContainText('no observed use');
    await expect(page.getByTestId('skills-rail-review').locator('b')).toHaveText('1');
    await expect(row.locator('.skills-usage-rollup .codex')).toHaveAttribute(
      'title',
      'Codex observed usage',
    );
    await expect(row.locator('.skills-usage-rollup .codex b')).toHaveText('0');
    // The inventory remains usable at a narrower desktop viewport: controls
    // wrap while the table keeps its horizontal scroll surface.
    await page.setViewportSize({ width: 900, height: 720 });
    await expect(page.locator('.sr-panel')).toHaveCSS('opacity', '0');
    await expect(page.getByTestId('skills-rescan')).toBeVisible();
    await expect(page.getByTestId('skills-rescan')).toBeInViewport();
    await expect(page.getByLabel('Search Skills')).toBeInViewport();
    await expect(row).toBeVisible();
    await expect(page.locator('.skills-table-frame')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Disable only the selected Charter copy: the grouped row dims…
    await page.getByTestId('skills-manage-pdf-fill').click();
    const pdfDrawer = page.getByRole('dialog', { name: 'Manage pdf-fill' });
    await expect(pdfDrawer).toContainText('Charter Agent');
    await expect(
      pdfDrawer.getByRole('checkbox', { name: 'Select Charter Agent copy' }),
    ).toBeChecked();
    await page.getByTestId('skills-drawer-disable').click();
    await expect(row).toHaveClass(/off/);

    // …and the skill vanishes from the "/" picker immediately.
    await page.getByRole('dialog', { name: 'Manage pdf-fill' }).getByLabel('Close').click();
    await page.getByTestId('rail-view-sessions').click();
    await intent.fill('');
    await intent.press('/');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('home-skill-item-deploy-staging')).toBeVisible();
    await expect(page.getByTestId('home-skill-item-pdf-fill')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('skills: discovers and live-syncs a trusted external Agent Skills source', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-live-skills-'));
  const skillHome = mkdtempSync(join(tmpdir(), 'pi-ide-skill-home-'));
  const agentsRoot = join(skillHome, '.agents', 'skills');
  const alphaDir = join(agentsRoot, 'live-alpha');
  seedSkill(agentsRoot, 'live-alpha', { description: 'Live description version one.' });

  const fixture = createGitFixture();
  const { app, page } = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_SKILLS_HOME: skillHome,
    },
  });
  try {
    await page.getByTestId('surface-home').click();
    await page.getByTestId('home-settings').click();
    await page.locator('.st-nav-item', { hasText: 'Skill Sources' }).click();

    const source = page.getByTestId('skill-source-agents');
    await expect(source).toContainText('1 Skills');

    // Discovery is not trust. Trust the source and opt into automatic
    // enablement before entering the main Skills workspace.
    await page.getByTestId('skill-source-trust-agents').check();
    await page.getByTestId('skill-source-auto-agents').check();
    await page.getByTestId('settings-go-to-skills').click();
    const alphaRow = page.locator('tbody tr', { hasText: 'live-alpha' });
    await expect(alphaRow).toBeVisible();
    await expect(alphaRow).toContainText('Charter');
    await expect(alphaRow).not.toHaveClass(/off/);

    // Atomic-ish editor update + newly added folder are reconciled by the
    // watcher and broadcast to the already-open Settings surface.
    writeFileSync(
      join(alphaDir, 'SKILL.md'),
      [
        '---',
        'name: live-alpha',
        'description: Live description version two.',
        '---',
        'Updated live instructions.',
      ].join('\n'),
    );
    seedSkill(agentsRoot, 'live-beta', { description: 'Added after app launch.' });
    await expect(alphaRow).toContainText('Live description version two.');
    const betaRow = page.locator('tbody tr', { hasText: 'live-beta' });
    await expect(betaRow).toBeVisible();
    await expect(betaRow).not.toHaveClass(/off/);

    // Deletion propagates too; Charter never owns or recreates linked files.
    rmSync(alphaDir, { recursive: true, force: true });
    await expect(alphaRow).toHaveCount(0);

    await page.getByTestId('rail-view-sessions').click();
    const intent = page.getByTestId('home-intent');
    await intent.click();
    await intent.press('/');
    await expect(page.getByTestId('home-skill-item-live-beta')).toBeVisible();
    await expect(page.getByTestId('home-skill-item-live-alpha')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(skillHome, { recursive: true, force: true });
  }
});

test('skills: groups same-name Agent copies and scopes disable/delete safely', async () => {
  test.setTimeout(120000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'pi-ide-agent-skills-'));
  const skillHome = mkdtempSync(join(tmpdir(), 'pi-ide-agent-skill-home-'));
  seedSkill(join(userDataDir, 'skills'), 'design-review', {
    description: 'Review a product design against the shared rubric.',
  });
  seedSkill(join(skillHome, '.claude', 'skills'), 'design-review', {
    description: 'Review a product design against the shared rubric.',
  });
  seedSkill(join(skillHome, '.codex', 'skills'), 'design-review', {
    description: 'Review a product design against the shared rubric.',
  });
  seedSkill(join(skillHome, '.codex', 'skills', '.system'), 'system-pdf', {
    description: 'Codex built-in PDF capability.',
    body: 'Use the Codex plugin integration to inspect PDF files.',
  });
  const codexSessionId = '019f1609-996f-7633-b306-921acdf80a78';
  const now = new Date();
  const codexSessionDir = join(
    skillHome,
    '.codex',
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  mkdirSync(codexSessionDir, { recursive: true });
  const observedAt = now.toISOString();
  writeFileSync(
    join(codexSessionDir, `rollout-e2e-${codexSessionId}.jsonl`),
    [
      {
        timestamp: observedAt,
        type: 'session_meta',
        payload: { id: codexSessionId, timestamp: observedAt, cwd: skillHome },
      },
      {
        timestamp: observedAt,
        type: 'event_msg',
        payload: { type: 'user_message', message: 'review this design' },
      },
      {
        timestamp: observedAt,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({
            cmd: `sed -n '1,260p' ${join(skillHome, '.codex', 'skills', 'design-review', 'SKILL.md')}`,
          }),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  );

  const { app, page } = await launchApp({
    userDataDir,
    home: 'keep',
    env: {
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_SKILLS_HOME: skillHome,
      PI_IDE_ARCHAEOLOGY_HOME: skillHome,
    },
  });
  try {
    await page.getByTestId('rail-view-skills').click();
    const row = page.locator('tbody tr', { hasText: 'design-review' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Charter');
    await expect(row).toContainText('Claude');
    await expect(row).toContainText('Codex');
    await expect(row.locator('.skills-usage-rollup .codex b')).toHaveText('1');
    await expect(row).not.toContainText('no observed use');

    // An Agent tab is a complete data perspective, not only a row filter.
    await page
      .locator('.skills-agent-tabs')
      .getByRole('button', { name: 'Claude', exact: true })
      .click();
    await expect(page.locator('thead')).toContainText('Claude Code installation');
    await expect(page.locator('thead')).toContainText('Claude Code usage');
    await expect(row.locator('.skills-install-pills .claude')).toHaveCount(1);
    await expect(row.locator('.skills-install-pills .pi')).toHaveCount(0);
    await expect(row.locator('.skills-install-pills .codex')).toHaveCount(0);
    await expect(row.locator('.skills-usage-rollup > span')).toHaveCount(1);
    await expect(row.locator('.skills-usage-rollup .claude b')).toHaveText('0');
    await expect(row.locator('.skills-usage-rollup .pi')).toHaveCount(0);
    await expect(row.locator('.skills-usage-rollup .codex')).toHaveCount(0);
    await expect(row.locator('.skills-metric')).toContainText('never');
    await expect(row.locator('.skills-metric')).toContainText('0 observed');
    await expect(row).toContainText('no observed use');
    await expect(page.locator('.skills-status-tabs')).toContainText('All 1');
    await expect(page.locator('.skills-status-tabs')).toContainText('Observed 0');
    await expect(page.locator('.skills-status-tabs')).toContainText('Review 1');

    await page.getByTestId('skills-manage-design-review').click();
    const drawer = page.getByRole('dialog', { name: 'Manage design-review' });
    await expect(drawer).toContainText('All agents · 3');
    await expect(drawer.getByRole('checkbox')).toHaveCount(3);
    const piCopy = drawer.getByRole('checkbox', { name: 'Select Charter Agent copy' });
    await expect(piCopy).not.toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: 'Select Claude Code copy' })).toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: 'Select Codex copy' })).not.toBeChecked();
    await expect(drawer).toContainText('1 selected');
    await drawer.getByRole('button', { name: 'All agents · 3' }).click();
    await expect(piCopy).toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: 'Select Codex copy' })).toBeChecked();
    await piCopy.uncheck();
    await expect(piCopy).not.toBeChecked();
    await expect(drawer).toContainText('2 selected');
    await drawer.getByRole('button', { name: 'Claude · 1' }).click();
    await expect(
      drawer.getByRole('checkbox', { name: 'Select Charter Agent copy' }),
    ).not.toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: 'Select Claude Code copy' })).toBeChecked();
    await expect(drawer.getByRole('checkbox', { name: 'Select Codex copy' })).not.toBeChecked();
    await page.getByTestId('skills-drawer-disable').click();
    await expect(drawer).toContainText('Disabled');
    await expect(row).toContainText('Claude · off');
    await expect(row).toHaveClass(/is-off/);
    await expect(page.getByTestId('skills-drawer-enable')).toBeEnabled();
    await expect(page.getByTestId('skills-drawer-disable')).toBeDisabled();
    await drawer.getByRole('button', { name: 'All agents · 3' }).click();
    await expect(page.getByTestId('skills-drawer-enable')).toBeEnabled();
    await expect(page.getByTestId('skills-drawer-disable')).toBeEnabled();
    await drawer.getByRole('button', { name: 'Claude · 1' }).click();
    await expect(page.getByTestId('skills-drawer-delete')).toBeEnabled();
    await page.getByTestId('skills-drawer-delete').click();
    await page.getByTestId('skills-delete-confirm-button').click();
    await expect(drawer).toHaveCount(0);
    await expect(row).toHaveCount(0);
    await page
      .locator('.skills-agent-tabs')
      .getByRole('button', { name: 'All agents', exact: true })
      .click();
    await expect(row).not.toContainText('Claude');
    await expect(row).toContainText('Charter');
    await expect(row).toContainText('Codex');

    const systemRow = page.locator('tbody tr', { hasText: 'system-pdf' });
    const reviewBadge = systemRow.getByText('needs review', { exact: true });
    await expect(reviewBadge).toBeVisible();
    await expect(reviewBadge).not.toHaveAttribute('title', /.+/);
    await reviewBadge.hover();
    const reviewTooltip = page.getByRole('tooltip');
    await expect(reviewTooltip).toBeVisible();
    await expect(reviewTooltip).toContainText('agent-specific tools or integrations');
    await page.mouse.move(0, 0);
    await expect(reviewTooltip).toHaveCount(0);
    await expect(systemRow.getByText('issue', { exact: true })).toHaveCount(0);
    await page.getByTestId('skills-manage-system-pdf').click();
    const systemDrawer = page.getByRole('dialog', { name: 'Manage system-pdf' });
    await expect(systemDrawer).toContainText('Built-in · locked');
    await expect(systemDrawer.locator('.skills-copy-review')).toContainText(
      'Instructions reference agent-specific tools or integrations',
    );
    await expect(systemDrawer.getByRole('checkbox', { name: 'Select Codex copy' })).toBeDisabled();
    await expect(page.getByTestId('skills-drawer-enable')).toBeDisabled();
    await expect(page.getByTestId('skills-drawer-disable')).toBeDisabled();
    await expect(page.getByTestId('skills-drawer-delete')).toBeDisabled();
    await systemDrawer.getByLabel('Close').click();
    await expect(systemRow).toContainText('built-in');
  } finally {
    await app.close();
    rmSync(skillHome, { recursive: true, force: true });
  }
});
