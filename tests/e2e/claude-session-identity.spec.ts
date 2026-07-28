import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { waitForTerminalOutput } from './helpers/terminal';

interface TerminalInfo {
  id: string;
}

interface ExternalTaskInfo {
  id: string;
  state: string;
  external: { cli: string; terminalId: string } | null;
}

function createDualClaudeBin(alphaFixture: string, betaFixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-dual-claude-'));
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      "const label = process.argv[2] === 'alpha' ? 'alpha' : 'beta';",
      `const fixture = label === 'alpha' ? ${JSON.stringify(alphaFixture)} : ${JSON.stringify(betaFixture)};`,
      'console.log(`claude-${label}-session-started`);',
      'setTimeout(() => {',
      "  const count = label === 'alpha' ? 1 : 3;",
      "  const lines = Array.from({ length: count }, (_, index) => `export const ${label}Reply${index + 1} = ${index + 1};`).join('\\n');",
      "  fs.writeFileSync(path.join(fixture, 'src', `${label}.ts`), `${lines}\\n`);",
      '  console.log(`claude-${label}-file-written`);',
      '}, 1800);',
      'setTimeout(() => {',
      '  console.log(JSON.stringify({',
      "    type: 'result',",
      "    subtype: 'success',",
      '    is_error: false,',
      '    session_id: `session-${label}`,',
      '    result: `${label}-reply-complete`,',
      '  }));',
      '}, 4500);',
      'setTimeout(() => process.exit(0), 8200);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  return bin;
}

function createObservedAgentBin(provider: 'claude' | 'codex'): string {
  const bin = mkdtempSync(join(tmpdir(), `charter-observed-${provider}-`));
  writeFileSync(
    join(bin, provider),
    [
      '#!/usr/bin/env node',
      "process.stdin.setEncoding('utf8');",
      `console.log(${JSON.stringify(`observed-${provider}-ready`)});`,
      'let replying = false;',
      "process.stdin.on('data', (input) => {",
      '  if (replying || !/[\\r\\n]/.test(input)) return;',
      '  replying = true;',
      "  console.log('observed-reply-start');",
      '  let part = 0;',
      '  const progress = setInterval(() => {',
      '    part += 1;',
      '    console.log(`observed-reply-part-${part}`);',
      '    if (part < 4) return;',
      '    clearInterval(progress);',
      "    console.log('observed-reply-complete');",
      '    replying = false;',
      '    let repaint = 0;',
      '    setTimeout(() => {',
      '      const idleRepaints = setInterval(() => {',
      "        console.log('observed-idle-repaint');",
      '        repaint += 1;',
      '        if (repaint >= 8) clearInterval(idleRepaints);',
      '      }, 200);',
      '    }, 1400);',
      '  }, 260);',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, provider), 0o755);
  return bin;
}

function createExitToShellAgentBin(provider: 'claude' | 'codex', fixture: string): string {
  const bin = mkdtempSync(join(tmpdir(), `charter-exit-to-shell-${provider}-`));
  writeFileSync(
    join(bin, provider),
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "const path = require('path');",
      `const fixture = ${JSON.stringify(fixture)};`,
      `console.log(${JSON.stringify(`${provider}-agent-started`)});`,
      'setTimeout(() => {',
      `  fs.writeFileSync(path.join(fixture, ${JSON.stringify(`${provider}-ended.txt`)}), 'changed by agent\\n');`,
      `  console.log(${JSON.stringify(`${provider}-agent-changed-file`)});`,
      '}, 800);',
      'setTimeout(() => {',
      `  console.log(${JSON.stringify(`${provider}-agent-exited`)});`,
      '  process.exit(0);',
      '}, 3200);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  chmodSync(join(bin, provider), 0o755);
  return bin;
}

async function terminalItems(page: Page): Promise<TerminalInfo[]> {
  return page.evaluate(async () => {
    const result = (await window.product.rpc['terminal.list']!({})) as {
      ok: boolean;
      data?: { items: TerminalInfo[] };
    };
    return result.ok ? (result.data?.items ?? []) : [];
  });
}

async function externalTasks(
  page: Page,
  provider: 'claude' | 'codex' = 'claude',
): Promise<ExternalTaskInfo[]> {
  return page.evaluate(async (nextProvider) => {
    const result = (await window.product.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
      scope: 'all',
    })) as { ok: boolean; data?: { tasks: ExternalTaskInfo[] } };
    return result.ok
      ? (result.data?.tasks ?? []).filter((task) => task.external?.cli === nextProvider)
      : [];
  }, provider);
}

