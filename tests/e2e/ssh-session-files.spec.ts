import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { MemFs, startFakeSshServer, type FakeSshServer } from './helpers/ssh-server';

/**
 * ADR-0059 remote session file transfer against the loopback ssh2 server:
 * the injected cwd hook lights the LIVE chip, the Files drawer follows the
 * terminal's cd (pinnable, with catch-up), uploads round-trip real bytes into
 * the fake SFTP filesystem, and the completion toast pastes the remote path
 * back into the shell without pressing Enter.
 */

const osc7 = (path: string): string => `\u001b]7;file://fake${path}\u001b\\`;

async function addHost(page: Page, port: number): Promise<void> {
  await page.getByTestId('rail-view-remotes').click();
  await expect(page.getByTestId('remotes-view')).toBeVisible();
  await page.getByRole('button', { name: 'New Host' }).first().click();
  await expect(page.getByTestId('rm-dialog')).toBeVisible();
  await page.getByTestId('rm-field-label').fill('e2e-host');
  await page.getByTestId('rm-field-host').fill('127.0.0.1');
  await page.getByTestId('rm-field-port').fill(String(port));
  await page.getByTestId('rm-field-username').fill('tester');
  await page.getByTestId('rm-auth-password').click();
  await page.getByTestId('rm-field-password').fill('e2e-password');
  await page.getByTestId('rm-dialog-submit').click();
  await expect(page.getByTestId('rm-dialog')).toBeHidden();
}

test.describe('Remote session file transfer (ADR-0059)', () => {
  let sshd: FakeSshServer;

  test.beforeEach(async () => {
    const fs = new MemFs('/home/tester');
    fs.writeFile('/home/tester/readme.txt', 'hello from the fake server');
    fs.mkdirp('/home/tester/docs');
    fs.writeFile('/home/tester/docs/orbit.html', '<title>Remote orbit</title>\n');
    sshd = await startFakeSshServer({
      password: 'e2e-password',
      fs,
      // Answer the app's injected __charter_cwd hook like a real shell would.
      cwdReport: '/home/tester',
    });
  });
  test.afterEach(async () => {
    await sshd.close();
  });

  test('E2E: live cwd chip, follow/pin drawer, upload, and paste-path round-trip', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'charter-e2e-rfl-'));
    writeFileSync(join(scratch, 'up-e2e.txt'), 'dropped payload');
    const { app, page } = await launchApp();
    try {
      await addHost(page, sshd.port);
      await page.getByTestId('rm-connect-e2e-host').click();
      await expect(page.getByTestId('ssh-hostkey-modal')).toBeVisible();
      await page.getByTestId('ssh-hostkey-accept').click();
      const authModal = page.getByTestId('ssh-auth-modal');
      if (await authModal.isVisible({ timeout: 3000 }).catch(() => false)) {
        await page.getByTestId('ssh-auth-input-0').fill('e2e-password');
        await page.getByTestId('ssh-auth-submit').click();
      }
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });

      // The injected hook was answered with OSC 7 → the context chip is live.
      const chip = page.getByTestId('tsb-cwd').first();
      await expect(chip).toContainText('LIVE', { timeout: 15000 });

      // The Files drawer opens at the live cwd and lists the remote home.
      await page.getByTestId('session-files').click();
      const drawer = page.getByTestId('remote-files-drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText('readme.txt', { timeout: 15000 });

      // Terminal cd (a fresh OSC 7 report) → chip and drawer follow.
      sshd.writeToLatestShell(osc7('/home/tester/docs'));
      await expect(chip).toContainText('docs', { timeout: 10000 });
      await expect(drawer).toContainText('orbit.html', { timeout: 10000 });

      // Pin, cd elsewhere → the drawer stays put and offers one-click catch-up.
      await page.getByTestId('drawer-follow-toggle').click();
      sshd.writeToLatestShell(osc7('/home/tester'));
      await expect(page.getByTestId('drawer-catch-up')).toBeVisible({ timeout: 10000 });
      await expect(drawer).toContainText('orbit.html');
      await page.getByTestId('drawer-catch-up').click();
      await expect(drawer).toContainText('readme.txt', { timeout: 10000 });

      // Upload through the drawer picker: the completion toast appears and the
      // bytes really land in the fake server's filesystem.
      await drawer.locator('input[type=file]').setInputFiles(join(scratch, 'up-e2e.txt'));
      const toast = page.getByTestId('remote-upload-toast');
      await expect(toast).toBeVisible({ timeout: 15000 });
      await expect
        .poll(() => sshd.fs.nodes.get('/home/tester/up-e2e.txt')?.data.toString('utf8'), {
          timeout: 15000,
        })
        .toBe('dropped payload');
      await expect(drawer).toContainText('up-e2e.txt', { timeout: 10000 });

      // "Paste remote path" types the uploaded path into the real SSH channel
      // (bracketed paste, no Enter) — assert it arrived at the fake shell.
      await page.getByTestId('toast-insert-path').click();
      await expect
        .poll(() => sshd.shellInput.some((chunk) => chunk.includes('/home/tester/up-e2e.txt')), {
          timeout: 10000,
        })
        .toBe(true);

      // Dragging OS files over the session raises the veil naming the live
      // target directory; leaving dismisses it without uploading anything.
      const dataTransfer = await page.evaluateHandle(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['probe'], 'veil-probe.txt', { type: 'text/plain' }));
        return dt;
      });
      await page.dispatchEvent('[data-testid="session-terminal-view"]', 'dragenter', {
        dataTransfer,
      });
      const veil = page.getByTestId('remote-drop-veil');
      await expect(veil).toBeVisible();
      await expect(veil).toContainText('Target directory');
      await expect(veil).toContainText('LIVE');
      await page.dispatchEvent('[data-testid="session-terminal-view"]', 'dragleave', {
        dataTransfer,
      });
      await expect(veil).toBeHidden();
      expect(sshd.fs.nodes.has('/home/tester/veil-probe.txt')).toBe(false);
    } finally {
      await app.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
