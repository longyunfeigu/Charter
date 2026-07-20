import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

async function switchReplayDepth(page: Page, depth: 'recap' | 'explore' | 'verify') {
  await page.getByTestId('replay-menu-toggle').click();
  await page.getByTestId(`replay-depth-${depth}`).click();
}

/**
 * Replay V3 (ADR-0017 am.8): one story, three depths.
 * Covers the Phase-1 gates from the V3 handoff: result-first opening without
 * autoplay, no A–E peer navigation, no numeric confidence, shared
 * depth/playhead/selection, story/real time, evidence within three
 * interactions, honest verification states, explicit-id relations only,
 * responsive layouts and console health.
 */
test.describe('Replay V3 — one story, three depths', () => {
  test('result-first recap, shared position across depths, story/real time, a11y basics', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-intent').fill('[scenario:edit-basic] replay v3 recap');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // 0) Replay is a secondary Session action. A result claim seeks directly
      //    to the file's material change rather than exposing peer navigation.
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await page.locator('.rp-summary-changed button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      await page.getByTestId('replay-close').click();
      await expect(page.getByTestId('replay-view')).toHaveCount(0);

      // 1) Result-first: session contract + result card, and no autoplay.
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-contract')).toContainText('原始目标');
      await expect(page.getByTestId('replay-outcome')).toContainText('待审阅');
      await expect(page.getByTestId('replay-summary')).toBeVisible();
      await expect(page.getByTestId('replay-play')).toContainText('Replay');
      // edit-basic never ran a verification — the contract must say so.
      await expect(page.getByTestId('replay-contract')).toContainText('未验证');

      // 1b) V3.1 result card: the quoted conclusion (agent's recorded report,
      //     Inferred level), the read-only return line, and the input ledger.
      await expect(page.getByTestId('replay-conclusion')).toBeVisible();
      await expect(page.getByTestId('replay-conclusion')).toContainText('引自最终报告');
      await expect(page.getByTestId('replay-to-room')).toContainText('回放保持只读');
      await expect(page.getByTestId('replay-inputs')).toBeVisible();
      // The conversation is first-class: the user's request renders as a bubble.
      await expect(page.locator('.rp-story-event.message.from-user').first()).toBeVisible();

      // 2) The design taxonomy is gone: no A–E navigation, no % confidence.
      expect(await page.locator('[data-testid^="replay-mode-"]').count()).toBe(0);
      const fullText = (await page.getByTestId('replay-view').textContent()) ?? '';
      expect(fullText).not.toMatch(/\d+%\s*(confidence|置信)/i);

      // 3) A result-card claim reaches its evidence within three interactions:
      //    open replay (1) → click the changed line (2) → evidence drawer (3).
      await page.locator('.rp-summary-changed button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      await expect(page.getByTestId('replay-diff')).toContainText('+  return add(3, 4);');
      await expect(page.getByTestId('replay-evidence-list')).toContainText('change:');
      await expect(page.getByTestId('replay-fact-level')).toContainText('结构化记录');

      // 3b) Evidence-bounded ask: the answer carries validated citations and
      //     an explicit boundary; it never claims hidden reasoning.
      await page.locator('#rp-ask-input').fill('为什么改这个文件？');
      await page.locator('.rp-ask button[type="submit"]').click();
      await expect(page.getByTestId('replay-answer')).toBeVisible();
      await expect(page.getByTestId('replay-answer')).toContainText('引用');
      await expect(page.getByTestId('replay-answer')).toContainText('无法确认');

      // 4) Depth changes keep the selected fact and playhead (one controller).
      const timeBefore = await page.getByTestId('replay-count').textContent();
      await switchReplayDepth(page, 'explore');
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      expect(await page.getByTestId('replay-count').textContent()).toBe(timeBefore);
      await switchReplayDepth(page, 'verify');
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      await expect(page.getByTestId('replay-receipt')).toBeVisible();
      await switchReplayDepth(page, 'recap');

      // 5) Story/Real switch keeps the same fact.
      await page.getByTestId('replay-skip-idle').click();
      await expect(page.getByTestId('replay-skip-idle')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');
      await page.getByTestId('replay-skip-idle').click();
      await expect(page.getByTestId('replay-skip-idle')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('replay-step')).toContainText('Edited src/index.ts');

      // 6) Transport: play/pause, speed, scrubbing.
      await page.getByTestId('replay-play').click();
      await expect(page.getByTestId('replay-play')).toContainText('Pause');
      await page.getByTestId('replay-play').click();
      await page.getByTestId('replay-timeline').locator('select').selectOption('4');
      // Scrub to the very start (Home fires a native input event React sees).
      await page.getByTestId('replay-scrubber').focus();
      await page.keyboard.press('Home');
      await expect(page.getByTestId('replay-count')).toContainText('step 1 /');
      await page.getByTestId('replay-scrubber').blur();

      // 7) Keyboard: arrows step; number keys switch depth; Escape closes.
      await page.keyboard.press('ArrowRight');
      await expect(page.getByTestId('replay-count')).toContainText('step 2 /');
      await page.keyboard.press('ArrowLeft');
      await expect(page.getByTestId('replay-count')).toContainText('step 1 /');
      await page.keyboard.press('2');
      await expect(page.getByTestId('replay-view')).toHaveAttribute('data-depth', 'explore');
      await page.keyboard.press('1');

      // 8) Responsive: 1024 and 390 widths keep controls without page overflow,
      //    and the Verify receipt stays reachable on the narrow layout.
      await app.evaluate(({ BrowserWindow }) => {
        // The product minWidth is 1024; lift it so the mobile layout is testable.
        BrowserWindow.getAllWindows()[0]?.setMinimumSize(320, 480);
      });
      for (const [width, height] of [
        [1024, 768],
        [390, 844],
      ] as const) {
        await app.evaluate(
          ({ BrowserWindow }, size: { width: number; height: number }) => {
            BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
          },
          { width, height },
        );
        await page.waitForTimeout(200);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${width}px width must not overflow horizontally`).toBeLessThanOrEqual(1);
        await expect(page.getByTestId('replay-play')).toBeVisible();
      }
      await switchReplayDepth(page, 'verify');
      await page.getByTestId('replay-receipt').scrollIntoViewIfNeeded();
      await expect(page.getByTestId('replay-receipt')).toBeVisible();

      // Receipt export writes HTML + JSON (E2E skips the native dialog).
      await page.getByTestId('replay-export-receipt').click();
      await expect(page.getByTestId('replay-receipt-exported')).toContainText('.html');
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
      });
      await page.waitForTimeout(150);

      await page.keyboard.press('Escape');
      await expect(page.getByTestId('replay-view')).toHaveCount(0);

      // The Session row replaces the removed Home card; replay stays available
      // from the room's More menu.
      await page.getByTestId('task-room-back').click();
      await page.locator('button[data-testid^="home-task-"]').first().click();
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-summary')).toBeVisible();
      // V3.1: the return line closes the read-only replay back into the room.
      await page.getByTestId('replay-to-room').locator('button').click();
      await expect(page.getByTestId('replay-view')).toHaveCount(0);

      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    } finally {
      await app.close();
    }
  });

  test('verification runs surface honestly: failed run is attention, passed run is Verified', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Replay verification');
      await page.getByTestId('home-verif-custom').fill('node check-agent.mjs');
      await page.getByTestId('home-verif-custom').press('Enter');
      await page.getByTestId('home-intent').fill('[scenario:verify-fail-fix] make the check pass');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 40000,
      });

      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();

      // One failed + one passed run: the session is partially verified, and
      // the failure is an attention line with a citation.
      await expect(page.getByTestId('replay-contract')).toContainText('部分验证');
      await expect(page.getByTestId('replay-summary')).toContainText('Verification failed');

      // The failed verification is never skipped: it is a chapter/mandatory
      // marker and clicking the attention line lands on the verification fact.
      await page.locator('.rp-summary-attention button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('Verification failed');

      // The passed run is the only thing allowed to claim Verified.
      await switchReplayDepth(page, 'explore');
      await page.getByTestId('replay-search').fill('Verification passed');
      await page.getByTestId('replay-event-list').locator('button').first().click();
      await expect(page.getByTestId('replay-fact-level')).toContainText('已验证');

      // The question filter isolates unverified moments without a mode switch.
      await page.getByTestId('replay-search').fill('');
      await page.getByTestId('replay-filters').getByText('哪些尚未验证？').click();
      await expect(page.getByTestId('replay-event-list')).toBeVisible();

      await page.getByTestId('replay-close').click();
    } finally {
      await app.close();
    }
  });

  test('a 10k-event ledger stays searchable and scrubbable without blocking the renderer', async () => {
    test.setTimeout(180_000);
    const fixture = createTsSmallFixture();
    // Pass 1: record a real task, then close the app so the ledger is free.
    const first = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    const userDataDir = first.userDataDir;
    try {
      await first.page.getByTestId('surface-home').click();
      await expect(first.page.getByTestId('home-model')).toContainText(/mock/i);
      await first.page.getByTestId('home-mode-auto').click();
      await first.page.getByTestId('home-intent').fill('[scenario:edit-basic] ten thousand events');
      await first.page.getByTestId('home-submit').click();
      await expect(first.page.getByTestId('task-state')).toHaveAttribute(
        'data-state',
        'REVIEW_READY',
        { timeout: 30000 },
      );
    } finally {
      await first.app.close();
    }

    // Grow the same immutable ledger to >10k rows (no second replay store —
    // these are ordinary task_events the projection must absorb).
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => {
        prepare(sql: string): {
          get(...args: unknown[]): Record<string, unknown> | undefined;
          run(...args: unknown[]): unknown;
        };
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new DatabaseSync(join(userDataDir, 'app.db'));
    try {
      const task = db.prepare('SELECT id FROM tasks ORDER BY created_at DESC LIMIT 1').get() as {
        id: string;
      };
      const seqRow = db
        .prepare('SELECT MAX(sequence) AS latest FROM task_events WHERE task_id = ?')
        .get(task.id) as { latest: number };
      const insert = db.prepare(
        'INSERT INTO task_events (id, task_id, sequence, type, schema_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const baseMs = Date.now();
      db.exec('BEGIN');
      for (let i = 1; i <= 10_000; i += 1) {
        const sequence = seqRow.latest + i;
        const at = new Date(baseMs + i * 1000).toISOString();
        if (i % 500 === 0) {
          insert.run(
            `bulk-evt-${i}`,
            task.id,
            sequence,
            'agent.message',
            1,
            JSON.stringify({ text: `bulk checkpoint needle-${i}` }),
            at,
          );
        } else {
          insert.run(
            `bulk-evt-${i}`,
            task.id,
            sequence,
            'tool.call',
            1,
            JSON.stringify({
              callId: `bulk-call-${i}`,
              name: 'read_file',
              state: 'SUCCEEDED',
              ok: true,
              input: { path: `src/bulk-${i % 40}.ts` },
            }),
            at,
          );
        }
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    // Pass 2: the projection absorbs the 10k ledger; search + scrub stay live.
    const second = await launchApp({
      userDataDir,
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      const { page } = second;
      await page.getByTestId('surface-home').click();
      await page.locator('button[data-testid^="home-task-"]').first().click();
      // A REVIEW_READY card may open straight into the review overlay.
      if (
        await page
          .getByTestId('review-view')
          .isVisible()
          .catch(() => false)
      ) {
        await page.getByTestId('review-close').click();
      }
      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();
      await expect(page.getByTestId('replay-count')).toContainText('/ 10', { timeout: 30000 });

      // V3.1: a 10k ledger folds into placeholders, never silent holes — the
      // fold row counts what it hides and expands to samples.
      const fold = page.getByTestId('replay-fold').first();
      await expect(fold).toBeVisible();
      await expect(fold).toContainText('折叠了');
      await fold.locator('summary').click();
      await expect(fold.locator('.rp-fold-sample button').first()).toBeVisible();

      // Search narrows 10k facts to the seeded needles without freezing.
      await switchReplayDepth(page, 'explore');
      const searchStarted = Date.now();
      await page.getByTestId('replay-search').fill('needle-5000');
      await expect(page.getByTestId('replay-event-list').locator('button')).toHaveCount(1, {
        timeout: 10000,
      });
      expect(Date.now() - searchStarted).toBeLessThan(10_000);
      await page.getByTestId('replay-event-list').locator('button').first().click();
      await expect(page.getByTestId('replay-step')).toContainText('needle-5000');

      // Scrubbing across the full run keeps responding.
      await page.getByTestId('replay-search').fill('');
      await page.getByTestId('replay-scrubber').focus();
      await page.keyboard.press('Home');
      await expect(page.getByTestId('replay-count')).toContainText('step 1 /');
      await page.keyboard.press('End');
      await expect(page.getByTestId('replay-count')).not.toContainText('step 1 /');
      await page.getByTestId('replay-close').click();
    } finally {
      await second.app.close();
    }
  });

  test('a recorded plan revision surfaces as a pivot card with id-backed grounds', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i, { timeout: 15000 });
      await page.getByTestId('home-intent').fill('[scenario:plan-request-changes] revise me');
      await page.getByTestId('home-submit').click();

      // Drive the recorded revision: feedback on plan v1 → revised v2 → approve.
      await expect(page.getByTestId('plan-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('agent-input').fill('please add a verification step');
      await page.getByTestId('agent-send').click();
      await expect(page.getByTestId('plan-card')).toContainText('Revised', { timeout: 20000 });
      await page.getByTestId('plan-approve').click();
      await page.getByTestId('perm-allow-task').click({ timeout: 20000 });
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();

      // The second proposal is a pivot: card in the story, chapter on the axis.
      const pivot = page.getByTestId('replay-pivot').first();
      await pivot.scrollIntoViewIfNeeded();
      await expect(pivot).toBeVisible();
      await expect(pivot).toContainText('转折');
      await expect(pivot).toContainText('推导叙事');
      // The revision's recorded prose (plan summary) is quoted, not invented.
      await expect(pivot).toContainText('Revised');
      await expect(
        page.getByTestId('replay-timeline').locator('[data-category="pivot"]'),
      ).toHaveCount(1);

      // Its grounds are clickable, id-backed references.
      const refs = pivot.locator('.rp-pivot-refs button');
      await expect(refs.first()).toBeVisible();
      await refs.first().click();
      await expect(page.getByTestId('replay-detail-layer')).toBeVisible();

      await page.keyboard.press('Escape');
    } finally {
      await app.close();
    }
  });

  test('approvals carry recorded risk and id-backed relations; no adjacency edges', async () => {
    const fixture = createTsSmallFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, PI_IDE_FORCE_MOCK: '1' },
    });
    try {
      page.on('dialog', (dialog) => void dialog.accept());
      await page.getByTestId('surface-home').click();
      await expect(page.getByTestId('home-model')).toContainText(/mock/i);
      await page.getByTestId('home-mode-auto').click();
      await page.getByTestId('home-advanced-toggle').click();
      await page.getByTestId('home-adv-title').fill('Replay approvals');
      await page.getByTestId('home-intent').fill('[scenario:edit-rollback] touch everything');
      await page.getByTestId('home-submit').click();

      // delete_file is R3 — approve it, then let the run finish.
      await expect(page.getByTestId('perm-card')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('perm-allow-once').click();
      await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'REVIEW_READY', {
        timeout: 30000,
      });

      // Approval entry: the resolved permission card links straight into
      // Verify at that approval's fact.
      await page.locator('[data-testid^="tl-verify-replay-"]').first().click();
      await expect(page.getByTestId('replay-view')).toHaveAttribute('data-depth', 'verify');
      await expect(page.getByTestId('replay-step')).toContainText('Waiting for approval');
      await page.getByTestId('replay-close').click();

      await page.getByTestId('session-more').click();
      await page.getByTestId('replay-open').click();
      await expect(page.getByTestId('replay-view')).toBeVisible();

      // Explore → approvals question filter → the decided approval.
      await switchReplayDepth(page, 'explore');
      await page.getByTestId('replay-filters').getByText('哪些需要审批？').click();
      await page
        .getByTestId('replay-event-list')
        .locator('button', { hasText: 'Approved' })
        .first()
        .click();

      // The approval renderer shows the recorded disposition, and the drawer
      // shows the explicit requested-by relation (recorded requestId/callId).
      await expect(page.getByTestId('replay-step')).toContainText('已批准');
      await expect(page.getByTestId('replay-evidence-drawer')).toContainText('明确关系');
      await expect(page.getByTestId('replay-evidence-drawer')).toContainText('requested-by');

      // Plain tool facts carry no relations — adjacency creates no edges.
      await page
        .getByTestId('replay-filters')
        .getByRole('button', { name: '全部', exact: true })
        .click();
      await page.getByTestId('replay-search').fill('Read src/index.ts');
      const row = page.getByTestId('replay-event-list').locator('button').first();
      if (await row.isVisible().catch(() => false)) {
        await row.click();
        await expect(page.getByTestId('replay-evidence-drawer')).not.toContainText('明确关系');
      }

      await page.getByTestId('replay-close').click();
    } finally {
      await app.close();
    }
  });
});
