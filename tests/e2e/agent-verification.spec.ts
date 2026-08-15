import { expect, test } from '@playwright/test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'charter-verification-e2e-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const executable = join(bin, 'gemini');
  writeFileSync(
    executable,
    [
      '#!/usr/bin/env node',
      "let pending = '';",
      'const answer = text => {',
      '  const challenge = text.match(/Challenge: ([a-z0-9]+)/i)?.[1];',
      '  if (!challenge) return;',
      "  process.stdout.write('esc to cancel\\r\\n');",
      '  setTimeout(() => {',
      "    process.stdout.write('CHARTER_AGENT_REPLY_' + [...challenge].reverse().join('') + '\\r\\nGemini CLI\\r\\n');",
      '  }, 1800);',
      '};',
      "process.stdout.write('\\x1b[?2004hGemini CLI\\r\\n');",
      "answer(process.argv.join(' '));",
      'process.stdin.setRawMode?.(true);',
      "process.stdin.on('data', chunk => { pending += chunk.toString('utf8'); answer(pending); pending = ''; });",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 120000);',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
  return { home, bin };
}

test('self-verifies a real visible Agent challenge, image path, and privacy-safe report', async () => {
  test.setTimeout(90_000);
  const cli = fixture();
  const project = createGitFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'charter-verification-user-'));
  const { app, page } = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: project,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_AGENT_HOME: cli.home,
      PATH: `${cli.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    await page.getByTestId('home-settings').click();
    await page.getByTestId('settings-section-agent').click();
    const center = page.getByTestId('agent-verification-center');
    await expect(center).toBeVisible();
    await center.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/charter-agent-verification-desktop.png' });
    await page.setViewportSize({ width: 900, height: 720 });
    await center.scrollIntoViewIfNeeded();
    const narrowBox = await center.boundingBox();
    expect(narrowBox).not.toBeNull();
    expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(900);
    await page.screenshot({ path: '/tmp/charter-agent-verification-narrow.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await center.scrollIntoViewIfNeeded();
    const gemini = page.getByTestId('agent-verification-gemini');
    await expect(gemini).toContainText('Integration tested');
    await expect(gemini).toContainText('Not run');

    await page.getByTestId('agent-verification-run-gemini').click();
    await expect(gemini).toContainText('Live check passed', { timeout: 25_000 });
    await expect(gemini).toContainText('Locally verified');
    await gemini.scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/charter-agent-verification-passed.png' });

    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await app.evaluate(({ clipboard, nativeImage }, data) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, 'base64')));
    }, pngBase64);
    await page.getByTestId('agent-verification-image-gemini').click();
    await expect(gemini).toContainText('Image passed', { timeout: 20_000 });

    await page.getByTestId('agent-verification-export').click();
    await expect
      .poll(() =>
        readdirSync(userDataDir).find((name) => name.startsWith('charter-agent-compatibility-')),
      )
      .toBeTruthy();
    const markdown = readdirSync(userDataDir).find((name) => name.endsWith('.md'));
    const json = readdirSync(userDataDir).find(
      (name) => name.endsWith('.json') && name.startsWith('charter-agent-compatibility-'),
    );
    expect(markdown).toBeTruthy();
    expect(json).toBeTruthy();
    const report = `${readFileSync(join(userDataDir, markdown!), 'utf8')}\n${readFileSync(join(userDataDir, json!), 'utf8')}`;
    expect(report).toContain('locally_verified');
    expect(report).not.toContain('Charter compatibility check');
    expect(report).not.toContain(project);
    expect(report).not.toContain(executablePath(cli.bin));
    expect(existsSync(join(userDataDir, 'agent-packs', 'verification-results.json'))).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

function executablePath(bin: string): string {
  return join(bin, 'gemini');
}
