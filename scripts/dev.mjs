#!/usr/bin/env node
// Dev orchestration: esbuild watch (main/preload/worker) + vite dev server + electron.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { watchAll, root } from './build-lib.mjs';

const DEV_URL = 'http://localhost:51730';

console.log('[dev] starting esbuild watchers…');
await watchAll((outfile, errors) => {
  if (errors.length > 0) console.error(`[dev] build errors in ${outfile}`);
});

console.log('[dev] starting vite…');
const vite = spawn('npx', ['vite', 'dev'], {
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

console.log('[dev] starting electron…');
const electronBin = join(root, 'node_modules/.bin/electron');
const electron = spawn(electronBin, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PI_IDE_DEV_SERVER_URL: DEV_URL,
    PI_IDE_LOG_LEVEL: process.env.PI_IDE_LOG_LEVEL ?? 'debug',
  },
});

const shutdown = () => {
  electron.kill();
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
electron.on('exit', () => {
  vite.kill();
  process.exit(0);
});
