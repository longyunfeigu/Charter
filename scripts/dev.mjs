#!/usr/bin/env node
// Dev orchestration: esbuild watch (main/preload/worker) + vite dev server + electron.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { watchAll, root } from './build-lib.mjs';

const DEV_URL = 'http://localhost:51730';
const electronBin = join(root, 'node_modules/.bin/electron');
const restartableBundles = new Set([
  join(root, 'apps/desktop-main/dist/main.cjs'),
  join(root, 'apps/desktop-preload/dist/preload.cjs'),
]);

let electron = null;
let vite = null;
let shuttingDown = false;
let watchRestartsEnabled = false;
let restartTimer = null;
let restartPending = false;

function launchElectron() {
  if (shuttingDown) return;
  console.log('[dev] starting electron…');
  const child = spawn(electronBin, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PI_IDE_DEV_SERVER_URL: DEV_URL,
      PI_IDE_LOG_LEVEL: process.env.PI_IDE_LOG_LEVEL ?? 'debug',
    },
  });
  electron = child;
  child.on('exit', (code, signal) => {
    if (electron === child) electron = null;
    if (shuttingDown) return;
    if (restartPending) {
      restartPending = false;
      launchElectron();
      return;
    }
    console.error(`[dev] electron exited: ${code ?? signal ?? 'unknown'}`);
    vite?.kill();
    process.exit(code ?? 1);
  });
}

function scheduleElectronRestart(outfile) {
  if (!watchRestartsEnabled || !restartableBundles.has(outfile) || shuttingDown) return;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (shuttingDown) return;
    restartPending = true;
    console.log(
      `[dev] ${outfile.endsWith('main.cjs') ? 'main' : 'preload'} rebuilt; restarting electron…`,
    );
    if (electron) electron.kill('SIGTERM');
    else {
      restartPending = false;
      launchElectron();
    }
  }, 150);
}

console.log('[dev] starting esbuild watchers…');
await watchAll((outfile, errors) => {
  if (errors.length > 0) {
    console.error(`[dev] build errors in ${outfile}`);
    return;
  }
  scheduleElectronRestart(outfile);
});

console.log('[dev] starting vite…');
vite = spawn('npx', ['vite', 'dev'], {
  cwd: join(root, 'apps/desktop-renderer'),
  stdio: ['ignore', 'pipe', 'inherit'],
});

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('vite did not start in 60s')), 60000);
  vite.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    if (String(chunk).includes('Local:')) {
      clearTimeout(timeout);
      resolve();
    }
  });
  vite.on('exit', (code) => reject(new Error(`vite exited: ${code}`)));
});

launchElectron();
watchRestartsEnabled = true;

const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (restartTimer) clearTimeout(restartTimer);
  electron?.kill();
  vite?.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
