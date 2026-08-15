import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  if (
    await hostKey
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await page.getByTestId('ssh-hostkey-accept').click();
  }
  const authModal = page.getByTestId('ssh-auth-modal');
  if (
    await authModal
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
  ) {
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
    fs.writeFile('/home/tester/docs/orbit.html', '<title>Remote orbit</title>\n');
    sshd = await startFakeSshServer({
      password: 'e2e-password',
      shellBanner: 'fake-sshd ready',
      fs,
    });
  });
  test.afterEach(async () => {
    await sshd.close();
  });

  test('New Host dialog closes with Escape and restores focus to its opener', async () => {
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      await page.getByTestId('rail-view-remotes').click();
      const opener = page.getByRole('button', { name: 'New Host' }).first();
      await opener.click();
      await expect(page.getByTestId('rm-dialog')).toBeVisible();
      await expect(page.getByTestId('rm-field-label')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('rm-dialog')).toBeHidden();
      await expect(opener).toBeFocused();
    } finally {
      await app.close();
    }
  });

  test('E2E: New Session connects by IP, discovers a remote Agent, and launches it there', async () => {
    const firstLaunch = await launchApp({ home: 'keep' });
    let app = firstLaunch.app;
    let page = firstLaunch.page;
    const prompt = "Audit reconnects; don't touch local files";
    try {
      // The canonical 0→1 path starts in New Session, with no saved host and
      // no local project: choose where the Agent runs before choosing files.
      await expect(page.getByTestId('home-target')).toContainText('This Mac');
      await page.getByTestId('home-target').click();
      await page.getByTestId('home-target-connect').click();
      await expect(page.getByTestId('rm-dialog')).toBeVisible();

      await page.getByTestId('rm-field-label').fill('e2e-agent-host');
      await page.getByTestId('rm-field-host').fill('127.0.0.1');
      await page.getByTestId('rm-field-port').fill(String(sshd.port));
      await page.getByTestId('rm-field-username').fill('tester');
      await page.getByTestId('rm-auth-password').click();
      await page.getByTestId('rm-field-password').fill('e2e-password');
      await page.getByTestId('rm-dialog-submit').click();

      await acceptPrompts(page);
      await expect(page.getByTestId('remote-setup-configure')).toBeVisible({ timeout: 20000 });
      // The setup is portalled above the Sessions rail instead of being
      // trapped in Home's stacking context.
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              document.elementFromPoint(100, 300)?.closest('[data-testid="remote-session-setup"]'),
            ),
          ),
        )
        .toBe(true);
      await expect(page.getByTestId('remote-setup-agent-claude')).toContainText(
        'Ready on this server',
      );
      await expect(page.getByTestId('remote-setup-agent-codex')).toContainText(
        'Ready on this server',
      );
      await expect(page.getByTestId('remote-worker-section')).toContainText('Not installed');
      await page.getByTestId('remote-worker-install').click();
      await expect(page.getByTestId('remote-worker-section')).toContainText('Ready · v1.2.0', {
        timeout: 15000,
      });
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1024, height: 640 });
      });
      await expect
        .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5000 })
        .toBeLessThanOrEqual(1024);
      const narrowLayout = await page.getByTestId('remote-session-setup').evaluate((backdrop) => {
        const dialog = backdrop.querySelector<HTMLElement>('.remote-setup-dialog');
        const rect = dialog?.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          left: rect?.left ?? -1,
          right: rect?.right ?? Number.POSITIVE_INFINITY,
        };
      });
      expect(narrowLayout.documentWidth).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      expect(narrowLayout.left).toBeGreaterThanOrEqual(0);
      expect(narrowLayout.right).toBeLessThanOrEqual(narrowLayout.viewportWidth);
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
      });

      // The working tree is chosen from the remote filesystem, not from the
      // MacBook's project picker.
      await page.getByTestId('remote-setup-browse').click();
      await expect(page.getByTestId('remote-folder-docs')).toBeVisible();
      await page.getByTestId('remote-folder-docs').click();
      await page
        .getByTestId('remote-folder-browser')
        .getByRole('button', { name: 'Use this folder' })
        .click();
      await page.getByTestId('remote-setup-agent-claude').click();
      await page.getByTestId('remote-setup-use').click();

      await expect(page.getByTestId('remote-session-setup')).toBeHidden();
      await expect(page.getByTestId('home-target')).toContainText('e2e-agent-host');
      await expect(page.getByTestId('home-remote-folder')).toContainText('/home/tester/docs');
      await expect(page.getByTestId('home-agent')).toContainText('Claude');

      // The selected path remains an active folder picker; users can change
      // it without clearing and recreating the remote execution target.
      await page.getByTestId('home-remote-folder').click();
      await expect(page.getByTestId('remote-setup-configure')).toBeVisible({ timeout: 20000 });
      await expect(page.getByTestId('remote-setup-workdir')).toHaveValue('/home/tester/docs');
      await expect(page.getByTestId('remote-worker-section')).toContainText('Ready · v1.2.0');
      await page.getByTestId('remote-session-setup').getByRole('button', { name: 'Close' }).click();
      await expect(page.getByTestId('remote-session-setup')).toBeHidden();

      await page.getByTestId('home-intent').fill(prompt);
      await page.getByTestId('home-submit').click();
      // Detection may promote the bare terminal route into its tracked Room
      // before this assertion runs; the external terminal host is stable on
      // both surfaces and proves the remote PTY actually mounted.
      await expect(page.getByTestId('external-terminal-host')).toBeVisible({ timeout: 15000 });
      const managedMetadata = await page.evaluate(async () => {
        const terminals = (await window.product.rpc['terminal.list']!({})) as {
          data?: {
            items: Array<{
              launch: string;
              projectName: string;
              remote?: { hostLabel: string; root?: string; workerSessionId?: string };
            }>;
          };
        };
        return terminals.data?.items.find((terminal) => terminal.launch === 'claude') ?? null;
      });
      expect(managedMetadata).toMatchObject({
        projectName: 'e2e-agent-host · docs',
        remote: {
          hostLabel: 'e2e-agent-host',
          root: '/home/tester/docs',
        },
      });
      expect(managedMetadata?.remote?.workerSessionId).toMatch(/^rws_/);

      // The manifest-owned launch argv and deferred Composer prompt both cross
      // the SSH PTY; no local Agent process is involved.
      await expect
        .poll(() => sshd.shellInput.join(''), { timeout: 10000 })
        .toMatch(/cd -- '\/home\/tester\/docs' && exec claude '--session-id' '[0-9a-f-]{36}'\r/);
      await expect.poll(() => sshd.shellInput.join(''), { timeout: 10000 }).toContain(prompt);
      await expect(page.getByTestId('external-terminal-host').locator('.xterm')).toBeVisible();

      // A remote write is collected by the Worker (not by a local fs watcher)
      // and appears in the ordinary Charter Diff ledger.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const result = (await window.product.rpc['task.list']!({
                filter: 'all',
                includeArchived: false,
                scope: 'all',
              })) as {
                ok: boolean;
                data?: { tasks: Array<{ id: string; external: { remote?: unknown } | null }> };
              };
              return result.data?.tasks.find((task) => task.external?.remote)?.id ?? null;
            }),
          { timeout: 15000 },
        )
        .toBeTruthy();
      const remoteTaskId = await page.evaluate(async () => {
        const result = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        })) as {
          data?: { tasks: Array<{ id: string; external: { remote?: unknown } | null }> };
        };
        return result.data!.tasks.find((task) => task.external?.remote)!.id;
      });

      // Product identity is the real server folder. The generated Worker id
      // and sparse accounting mirror stay internal, while Files browses the
      // canonical remote tree directly over SFTP.
      await expect(page.getByTestId('rail-session-group-e2e-agent-host · docs')).toBeVisible();
      await expect(page.getByTestId('rail-session-group-e2e-agent-host · docs')).not.toContainText(
        'rws_',
      );
      await page.getByTestId(`home-task-${remoteTaskId}`).click();
      await page.getByTestId('rail-tab-files').click();
      await expect(page.getByTestId('session-remote-files-pane')).toBeVisible();
      await expect(page.getByTestId('session-remote-files-root')).toHaveText('/home/tester/docs');
      await expect(page.getByTestId('session-remote-file-orbit.html')).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId('session-remote-files-pane')).not.toContainText('rws_');
      sshd.fs.writeFile('/home/tester/docs/worker-change.txt', 'written on remote\n');
      await expect
        .poll(
          () =>
            page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.changeSet']!({ taskId })) as {
                data?: { changeSet: { files: Array<{ path: string }> } };
              };
              return result.data?.changeSet.files.map((file) => file.path) ?? [];
            }, remoteTaskId),
          { timeout: 15000 },
        )
        .toContain('worker-change.txt');

      // Ending the PTY performs one final Worker sync before REVIEW_READY.
      sshd.closeLatestShell();
      await expect
        .poll(
          () =>
            page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.get']!({
                taskId,
                eventsAfter: 0,
              })) as { data?: { task: { state: string } } };
              return result.data?.task.state ?? null;
            }, remoteTaskId),
          { timeout: 15000 },
        )
        .toBe('REVIEW_READY');

      // The normal Review UI can reject it; the protected apply path removes
      // the file on the server too (no local-only fake rollback).
      await page.getByTestId('rail-tab-sessions').click();
      await page.getByTestId(`home-task-${remoteTaskId}`).click();
      if (!(await page.getByTestId('review-bar-open').isVisible())) {
        await page.getByTestId('session-tools-open').click();
      }
      await page.getByTestId('review-bar-open').click();
      await expect(page.getByTestId('review-file-worker-change.txt')).toBeVisible({
        timeout: 15000,
      });
      page.once('dialog', (dialog) => dialog.accept());
      await page.getByTestId('file-reject-worker-change.txt').click();
      await expect.poll(() => sshd.fs.nodes.has('/home/tester/docs/worker-change.txt')).toBe(false);

      // Resume stays remote and reuses the same Worker baseline. It must not
      // create a local Mac terminal or silently take a fresh baseline. Relaunch
      // the desktop first to prove the durable task/Worker binding survives a
      // real main-process restart, including remote writes made while offline.
      await page.getByTestId('review-close').click();
      const remoteSessionId = await page.evaluate(async (taskId) => {
        const result = (await window.product.rpc['task.get']!({
          taskId,
          eventsAfter: 0,
        })) as { data?: { task: { external: { sessionId: string | null } | null } } };
        return result.data?.task.external?.sessionId ?? null;
      }, remoteTaskId);
      expect(remoteSessionId).toMatch(/^[0-9a-f-]{36}$/);
      await app.close();
      sshd.fs.writeFile(
        '/home/tester/docs/after-restart.txt',
        'written while Charter was closed\n',
      );
      const relaunched = await launchApp({
        home: 'keep',
        userDataDir: firstLaunch.userDataDir,
      });
      app = relaunched.app;
      page = relaunched.page;
      await expect(page.getByTestId(`home-resume-${remoteTaskId}`)).toBeVisible();
      await page.getByTestId(`home-resume-${remoteTaskId}`).click();
      await acceptPrompts(page);
      await expect
        .poll(() => sshd.shellInput.join(''), { timeout: 15000 })
        .toContain(`cd -- '/home/tester/docs' && exec claude '--resume' '${remoteSessionId}'\r`);
      await expect
        .poll(
          () =>
            page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.get']!({
                taskId,
                eventsAfter: 0,
              })) as {
                data?: { task: { state: string; external: { terminalId: string } } };
              };
              return result.data?.task ?? null;
            }, remoteTaskId),
          { timeout: 15000 },
        )
        .toMatchObject({ state: 'IN_PROGRESS' });
      await expect
        .poll(
          () =>
            page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.changeSet']!({ taskId })) as {
                data?: { changeSet: { files: Array<{ path: string }> } };
              };
              return result.data?.changeSet.files.map((file) => file.path) ?? [];
            }, remoteTaskId),
          { timeout: 15000 },
        )
        .toContain('after-restart.txt');
    } finally {
      await app.close();
    }
  });

  test('official Pack probes and launches all five Agents with manifest-owned SSH commands', async () => {
    test.setTimeout(120_000);
    await sshd.close();
    sshd = await startFakeSshServer({
      password: 'e2e-password',
      shellBanner: 'official-pack-sshd ready',
      installedClis: ['gemini', 'opencode', 'copilot', 'cursor-agent', 'aider'],
    });
    sshd.fs.mkdirp('/home/tester/project');
    const { app, page } = await launchApp({ home: 'keep' });
    try {
      await page.getByTestId('home-target').click();
      await page.getByTestId('home-target-connect').click();
      await page.getByTestId('rm-field-label').fill('official-agent-host');
      await page.getByTestId('rm-field-host').fill('127.0.0.1');
      await page.getByTestId('rm-field-port').fill(String(sshd.port));
      await page.getByTestId('rm-field-username').fill('tester');
      await page.getByTestId('rm-auth-password').click();
      await page.getByTestId('rm-field-password').fill('e2e-password');
      await page.getByTestId('rm-dialog-submit').click();
      await acceptPrompts(page);
      await expect(page.getByTestId('remote-setup-configure')).toBeVisible({ timeout: 20_000 });

      for (const id of ['gemini', 'opencode', 'copilot', 'cursor', 'aider']) {
        await expect(page.getByTestId(`remote-setup-agent-${id}`)).toContainText(
          'Ready on this server',
          { timeout: 20_000 },
        );
      }
      await page.getByTestId('remote-worker-install').click();
      await expect(page.getByTestId('remote-worker-section')).toContainText('Ready · v1.2.0', {
        timeout: 15_000,
      });
      await page.getByTestId('remote-setup-browse').click();
      await page.getByTestId('remote-folder-project').click();
      await page
        .getByTestId('remote-folder-browser')
        .getByRole('button', { name: 'Use this folder' })
        .click();
      await page.getByTestId('remote-setup-agent-gemini').click();
      await page.getByTestId('remote-setup-use').click();

      const hostId = await page.evaluate(async () => {
        const result = (await window.product.rpc['ssh.listHosts']!({})) as {
          data?: { hosts: Array<{ id: string; label: string }> };
        };
        return result.data?.hosts.find((host) => host.label === 'official-agent-host')?.id ?? null;
      });
      expect(hostId).toBeTruthy();

      const expectedLaunch: Record<string, string> = {
        gemini:
          "cd -- '/home/tester/project' && exec gemini '--prompt-interactive' 'ssh prompt gemini'\r",
        opencode:
          "cd -- '/home/tester/project' && exec opencode '--prompt' 'ssh prompt opencode'\r",
        copilot: "cd -- '/home/tester/project' && exec copilot\r",
        cursor: "cd -- '/home/tester/project' && exec cursor-agent 'ssh prompt cursor'\r",
        aider: "cd -- '/home/tester/project' && exec aider\r",
      };
      for (const id of ['gemini', 'opencode', 'copilot', 'cursor', 'aider']) {
        const prompt = `ssh prompt ${id}`;
        const result = (await page.evaluate(
          async ({ hostId: remoteHostId, launch, initialPrompt }) =>
            window.product.rpc['terminal.create']!({
              context: { kind: 'scratch' },
              launch,
              initialPrompt,
              target: { kind: 'ssh', hostId: remoteHostId, workspaceKind: 'remote' },
            }),
          { hostId: hostId!, launch: id, initialPrompt: prompt },
        )) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
        if (!result.ok) throw new Error(result.error?.userMessage ?? `failed to launch ${id}`);
        await expect
          .poll(() => sshd.shellInput.join(''), { timeout: 15_000 })
          .toContain(expectedLaunch[id]);
        if (id === 'copilot' || id === 'aider') {
          await expect.poll(() => sshd.shellInput.join(''), { timeout: 15_000 }).toContain(prompt);
        }
        const metadata = await page.evaluate(async (terminalId) => {
          const listed = (await window.product.rpc['terminal.list']!({})) as {
            data?: { items: Array<{ id: string; launch: string; persistence: string }> };
          };
          return listed.data?.items.find((terminal) => terminal.id === terminalId) ?? null;
        }, result.data.id);
        expect(metadata).toMatchObject({ launch: id, persistence: 'remote' });
        await page.evaluate(
          async (terminalId) =>
            window.product.rpc['terminal.kill']!({ id: terminalId, force: true }),
          result.data.id,
        );
      }
    } finally {
      await app.close();
    }
  });

  test('E2E: a local project stays canonical while its Agent runs in an isolated remote copy', async () => {
    const localRoot = realpathSync(mkdtempSync(join(tmpdir(), 'charter-e2e-local-remote-')));
    execFileSync('git', ['init', '-q', localRoot]);
    writeFileSync(join(localRoot, '.gitignore'), 'private.env\n');
    writeFileSync(join(localRoot, 'app.txt'), 'local baseline\n');
    writeFileSync(join(localRoot, 'private.env'), 'must stay on this Mac\n');

    const launched = await launchApp({
      home: 'keep',
      env: { PI_IDE_OPEN_WORKSPACE: localRoot },
    });
    const { app, page } = launched;
    try {
      // Opening the local project enters the workspace surface. Return to New
      // Session without closing it, so SSH setup can offer it as the source.
      const homeButton = page.locator('button[data-testid="surface-home"]');
      if (await homeButton.isVisible({ timeout: 10000 }).catch(() => false)) {
        await homeButton.click();
      }
      await expect(page.getByTestId('home-view')).toBeVisible({ timeout: 10000 });
      await page.getByTestId('home-target').click();
      await page.getByTestId('home-target-connect').click();
      await expect(page.getByTestId('rm-dialog')).toBeVisible();
      await page.getByTestId('rm-field-label').fill('e2e-local-agent');
      await page.getByTestId('rm-field-host').fill('127.0.0.1');
      await page.getByTestId('rm-field-port').fill(String(sshd.port));
      await page.getByTestId('rm-field-username').fill('tester');
      await page.getByTestId('rm-auth-password').click();
      await page.getByTestId('rm-field-password').fill('e2e-password');
      await page.getByTestId('rm-dialog-submit').click();
      await acceptPrompts(page);

      await expect(page.getByTestId('remote-setup-configure')).toBeVisible({ timeout: 20000 });
      await page.getByTestId('remote-worker-install').click();
      await expect(page.getByTestId('remote-worker-section')).toContainText('Ready · v1.2.0', {
        timeout: 15000,
      });
      await page.getByTestId('remote-workspace-local').click();
      await expect(page.getByTestId('remote-local-workdir')).toHaveText(localRoot);
      await expect(page.getByTestId('remote-local-workspace')).toContainText(
        'synchronizes file changes both ways',
      );
      await page.getByTestId('remote-setup-agent-claude').click();
      await page.getByTestId('remote-setup-use').click();

      await expect(page.getByTestId('home-remote-folder')).toContainText(localRoot);
      await expect(page.getByTestId('home-remote-folder')).toContainText('LOCAL · REMOTE AGENT');
      await page.getByTestId('home-intent').fill('Work remotely against my local project');
      await page.getByTestId('home-submit').click();
      await expect(page.getByTestId('external-terminal-host')).toBeVisible({ timeout: 20000 });

      const localTask = await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const result = (await window.product.rpc['task.list']!({
                filter: 'all',
                includeArchived: false,
                scope: 'all',
              })) as {
                data?: {
                  tasks: Array<{
                    id: string;
                    projectPath: string;
                    external: {
                      remote?: { root: string; workspaceKind?: 'remote' | 'local' };
                    } | null;
                  }>;
                };
              };
              const task = result.data?.tasks.find(
                (entry) => entry.external?.remote?.workspaceKind === 'local',
              );
              return task
                ? {
                    id: task.id,
                    projectPath: task.projectPath,
                    root: task.external!.remote!.root,
                  }
                : null;
            }),
          { timeout: 20000 },
        )
        .not.toBeNull()
        .then(async () =>
          page.evaluate(async () => {
            const result = (await window.product.rpc['task.list']!({
              filter: 'all',
              includeArchived: false,
              scope: 'all',
            })) as {
              data: {
                tasks: Array<{
                  id: string;
                  projectPath: string;
                  external: { remote?: { root: string; workspaceKind?: string } } | null;
                }>;
              };
            };
            const task = result.data.tasks.find(
              (entry) => entry.external?.remote?.workspaceKind === 'local',
            )!;
            return {
              id: task.id,
              projectPath: task.projectPath,
              root: task.external!.remote!.root,
            };
          }),
        );

      expect(localTask.projectPath).toBe(localRoot);
      expect(localTask.root).toMatch(/^\/home\/tester\/\.charter\/workspaces\/rws_/);
      expect(sshd.fs.nodes.get(`${localTask.root}/app.txt`)?.data.toString()).toBe(
        'local baseline\n',
      );
      expect(sshd.fs.nodes.has(`${localTask.root}/private.env`)).toBe(false);
      expect(
        [...sshd.fs.nodes.keys()].some((path) => path.startsWith(`${localTask.root}/.git/`)),
      ).toBe(false);
      await expect
        .poll(() => sshd.shellInput.join(''), { timeout: 10000 })
        .toMatch(
          new RegExp(`cd -- '${localTask.root}' && exec claude '--session-id' '[0-9a-f-]{36}'\\r`),
        );
      await expect
        .poll(() => sshd.shellInput.join(''), { timeout: 10000 })
        .toContain('Work remotely against my local project');

      // Files remains the real local ProjectTree in this mode, while the
      // generated remote execution root is kept out of product navigation.
      const localProjectName = localRoot.split('/').at(-1)!;
      await expect(page.getByTestId(`rail-session-group-${localProjectName}`)).toBeVisible();
      await expect(page.getByTestId(`rail-session-group-${localProjectName}`)).not.toContainText(
        'rws_',
      );
      await page.getByTestId(`home-task-${localTask.id}`).click();
      await page.getByTestId('rail-tab-files').click();
      await expect(page.getByTestId('session-files-pane')).toBeVisible();
      await expect(page.getByTestId('session-remote-files-pane')).toHaveCount(0);
      await expect(page.getByTestId('session-files-pane')).toContainText('app.txt');
      // Remote Agent writes flow down to the canonical local directory.
      sshd.fs.writeFile(`${localTask.root}/from-remote.txt`, 'remote edit\n');
      await expect
        .poll(
          () =>
            existsSync(join(localRoot, 'from-remote.txt'))
              ? readFileSync(join(localRoot, 'from-remote.txt'), 'utf8')
              : null,
          { timeout: 15000 },
        )
        .toBe('remote edit\n');

      // Local edits flow up through expected-hash protected writes.
      writeFileSync(join(localRoot, 'from-local.txt'), 'local edit\n');
      await expect
        .poll(
          () => sshd.fs.nodes.get(`${localTask.root}/from-local.txt`)?.data.toString() ?? null,
          { timeout: 15000 },
        )
        .toBe('local edit\n');

      // A same-file race preserves both versions: synchronization pauses on
      // the hash mismatch rather than choosing either side implicitly.
      sshd.fs.writeFile(`${localTask.root}/app.txt`, 'remote conflict\n');
      writeFileSync(join(localRoot, 'app.txt'), 'local conflict\n');
      await page.waitForTimeout(2500);
      expect(readFileSync(join(localRoot, 'app.txt'), 'utf8')).toBe('local conflict\n');
      expect(sshd.fs.nodes.get(`${localTask.root}/app.txt`)?.data.toString()).toBe(
        'remote conflict\n',
      );

      // Deleting the Session reclaims only Charter's isolated server copy.
      sshd.closeLatestShell();
      await expect
        .poll(
          () =>
            page.evaluate(async (taskId) => {
              const result = (await window.product.rpc['task.get']!({
                taskId,
                eventsAfter: 0,
              })) as { data?: { task: { external: { status: string } | null } } };
              return result.data?.task.external?.status ?? null;
            }, localTask.id),
          { timeout: 15000 },
        )
        .toBe('ended');
      const deleted = await page.evaluate(
        async (taskId) => window.product.rpc['task.delete']!({ taskId }),
        localTask.id,
      );
      expect(deleted).toMatchObject({ ok: true, data: { deleted: true } });
      expect(existsSync(localRoot)).toBe(true);
      expect(
        [...sshd.fs.nodes.keys()].some(
          (path) => path === localTask.root || path.startsWith(`${localTask.root}/`),
        ),
      ).toBe(false);
    } finally {
      await app.close();
      rmSync(localRoot, { recursive: true, force: true });
    }
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
      await expect(page.getByTestId('session-terminal-view')).toHaveAttribute(
        'data-terminal-scope',
        'remote-host',
      );
      await expect(page.getByTestId('ssh-new-session')).toHaveText('New SSH Session');
      await expect(page.getByTestId('ssh-all-terminals')).toBeVisible();
      // One host session needs no second switcher, and the local New Terminal
      // action must never masquerade as an SSH-scoped command.
      await expect(page.getByTestId('ssh-session-switcher')).toHaveCount(0);
      await expect(page.getByTestId('terminal-new')).toHaveCount(0);

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
      await expect(page.getByTestId('ssh-session-switcher')).toHaveCount(0);
      await expect(page.locator('[data-testid^="rm-session-term_"]')).toHaveCount(1);

      // The SSH-scoped header creates a second shell on the same transport.
      // Only then does a compact, host-filtered session switcher appear.
      await page.getByTestId('ssh-new-session').click();
      await expect(page.getByTestId('session-terminal-view')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('remote-explorer-rail')).toBeVisible();
      await expect(page.getByTestId('ssh-session-switcher')).toBeVisible();
      await expect(page.getByTestId('ssh-session-switcher-heading')).toContainText(
        'e2e-host sessions',
      );
      await expect(
        page.getByTestId('ssh-session-switcher').locator('[data-testid^="terminal-tab-"]'),
      ).toHaveCount(2);
      await expect(page.getByTestId('terminal-new')).toHaveCount(0);

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

      // Global terminals remain available, but only after an explicit scope
      // change. The ordinary local creation control belongs there.
      await page.getByTestId('ssh-all-terminals').click();
      await expect(page.getByTestId('session-terminal-view')).toHaveAttribute(
        'data-terminal-scope',
        'all',
      );
      await expect(page.getByTestId('terminal-new')).toBeVisible();
      await expect(page.getByTestId('remote-explorer-rail')).toHaveCount(0);
      // Selecting a concrete row in Sessions returns to one terminal and does
      // not keep the global terminal list attached to that Session page.
      await page.getByTestId(`session-terminal-${endedTerminalId}`).click();
      await expect(page.getByTestId('session-terminal-view')).toHaveAttribute(
        'data-terminal-scope',
        'single',
      );
      await expect(page.getByTestId('terminal-new')).toHaveCount(0);
      await expect(page.getByTestId('session-all-terminals')).toBeVisible();

      await page.getByTestId('rail-view-remotes').click();
      await expect(page.getByTestId('remote-explorer-rail')).toBeVisible();
      await page.getByTestId(`rm-session-${endedTerminalId}`).click();
      await expect(page.getByTestId('session-terminal-view')).toHaveAttribute(
        'data-terminal-scope',
        'remote-host',
      );

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

      // The host explorer remains a shell-first connection surface. Remote
      // Agents are selected through New Session, so the host card has no
      // duplicate launch-type menu.
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
