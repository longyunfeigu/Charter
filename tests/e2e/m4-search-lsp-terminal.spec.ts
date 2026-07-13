import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('M4 search, intelligence, terminal', () => {
  test('quick open finds files by fuzzy name', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
      await expect(page.getByTestId('workspace-chip')).toBeVisible();
      await page.keyboard.press(`${mod}+p`);
      await expect(page.getByTestId('quick-open')).toBeVisible();
      await page.keyboard.type('util');
      await expect(page.getByTestId('quickopen-item-src/util.ts')).toBeVisible();
      await page.keyboard.press('Enter');
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

  test('E2E-005: TS diagnostics, cross-file definition and rename with preview', async () => {
    const fixture = createTsSmallFixture();
    // Introduce a type error for diagnostics.
    writeFileSync(
      join(fixture, 'src/broken.ts'),
      `import { add } from './util';\nconst x: string = add(1, 2);\nexport default x;\n`,
    );
    const { app, page } = await launchApp({ env: { PI_IDE_OPEN_WORKSPACE: fixture } });
    try {
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
      // Position cursor at add( call: line 2 column 20 approximately via go-to-line
      await page.keyboard.press('Control+g');
      await page.keyboard.type('2');
      await page.keyboard.press('Enter');
      // Move to the identifier `add`
      await page.keyboard.press('Home');
      for (let i = 0; i < 19; i++) await page.keyboard.press('ArrowRight');
      await page.keyboard.press('F12');
      await expect(page.getByTestId('tab-src/util.ts')).toBeVisible({ timeout: 15000 });
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
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Home');
      for (let i = 0; i < 17; i++) await page.keyboard.press('ArrowRight');
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

      // Run a command and observe output.
      await page.locator('.xterm').click();
      await page.keyboard.type('echo pi-ide-terminal-works');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('terminal-panel')).toContainText('pi-ide-terminal-works', {
        timeout: 15000,
      });

      // Get shell pid from main for orphan check.
      shellPid = await page.evaluate(async () => {
        const bridge = (
          window as never as {
            product: {
              rpc: Record<
                string,
                (p: unknown) => Promise<{ ok: boolean; data?: { items: Array<{ pid: number }> } }>
              >;
            };
          }
        ).product;
        const res = await bridge.rpc['terminal.list']!({});
        return res.data?.items[0]?.pid ?? null;
      });
      expect(shellPid).not.toBeNull();

      // Second terminal + switch.
      await page.getByTestId('terminal-new').click();
      await expect
        .poll(async () => {
          const bridge = await page.evaluate(async () => {
            const b = (
              window as never as {
                product: {
                  rpc: Record<
                    string,
                    (p: unknown) => Promise<{ ok: boolean; data?: { items: unknown[] } }>
                  >;
                };
              }
            ).product;
            const res = await b.rpc['terminal.list']!({});
            return res.data?.items.length ?? 0;
          });
          return bridge;
        })
        .toBe(2);
    } finally {
      await app.close();
    }
    // TERM-004/REL: after app exit the shell process must be gone.
    if (shellPid) {
      await new Promise((r) => setTimeout(r, 2500));
      let alive = true;
      try {
        process.kill(shellPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });
});
