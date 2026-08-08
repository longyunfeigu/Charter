import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchApp,
  restartMainPreservingTerminals,
  shutdownPersistentTestTerminals,
} from './helpers/launch';
import { createGitFixture } from './helpers/fixtures';
import { terminalPtySnapshot, typeTerminalCommand } from './helpers/terminal';

function createOfflineCodexBin(fixture: string): {
  bin: string;
  trigger: string;
  done: string;
} {
  const bin = mkdtempSync(join(tmpdir(), 'pi-ide-offline-codex-'));
  const trigger = join(bin, 'trigger');
  const done = join(bin, 'done');
  const modified = join(fixture, 'src/util.ts');
  const created = join(fixture, 'src/offline-created.ts');
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const trigger = ${JSON.stringify(trigger)};`,
      `const done = ${JSON.stringify(done)};`,
      `const modified = ${JSON.stringify(modified)};`,
      `const created = ${JSON.stringify(created)};`,
      "console.log('OFFLINE_CODEX_READY');",
      'const timer = setInterval(() => {',
      '  if (!fs.existsSync(trigger)) return;',
      '  clearInterval(timer);',
      "  fs.appendFileSync(modified, 'export const offlineDaemonEdit = true;\\n');",
      "  fs.writeFileSync(created, 'export const createdWhileClosed = true;\\n');",
      "  console.log('OFFLINE_CODEX_FILES_WRITTEN');",
      "  fs.writeFileSync(done, 'done');",
      '}, 25);',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return { bin, trigger, done };
}

async function externalTask(page: Page): Promise<{
  id: string;
  state: string;
  terminalId: string;
} | null> {
  return await page.evaluate(async () => {
    const result = (await window.product.rpc['task.list']!({
      filter: 'all',
      includeArchived: false,
    })) as {
      ok: boolean;
      data?: {
        tasks: Array<{
          id: string;
          state: string;
          external: { terminalId: string } | null;
        }>;
      };
    };
    const task = result.data?.tasks.find((candidate) => candidate.external);
    return task?.external
      ? { id: task.id, state: task.state, terminalId: task.external.terminalId }
      : null;
  });
}

async function killTerminal(page: Page, terminalId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.product.rpc['terminal.kill']!({ id, force: true });
  }, terminalId);
}

test.describe('daemon recovery file accounting', () => {
  test('records and rolls back agent writes made while the app is fully closed', async () => {
    const fixture = createGitFixture();
    const originalUtil = readFileSync(join(fixture, 'src/util.ts'), 'utf8');
    const fake = createOfflineCodexBin(fixture);
    const environment = {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'codex',
      PI_IDE_TERMINAL_PERSIST: '1',
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: fake.bin,
    };
    let firstApp: ElectronApplication | null = null;
    let secondApp: ElectronApplication | null = null;
    let terminalId: string | null = null;
    let userDataDir: string | null = null;

    try {
      const first = await launchApp({ env: environment });
      firstApp = first.app;
      userDataDir = first.userDataDir;
      await first.page.keyboard.press('Control+`');
      await expect(first.page.getByTestId('terminal-panel')).toBeVisible();
      let terminals = await terminalPtySnapshot(first.page);
      if (terminals.items.length === 0) {
        await first.page.getByTestId('terminal-new').click();
        terminals = await terminalPtySnapshot(first.page);
      }
      terminalId = terminals.items.at(-1)?.id ?? null;
      expect(terminalId).toBeTruthy();
      await typeTerminalCommand(first.page, 'codex', { terminalId: terminalId! });
      await expect(first.page.locator('[data-testid^="terminal-agent-"]')).toContainText('Codex', {
        timeout: 15_000,
      });
      const beforeClose = await externalTask(first.page);
      expect(beforeClose).toMatchObject({ state: 'IN_PROGRESS', terminalId });

      await restartMainPreservingTerminals(first.app);
      firstApp = null;
      writeFileSync(fake.trigger, 'write now');
      await expect.poll(() => existsSync(fake.done), { timeout: 10_000 }).toBe(true);
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('offlineDaemonEdit');
      expect(existsSync(join(fixture, 'src/offline-created.ts'))).toBe(true);

      const second = await launchApp({
        userDataDir: first.userDataDir,
        env: environment,
      });
      secondApp = second.app;
      await expect
        .poll(() => externalTask(second.page), { timeout: 20_000 })
        .toMatchObject({ id: beforeClose!.id, state: 'IN_PROGRESS', terminalId });

      const recovered = await expect
        .poll(
          async () => {
            return await second.page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.changeSet']!({ taskId })) as {
                ok: boolean;
                data?: {
                  changeSet: {
                    files: Array<{
                      path: string;
                      status: string;
                      additions: number;
                    }>;
                  };
                };
              };
              return result.data?.changeSet.files ?? [];
            }, beforeClose!.id);
          },
          { timeout: 20_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: 'src/util.ts', status: 'modified', additions: 1 }),
            expect.objectContaining({ path: 'src/offline-created.ts', status: 'created' }),
          ]),
        );
      void recovered;

      const review = await second.page.evaluate(async (taskId) => {
        const result = (await window.product.rpc['task.reviewFile']!({
          taskId,
          path: 'src/util.ts',
        })) as {
          ok: boolean;
          data?: { baseline: string | null; current: string | null };
        };
        return result.ok && result.data
          ? { ok: true as const, data: result.data }
          : { ok: false as const, data: null };
      }, beforeClose!.id);
      expect(review.ok).toBe(true);
      if (!review.ok) throw new Error('task.reviewFile failed');
      expect(review.data.baseline).toBe(originalUtil);
      expect(review.data.current).toContain('offlineDaemonEdit');

      await killTerminal(second.page, terminalId!);
      await expect
        .poll(async () => (await externalTask(second.page))?.state, { timeout: 20_000 })
        .toBe('REVIEW_READY');
      const rollback = await second.page.evaluate(async (taskId) => {
        const result = (await window.product.rpc['task.rollback']!({
          taskId,
          force: false,
        })) as { ok: boolean; data?: { status: string } };
        return result.ok && result.data
          ? { ok: true as const, data: result.data }
          : { ok: false as const, data: null };
      }, beforeClose!.id);
      expect(rollback.ok).toBe(true);
      if (!rollback.ok) throw new Error('task.rollback failed');
      expect(rollback.data.status).toBe('ok');
      expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toBe(originalUtil);
      expect(existsSync(join(fixture, 'src/offline-created.ts'))).toBe(false);
    } finally {
      if (secondApp && terminalId) {
        const [page] = secondApp.windows();
        if (page) await killTerminal(page, terminalId).catch(() => undefined);
      }
      await firstApp?.close().catch(() => undefined);
      await secondApp?.close().catch(() => undefined);
      if (userDataDir) await shutdownPersistentTestTerminals(userDataDir).catch(() => undefined);
    }
  });
});
