import { expect, test } from '@playwright/test';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { waitForTerminalOutput } from './helpers/terminal';

/** Idle fake agent CLIs so quick-spawned PTYs stay alive without real agents. */
function createIdleAgentBins(): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-qs-bin-'));
  for (const cli of ['claude', 'codex']) {
    writeFileSync(
      join(bin, cli),
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${cli} ready`)});`,
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 60000);',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, cli), 0o755);
  }
  // Keep the embedded login shell from restoring a machine-installed Claude
  // ahead of the deterministic fixtures through the user's zsh startup files.
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return bin;
}

test.describe('Session Rail Workbench', () => {
  test('keeps Sessions present across Agent choice and in-room editing', async () => {
    const fixture = realpathSync(createGitFixture());
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    try {
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      // One Composer exposes every Agent backend without separate entry points.
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-agent').click();
      await expect(page.getByTestId('home-agent-menu')).toBeVisible();
      await expect(page.getByTestId('home-agent-claude')).toBeVisible();
      await expect(page.getByTestId('home-agent-codex')).toBeVisible();
      await page.getByTestId('home-agent-pi').click();

      await expect(page.getByTestId('home-view')).toBeVisible();
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] session-first edit');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The real Monaco document model opens beside the continuous Pi run.
      await page.getByTestId('session-more').click();
      await page.getByTestId('task-room-edit-file').click();
      await expect(page.getByTestId('peek-mode-edit')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('file-peek').getByTestId('editor-groups')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toBeVisible();

      // Editing is a state of the Session-owned File tool, not another shell.
      await expect(page.getByTestId('file-peek').getByTestId('editor-groups')).toBeVisible();
      await expect(page.getByTestId('home-sidebar')).toContainText('session-first edit');
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('file-peek')).toBeVisible();

      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  // ADR-0023 direction D: activity bar + project-grouped panel with one global
  // Inbox badge and a resident working-context control in the new-session row.
  test('groups sessions by project and routes attention through the inbox', async () => {
    const fixture = realpathSync(createGitFixture());
    const name = fixture.split('/').pop()!;
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-view')).toBeVisible();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] direction d walk');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // The session sits under its project group. Attention is intentionally
      // not repeated per group; the stable Inbox icon is the one global queue.
      const group = page.getByTestId(`rail-group-${name}`);
      await expect(group).toBeVisible();
      await expect(group).toContainText('1');

      // The Inbox badge opens the triage panel; a panel row opens its room.
      await expect(page.getByTestId('rail-needs-you')).toContainText('1');
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('rail-inbox-panel')).toBeVisible();
      await page
        .locator('[data-testid="rail-inbox-panel"] [data-testid^="home-task-"]')
        .first()
        .click();
      await expect(page.getByTestId('task-room')).toBeVisible();

      // Clearing is reminder-only: it empties the Inbox and badge while the
      // Session remains under its project group.
      await page.getByTestId('task-room-back').click();
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('rail-inbox-clear')).toBeVisible();
      await page.getByTestId('rail-inbox-clear').click();
      await expect(page.getByTestId('rail-inbox-panel')).toContainText(
        'Nothing needs you right now.',
      );
      await expect(page.getByTestId('rail-needs-you').locator('.sr-mini-badge')).toHaveCount(0);

      // Collapse still only affects project rows; the cleared Inbox badge stays empty.
      await page.getByTestId('rail-view-sessions').click();
      await group.click();
      await expect(page.locator('[data-testid^="home-task-"]')).toHaveCount(0);
      await expect(page.getByTestId('rail-needs-you').locator('.sr-mini-badge')).toHaveCount(0);
      await group.click();
      await expect(page.locator('[data-testid^="home-task-"]').first()).toBeVisible();

      // The resident working-context row routes to the Projects panel.
      await expect(page.getByTestId('rail-context')).toContainText(name);
      await page.getByTestId('rail-context').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();
      await expect(page.locator('.sr-project-wrap.current')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // ADR-0046: the session the user enters defines the working context — the
  // rail's Files tree must show the files of the opened session's project,
  // not whichever project happened to be bound before.
  test('entering a session moves the working context to its project', async () => {
    const fixtureA = realpathSync(createGitFixture());
    const fixtureB = realpathSync(createGitFixture());
    const nameA = fixtureA.split('/').pop()!;
    const nameB = fixtureB.split('/').pop()!;
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixtureA, PI_IDE_FORCE_MOCK: '1' },
      home: 'keep',
    });
    try {
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      // Record a session in project A.
      await page.getByTestId('home-new-task').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] direction d walk');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Bind the working context to project B — Files now shows B.
      await page.evaluate(async (path) => {
        await window.product.rpc['workspace.open']!({ path });
      }, fixtureB);
      await page.getByTestId('rail-tab-sessions').click();
      await expect(page.getByTestId('rail-context')).toContainText(nameB);

      // Entering A's session pulls the context back to A while the room stays.
      await page.locator('[data-testid^="home-task-"]').first().click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('rail-context')).toContainText(nameA);
      await page.getByTestId('rail-tab-files').click();
      const filesPane = page.getByTestId('session-files-pane');
      await expect(filesPane).toContainText(nameA);
      await expect(filesPane).toContainText('README.md');
      await expect(page.getByTestId('task-room')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  // Projects choose working context; the one shared Composer then chooses the
  // Agent backend. These are not separate product entry points.
  test('binds a project, then starts a native Agent from the shared Composer', async () => {
    const fixture = realpathSync(createGitFixture());
    const bin = createIdleAgentBins();
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_FORCE_MOCK: '1',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      },
      home: 'keep',
    });
    const name = fixture.split('/').pop()!;
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`);
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('home-sidebar')).toBeVisible();
      // The boot-time workspace open swaps the shell tree and remounts the
      // rail — wait until the working context is bound before driving panel
      // state, or the Projects view resets underneath the test.
      await expect(page.getByTestId('rail-context')).toContainText(name);
      await page.getByTestId('rail-context').click();
      await expect(page.getByTestId('rail-projects-panel')).toBeVisible();

      // One explicit Use action binds the project to the shared Composer.
      const row = page.getByTestId(`home-recent-${fixture}`);
      await expect(row).toBeVisible();
      await page.getByTestId(`project-menu-${fixture}`).click();
      await page.getByTestId(`project-spawn-pi-${fixture}`).click();
      await expect(page.getByTestId('home-intent')).toBeFocused();

      // Claude is an execution backend in that Composer. The resulting PTY
      // remains a Session in the same rail and is cwd-bound to the project.
      await page.getByTestId('home-agent').click();
      await page.getByTestId('home-agent-claude').click();
      await page.getByTestId('home-intent').fill('Inspect the project architecture');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible();
      await expect(page.getByTestId('session-terminal-view')).toContainText(fixture);

      // The rail row identifies the provider by mark and keeps the user's
      // task title instead of falling back to a provider or session label.
      const railRow = page
        .locator('[data-session-key]')
        .filter({ has: page.locator('.sr-provider.claude') })
        .first();
      await expect(railRow).toBeVisible();
      await expect(railRow).toContainText('Inspect the project architecture');
      await expect(railRow).not.toContainText('Claude Code');

      // The external Agent PTY is the conversation in the center column. The
      // Terminal tool must create a separate command shell instead of moving
      // that same xterm to the right and leaving an empty black host behind.
      await railRow.click();
      const externalTerminalId = await page
        .getByTestId('external-terminal-column')
        .getAttribute('data-terminal-id');
      expect(externalTerminalId).not.toBeNull();
      await waitForTerminalOutput(page, 'claude ready', { terminalId: externalTerminalId! });
      const externalXterm = page.getByTestId('external-terminal-host').locator('.xterm');
      await expect(externalXterm).toHaveAttribute('data-terminal-font-size', '15');
      await expect(externalXterm).toHaveAttribute('data-terminal-line-height', '1.2');
      await expect(page.getByTestId('external-terminal-host')).toHaveAttribute(
        'data-terminal-padding',
        '12x10',
      );

      await expect(page.getByTestId('session-tools-open')).toBeVisible();
      await page.getByTestId('session-tools-open').click();
      await page.getByTestId('session-tool-terminal').click();
      await expect(page.getByTestId('session-terminal-create')).toBeVisible();
      await waitForTerminalOutput(page, 'claude ready', { terminalId: externalTerminalId! });

      await page.getByTestId('session-terminal-create').click();
      const shell = page.getByTestId('session-terminal-tool');
      await expect(shell).toBeVisible();
      await expect(shell).toHaveAttribute('data-terminal-id', /.+/);
      const shellTerminalId = await shell.getAttribute('data-terminal-id');
      expect(shellTerminalId).not.toBe(externalTerminalId);
      await expect(page.getByTestId('external-terminal-host').locator('.xterm')).toHaveCount(1);
      const shellXterm = shell.locator('.session-terminal-host .xterm');
      await expect(shellXterm).toHaveCount(1);
      await expect(shellXterm).toHaveAttribute('data-terminal-font-size', '15');
      await expect(shellXterm).toHaveAttribute('data-terminal-line-height', '1.2');
      await expect(shell.locator('.session-terminal-host')).toHaveAttribute(
        'data-terminal-padding',
        '12x10',
      );
      await waitForTerminalOutput(page, 'claude ready', { terminalId: externalTerminalId! });

      await shell.locator('.session-terminal-host .xterm').click();
      await page.keyboard.type("printf '\\163\\150\\145\\154\\154\\055\\157\\153\\n'");
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'shell-ok', { terminalId: shellTerminalId! });
      await waitForTerminalOutput(page, 'claude ready', { terminalId: externalTerminalId! });

      if (process.env.CHARTER_CAPTURE_EXTERNAL_TERMINAL_ISOLATION === '1') {
        await page.screenshot({ path: '/tmp/charter-external-terminal-isolation-1440.png' });
        await page.setViewportSize({ width: 900, height: 900 });
        await waitForTerminalOutput(page, 'claude ready', { terminalId: externalTerminalId! });
        await waitForTerminalOutput(page, 'shell-ok', { terminalId: shellTerminalId! });
        await page.waitForTimeout(250);
        await page.screenshot({ path: '/tmp/charter-external-terminal-isolation-900.png' });
      }

      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