test.describe('External Session identity and presence', () => {
  for (const provider of ['claude', 'codex'] as const) {
    test(`${provider} keeps its identity after Agent exit and app restart while zsh remains usable`, async () => {
      test.setTimeout(120_000);
      const fixture = createGitFixture();
      const bin = createExitToShellAgentBin(provider, fixture);
      const env = {
        PI_IDE_OPEN_WORKSPACE: fixture,
        PI_IDE_EXTERNAL_CLIS: provider,
        PI_IDE_TERMINAL_PERSIST: '1',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ZDOTDIR: bin,
      };
      const first = await launchApp({ env });
      let restarted: Awaited<ReturnType<typeof launchApp>> | null = null;
      try {
        const terminalId = await first.page.evaluate(async (launch) => {
          const result = (await window.product.rpc['terminal.create']!({
            context: { kind: 'focused' },
            launch,
          })) as { ok: boolean; data?: { id: string } };
          return result.ok ? (result.data?.id ?? null) : null;
        }, provider);
        expect(terminalId).toBeTruthy();
        await waitForTerminalOutput(first.page, `${provider}-agent-started`, {
          terminalId: terminalId!,
          timeout: 20_000,
        });
        await expect.poll(async () => (await externalTasks(first.page, provider)).length).toBe(1);
        const task = (await externalTasks(first.page, provider))[0]!;
        await waitForTerminalOutput(first.page, `${provider}-agent-exited`, {
          terminalId: terminalId!,
          timeout: 20_000,
        });
        await expect
          .poll(async () => (await externalTasks(first.page, provider))[0]?.state, {
            timeout: 20_000,
          })
          .toBe('REVIEW_READY');

        const closed = first.app.waitForEvent('close');
        await first.app.evaluate(({ app }) => {
          setTimeout(() => app.quit(), 0);
        });
        await closed;
        restarted = await launchApp({ userDataDir: first.userDataDir, env });
        const { page } = restarted;
        const rendererErrors: string[] = [];
        page.on('pageerror', (error) => rendererErrors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error') rendererErrors.push(message.text());
        });
        await restarted.app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
        });
        await expect
          .poll(async () => (await terminalItems(page)).some((item) => item.id === terminalId))
          .toBe(true);

        const row = page.getByTestId(`home-task-${task.id}`);
        const providerLabel = provider === 'claude' ? 'Claude Code' : 'Codex';
        if (!(await row.isVisible().catch(() => false))) {
          const history = page.getByTestId('rail-group-history');
          if ((await history.getAttribute('aria-expanded')) !== 'true') await history.click();
        }
        await expect(row).toBeVisible({ timeout: 20_000 });
        await expect(row).toHaveAttribute(
          'aria-label',
          new RegExp(`${providerLabel} ended · Shell available`),
        );
        await expect(row).not.toContainText('zsh');
        await row.hover();
        await expect(page.getByRole('tooltip')).toContainText(
          `${providerLabel} ended · Shell available`,
        );
        await expect(page.getByTestId(`session-terminal-${terminalId}`)).toHaveCount(0);

        await row.click();
        await expect(page.getByTestId('external-ended')).toHaveText('Agent ended');
        await expect(page.getByTestId('external-terminal-lifecycle')).toHaveText('Shell available');
        const terminal = page.getByTestId('external-terminal-host');
        await expect(terminal.locator('.xterm')).toBeVisible({ timeout: 15_000 });
        await terminal.locator('.xterm').click();
        await page.keyboard.type(`echo shell-after-${provider}`);
        await page.keyboard.press('Enter');
        await waitForTerminalOutput(page, `shell-after-${provider}`, {
          terminalId: terminalId!,
          timeout: 15_000,
        });
        await page.screenshot({ path: `/tmp/charter-${provider}-ended-shell-1440.png` });

        await restarted.app.evaluate(({ BrowserWindow }) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 980, height: 760 });
        });
        await expect(page.getByTestId('external-terminal-lifecycle')).toHaveText('Shell available');
        await expect(terminal.locator('.xterm')).toBeVisible();
        await page.screenshot({ path: `/tmp/charter-${provider}-ended-shell-980.png` });
        expect(rendererErrors).toEqual([]);
      } finally {
        if (restarted) await restarted.app.close();
        else await first.app.close().catch(() => undefined);
      }
    });
  }

  for (const provider of ['claude', 'codex'] as const) {
    test(`observed ${provider} TUI shows a reply notice and whole-card shake`, async () => {
      const fixture = createGitFixture();
      const bin = createObservedAgentBin(provider);
      const { app, page } = await launchApp({
        env: {
          PI_IDE_OPEN_WORKSPACE: fixture,
          PI_IDE_EXTERNAL_CLIS: provider,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      try {
        // The user's Retina capture is 2736×1474 physical pixels, i.e. a
        // 1368×737 logical viewport. Match that frame for design comparison.
        await page.setViewportSize({ width: 1368, height: 737 });
        await page.keyboard.press('Control+`');
        await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
        await page.getByTestId('terminal-host').locator('.xterm').click();
        await page.keyboard.type(join(bin, provider));
        await page.keyboard.press('Enter');
        const terminalId = await page.getByTestId('terminal-host').getAttribute('data-terminal-id');
        expect(terminalId).toBeTruthy();
        await waitForTerminalOutput(page, `observed-${provider}-ready`, {
          terminalId: terminalId!,
        });
        await expect.poll(async () => (await externalTasks(page, provider)).length).toBe(1);

        const task = (await externalTasks(page, provider))[0]!;
        const row = page.getByTestId(`home-task-${task.id}`);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute('data-working', 'false');
        await expect(row).not.toHaveAttribute('data-reply', 'true');
        await row.click();
        await expect(row).toHaveClass(/selected/);
        await expect(page.getByTestId('external-terminal-host')).toBeVisible();
        await page.locator('.toast button[aria-label="Dismiss"]').evaluateAll((buttons) => {
          for (const button of buttons) (button as HTMLButtonElement).click();
        });

        // Exercise the exact in-Session path from the report — ADR-0030: the
        // CLI's own input line is the room's only composer, so the turn is
        // typed straight into the session terminal. The host sees the
        // submitted Enter, observes non-structured PTY output, then emits only
        // a presence edge after the quiet window.
        await page.getByTestId('external-terminal-host').locator('.xterm').click();
        await page.keyboard.type('finish this observed turn');
        await page.keyboard.press('Enter');
        await expect(row).toHaveAttribute('data-working', 'true');
        // Leave before the observed quiet-window edge: background Sessions
        // announce completion, while an open Session owns its local status.
        await page.getByTestId('task-room-back').click();
        await waitForTerminalOutput(page, 'observed-reply-complete', {
          terminalId: task.external!.terminalId,
          timeout: 10_000,
        });

        const notice = page.locator(
          `[data-testid="session-completion-notice"][data-kind="reply"][data-task-id="${task.id}"]`,
        );
        await expect(notice).toBeVisible({ timeout: 8_000 });
        await expect(notice).toContainText(
          `${provider === 'claude' ? 'Claude' : 'Codex'} reply complete`,
        );
        await expect(notice).toContainText('Terminal output settled');

        await expect(row).toHaveAttribute('data-reply', 'true', { timeout: 8_000 });
        await expect(row).toHaveAttribute('data-working', 'false');
        await expect(row).toHaveClass(/reply-shake/);
        await expect(row).toHaveCSS('animation-name', 'srSessionReplyShake');
        await expect(row).toHaveCSS('animation-duration', '2.2s');
        const cardWave = await row.evaluate(
          (element) => getComputedStyle(element, '::after').animationName,
        );
        expect(cardWave).toBe('srSessionCardWave');

        // Claude/Codex may repaint an idle status line long after the reply
        // settled. With no submitted input, those bytes must not restart the
        // Session spinner or the fleet worker state.
        await waitForTerminalOutput(page, 'observed-idle-repaint', {
          terminalId: task.external!.terminalId,
          timeout: 8_000,
        });
        await page.waitForTimeout(450);
        await expect(row).toHaveAttribute('data-working', 'false');

        // Match the reported Archive surface and retain a desktop artifact of
        // both pieces of completion presence in one real Electron frame.
        await page.evaluate(() => {
          document.documentElement.dataset.skin = 'archive';
          document.documentElement.dataset.theme = 'light';
        });
        await page.screenshot({
          path: `/tmp/charter-observed-${provider}-reply-notice.png`,
        });
        await row.screenshot({ path: `/tmp/charter-observed-${provider}-reply-card.png` });

        await page.setViewportSize({ width: 820, height: 720 });
        const noticeBox = await notice.boundingBox();
        expect(noticeBox).not.toBeNull();
        expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
        expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(820);
        await page.screenshot({
          path: `/tmp/charter-observed-${provider}-reply-notice-narrow.png`,
        });

        // The banner carries the exact accounting task identity and reopens
        // that Session through the same route as the Pi completion card.
        await notice.getByRole('button', { name: /Open Session/i }).click();
        await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', task.id);
        await expect(row).toHaveClass(/selected/);
        expect(errors, errors.join('\n')).toEqual([]);
        await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      } finally {
        await app.close();
      }
    });
  }

  test('two Claude Sessions keep distinct right panes and pulse the replying row', async () => {
    const alphaFixture = createGitFixture();
    const betaFixture = createGitFixture();
    const bin = createDualClaudeBin(alphaFixture, betaFixture);
    const { app, page } = await launchApp({
      env: {
        PI_IDE_OPEN_WORKSPACE: alphaFixture,
        PI_IDE_EXTERNAL_CLIS: 'claude',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });

      const firstTerminal = (await terminalItems(page))[0]!;
      await page.getByTestId('terminal-host').locator('.xterm').click();
      await page.keyboard.type('echo alpha-shell-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'alpha-shell-ready', { terminalId: firstTerminal.id });
      await page.keyboard.type(`${join(bin, 'claude')} alpha`);
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(1, {
        timeout: 15_000,
      });

      // Give the second Claude an independent working tree. This makes any
      // right-pane crossover an identity bug rather than honest observed-grade
      // overlap from two processes touching one workspace concurrently.
      await page.evaluate(async (path) => {
        await window.product.rpc['workspace.open']!({ path });
      }, betaFixture);
      await page.getByTestId('terminal-new').click();
      await expect.poll(async () => (await terminalItems(page)).length).toBe(2);
      const secondTerminal = (await terminalItems(page)).find(
        (terminal) => terminal.id !== firstTerminal.id,
      )!;
      await page.getByTestId('terminal-host').locator('.xterm').click();
      await page.keyboard.type('echo beta-shell-ready');
      await page.keyboard.press('Enter');
      await waitForTerminalOutput(page, 'beta-shell-ready', { terminalId: secondTerminal.id });
      await page.keyboard.type(`${join(bin, 'claude')} beta`);
      await page.keyboard.press('Enter');
      await expect(page.locator('[data-testid^="terminal-agent-"]')).toHaveCount(2, {
        timeout: 15_000,
      });

      await expect.poll(async () => (await externalTasks(page)).length).toBe(2);
      const tasks = await externalTasks(page);
      const alphaTask = tasks.find((task) => task.external?.terminalId === firstTerminal.id)!;
      const betaTask = tasks.find((task) => task.external?.terminalId === secondTerminal.id)!;
      expect(alphaTask.id).not.toBe(betaTask.id);

      const alphaRow = page.getByTestId(`home-task-${alphaTask.id}`);
      const betaRow = page.getByTestId(`home-task-${betaTask.id}`);
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toBeVisible();

      // Claude's structured result is a genuine turn boundary. It must animate
      // the matching background Session as a whole-card, diagonal damped shake
      // and surface one global reply notice.
      await expect(betaRow).toHaveAttribute('data-reply', 'true', { timeout: 12_000 });
      await expect(betaRow).toHaveClass(/reply-shake/);
      await expect(betaRow).toHaveCSS('animation-name', 'srSessionReplyShake');
      await expect(betaRow.locator('.sr-provider')).toHaveClass(/session-wave/);

      // Freeze the genuine running animation on its first diagonal peak so
      // the visual artifact proves the card rotates and moves vertically — a
      // horizontal-only nudge would produce neither component. Capture it
      // before the notification and navigation checks can outlive the effect.
      const replyMotion = await betaRow.evaluate((element) => {
        const animation = element
          .getAnimations()
          .find(
            (candidate) =>
              candidate instanceof CSSAnimation &&
              candidate.animationName === 'srSessionReplyShake',
          );
        if (!animation) return null;
        animation.pause();
        animation.currentTime = 286;
        const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        return {
          rotationComponent: matrix.b,
          verticalOffset: matrix.m42,
        };
      });
      expect(replyMotion).not.toBeNull();
      expect(Math.abs(replyMotion!.rotationComponent)).toBeGreaterThan(0.02);
      expect(Math.abs(replyMotion!.verticalOffset)).toBeGreaterThan(0.5);
      await page.screenshot({ path: '/tmp/charter-claude-session-reply-wave.png' });
      await betaRow.screenshot({ path: '/tmp/charter-claude-session-reply-shake-card.png' });
      await betaRow.evaluate((element) => {
        element
          .getAnimations()
          .find(
            (candidate) =>
              candidate instanceof CSSAnimation &&
              candidate.animationName === 'srSessionReplyShake',
          )
          ?.play();
      });

      const betaReplyNotice = page.locator(
        `[data-testid="session-completion-notice"][data-kind="reply"][data-task-id="${betaTask.id}"]`,
      );
      await expect(betaReplyNotice).toBeVisible();
      await expect(betaReplyNotice).toContainText('Claude reply complete');
      await expect(betaReplyNotice).toContainText('The latest reply finished');
      await betaRow.click();
      await expect(betaRow).toHaveClass(/selected/);
      await expect(betaReplyNotice).toHaveCount(0);

      await expect
        .poll(
          async () => (await externalTasks(page)).every((task) => task.state === 'REVIEW_READY'),
          {
            timeout: 20_000,
          },
        )
        .toBe(true);
      await expect(alphaRow).toHaveAttribute('data-state', 'REVIEW_READY');
      await expect(betaRow).toHaveAttribute('data-state', 'REVIEW_READY');
      const betaCompletionNotice = page.locator(
        `[data-testid="session-completion-notice"][data-kind="completion"][data-task-id="${betaTask.id}"]`,
      );
      await expect(betaCompletionNotice).toHaveCount(0);
      await expect(betaReplyNotice).toHaveCount(0);
      const alphaTitle = await alphaRow.locator('.sr-session-title b').innerText();
      const betaTitle = await betaRow.locator('.sr-session-title b').innerText();
      expect(alphaTitle).toMatch(/^Session /);
      expect(betaTitle).toMatch(/^Session /);
      expect(alphaTitle).not.toBe(betaTitle);

      // Make the first Session's reads arrive after the second Session. The UI
      // must still be bound to the latest selected identity.
      await page.evaluate((slowTaskId) => {
        const rpc = window.product.rpc as Record<
          string,
          (payload: Record<string, unknown>) => Promise<unknown>
        >;
        for (const [channel, wait] of [
          ['task.get', 700],
          ['task.changeSet', 900],
        ] as const) {
          const original = rpc[channel]!;
          rpc[channel] = async (payload) => {
            const result = await original(payload);
            if (payload.taskId === slowTaskId) {
              await new Promise((resolve) => setTimeout(resolve, wait));
            }
            return result;
          };
        }
      }, alphaTask.id);

      await alphaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', alphaTask.id);
      await page.waitForTimeout(80);
      await betaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', betaTask.id);
      await expect(page.getByTestId('session-tool-canvas')).toHaveAttribute(
        'data-task-id',
        betaTask.id,
      );
      await expect(page.getByTestId('external-terminal-column')).toHaveAttribute(
        'data-terminal-id',
        secondTerminal.id,
      );

      // Wait beyond both injected delays: a late alpha response must not
      // replace beta's right-side totals, file ledger, or terminal.
      await page.waitForTimeout(1_050);
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', betaTask.id);
      await expect(page.getByTestId('task-room-file-src/beta.ts')).toBeVisible();
      await expect(page.getByTestId('task-room-file-src/alpha.ts')).toHaveCount(0);
      await expect(page.locator('.session-diff-total')).toContainText('+3');
      await waitForTerminalOutput(page, 'claude-beta-session-started', {
        terminalId: secondTerminal.id,
      });

      await alphaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', alphaTask.id);
      await expect(page.getByTestId('task-room-file-src/alpha.ts')).toBeVisible();
      await expect(page.locator('.session-diff-total')).toContainText('+1');
      await waitForTerminalOutput(page, 'claude-alpha-session-started', {
        terminalId: firstTerminal.id,
      });

      await betaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', betaTask.id);
      await expect(page.getByTestId('task-room-file-src/beta.ts')).toBeVisible();
      await expect(page.locator('.session-diff-total')).toContainText('+3');
      await waitForTerminalOutput(page, 'claude-beta-session-started', {
        terminalId: secondTerminal.id,
      });
      await page.screenshot({ path: '/tmp/charter-claude-session-switch-beta.png' });

      expect(errors, errors.join('\n')).toEqual([]);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
