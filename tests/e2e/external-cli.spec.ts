import { expect, test } from '@playwright/test';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

/**
 * ADR-0017 — external CLI agent sessions. A fake agent CLI (a node script, so
 * detection exercises the interpreter/descendant-scan path like an
 * npm-installed claude) runs inside a REAL embedded PTY, edits a workspace
 * file and exits. The product must detect the session, badge the terminal,
 * account the change, offer the session room and land in REVIEW_READY.
 */

function createFakeAgentBin(fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-fakebin-'));
  const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
  writeFileSync(
    join(bin, 'fakeagent'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      `const target = ${JSON.stringify(target)};`,
      "console.log('✳ fake agent session started');",
      'setTimeout(() => {',
      "  const src = fs.readFileSync(target, 'utf8');",
      "  fs.writeFileSync(target, src + 'export const externalTouch = 1;\\n');",
      "  console.log('✏ edited src/util.ts');",
      '}, 1500);',
      // Long enough to promote the pane and type into the live PTY mid-session.
      'setTimeout(() => process.exit(0), 12000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'fakeagent'), 0o755);
  return bin;
}

test.describe('ADR-0017 external CLI agent sessions', () => {
  test('detect → badge → account → session room → REVIEW_READY', async () => {
    const fixture = createGitFixture();
    const bin = createFakeAgentBin(fixture);
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'fakeagent',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    try {
      // Open a terminal on the IDE surface and start the fake agent.
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      // zsh init can drop very-early keystrokes — prove the prompt is live first.
      await page.keyboard.type('echo ready-marker');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-panel')).toContainText('ready-marker', {
        timeout: 15000,
      });
      await page.keyboard.type('fakeagent');
      await page.keyboard.press('Enter');

      // Detection = decoration in place (ADR-0017 rev.2): badge + session bar
      // appear, but NOTHING moves — no side panel, the dock stays put.
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('fakeagent', {
        timeout: 15000,
      });
      const bar = page.getByTestId('terminal-session-bar');
      await expect(bar).toBeVisible();
      await expect(bar).toContainText('fakeagent');
      await expect(bar).toContainText('EXT');
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.locator('[data-testid^="terminal-open-room-"]')).toBeVisible({
        timeout: 15000,
      });

      // The CLI's edit lands in the bar's live counter.
      await expect(page.getByTestId('session-bar-files')).toContainText('1 file', {
        timeout: 15000,
      });

      // 「意图升格」: moving to the side panel is the user's click. Same
      // xterm/PTY — the scrollback must actually render in the panel, and the
      // dock (whose only terminal this was) collapses as a consequence of the
      // user's own action.
      await page.getByTestId('session-bar-promote').click();
      const panel = page.getByTestId('external-panel');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText('fakeagent');
      await expect(page.getByTestId('external-panel-terminal')).toContainText(
        'fake agent session started',
        { timeout: 10000 },
      );
      await expect(page.getByTestId('bottom-panel')).toHaveCount(0);

      // The promoted terminal is ALIVE: keystrokes reach the PTY and echo back
      // (the exact failure of the original 决策 4 implementation).
      await page.getByTestId('external-panel-terminal').click();
      await page.keyboard.type('promoted-echo-ok');
      await expect(page.getByTestId('external-panel-terminal')).toContainText('promoted-echo-ok', {
        timeout: 10000,
      });

      // The panel carries the live "session changes" strip with a diffstat.
      const stripRow = page.getByTestId('external-strip-file-src/util.ts');
      await expect(stripRow).toBeVisible({ timeout: 15000 });
      await expect(stripRow).toContainText('+1');

      // Session end: the pane STAYS where the user put it (no auto-return);
      // the panel header flips to the ended state with a Review entry.
      await expect(page.getByTestId('external-panel-ended')).toBeVisible({ timeout: 25000 });
      await expect(page.getByTestId('external-panel')).toBeVisible();
      await expect(page.getByTestId('external-panel-review')).toBeVisible();

      // 「归位」is the user's click too: the dock comes back, the SAME terminal
      // returns with its scrollback (banner + the echo we typed), and the bar
      // keeps its ended state with the Review entry.
      await page.getByTestId('external-return-dock').click();
      await expect(page.getByTestId('external-panel')).toHaveCount(0);
      await expect(page.getByTestId('bottom-panel')).toBeVisible();
      await expect(page.getByTestId('terminal-host')).toContainText('fake agent session started', {
        timeout: 10000,
      });
      await expect(page.getByTestId('terminal-host')).toContainText('promoted-echo-ok');
      await expect(page.getByTestId('session-bar-ended')).toContainText('1 file');

      // Review from the bar opens the session room: terminal column (content
      // follows the instance), rail row, review entry; rail row click peeks.
      await page.getByTestId('session-bar-review').click();
      await expect(page.getByTestId('task-room')).toBeVisible();
      await expect(page.getByTestId('task-room-external-chip')).toContainText('fakeagent');
      await expect(page.getByTestId('external-terminal-column')).toBeVisible();
      await expect(page.getByTestId('external-terminal-host')).toContainText(
        'fake agent session started',
        { timeout: 10000 },
      );
      await expect(page.getByTestId('external-ended')).toBeVisible();
      await expect(page.getByTestId('task-room-file-src/util.ts')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('review-open').first()).toBeVisible({ timeout: 15000 });
      await page.getByTestId('task-room-file-src/util.ts').click();
      await expect(page.getByTestId('file-peek')).toBeVisible();
      await expect(page.getByTestId('peek-tab-src/util.ts')).toBeVisible();
      await page.getByTestId('peek-close').click();

      // The accounted baseline is the PRE-session content: the diff must show
      // exactly the line the fake agent appended.
      const cs = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{
                  ok: boolean;
                  data?: {
                    changeSet: {
                      files: Array<{ path: string; status: string; additions: number }>;
                    };
                  };
                }>
              >;
            };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const list = (tasks as { data?: { tasks: Array<{ id: string; external: unknown }> } }).data
          ?.tasks;
        const external = list?.find((t) => t.external);
        if (!external) return null;
        const res = await bridge.rpc['task.changeSet']!({ taskId: external.id });
        return res.data?.changeSet ?? null;
      });
      expect(cs).not.toBeNull();
      const utilFile = cs!.files.find((f) => f.path === 'src/util.ts');
      expect(utilFile?.status).toBe('modified');
      expect(utilFile?.additions).toBe(1);

      // Disk really has the CLI's edit (the session was real, not simulated).
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('externalTouch');
    } finally {
      await app.close();
    }
  });

  test('detects the native-installer shape: version-named binary behind a CLI symlink', async () => {
    // Installer shapes hide the CLI name from the foreground title: the native
    // installer links `claude → …/versions/2.1.209`, the npm install links
    // `claude → …/bin/claude.exe` (Bun-compiled) — either way the kernel short
    // name is not `claude`, and only the argv process-tree fallback sees the
    // session. The fixture binary is a copy of the running node executable:
    // copying /bin/zsh looks simpler but macOS AMFI SIGKILLs copies of Apple
    // platform binaries, so that shape can never run.
    test.skip(process.platform !== 'darwin', 'kernel comm shape under test is darwin-specific');
    const fixture = createGitFixture();
    const bin = mkdtempSync(join(tmpdir(), 'pi-ide-fakebin-'));
    mkdirSync(join(bin, 'versions'));
    copyFileSync(process.execPath, join(bin, 'versions', '9.9.9'));
    chmodSync(join(bin, 'versions', '9.9.9'), 0o755);
    symlinkSync(join(bin, 'versions', '9.9.9'), join(bin, 'fakeclaude'));
    const target = join(fixture, 'src/util.ts').replace(/\\/g, '/');
    writeFileSync(
      join(bin, 'agent.js'),
      [
        "const fs = require('fs');",
        "console.log('✳ fake versioned agent started');",
        'setTimeout(() => {',
        `  fs.appendFileSync(${JSON.stringify(target)}, 'export const externalTouch = 1;\\n');`,
        "  console.log('✏ edited src/util.ts');",
        '}, 2000);',
        'setTimeout(() => process.exit(0), 3500);',
        '',
      ].join('\n'),
    );

    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: 'fakeclaude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
      await page.locator('.xterm').click();
      await page.keyboard.type('echo ready-marker');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-panel')).toContainText('ready-marker', {
        timeout: 15000,
      });
      await page.keyboard.type(`fakeclaude ${join(bin, 'agent.js')}`);
      await page.keyboard.press('Enter');

      // Detection despite the foreground title reading "9.9.9".
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toContainText('fakeclaude', {
        timeout: 15000,
      });

      // Script exit ends the session (badge clears after the grace streak).
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(0, {
        timeout: 20000,
      });

      // The edit was accounted against an external task.
      const cs = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: { rpc: Record<string, (p: unknown) => Promise<{ ok: boolean; data?: any }>> };
          }
        ).product;
        const tasks = await bridge.rpc['task.list']!({ filter: 'all', includeArchived: false });
        const external = tasks.data?.tasks?.find((t: { external: unknown }) => t.external);
        if (!external) return null;
        const res = await bridge.rpc['task.changeSet']!({ taskId: external.id });
        return res.data?.changeSet ?? null;
      });
      expect(cs).not.toBeNull();
      const utilFile = (cs as { files: Array<{ path: string; status: string }> }).files.find(
        (f) => f.path === 'src/util.ts',
      );
      expect(utilFile?.status).toBe('modified');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('externalTouch');
    } finally {
      await app.close();
    }
  });
});
