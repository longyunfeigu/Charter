import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './helpers/launch';

interface ProbeRecord {
  protocol: 'anthropic' | 'openai';
  model: string;
  maxTokens: number | null;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('model fixture did not bind TCP');
  return address.port;
}

test('Fetch & verify probes provider and Pi registry candidates, then exposes only successes', async () => {
  const probes: ProbeRecord[] = [];
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/v1/models') {
      response.end(
        JSON.stringify({
          data: [
            {
              id: 'claude-haiku-4-5-20251001',
              display_name: 'Claude Haiku 4.5 verified',
            },
            {
              id: 'claude-opus-4-20250514',
              display_name: 'Claude Opus 4 advertised but unavailable',
            },
            { id: 'gpt-5.4', display_name: 'GPT-5.4 advertised but unavailable' },
          ],
        }),
      );
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/messages') {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw) as { model?: string; max_tokens?: number };
        probes.push({
          protocol: 'anthropic',
          model: body.model ?? '',
          maxTokens: body.max_tokens ?? null,
        });
        // Keep the request in flight long enough to assert the real busy UI.
        setTimeout(() => {
          if (body.model === 'claude-haiku-4-5-20251001' || body.model === 'claude-sonnet-5') {
            response.end(
              JSON.stringify({
                type: 'message',
                content: [{ type: 'text', text: '1' }],
                stop_reason: 'max_tokens',
              }),
            );
          } else {
            response.statusCode = 500;
            response.end(
              JSON.stringify({
                type: 'error',
                error: { type: 'model_unavailable', message: 'no account supports this model' },
              }),
            );
          }
        }, 250);
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/chat/completions') {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        const body = JSON.parse(raw) as {
          model?: string;
          max_completion_tokens?: number;
          stream?: boolean;
        };
        probes.push({
          protocol: 'openai',
          model: body.model ?? '',
          maxTokens: body.max_completion_tokens ?? null,
        });
        setTimeout(() => {
          if (body.model === 'gpt-5.6-sol' && body.stream === true) {
            response.end(
              JSON.stringify({
                id: 'chatcmpl-verified',
                choices: [{ delta: { content: '1' }, finish_reason: 'stop' }],
              }),
            );
          } else {
            response.statusCode = 500;
            response.end(
              JSON.stringify({
                error: { message: 'no account supports this model over OpenAI chat' },
              }),
            );
          }
        }, 250);
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });

  const port = await listen(server);
  let launched: LaunchedApp | null = null;
  try {
    launched = await launchApp({ home: 'keep' });
    const { app, page, userDataDir } = launched;
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await page.getByTestId('provider-key-input').fill('sk-model-verification-e2e');
    await page.getByTestId('provider-baseurl-input').fill(`http://127.0.0.1:${port}/api`);
    await page.getByTestId('provider-key-save').click();
    await expect(page.getByTestId('provider-row-anthropic')).toBeVisible();

    const verify = page.getByTestId('provider-fetch-anthropic');
    await expect(verify).toHaveText('Fetch & verify');
    await verify.click();
    await expect(verify).toHaveText('Verifying…');
    await expect(verify).toHaveText('Fetch & verify', { timeout: 120_000 });
    await expect(
      page.locator('.toast').filter({ hasText: /3\/\d+ models verified for anthropic/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.toast').filter({ hasText: '2 protocol routes' })).toBeVisible();
    await expect(page.locator('.toast').filter({ hasText: '3 advertised' })).toBeVisible();
    await expect(
      page.locator('.toast').filter({ hasText: 'Pi registry candidates' }),
    ).toBeVisible();
    expect(probes).toEqual(
      expect.arrayContaining([
        { protocol: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 1 },
        { protocol: 'anthropic', model: 'claude-sonnet-5', maxTokens: 1 },
        { protocol: 'anthropic', model: 'claude-opus-4-20250514', maxTokens: 1 },
        { protocol: 'openai', model: 'gpt-5.4', maxTokens: 16 },
        { protocol: 'openai', model: 'gpt-5.6-sol', maxTokens: 16 },
      ]),
    );
    expect(probes.length).toBeGreaterThan(5);
    expect(new Set(probes.map((probe) => `${probe.protocol}:${probe.model}`)).size).toBe(
      probes.length,
    );
    expect(
      probes
        .filter((probe) => probe.model.startsWith('gpt-'))
        .every((probe) => probe.protocol === 'openai'),
    ).toBe(true);
    expect(
      probes
        .filter((probe) => probe.model.startsWith('claude-'))
        .every((probe) => probe.protocol === 'anthropic'),
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('home-view')).toBeVisible();
    await page.getByTestId('home-model').click();
    await expect(
      page.getByTestId('home-model-opt-anthropic::claude-haiku-4-5-20251001'),
    ).toBeVisible();
    await expect(page.getByTestId('home-model-opt-anthropic::claude-sonnet-5')).toBeVisible();
    await expect(page.getByTestId('home-model-opt-anthropic__openai::gpt-5.6-sol')).toBeVisible();
    await expect(page.getByTestId('home-model-opt-anthropic__openai::gpt-5.4')).toHaveCount(0);
    await expect(page.getByTestId('home-model-opt-anthropic::claude-opus-4-20250514')).toHaveCount(
      0,
    );
    await expect(page.getByTestId('home-model-opt-anthropic::claude-opus-4-8')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 980, height: 760 });
    });
    await page.getByTestId('home-settings').click();
    await page.getByText('Models', { exact: true }).click();
    await expect(page.getByTestId('provider-fetch-anthropic')).toBeVisible();
    await page.screenshot({ path: '/tmp/charter-model-verification-narrow.png', fullPage: true });
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(pageErrors).toEqual([]);

    await app.close();
    launched = null;
    const probesBeforeRestart = probes.length;
    launched = await launchApp({ home: 'keep', userDataDir });
    await expect(launched.page.getByTestId('home-model')).toContainText('Claude Haiku 4.5', {
      timeout: 15_000,
    });
    await launched.page.getByTestId('home-model').click();
    await expect(
      launched.page.getByTestId('home-model-opt-anthropic::claude-sonnet-5'),
    ).toBeVisible();
    await expect(
      launched.page.getByTestId('home-model-opt-anthropic__openai::gpt-5.6-sol'),
    ).toBeVisible();
    expect(probes).toHaveLength(probesBeforeRestart);
  } finally {
    await launched?.app.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
