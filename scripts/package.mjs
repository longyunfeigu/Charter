#!/usr/bin/env node
// Build + package. `--dir-only` produces the unpacked app for smoke tests;
// default produces installable artifacts for the current platform.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './build-lib.mjs';
import { readProductPackage, validateReleasePolicy } from './release-lib.mjs';

const dirOnly = process.argv.includes('--dir-only');
const signingMode = process.env.CHARTER_SIGNING_MODE ?? 'unsigned';
const electronBuilderCli = join(root, 'node_modules', 'electron-builder', 'cli.js');
const requestedPlatforms = [
  ['--mac', '--mac'],
  ['--win', '--win'],
  ['--linux', '--linux'],
]
  .filter(([flag]) => process.argv.includes(flag))
  .map(([, builderFlag]) => builderFlag);

const pkg = readProductPackage(root);
const policy = validateReleasePolicy({ version: pkg.version, signingMode });
console.log(
  `[package] Charter ${pkg.version} (${policy.channel}, ${policy.signed ? 'signed' : 'unsigned'})`,
);

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });

const args = [
  '--config',
  'electron-builder.yml',
  `-c.extraMetadata.charterUpdateMode=${policy.signed ? 'signed' : 'unsigned'}`,
  '--publish',
  'never',
  ...requestedPlatforms,
];
if (dirOnly) args.push('--dir');

console.log(`[package] running electron-builder ${dirOnly ? '(--dir smoke)' : ''}…`);
execFileSync(process.execPath, [electronBuilderCli, ...args], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
    // Preview releases are deliberately unsigned. A future paid signing run
    // opts in explicitly and may use either an installed identity or CSC_LINK.
    ...(policy.signed ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }),
  },
});
console.log('[package] done');
