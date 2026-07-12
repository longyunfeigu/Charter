#!/usr/bin/env node
// Build + package. `--dir-only` produces the unpacked app for smoke tests;
// default produces installable artifacts for the current platform.
import { execFileSync } from 'node:child_process';
import { root } from './build-lib.mjs';

const dirOnly = process.argv.includes('--dir-only');

execFileSync('node', ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });

const args = ['electron-builder', '--config', 'electron-builder.yml'];
if (dirOnly) args.push('--dir');

console.log(`[package] running electron-builder ${dirOnly ? '(--dir smoke)' : ''}…`);
execFileSync('npx', args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  },
});
console.log('[package] done');
