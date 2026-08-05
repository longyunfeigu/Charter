import { expect, test } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { createTsSmallFixture } from './helpers/fixtures';

/**
 * TEMPORARY manual verification (not part of the suite): drives the REAL pi
 * runtime against the user's gateway. Requires CHARTER_TEST_KEY and
 * CHARTER_TEST_BASEURL in the environment; skips otherwise.
 */
const KEY = process.env.CHARTER_TEST_KEY ?? '';
const BASEURL = process.env.CHARTER_TEST_BASEURL ?? '';
const CLAUDE_MODEL = process.env.CHARTER_TEST_MODEL ?? 'claude-haiku-4-5-20251001';
const GPT_MODEL = process.env.CHARTER_TEST_GPT_MODEL ?? 'gpt-5.6-sol';
const OPENAI_ROUTE = 'anthropic__openai';

test('real mixed gateway: one credential verifies and runs Claude + GPT Charter sessions', async () => {
  test.skip(!KEY || !BASEURL, 'no real credentials in env');
  test.setTimeout(480000);
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture },
  });
  try {
    // 1) Configure the provider with key + base URL in Settings → Models.
    await page.getByTestId('home-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await page.getByTestId('provider-key-input').fill(KEY);
    await page.getByTestId('provider-baseurl-input').fill(BASEURL);
    await page.getByTestId('provider-key-save').click();
    await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();
    await expect(page.getByTestId('provider-baseurl-anthropic')).toContainText(
      BASEURL.replace(/\/+$/, ''),
    );

    // 2) Live model list through the gateway.
    await page.getByTestId('provider-fetch-anthropic').click();
    await expect(page.locator('.toast').filter({ hasText: 'models verified' })).toBeVisible({
      timeout: 180000,
    });
    await page.screenshot({ path: '/tmp/ui-shots/real-1-settings.png' });
    await page.keyboard.press('Escape');

    // 3) Pick the real model on Home and run a real ask task.
    await page.getByTestId('surface-home').click();
    const model = page.getByTestId('home-model');
    await expect(model).toBeVisible();
    await model.click();
    const claudeOption = page.getByTestId(`home-model-opt-anthropic::${CLAUDE_MODEL}`);
    const gptOption = page.getByTestId(`home-model-opt-${OPENAI_ROUTE}::${GPT_MODEL}`);
    await expect(claudeOption).toBeVisible();
    await expect(gptOption).toBeVisible();
    await gptOption.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/ui-shots/real-2-model-picker-gpt.png' });
    await claudeOption.click();
    await page.getByTestId('home-mode-ask').click();
    await page
      .getByTestId('home-intent')
      .fill('Reply with exactly the word PONG and nothing else. Do not use any tools.');
    await page.getByTestId('home-submit').click();

    // 4) The Task Room shows the real provider/model and the real answer.
    await expect(page.getByTestId('task-room')).toBeVisible();
    await expect(page.getByTestId('reply-model')).toHaveAttribute(
      'data-model-key',
      `anthropic::${CLAUDE_MODEL}`,
    );
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 180000,
    });
    await expect(page.getByTestId('tl-agent').last()).toContainText('PONG');
    // Zero-change ask task → light completion (PIVOT-031).
    await expect(page.getByTestId('tl-answered')).toHaveCount(0);
    await expect(page.getByTestId('tl-run-details')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/ui-shots/real-3-claude-task-room.png' });

    // 5) Identity (PIVOT-008/ADR-0009): the preamble now reaches the model —
    // the agent introduces itself as Charter's agent, not as internal tooling.
    await page.getByTestId('agent-input').fill('Who are you? One sentence.');
    await page.getByTestId('agent-send').click();
    const reply = page.getByTestId('tl-agent').last();
    await expect(reply).toContainText(/Charter/i, { timeout: 180000 });
    await expect(reply).not.toContainText(/Claude Code/i);
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 60000,
    });
    await page.screenshot({ path: '/tmp/ui-shots/real-4-claude-identity.png' });

    // 6) The same stored credential also drives a real GPT session through
    // the derived OpenAI-compatible streaming route.
    await page.getByTestId('surface-home').click();
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-model').click();
    await page.getByTestId(`home-model-opt-${OPENAI_ROUTE}::${GPT_MODEL}`).dispatchEvent('click');
    await page.getByTestId('home-mode-ask').click();
    await page
      .getByTestId('home-intent')
      .fill('Reply with exactly GPT_PONG and nothing else. Do not use any tools.');
    await page.getByTestId('home-submit').click();

    await expect(page.getByTestId('task-room')).toBeVisible();
    await expect(page.getByTestId('reply-model')).toHaveAttribute(
      'data-model-key',
      `${OPENAI_ROUTE}::${GPT_MODEL}`,
    );
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 180000,
    });
    await expect(page.getByTestId('tl-agent').last()).toContainText('GPT_PONG');
    await expect(page.getByTestId('tl-answered')).toHaveCount(0);
    await expect(page.getByTestId('tl-run-details')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/ui-shots/real-5-gpt-session.png' });
  } finally {
    await app.close();
  }
});

test('real gateway: LiteLLM preset over the OpenAI-compatible surface (PIVOT-033)', async () => {
  test.skip(!KEY || !BASEURL, 'no real credentials in env');
  test.setTimeout(480000);
  const openAiBase = `${BASEURL.replace(/\/+$/, '')}/v1`;
  const fixture = createTsSmallFixture();
  const { app, page } = await launchApp({
    env: { PI_IDE_OPEN_WORKSPACE: fixture },
  });
  try {
    // Configure the SAME gateway as an OpenAI-compatible LiteLLM provider.
    await page.getByTestId('home-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await page.getByTestId('provider-select').selectOption('litellm');
    await page.getByTestId('provider-key-input').fill(KEY);
    await page.getByTestId('provider-baseurl-input').fill(openAiBase);
    await page.getByTestId('provider-key-save').click();
    await expect(page.getByTestId('provider-row-litellm')).toBeVisible();
    await expect(page.getByTestId('provider-api-litellm')).toContainText('OpenAI API');

    // Live model list over GET <base>/models with Bearer auth — real network.
    await page.getByTestId('provider-fetch-litellm').click();
    await expect(page.locator('.toast').filter({ hasText: 'models verified' })).toBeVisible({
      timeout: 180000,
    });
    await page.keyboard.press('Escape');

    // Run a REAL task through the synthesized openai-completions provider.
    await page.getByTestId('surface-home').click();
    const model = page.getByTestId('home-model');
    await expect(model).toBeVisible();
    await model.click();
    await page.getByTestId(`home-model-opt-litellm::${CLAUDE_MODEL}`).click();
    await page.getByTestId('home-mode-ask').click();
    await page
      .getByTestId('home-intent')
      .fill('Reply with exactly the word PONG and nothing else. Do not use any tools.');
    await page.getByTestId('home-submit').click();

    await expect(page.getByTestId('task-room')).toBeVisible();
    await expect(page.getByTestId('reply-model')).toHaveAttribute(
      'data-model-key',
      `litellm::${CLAUDE_MODEL}`,
    );
    await expect(page.getByTestId('task-state')).toHaveAttribute('data-state', 'IDLE', {
      timeout: 180000,
    });
    await expect(page.getByTestId('tl-agent').last()).toContainText('PONG');
    await expect(page.getByTestId('tl-answered')).toHaveCount(0);
    await expect(page.getByTestId('tl-run-details')).toHaveCount(0);
    await page.screenshot({ path: '/tmp/ui-shots/real-4-litellm.png' });
  } finally {
    await app.close();
  }
});
