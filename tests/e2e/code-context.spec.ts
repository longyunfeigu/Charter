import { expect, test } from '@playwright/test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchApp } from './helpers/launch.js';
import { createTsSmallFixture } from './helpers/fixtures.js';
import { waitForTerminalOutput } from './helpers/terminal.js';

function createContextEchoAgents(): string {
  const bin = mkdtempSync(join(tmpdir(), 'charter-code-context-agents-'));
  for (const cli of ['claude', 'codex']) {
    writeFileSync(
      join(bin, cli),
      [
        '#!/usr/bin/env node',
        `console.log(${JSON.stringify(`${cli}-context-agent-ready`)});`,
        "process.stdin.setEncoding('utf8');",
        `process.stdin.on('data', (chunk) => console.log(${JSON.stringify(`${cli}-received:`)} + chunk.replace(/\\u001b/g, '<ESC>')));`,
        'setTimeout(() => process.exit(0), 20000);',
        '',
      ].join('\n'),
    );
    chmodSync(join(bin, cli), 0o755);
  }
  return bin;
}

test.describe('mature CodeContextRef', () => {
  test('Diff selection becomes a structured Pi turn and reaches the running agent', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const rendererErrors: string[] = [];
    page.on('pageerror', (error) => rendererErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text());
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-live] code context live turn');
      await page.getByTestId('home-submit').click();

      await expect(page.getByTestId('session-tools-open')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('session-tools-open').click();
      const roomBoard = page.locator('[data-testid^="live-board-"]').first();
      await expect(roomBoard).toBeVisible({ timeout: 20000 });
      const liveFile = roomBoard.getByTestId('live-tile-notes-live-a.txt');
      await expect(liveFile).toBeVisible({ timeout: 20000 });
      await liveFile.click();
      await expect(page.locator('.session-inline-line.addition').first()).toContainText(
        'live board A',
      );

      await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>('.session-inline-line.addition');
        const code = row?.querySelector('code');
        const host = document.querySelector<HTMLElement>('.session-inline-diff-body');
        if (!row || !code || !host) throw new Error('diff selection target missing');
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });

      await expect(page.getByTestId('diff-code-selection-bar')).toBeVisible();
      await page.getByTestId('diff-add-code-context').click();
      await expect(page.getByTestId('room-code-context-refs')).toContainText('notes-live-a.txt');
      await expect(page.getByTestId('room-code-context-refs')).toContainText('L1');

      if (process.env.CHARTER_CAPTURE_CODE_CONTEXT === '1') {
        await page.screenshot({ path: '/tmp/charter-code-context-1440.png' });
        await page.setViewportSize({ width: 900, height: 900 });
        await expect(page.getByTestId('session-tool-canvas')).toBeVisible();
        await expect(page.getByTestId('room-code-context-refs')).toBeHidden();
        await expect(page.locator('.session-inline-line.addition').first()).toContainText(
          'live board A',
        );
        await page.waitForTimeout(300);
        await page.screenshot({ path: '/tmp/charter-code-context-tools-900.png' });
        await page.getByTestId('session-tool-close').click();
        await expect(page.getByTestId('session-tool-canvas')).toBeHidden();
        await expect(page.getByTestId('room-code-context-refs')).toBeVisible();
        await page.screenshot({ path: '/tmp/charter-code-context-900.png' });
        await page.setViewportSize({ width: 1440, height: 900 });
      }

      await page.getByTestId('agent-input').fill('Use this exact selected line as context.');
      await page.getByTestId('agent-send').click();
      await expect(page.getByTestId('room-code-context-refs')).toHaveCount(0);
      await expect(page.getByTestId('tl-code-context')).toContainText('notes-live-a.txt');

      // The deterministic mock acknowledges the exact runtime prompt. Seeing
      // the selected bytes here proves the attachment crossed main → runtime;
      // it was not merely rendered as a frontend chip.
      const acknowledgement = page
        .getByTestId('tl-agent')
        .filter({ hasText: 'Adjusting approach based on your instruction' });
      await expect(acknowledgement).toContainText('live board A', { timeout: 15000 });
      expect(rendererErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });

  for (const cli of ['claude', 'codex'] as const) {
    test(`${cli} receives the same structured snapshot through its real PTY`, async () => {
      const fixture = createTsSmallFixture();
      const bin = createContextEchoAgents();
      const { app, page } = await launchApp({
        env: {
          PI_IDE_OPEN_WORKSPACE: fixture,
          PI_IDE_EXTERNAL_CLIS: 'claude,codex',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
      });
      try {
        await page.keyboard.press('Control+`');
        await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });
        await page.locator('.xterm').click();
        // zsh can still be initializing when xterm first paints. Prove the PTY
        // prompt is accepting complete commands before launching the fake CLI.
        const readyMarker = `context-shell-ready-${cli}`;
        await page.keyboard.type(`echo ${readyMarker}`);
        await page.keyboard.press('Enter');
        await waitForTerminalOutput(page, readyMarker);
        await page.keyboard.type(join(bin, cli));
        await page.keyboard.press('Enter');
        await expect(page.locator('[data-testid^="terminal-agent-"]')).toBeVisible({
          timeout: 15000,
        });

        const marker = `${cli.toUpperCase()}_STRUCTURED_CONTEXT_MARKER`;
        const result = await page.evaluate(
          async ({ expectedCli, markerText }) => {
            const bridge = (
              window as never as {
                product: {
                  rpc: Record<string, (payload: unknown) => Promise<unknown>>;
                };
              }
            ).product;
            const listed = (await bridge.rpc['task.list']!({
              filter: 'all',
              includeArchived: false,
            })) as {
              ok: boolean;
              data?: {
                tasks: Array<{ id: string; external: { cli: string } | null }>;
              };
            };
            const task = listed.data?.tasks.find((item) => item.external?.cli === expectedCli);
            if (!task) throw new Error(`No external ${expectedCli} task`);
            // ADR-0030: the snapshot is injected into the CLI's own input
            // line (bracketed paste, no Enter) instead of being sent as a
            // composed turn.
            return bridge.rpc['external.injectContext']!({
              taskId: task.id,
              ref: {
                kind: 'selection',
                code: {
                  id: `ref-${expectedCli}`,
                  path: 'src/index.ts',
                  origin: 'editor',
                  version: 'working-tree',
                  startLine: 3,
                  startColumn: 1,
                  endLine: 3,
                  endColumn: markerText.length + 1,
                  text: markerText,
                  language: 'typescript',
                  contentHash: null,
                  selectionHash: 'a'.repeat(64),
                  createdAt: '2026-07-17T00:00:00.000Z',
                },
              },
            });
          },
          { expectedCli: cli, markerText: marker },
        );
        expect(result).toMatchObject({ ok: true, data: { delivered: true } });
        // The echo agent prints every stdin chunk: the frozen bytes crossed
        // main → PTY as pasted input. (The no-Enter payload contract is unit
        // tested — externalInjectText; the canonical-mode fake CLI only sees
        // newline-terminated chunks, so the paste-close byte isn't assertable
        // here.)
        await waitForTerminalOutput(page, marker);
      } finally {
        await app.close();
      }
    });
  }

  test('capture the mature HTML source visual', async () => {
    test.skip(process.env.CHARTER_CAPTURE_CODE_CONTEXT !== '1', 'visual QA capture only');
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(
        pathToFileURL(join(process.cwd(), 'docs/design/code-context-ref-mockups/unified.html'))
          .href,
      );
      await page.waitForLoadState('domcontentloaded');
      await page.evaluate(() => {
        for (const key of ['editor', 'search']) {
          document.querySelector<HTMLButtonElement>(`[data-ref="${key}"] .remove-ref`)?.click();
        }
      });
      await expect(page.locator('[data-ref="file"]')).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-code-context-source-1440.png' });

      const sourceUrl = pathToFileURL('/tmp/charter-code-context-source-1440.png').href;
      const implementationUrl = pathToFileURL('/tmp/charter-code-context-1440.png').href;
      await page.setViewportSize({ width: 2880, height: 938 });
      await page.setContent(`
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #17130f; color: white; font: 14px system-ui; }
          main { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
          figure { margin: 0; background: #17130f; }
          figcaption { height: 38px; display: flex; align-items: center; padding: 0 14px; }
          img { display: block; width: 1440px; height: 900px; object-fit: contain; background: white; }
        </style>
        <main>
          <figure><figcaption>Source visual · mature unified mock</figcaption><img src="${sourceUrl}"></figure>
          <figure><figcaption>Electron implementation · current Studio skin</figcaption><img src="${implementationUrl}"></figure>
        </main>
      `);
      await expect(page.locator('img').first()).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-code-context-comparison-1440.png' });

      await page.setViewportSize({ width: 2880, height: 400 });
      await page.setContent(`
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; background: #17130f; color: white; font: 14px system-ui; }
          main { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; }
          figure { position: relative; height: 400px; margin: 0; overflow: hidden; background: white; }
          figcaption { position: absolute; z-index: 2; top: 0; left: 0; padding: 7px 12px; background: #17130f; }
          img { position: absolute; left: 0; bottom: 0; width: 1440px; height: 900px; }
        </style>
        <main>
          <figure><figcaption>Source · composer context shelf</figcaption><img src="${sourceUrl}"></figure>
          <figure><figcaption>Implementation · composer context shelf</figcaption><img src="${implementationUrl}"></figure>
        </main>
      `);
      await expect(page.locator('img').last()).toBeVisible();
      await page.screenshot({ path: '/tmp/charter-code-context-comparison-focused.png' });
    } finally {
      await app.close();
    }
  });
});
