import { expect, test } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root }).toString();
}

test.describe('M5 git workflow', () => {
  test('E2E-008: modify → diff → stage → commit matches git CLI', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      // Modify a file externally (same as editing+saving).
      writeFileSync(join(fixture, 'src/util.ts'), 'export const changed = true;\n');

      // ADR-0054: the shell boots on Home — the way into the project editor
      // is the rail's canonical Files tree.
      await page.getByTestId('rail-tab-files').click();
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/util.ts').click();
      await expect(page.getByTestId('project-tool-view')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('project-tool-changes').click();
      await expect(page.getByTestId('scm-view')).toBeVisible();
      await expect(page.getByTestId('scm-entry-src/util.ts')).toBeVisible({ timeout: 15000 });

      // ADR-0057: the working-tree diff opens as a TAB in the adjacent editor,
      // never as a modal.
      await page.getByTestId('scm-entry-src/util.ts').getByRole('button').first().click();
      await expect(page.getByTestId('tab-git-diff://work/src/util.ts')).toBeVisible();
      await expect(page.getByTestId('git-diff-pane')).toBeVisible();
      await expect(page.getByTestId('git-diff-pane')).toContainText('util.ts');
      await expect(page.getByTestId('diff-monaco')).toBeVisible({ timeout: 10000 });
      // Close the diff tab; the editor group returns to its previous state.
      await page
        .getByTestId('tab-git-diff://work/src/util.ts')
        .getByRole('button', { name: /Close util.ts/ })
        .click();
      await expect(page.getByTestId('git-diff-pane')).toHaveCount(0);

      // Untracked files have nothing to diff — they open as a plain file tab.
      // The file lives in an untracked DIRECTORY on purpose: status must
      // enumerate it (-uall) instead of a dead "examples-e2e/" row (ADR-0057).
      mkdirSync(join(fixture, 'examples-e2e'), { recursive: true });
      writeFileSync(join(fixture, 'examples-e2e/brand-new.txt'), 'hello\n');
      await expect(page.getByTestId('scm-entry-examples-e2e/brand-new.txt')).toBeVisible({
        timeout: 15000,
      });
      // The row text truncates, so its tooltip is the full path.
      await expect(
        page.getByTestId('scm-entry-examples-e2e/brand-new.txt').getByRole('button').first(),
      ).toHaveAttribute('title', 'examples-e2e/brand-new.txt');
      await page
        .getByTestId('scm-entry-examples-e2e/brand-new.txt')
        .getByRole('button')
        .first()
        .click();
      await expect(page.getByTestId('tab-examples-e2e/brand-new.txt')).toBeVisible();
      await expect(page.getByTestId('git-diff-pane')).toHaveCount(0);
      await page
        .getByTestId('tab-examples-e2e/brand-new.txt')
        .getByRole('button', { name: /Close brand-new.txt/ })
        .click();
      rmSync(join(fixture, 'examples-e2e'), { recursive: true });

      // Stage and verify against the CLI.
      // The status refresh can replace the list between pointer-down and click;
      // repeat this idempotent action until Git itself confirms the transition.
      await expect
        .poll(async () => {
          const stageBtn = page.getByTestId('stage-src/util.ts');
          if (await stageBtn.isVisible().catch(() => false)) {
            await stageBtn.click().catch(() => undefined);
          }
          return git(fixture, ['status', '--porcelain']);
        })
        .toContain('M  src/util.ts');
      await expect(page.getByTestId('scm-group-staged')).toBeVisible();

      // Staged entries open the read-only HEAD ↔ index diff tab.
      await page.getByTestId('scm-entry-src/util.ts').getByRole('button').first().click();
      await expect(page.getByTestId('tab-git-diff://staged/src/util.ts')).toBeVisible();
      await expect(page.getByTestId('git-diff-pane')).toContainText('Staged');
      await page
        .getByTestId('tab-git-diff://staged/src/util.ts')
        .getByRole('button', { name: /Close util.ts/ })
        .click();

      // Unstage round-trip. The SCM list re-renders on every git refresh, which
      // can swallow a click that lands on the re-render boundary — retry the
      // idempotent click until the CLI confirms the unstage took effect.
      await expect
        .poll(async () => {
          const unstageBtn = page.getByTestId('unstage-src/util.ts');
          if (await unstageBtn.isVisible().catch(() => false)) {
            await unstageBtn.click().catch(() => undefined);
          }
          return git(fixture, ['status', '--porcelain']);
        })
        .toContain(' M src/util.ts');
      await expect
        .poll(async () => {
          const stageBtn = page.getByTestId('stage-src/util.ts');
          if (await stageBtn.isVisible().catch(() => false)) {
            await stageBtn.click().catch(() => undefined);
          }
          return git(fixture, ['status', '--porcelain']);
        })
        .toContain('M  src/util.ts');

      // The staged file carries its tree decoration before the commit…
      await expect(page.getByTestId('tree-git-src/util.ts')).toBeVisible({ timeout: 15000 });

      // Commit.
      await page.getByTestId('commit-message').fill('feat: e2e commit');
      await page.getByTestId('commit-btn').click();
      await expect(page.getByTestId('scm-clean')).toBeVisible({ timeout: 15000 });
      expect(git(fixture, ['log', '--format=%s', '-1']).trim()).toBe('feat: e2e commit');
      expect(git(fixture, ['status', '--porcelain']).trim()).toBe('');

      // …and the decoration clears WITH the commit: index-only transitions
      // reach the tree through git.changed, not the fs watcher (ADR-0057
      // acceptance finding — committed files stayed green).
      await expect(page.getByTestId('tree-git-src/util.ts')).not.toBeAttached({
        timeout: 15000,
      });

      // Branch: create and switch back.
      await page.getByTestId('status-branch').click();
      await expect(page.getByTestId('branch-picker')).toBeVisible();
      await page.keyboard.type('e2e-branch');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('status-branch')).toContainText('e2e-branch', {
        timeout: 15000,
      });
      await page.getByTestId('status-branch').click();
      await page.getByTestId('branch-main').click();
      await expect(page.getByTestId('status-branch')).toContainText('main');
    } finally {
      await app.close();
    }
  });

  test('non-git workspace offers init without forcing it (WS-013)', async () => {
    const { createTsSmallFixture } = await import('./helpers/fixtures');
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      // ADR-0054 boot-on-Home: reach the editor through the rail tree, then
      // open the Changes tool (ADR-0029: the tree lives in the rail).
      await page.getByTestId('rail-tab-files').click();
      await page.getByTestId('tree-item-README.md').click();
      await expect(page.getByTestId('tab-README.md')).toBeVisible();
      await expect(page.getByTestId('project-tool-view')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('project-tool-changes').click();
      await expect(page.getByTestId('scm-no-repo')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
