import { expect, test, type Page } from '@playwright/test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';

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
      '  }, 260);',
      '});',
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
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
        await expect(page.getByTestId('terminal-host')).toContainText(
          `observed-${provider}-ready`,
          { timeout: 15_000 },
        );
        await expect.poll(async () => (await externalTasks(page, provider)).length).toBe(1);

        const task = (await externalTasks(page, provider))[0]!;
        const row = page.getByTestId(`home-task-${task.id}`);
        await expect(row).toBeVisible();
        await expect(row).not.toHaveAttribute('data-reply', 'true');
        await row.click();
        await expect(row).toHaveClass(/selected/);
        await expect(page.getByTestId('external-agent-input')).toBeEnabled();
        await page.locator('.toast button[aria-label="Dismiss"]').evaluateAll((buttons) => {
          for (const button of buttons) (button as HTMLButtonElement).click();
        });

        // Exercise the exact in-Session path from the report: the host sees the
        // submitted Enter, observes non-structured PTY output, then emits only a
        // presence edge after 1.8s of quiet.
        await page.getByTestId('external-agent-input').fill('finish this observed turn');
        await page.getByTestId('external-agent-send').click();
        await expect(page.getByTestId('external-terminal-host')).toContainText(
          'observed-reply-complete',
          { timeout: 10_000 },
        );

        const notice = page.locator(
          `[data-testid="session-completion-notice"][data-kind="reply"][data-task-id="${task.id}"]`,
        );
        await expect(notice).toBeVisible({ timeout: 8_000 });
        await expect(notice).toContainText(
          `${provider === 'claude' ? 'Claude' : 'Codex'} reply complete`,
        );
        await expect(notice).toContainText('Terminal output settled');

        await expect(row).toHaveAttribute('data-reply', 'true', { timeout: 8_000 });
        await expect(row).toHaveClass(/reply-shake/);
        await expect(row).toHaveCSS('animation-name', 'srSessionReplyShake');
        await expect(row).toHaveCSS('animation-duration', '2.2s');
        const cardWave = await row.evaluate(
          (element) => getComputedStyle(element, '::after').animationName,
        );
        expect(cardWave).toBe('srSessionCardWave');

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
      await expect(page.getByTestId('terminal-host')).toContainText('alpha-shell-ready');
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
      await expect(page.getByTestId('terminal-host')).toContainText('beta-shell-ready');
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
      await betaRow.click();
      await expect(betaRow).toHaveClass(/selected/);

      // Claude's structured result is a genuine turn boundary. It must animate
      // the matching Session as a whole-card, diagonal damped shake.
      await expect(betaRow).toHaveAttribute('data-reply', 'true', { timeout: 12_000 });
      await expect(betaRow).toHaveClass(/reply-shake/);
      await expect(betaRow).toHaveCSS('animation-name', 'srSessionReplyShake');
      await expect(betaRow.locator('.sr-provider')).toHaveClass(/session-wave/);
      const betaReplyNotice = page.locator(
        `[data-testid="session-completion-notice"][data-kind="reply"][data-task-id="${betaTask.id}"]`,
      );
      await expect(betaReplyNotice).toBeVisible();
      await expect(betaReplyNotice).toContainText('Claude reply complete');
      await expect(betaReplyNotice).toContainText('The latest reply finished');

      // Freeze the genuine running animation on its first diagonal peak so
      // the visual artifact proves the card rotates and moves vertically — a
      // horizontal-only nudge would produce neither component.
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
      await expect(betaCompletionNotice).toBeVisible();
      await expect(betaCompletionNotice).toContainText('Ready for review');
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
      await expect(page.getByTestId('external-terminal-host')).toContainText(
        'claude-beta-session-started',
      );

      await alphaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', alphaTask.id);
      await expect(page.getByTestId('task-room-file-src/alpha.ts')).toBeVisible();
      await expect(page.locator('.session-diff-total')).toContainText('+1');
      await expect(page.getByTestId('external-terminal-host')).toContainText(
        'claude-alpha-session-started',
      );

      await betaRow.click();
      await expect(page.getByTestId('task-room')).toHaveAttribute('data-task-id', betaTask.id);
      await expect(page.getByTestId('task-room-file-src/beta.ts')).toBeVisible();
      await expect(page.locator('.session-diff-total')).toContainText('+3');
      await expect(page.getByTestId('external-terminal-host')).toContainText(
        'claude-beta-session-started',
      );
      await page.screenshot({ path: '/tmp/charter-claude-session-switch-beta.png' });

      expect(errors, errors.join('\n')).toEqual([]);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
