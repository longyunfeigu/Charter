#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from './build-lib.mjs';

const releaseDir = join(root, 'release');
const playwrightCli = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const scratch = mkdtempSync(join(tmpdir(), 'charter-install-smoke-'));
let mountedDmg = null;
let executable = null;
let uninstaller = null;
let uninstalled = false;

function findEntry(dir, predicate) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (predicate(full, entry)) return full;
    if (entry.isDirectory()) {
      const nested = findEntry(full, predicate);
      if (nested) return nested;
    }
  }
  return null;
}

function artifact(suffix) {
  const found = readdirSync(releaseDir)
    .filter((name) => name.toLowerCase().endsWith(suffix))
    .sort()
    .at(-1);
  if (!found) throw new Error(`No ${suffix} artifact found under ${releaseDir}`);
  return join(releaseDir, found);
}

function stageMac() {
  const dmg = artifact('.dmg');
  const mount = join(scratch, 'mount');
  const installed = join(scratch, 'Applications');
  mkdirSync(mount);
  mkdirSync(installed);
  execFileSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount], {
    stdio: 'inherit',
  });
  mountedDmg = mount;
  const sourceApp = findEntry(mount, (path, entry) => entry.isDirectory() && path.endsWith('.app'));
  if (!sourceApp) throw new Error(`No .app bundle found in ${basename(dmg)}`);
  const targetApp = join(installed, basename(sourceApp));
  execFileSync('ditto', [sourceApp, targetApp]);
  execFileSync('hdiutil', ['detach', mount], { stdio: 'inherit' });
  mountedDmg = null;
  executable = join(targetApp, 'Contents', 'MacOS', 'Charter');
}

function stageWindows() {
  const installer = artifact('.exe');
  const installed = join(scratch, 'Charter');
  execFileSync(installer, ['/S', `/D=${installed}`], { stdio: 'inherit' });
  executable = findEntry(
    installed,
    (path, entry) => entry.isFile() && basename(path).toLowerCase() === 'charter.exe',
  );
  uninstaller = findEntry(
    installed,
    (path, entry) => entry.isFile() && basename(path).toLowerCase().startsWith('uninstall'),
  );
  if (!uninstaller) throw new Error(`NSIS uninstaller was not created under ${installed}`);
}

function stageLinux() {
  const tarball = artifact('.tar.gz');
  const installed = join(scratch, 'opt');
  mkdirSync(installed);
  execFileSync('tar', ['-xzf', tarball, '-C', installed], { stdio: 'inherit' });
  const sandboxHelper = findEntry(
    installed,
    (path, entry) => entry.isFile() && basename(path) === 'chrome-sandbox',
  );
  if (!sandboxHelper) throw new Error(`chrome-sandbox was not found under ${installed}`);
  if (process.getuid?.() === 0) {
    execFileSync('chown', ['root:root', sandboxHelper], { stdio: 'inherit' });
    execFileSync('chmod', ['4755', sandboxHelper], { stdio: 'inherit' });
  } else {
    // A tarball has no system installer to assign the Chromium helper's root
    // owner. Configure it exactly as documented before launching the app.
    execFileSync('sudo', ['chown', 'root:root', sandboxHelper], { stdio: 'inherit' });
    execFileSync('sudo', ['chmod', '4755', sandboxHelper], { stdio: 'inherit' });
  }
  executable = findEntry(
    installed,
    (path, entry) => entry.isFile() && basename(path).toLowerCase() === 'charter',
  );
}

function uninstallWindows() {
  if (!uninstaller || !existsSync(uninstaller)) return;
  execFileSync(uninstaller, ['/S'], { stdio: 'inherit' });
  const deadline = Date.now() + 15_000;
  while (executable && existsSync(executable) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (executable && existsSync(executable)) {
    throw new Error('NSIS uninstall left the Charter executable behind');
  }
  uninstalled = true;
}

try {
  if (process.platform === 'darwin') stageMac();
  else if (process.platform === 'win32') stageWindows();
  else if (process.platform === 'linux') stageLinux();
  else throw new Error(`Unsupported install-smoke platform: ${process.platform}`);

  if (!executable || !existsSync(executable) || !statSync(executable).isFile()) {
    throw new Error(`Installed executable was not found: ${executable ?? '(none)'}`);
  }
  console.log(`[install-smoke] staged ${executable}`);
  execFileSync(
    process.execPath,
    [playwrightCli, 'test', '--config', 'tests/release/playwright.config.ts'],
    {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CHARTER_PACKAGED_EXECUTABLE: executable },
    },
  );

  uninstallWindows();
  console.log('[install-smoke] clean install, launch, and uninstall PASS');
} finally {
  if (process.platform === 'win32' && !uninstalled) {
    try {
      uninstallWindows();
    } catch {
      // Preserve the original smoke-test failure; the temporary tree is still removed below.
    }
  }
  if (mountedDmg) {
    try {
      execFileSync('hdiutil', ['detach', mountedDmg, '-force'], { stdio: 'ignore' });
    } catch {
      // The temporary mount is removed below; keep the original failure.
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
