import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';
import {
  terminalPtyOutput,
  terminalPtySnapshot,
  typeTerminalCommand,
  waitForTerminalOutput,
} from './helpers/terminal';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('M4 search, intelligence, terminal', () => {
  test('quick open finds files by fuzzy name', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await expect(page.getByTestId('workbench')).toBeVisible();
      await page.keyboard.press(`${mod}+p`);
      await expect(page.getByTestId('quick-open')).toBeVisible();
      // Fill the input directly — free typing races the dialog's focus timing.
      const input = page.getByRole('textbox', { name: 'File name' });
      await input.fill('util');
      await expect(page.getByTestId('quickopen-item-src/util.ts')).toBeVisible();
      await input.press('Enter');
      await expect(page.getByTestId('tab-src/util.ts')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('E2E-004: global search with regex, then preview-verified replace', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.keyboard.press(`${mod}+Shift+f`);
      await expect(page.getByTestId('search-view')).toBeVisible();
      await page.getByTestId('search-input').fill('add|sub');
      // enable regex
      await page.getByTitle('Regular expression').click();
      await page.getByTestId('search-run').click();
      await expect(page.getByTestId('search-results')).toContainText('util.ts');
      await expect(page.getByTestId('search-results')).toContainText('index.ts');

      // Replace flow with preview.
      await page.getByLabel('Toggle replace').click();
      await page.getByTestId('replace-input').fill('calc');
      await page.getByTestId('replace-preview-btn').click();
      await expect(page.getByTestId('replace-preview')).toBeVisible();
      await page.getByTestId('replace-apply').click();
      await expect
        .poll(() => readFileSync(join(fixture, 'src/util.ts'), 'utf8'))
        .toContain('export function calc(');
    } finally {
      await app.close();
    }
  });

  test('ordinary search presents multiple matches on one source line as one result row', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.keyboard.press(`${mod}+Shift+f`);
      await page.getByTestId('search-input').fill('add');
      await page.getByTestId('search-run').click();
      const row = page.getByTestId('search-match-run-tests.mjs-2');
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('×2');
    } finally {
      await app.close();
    }
  });

  test('opening a terminal from Home keeps it in the unified Session shell', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-shell')).toBeVisible();

      await page.keyboard.press(`${mod}+Shift+p`);
      const command = page.getByRole('textbox', { name: 'Command' });
      await command.fill('Open Terminal Session');
      await page.getByRole('option', { name: /Open Terminal Session/ }).click();

      await expect(page.getByTestId('home-shell')).toBeVisible();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible();
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });

      await page
        .getByTestId('session-terminal-view')
        .getByRole('button', { name: /Sessions/ })
        .click();
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('session-terminal-view')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('Terminal Session status follows a new live PTY after the original shell exits', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.keyboard.press(`${mod}+Shift+p`);
      const command = page.getByRole('textbox', { name: 'Command' });
      await command.fill('Open Terminal Session');
      await page.getByRole('option', { name: /Open Terminal Session/ }).click();

      const first = (await terminalPtySnapshot(page)).items[0]!;
      await expect(page.getByTestId('session-terminal-manager-status')).toHaveText(/Live/);
      await typeTerminalCommand(page, 'exit', { terminalId: first.id });
      await expect(page.getByTestId('session-terminal-manager-status')).toHaveText(/Ended/, {
        timeout: 15000,
      });

      await page.getByTestId('terminal-new').click();
      await expect
        .poll(async () =>
          (await terminalPtySnapshot(page)).items.find((entry) => entry.id !== first.id),
        )
        .not.toBeUndefined();
      const second = (await terminalPtySnapshot(page)).items.find(
        (entry) => entry.id !== first.id,
      )!;
      await typeTerminalCommand(page, "printf '__NEW_PTY_LIVE__\\n'", { terminalId: second.id });
      await waitForTerminalOutput(page, '__NEW_PTY_LIVE__', { terminalId: second.id });

      await expect(page.getByTestId('session-terminal-manager-status')).toHaveText(/Live/);
      await expect(page.getByTestId('session-terminal-manager-footer')).toContainText(
        'live sessions · 1 active',
      );
    } finally {
      await app.close();
    }
  });

  test('E2E-005: TS diagnostics, cross-file definition and rename with preview', async () => {
    const fixture = createTsSmallFixture();
    // Introduce a type error for diagnostics.
    writeFileSync(
      join(fixture, 'src/broken.ts'),
      `import { add } from './util';\nconst x: string = add(1, 2);\nexport default x;\n`,
    );
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('rail-tab-files').click();
      await page.getByTestId('tree-item-src').click();
      await page.getByTestId('tree-item-src/broken.ts').click();
      await expect(page.getByTestId('tab-src/broken.ts')).toBeVisible();

      // Problems panel should show the type error (aria-label carries the counts
      // — the visible glyphs are SVG icons since ADR-0008).
      await expect
        .poll(
          async () => {
            const status = await page.getByTestId('status-problems').getAttribute('aria-label');
            return status ?? '';
          },
          { timeout: 20000 },
        )
        .toMatch(/^[1-9]\d* errors?/);
      await page.getByTestId('status-problems').click();
      await expect(page.getByTestId('problems-panel')).toBeVisible();
      await expect(page.getByTestId('problem-error').first()).toContainText(
        /not assignable|string/,
      );

      // Cross-file definition: F12 on `add` should open util.ts.
      await page.locator('.monaco-editor').first().click();
      // put cursor on "add" occurrence (line 2, find via search within editor)
      await page.keyboard.press(`${mod}+Home`);
      await page.evaluate(() => {
        const w = window as unknown as {
          monaco?: typeof import('monaco-editor');
        };
        void w;
      });
      // Position the cursor exactly on the `add` call. Monaco's Go to Line
      // accepts line:column, which is more deterministic than synthesizing 19
      // ArrowRight events after the Problems panel has resized the editor.
      await page.keyboard.press('Control+g');
      await page.keyboard.type('2:19');
      await page.keyboard.press('Enter');
      // The TypeScript worker may still be finishing its project graph after a
      // long serial Electron run. Retry the real F12 interaction at the same
      // cursor instead of replacing it with a direct file-open shortcut.
      const utilTab = page.getByTestId('tab-src/util.ts');
      let definitionOpened = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.keyboard.press('F12');
        definitionOpened = await utilTab
          .waitFor({ state: 'visible', timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (definitionOpened) break;
        // Reassert the exact target in case a failed definition action moved
        // focus into a notification or peek widget.
        await page.locator('.monaco-editor').first().click();
        await page.keyboard.press('Control+g');
        await page.keyboard.type('2:19');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1200);
      }
      expect(definitionOpened).toBe(true);
      // F12 navigation swaps the editor model asynchronously; wait until util.ts is
      // actually rendered (its `sub` helper is unique to this file) so keystrokes
      // land in the util.ts model, not the previous one.
      await expect(page.locator('.monaco-editor').first()).toContainText('function sub', {
        timeout: 15000,
      });
      // The TS worker re-analyses the newly-focused file before it can return a
      // complete cross-file rename set; give it a moment so the rename resolves all
      // locations (product works for a human — this only guards sub-second automation).
      await page.waitForTimeout(1500);

      // Rename with preview: place the cursor deterministically on the `add`
      // identifier in util.ts (line 1: `export function add(`).
      await page.locator('.monaco-editor').first().click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+g');
      await page.keyboard.type('1:18');
      await page.keyboard.press('Enter');
      await page.keyboard.press('F2');
      await expect(page.getByTestId('rename-input-dialog')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('rename-input').fill('addNumbers');
      await page.keyboard.press('Enter');
      // Preview must resolve cross-file before we apply (proves the worker was ready).
      await expect(page.getByTestId('rename-preview')).toBeVisible();
      await expect(page.getByTestId('rename-preview')).toContainText('src/util.ts');
      await expect(page.getByTestId('rename-preview')).toContainText('src/index.ts');
      await page.getByTestId('rename-apply').click();
      await expect
        .poll(() => readFileSync(join(fixture, 'src/util.ts'), 'utf8'), { timeout: 15000 })
        .toContain('export function addNumbers(');
      await expect
        .poll(() => readFileSync(join(fixture, 'src/index.ts'), 'utf8'))
        .toContain('addNumbers(2, 3)');
    } finally {
      await app.close();
    }
  });

  test('E2E-006: python file shows LSP guidance or live diagnostics', async () => {
    const fixture = createTsSmallFixture();
    mkdirSync(join(fixture, 'py'), { recursive: true });
    writeFileSync(join(fixture, 'py/app.py'), 'def greet(name):\n    return "hi " + name\n');
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await page.getByTestId('rail-tab-files').click();
      await page.getByTestId('tree-item-py').click();
      await page.getByTestId('tree-item-py/app.py').click();
      await expect(page.getByTestId('tab-py/app.py')).toBeVisible();
      // Either a running server (no banner) or explicit install guidance (LSP-003).
      const banner = page.getByTestId('python-lsp-banner');
      const bannerVisible = await banner.isVisible().catch(() => false);
      if (bannerVisible) {
        await expect(banner).toContainText(/python-lsp-server|language server/i);
      }
      // Syntax highlighting requires the language id to be python either way.
      await expect(page.getByTestId('status-language')).toHaveText('python');
    } finally {
      await app.close();
    }
  });

  test('E2E-007: terminal lifecycle — run, resize, kill, no orphans', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    let shellPid: number | null = null;
    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15000 });

      const initial = await terminalPtySnapshot(page);
      expect(initial.items).toHaveLength(1);
      const first = initial.items[0]!;
      shellPid = first.pid;

      // Business evidence comes from the host-owned PTY tail, not xterm's DOM
      // rows (which intentionally disappear when WebGL is active).
      await typeTerminalCommand(
        page,
        "printf '__TERM_RUN__\\n'; stty size | sed 's/^/__SIZE_BEFORE__ /'",
        { terminalId: first.id },
      );
      await waitForTerminalOutput(page, '__TERM_RUN__', { terminalId: first.id });
      await waitForTerminalOutput(page, /__SIZE_BEFORE__ \d+ \d+/, { terminalId: first.id });
      const beforeOutput = await terminalPtyOutput(page, first.id);
      const beforeSize = beforeOutput.match(/__SIZE_BEFORE__ (\d+) (\d+)/);
      expect(beforeSize).not.toBeNull();

      // Resize the real BrowserWindow and prove xterm propagated a different
      // row/column geometry through terminal.resize into the PTY.
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 980, height: 700 });
      });
      await expect(page.locator('.xterm')).toBeVisible();
      await page.waitForTimeout(500);
      await typeTerminalCommand(page, "stty size | sed 's/^/__SIZE_AFTER__ /'", {
        terminalId: first.id,
      });
      await waitForTerminalOutput(page, /__SIZE_AFTER__ \d+ \d+/, { terminalId: first.id });
      const afterOutput = await terminalPtyOutput(page, first.id);
      const afterSize = afterOutput.match(/__SIZE_AFTER__ (\d+) (\d+)/);
      expect(afterSize).not.toBeNull();
      expect(afterSize!.slice(1)).not.toEqual(beforeSize!.slice(1));

      // A second terminal with a live child takes the confirmed kill path.
      await page.getByTestId('terminal-new').click();
      await expect.poll(async () => (await terminalPtySnapshot(page)).items.length).toBe(2);
      const second = (await terminalPtySnapshot(page)).items.find((item) => item.id !== first.id)!;
      await typeTerminalCommand(page, 'sleep 30', { terminalId: second.id });
      await page.getByTestId(`terminal-tab-${second.id}`).getByRole('button').click();
      await expect(page.getByTestId('terminal-kill-confirm')).toBeVisible();
      await page.getByTestId('terminal-kill-force').click();
      await expect
        .poll(async () => (await terminalPtySnapshot(page)).items.map((item) => item.id))
        .not.toContain(second.id);
      await expect.poll(() => processIsAlive(second.pid)).toBe(false);

      // Killing the neighbour must not damage the original PTY.
      await typeTerminalCommand(page, "printf '\\137\\137FIRST_SURVIVES_KILL\\137\\137\\n'", {
        terminalId: first.id,
      });
      await waitForTerminalOutput(page, '__FIRST_SURVIVES_KILL__', { terminalId: first.id });
    } finally {
      await app.close();
    }
    // TERM-004/REL: after app exit the shell process must be gone.
    if (shellPid) {
      await new Promise((r) => setTimeout(r, 2500));
      expect(processIsAlive(shellPid)).toBe(false);
    }
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
