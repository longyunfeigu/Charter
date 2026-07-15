import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * TEMPORARY manual verification (ADR-0018, not part of the suite): drives the
 * REAL pi runtime against the user's gateway to exercise the preset-E room
 * presentation end to end — spine column, serif agent prose, recessed worklog
 * with timestamps, review bar, composer focus. Real writes are asserted on
 * disk, not just in the UI. Requires CHARTER_TEST_KEY and CHARTER_TEST_BASEURL
 * in the environment; skips otherwise.
 */
const KEY = process.env.CHARTER_TEST_KEY ?? '';
const BASEURL = process.env.CHARTER_TEST_BASEURL ?? '';
const MODEL = process.env.CHARTER_TEST_MODEL ?? 'claude-haiku-4-5-20251001';

/** Wait for REVIEW_READY while approving any plan/permission gate that opens. */
async function waitReviewReady(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page
      .getByTestId('task-state')
      .getAttribute('data-state')
      .catch(() => null);
    if (state === 'REVIEW_READY') return;
    if (state === 'FAILED') throw new Error('task reached FAILED');
    const plan = page.getByTestId('plan-approve');
    if (await plan.isVisible().catch(() => false)) await plan.click().catch(() => undefined);
    const perm = page.getByTestId('perm-allow-once');
    if (await perm.isVisible().catch(() => false)) await perm.click().catch(() => undefined);
    await page.waitForTimeout(1000);
  }
  throw new Error('timeout waiting for REVIEW_READY');
}

test('real gateway: preset-E room — real write task, worklog evidence, serif prose, review bar', async () => {
  test.skip(!KEY || !BASEURL, 'no real credentials in env');
  test.setTimeout(600000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture },
  });
  try {
    // 1) Real provider: key + base URL through Settings → Models.
    await page.getByTestId('activity-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await page.getByTestId('provider-key-input').fill(KEY);
    await page.getByTestId('provider-baseurl-input').fill(BASEURL);
    await page.getByTestId('provider-key-save').click();
    await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
    // Live model list through the gateway — the Home picker only offers
    // fetched models.
    await page.getByTestId('provider-fetch-anthropic').click();
    await expect(page.locator('.toast').filter({ hasText: 'models fetched' })).toBeVisible({
      timeout: 20000,
    });
    await page.keyboard.press('Escape');

    // 2) A REAL write task from Home (agent mode), substantial Chinese brief.
    await page.getByTestId('surface-home').click();
    const model = page.getByTestId('home-model');
    await expect(model).toBeVisible();
    await model.click();
    // The picker is a long popover that can overflow the window — dispatch the
    // click straight to the option instead of relying on viewport coordinates.
    await page.getByTestId(`home-model-opt-anthropic::${MODEL}`).dispatchEvent('click');
    await page
      .getByTestId('home-intent')
      .fill(
        '在项目根目录新建 docs/NOTES.md：用中文写三条要点，每条一行、以 "- " 开头：' +
          '1) 这个项目是干什么的；2) 怎么在本地跑起来；3) 测试怎么跑。' +
          '然后在 src/util.ts 末尾追加并导出函数 mul(a: number, b: number): number，返回 a * b。' +
          '只读写文件，不要运行任何 shell 命令。完成后用中文总结改动，并用 markdown 列表列出改过的文件。',
      );
    await page.getByTestId('home-submit').click();
    await expect(page.getByTestId('task-room')).toBeVisible();

    // 3) Mid-run: the recessed worklog groups real tool evidence with clocks.
    await expect(page.getByTestId('tl-worklog').first()).toBeVisible({ timeout: 120000 });
    expect(await page.locator('.rt-ts').count()).toBeGreaterThan(0);
    await page.screenshot({ path: '/tmp/ui-shots/e-1-working.png' });

    await waitReviewReady(page, 420000);

    // 4) Preset-E presentation, computed for real: spine, serif prose, worklog.
    const style = await page.evaluate(() => {
      const col = document.querySelector('.rt-col');
      const agent = document.querySelector('[data-testid="tl-agent"]');
      const ms = document.querySelector('[data-testid="tl-milestone"] b, .rt-milestone b');
      return {
        spine: col ? getComputedStyle(col, '::before').width : null,
        agentFont: agent ? getComputedStyle(agent).fontFamily : '',
        msTransform: ms ? getComputedStyle(ms).textTransform : '',
      };
    });
    expect(style.spine).toBe('1px');
    expect(style.agentFont).toContain('Charter');
    expect(style.msTransform).toBe('uppercase');
    await expect(page.getByTestId('review-bar')).toBeVisible();
    await page.screenshot({ path: '/tmp/ui-shots/e-2-review.png' });

    // 5) The writes are REAL — assert them on disk, not just in the UI.
    const notes = join(fixture, 'docs/NOTES.md');
    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, 'utf8')).toContain('- ');
    expect(readFileSync(join(fixture, 'src/util.ts'), 'utf8')).toContain('mul');

    // 6) Composer focus lives on the card — the old black :focus-visible box
    //    must be gone (ADR-0018 / room.css fix).
    await page.getByTestId('agent-input').click();
    const focus = await page.evaluate(() => {
      const ta = document.querySelector('[data-testid="agent-input"]');
      return ta ? getComputedStyle(ta).outlineStyle : '';
    });
    expect(focus).toBe('none');
    await page.screenshot({ path: '/tmp/ui-shots/e-3-focus.png' });

    // 7) Follow-up run (a reply IS a new run): more real content, second
    //    worklog group, disk updated again.
    await page
      .getByTestId('agent-input')
      .fill(
        '把 docs/NOTES.md 里每条要点扩写成两句话（保持 "- " 前缀），' +
          '并在文件末尾追加一行「更新于第二轮」。同样只读写文件、不要运行命令，改完用中文简单总结。',
      );
    await page.getByTestId('agent-send').click();
    await expect
      .poll(async () => page.getByTestId('task-state').getAttribute('data-state'), {
        timeout: 60000,
      })
      .not.toBe('REVIEW_READY');
    await waitReviewReady(page, 420000);
    expect(readFileSync(notes, 'utf8')).toContain('更新于第二轮');
    expect(await page.getByTestId('tl-worklog').count()).toBeGreaterThan(1);
    await page.screenshot({ path: '/tmp/ui-shots/e-4-followup.png' });
  } finally {
    await app.close();
  }
});
