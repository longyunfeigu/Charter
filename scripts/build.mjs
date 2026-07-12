#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { buildAll, root } from './build-lib.mjs';

console.log('[build] bundling main/preload/worker…');
await buildAll();

console.log('[build] building renderer…');
execFileSync('npx', ['vite', 'build'], {
  cwd: join(root, 'apps/desktop-renderer'),
  stdio: 'inherit',
});

console.log('[build] done');
