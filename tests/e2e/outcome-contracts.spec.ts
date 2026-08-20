import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';

function runtimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function createWork(
  page: Page,
  input: {
    title: string;
    typeId: string;
    description: string;
    sourcePerson: string;
    acceptance?: string;
    custom: Record<string, string>;
  },
): Promise<void> {
  await page.getByTestId('work-new-item').click();
  await page.getByTestId('work-title').fill(input.title);
  await page.getByTestId('work-type').click();
  await page.getByTestId(`work-type-option-${input.typeId}`).click();
  await page.getByTestId('work-description').fill(input.description);
  await page.getByTestId('work-source-person').fill(input.sourcePerson);
  if (input.acceptance) {
    await page.getByTestId('work-acceptance-add').click();
    await page.getByTestId('work-acceptance-line-0').fill(input.acceptance);
  }
  for (const [key, value] of Object.entries(input.custom)) {
    await page.getByTestId(`work-custom-${key}`).fill(value);
  }
  await page.getByTestId('work-page-back').click();
  await expect(page.getByTestId('work-detail-title')).toHaveText(input.title);
  await expect(page.getByTestId('outcome-contract-panel')).toBeVisible();
}

async function applyPackAndResolve(page: Page, pack: 'product' | 'finance'): Promise<Locator> {
  const panel = page.getByTestId('outcome-contract-panel');
  await panel.getByTestId('outcome-pack-select').selectOption(pack);
  await panel.getByTestId('outcome-apply-pack').click();
  const questions = panel.getByRole('button', { name: 'Mark question resolved' });
  await expect(questions.first()).toBeVisible();
  while ((await questions.count()) > 0) await questions.first().click();
  return panel;
}

async function recordPass(form: Locator, prefix: string): Promise<void> {
  await form.getByLabel('Observed result').fill(`${prefix} was observed against the contract.`);
  await form.getByLabel('Review note').fill(`${prefix} evidence is complete and in scope.`);
  const labels = form.getByLabel('Evidence label');
  const references = form.getByLabel('Evidence reference');
  const summaries = form.getByLabel('Evidence summary');
  for (let index = 0; index < (await labels.count()); index += 1) {
    await labels.nth(index).fill(`${prefix} evidence ${index + 1}`);
    await references
      .nth(index)
      .fill(`fixture://${prefix.toLowerCase().replaceAll(' ', '-')}/${index + 1}`);
    await summaries.nth(index).fill(`${prefix} supporting observation ${index + 1}.`);
  }
  await form.getByRole('button', { name: 'Record review' }).click();
}

test.describe('Generic Outcome Contracts', () => {
  test('supports product exceptions and independently verified finance acceptance across restart', async () => {
    const launched = await launchApp({ home: 'keep' });
    const { app, page, userDataDir } = launched;
    const errors = runtimeErrors(page);
    try {
      await page.getByTestId('rail-view-work').click();
      await createWork(page, {
        title: 'Approve self-serve onboarding for the September pilot',
        typeId: 'work-type-product',
        description:
          'A first-time operations lead can create a workspace, invite a teammate, and understand recovery states.',
        sourcePerson: 'Mina · Product',
        acceptance: 'The product owner confirms the pilot audience can complete onboarding.',
        custom: {
          user_problem: 'New operations leads do not know whether setup is complete.',
          target_users: 'First-time operations leads',
          success_metric: '80% complete the core journey without support',
        },
      });
      let panel = await applyPackAndResolve(page, 'product');
      await panel.getByTestId('outcome-approver').fill('Mina · Product');
      await panel.getByTestId('outcome-freeze').click();
      await expect(panel.getByTestId('outcome-contract-frozen')).toBeVisible();
      await expect(panel).toContainText('Verified · Ready to verify');

      const productReviews = panel.locator('.outcome-review-form');
      await expect(productReviews).toHaveCount(2);
      await recordPass(productReviews.nth(0), 'Pilot owner criterion');
      await recordPass(productReviews.nth(1), 'Release quality criterion');
      await expect(panel).toContainText('2/4');
      await expect(panel).toContainText('Verified · Ready to verify');

      await panel
        .getByLabel('Decision rationale')
        .fill('Pilot accepted with Agent journey verification scheduled before general release.');
      await panel.locator('.outcome-override input').check();
      await panel.getByTestId('outcome-accept').click();
      await expect(panel).toContainText('Accepted · accepted');
      await expect(panel).toContainText('Verified · Ready to verify');

      await page.getByTestId('work-detail-close').click();
      await createWork(page, {
        title: 'Reconcile August marketplace settlement',
        typeId: 'work-type-finance',
        description:
          'Reconcile the August marketplace settlement to the bank and ERP before close.',
        sourcePerson: 'Alex · Finance operations',
        custom: {
          entity: 'Charter Labs Ltd.',
          period: '2026-08',
          currency: 'USD',
          source_of_truth: 'ERP settlement ledger + bank statement',
          tolerance: '0.01',
          performer: 'Alex · Finance operations',
          approval_owner: 'Priya · Controller',
        },
      });
      panel = await applyPackAndResolve(page, 'finance');
      await panel
        .getByPlaceholder('ERP ledger, signed receipt, policy owner…')
        .fill('ERP settlement ledger and signed August bank statement');
      await panel.getByTestId('outcome-freeze').click();
      await expect(panel.getByTestId('outcome-contract-frozen')).toBeVisible();

      const financeReviews = panel.locator('.outcome-review-form');
      await expect(financeReviews).toHaveCount(4);
      for (let index = 0; index < 4; index += 1) {
        await recordPass(financeReviews.nth(index), `Finance control ${index + 1}`);
      }
      await expect(panel).toContainText('4/4');
      await expect(panel).toContainText('Verified · Verified');
      await expect(panel.getByTestId('outcome-accept')).toHaveText('Accept result');
      await panel
        .getByLabel('Decision rationale')
        .fill(
          'Controller reviewed the reconciliation, exceptions, traceability, and segregation of duties.',
        );
      await panel.getByTestId('outcome-accept').click();
      await expect(panel).toContainText('Accepted · accepted');

      await page.setViewportSize({ width: 900, height: 760 });
      await expect(panel).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.screenshot({ path: '/tmp/charter-outcome-contract-finance.png' });
      await expect(page.locator('#webpack-dev-server-client-overlay')).toHaveCount(0);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app.close();
    }

    const restarted = await launchApp({ userDataDir, home: 'keep' });
    const restartErrors = runtimeErrors(restarted.page);
    try {
      await restarted.page.getByTestId('rail-view-work').click();
      await restarted.page
        .locator('.work-card')
        .filter({ hasText: 'Reconcile August marketplace settlement' })
        .click();
      const panel = restarted.page.getByTestId('outcome-contract-panel');
      await expect(panel.getByTestId('outcome-contract-frozen')).toBeVisible();
      await expect(panel).toContainText('Verified · Verified');
      await expect(panel).toContainText('Accepted · accepted');
      await expect(panel.locator('.outcome-ledger').first()).toContainText('Evidence ledger · 5');
      expect(restartErrors).toEqual([]);
    } finally {
      await restarted.app.close();
    }
  });
});
