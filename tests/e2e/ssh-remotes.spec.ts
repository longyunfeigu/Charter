import { connect } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp } from './helpers/launch';
import { startFakeSshServer, MemFs, type FakeSshServer } from './helpers/ssh-server';

/**
 * ADR-0047 SSH Remotes end-to-end against a loopback ssh2 server (no system
 * sshd). Covers the first-connection flow (host book → TOFU → password →
 * live session → connection loss), the host/session explorer UX, the SFTP files
 * panel, and local port forwards.
 */

/** Create the e2e host via the New Host dialog (password auth, saved). */
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

/** First connect raises the TOFU modal (accept & remember); the saved
 * password may or may not satisfy auth silently — handle both. */
async function acceptPrompts(page: Page): Promise<void> {
  const hostKey = page.getByTestId('ssh-hostkey-modal');
  if (await hostKey.isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.getByTestId('ssh-hostkey-accept').click();
  }
  const authModal = page.getByTestId('ssh-auth-modal');
  if (await authModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await page.getByTestId('ssh-auth-input-0').fill('e2e-password');
    await page.getByTestId('ssh-auth-submit').click();
  }
}

test.describe('SSH Remotes (ADR-0047)', () => {
  let sshd: FakeSshServer;

  test.beforeEach(async () => {
    const fs = new MemFs('/home/tester');
    fs.writeFile('/home/tester/readme.txt', 'hello from the fake server');
    fs.mkdirp('/home/tester/docs');
    sshd = await startFakeSshServer({
      password: 'e2e-password',
      shellBanner: 'fake-sshd ready',
      fs,
    });
  });
  test.afterEach(async () => {
    await sshd.close();
  });

  test('E2E: add a host, verify its key, authenticate, and open a remote session', async () => {
    const { app, page } = await launchApp();
    try {
      await addHost(page, sshd.port);

      // The disconnected overview has one connection action and keeps host
      // tools in the single top-level tab strip rather than duplicating them
      // in dashboard cards and the inspector.
      await expect(page.getByTestId('rm-connection-stage')).toContainText('Ready when you are');
      await expect(page.getByTestId('rm-session-empty')).toContainText('No remote sessions');
      await expect(page.getByRole('button', { name: 'Connect' })).toHaveCount(1);
      await expect(
        page.getByTestId('remote-inspector').getByRole('button', { name: 'Connect' }),
      ).toHaveCount(0);

      // Connect → the first-use host-key modal appears with a SHA256 fingerprint.
      await page.getByTestId('rm-connect-e2e-host').click();
      await expect(page.getByTestId('ssh-hostkey-modal')).toBeVisible();
      await expect(page.locator('.rm-fp')).toContainText(/SHA256:/);
      await page.getByTestId('ssh-hostkey-accept').click();
      const authModal = page.getByTestId('ssh-auth-modal');
      if (await authModal.isVisible({ timeout: 3000 }).catch(() => false)) {
        await page.getByTestId('ssh-auth-input-0').fill('e2e-password');
        await page.getByTestId('ssh-auth-submit').click();
      }

      // A live remote terminal session mounts with the remote header — the
      // Disconnect control only renders when the session carries remote info.
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('ssh-disconnect')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('remote-explorer-rail')).toBeVisible();
      await expect(page.getByTestId('rm-host-e2e-host')).toBeVisible();

      // Dropping the transport deletes the ended Session and returns directly
      // to its host instead of retaining a dead terminal row.
      sshd.dropConnections();
      await expect(page.getByTestId('session-terminal-view')).toBeHidden({ timeout: 15000 });
      await expect(page.getByTestId('rm-host-overview-e2e-host')).toBeVisible();
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(0);
      await expect(page.getByTestId('rm-connect-e2e-host')).toBeVisible({ timeout: 20000 });

      // Rail navigation leaves the Remotes surface — switching the left panel
      // must not leave the main area parked on hosts (dead-click report).
      await page.getByTestId('rail-needs-you').click();
      await expect(page.getByTestId('remotes-view')).toBeHidden();
    } finally {
      await app.close();
    }
  });

  test('E2E: one remote multiplexes several sessions from the host explorer', async () => {
    const { app, page } = await launchApp();
    try {
      await addHost(page, sshd.port);
      await page.getByTestId('rm-connect-e2e-host').click();
      await acceptPrompts(page);
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });

      // Back on the host: connected, one session listed, New Session offered.
      await page.getByTestId('remote-host-e2e-host').click();
      await expect(page.getByTestId('rm-sessions-e2e-host')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(1);

      // Second session on the same transport (no new TOFU/auth prompts).
      await page.getByTestId('rm-new-session-e2e-host').click();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('remote-explorer-rail')).toBeVisible();

      // End the currently selected shell. Its row is deleted immediately and
      // the remaining live PTY becomes both the route and TerminalPanel active.
      const endedTerminalId = await page
        .getByTestId('session-terminal-view')
        .getAttribute('data-terminal-id');
      expect(endedTerminalId).toBeTruthy();
      const terminalIds = await page
        .locator('[data-testid^="rm-session-term_"]')
        .evaluateAll((nodes) =>
          nodes
            .map((node) => node.getAttribute('data-testid')?.replace('rm-session-', ''))
            .filter((id): id is string => Boolean(id)),
        );
      const liveTerminalId = terminalIds.find((id) => id !== endedTerminalId);
      expect(liveTerminalId).toBeTruthy();
      sshd.closeLatestShell();
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(1);
      await expect(page.getByTestId('session-terminal-view')).toHaveAttribute(
        'data-terminal-id',
        liveTerminalId!,
      );
      await expect(page.getByTestId('terminal-host')).toHaveAttribute(
        'data-terminal-id',
        liveTerminalId!,
      );
      await expect(page.locator('.stv-status.ended')).toHaveCount(0);

      await page.getByTestId('remote-host-e2e-host').click();
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(1, {
        timeout: 10000,
      });

      // Remote sessions are shell-only for now — no launch-type menu on the host.
      await expect(page.getByTestId('rm-launch-menu-e2e-host')).toHaveCount(0);

      // Disconnect deletes the final live Session as soon as its channel exits.
      await page.getByTestId('rm-disconnect-e2e-host').click();
      await expect(page.getByTestId('rm-connect-e2e-host')).toBeVisible({ timeout: 10000 });
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(0, {
        timeout: 10000,
      });
    } finally {
      await app.close();
    }
  });

  test('E2E: dual-pane SFTP browses, uploads, downloads via the Transfer Center; forwards tunnel TCP', async () => {
    // A scratch folder in the real home so the local pane can reach it by
    // double-click navigation (the pane starts at the OS home).
    const scratchName = `charter-e2e-sftp-${Date.now()}`;
    const scratch = join(homedir(), scratchName);
    mkdirSync(scratch);
    writeFileSync(join(scratch, 'up.txt'), 'local payload');

    const { app, page } = await launchApp();
    try {
      await addHost(page, sshd.port);

      // --- Files panel (PR2, dual-pane) ---
      await page.getByTestId('remote-tab-files').click();
      await acceptPrompts(page);
      await expect(page.getByTestId('sftp-panel')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('sftp-local-pane')).toBeVisible();
      await expect(page.getByTestId('sftp-entry-readme.txt')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('sftp-entry-docs')).toBeVisible();

      // Navigate into a remote directory and create a folder there.
      await page.getByTestId('sftp-entry-docs').getByText('docs').click();
      await expect(page.getByTestId('sftp-crumbs')).toContainText('docs');
      await page.getByRole('button', { name: 'New Folder' }).click();
      await page.getByPlaceholder('folder name').fill('made-in-e2e');
      await page.getByPlaceholder('folder name').press('Enter');
      await expect(page.getByTestId('sftp-entry-made-in-e2e')).toBeVisible({ timeout: 10000 });
      expect(sshd.fs.nodes.get('/home/tester/docs/made-in-e2e')?.type).toBe('dir');

      // Local pane: jump straight to the scratch folder via the editable path
      // bar, select the file, push it across.
      await page.getByTestId('sftp-local-path-edit').click();
      await page.getByTestId('sftp-local-path-input').fill(scratch);
      await page.getByTestId('sftp-local-path-input').press('Enter');
      await expect(page.getByTestId('sftp-local-crumbs')).toContainText(scratchName);
      await page.getByTestId('sftp-local-entry-up.txt').click();
      await page.getByTestId('sftp-upload-selected').click();
      await expect(page.getByTestId('sftp-entry-up.txt')).toBeVisible({ timeout: 15000 });
      expect(sshd.fs.nodes.get('/home/tester/docs/up.txt')?.data.toString()).toBe('local payload');

      // Remote pane: select the uploaded file and pull it back — the name
      // collides with the local original, so the download uniquifies.
      await page.getByTestId('sftp-entry-up.txt').click();
      await page.getByTestId('sftp-download-selected').click();
      await expect(page.getByTestId('sftp-local-entry-up (1).txt')).toBeVisible({
        timeout: 15000,
      });
      expect(readFileSync(join(scratch, 'up (1).txt'), 'utf8')).toBe('local payload');

      // Remote path bar expands ~ against the server-resolved home.
      await page.getByTestId('sftp-path-edit').click();
      await page.getByTestId('sftp-path-input').fill('~');
      await page.getByTestId('sftp-path-input').press('Enter');
      await expect(page.getByTestId('sftp-entry-readme.txt')).toBeVisible({ timeout: 10000 });

      // Transfer Center: both transfers are aggregated, then cleared.
      await expect(page.getByTestId('transfer-center-pill')).toBeVisible();
      await page.getByTestId('transfer-center-pill').click();
      await expect(page.getByTestId('transfer-center-pop')).toBeVisible();
      await expect(page.locator('[data-testid^="tc-row-"]')).toHaveCount(2);
      await page.getByRole('button', { name: 'Clear finished' }).click();
      await expect(page.getByTestId('transfer-center')).toBeHidden();

      await page.getByTestId('sftp-back').click();
      await expect(page.getByTestId('rm-host-overview-e2e-host')).toBeVisible();

      // --- Port forward (PR3) ---
      const bindPort = 20000 + Math.floor(Math.random() * 20000);
      await page.getByTestId('remote-tab-forwards').click();
      await expect(page.getByTestId('fwd-dialog')).toBeVisible();
      await page.getByTestId('fwd-field-bindport').fill(String(bindPort));
      await page.getByTestId('fwd-field-targetport').fill('7');
      await page.getByTestId('fwd-add').click();
      await acceptPrompts(page);
      await expect(page.locator('[data-testid^="fwd-toggle-"]')).toHaveText('Stop', {
        timeout: 15000,
      });

      // Real bytes through the tunnel: the fake sshd echoes direct-tcpip data.
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = connect(bindPort, '127.0.0.1', () => socket.write('tunnel-ping'));
        socket.once('data', (chunk) => {
          resolve(chunk.toString('utf8'));
          socket.end();
        });
        socket.on('error', reject);
        setTimeout(() => reject(new Error('no echo within 10s')), 10000);
      });
      expect(echoed).toBe('tunnel-ping');

      await page.locator('[data-testid^="fwd-toggle-"]').click();
      await expect(page.locator('[data-testid^="fwd-toggle-"]')).toHaveText('Start', {
        timeout: 10000,
      });
    } finally {
      await app.close();
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
    }
  });
});
