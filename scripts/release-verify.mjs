#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './build-lib.mjs';
import { readProductPackage, validateReleasePolicy } from './release-lib.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const quick = process.argv.includes('--quick');
const outputDir = join(root, 'release');
const startedAt = new Date();
const pkg = readProductPackage();
const results = [];

function gate(name, command, args, env = {}) {
  const started = Date.now();
  console.log(`\n[release-verify] === ${name} ===`);
  const run = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const result = {
    name,
    command: [command, ...args].join(' '),
    passed: run.status === 0,
    exitCode: run.status,
    durationMs: Date.now() - started,
  };
  results.push(result);
  if (!result.passed) throw new Error(`${name} failed with exit code ${run.status ?? 'unknown'}`);
}

function writeReport(error) {
  mkdirSync(outputDir, { recursive: true });
  const report = {
    schemaVersion: 1,
    product: 'Charter',
    version: pkg.version,
    scope: quick ? 'quick' : 'full',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: !error && results.every((result) => result.passed),
    signingMode: process.env.CHARTER_SIGNING_MODE ?? 'unsigned',
    failure: error instanceof Error ? error.message : error ? String(error) : null,
    gates: results,
  };
  writeFileSync(join(outputDir, 'gate-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = [
    `# Charter ${pkg.version} release gate report`,
    '',
    `- Scope: ${report.scope}`,
    `- Result: ${report.passed ? 'PASS' : 'FAIL'}`,
    `- Signing: ${report.signingMode}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    '',
    '| Gate | Result | Duration | Command |',
    '| --- | --- | ---: | --- |',
    ...results.map(
      (result) =>
        `| ${result.name} | ${result.passed ? 'PASS' : 'FAIL'} | ${(result.durationMs / 1000).toFixed(1)}s | \`${result.command}\` |`,
    ),
    '',
    ...(report.failure ? [`Failure: ${report.failure}`, ''] : []),
  ];
  writeFileSync(join(outputDir, 'GATE_REPORT.md'), `${markdown.join('\n')}\n`);
  return report;
}

let failure = null;
try {
  const policy = validateReleasePolicy({
    version: pkg.version,
    signingMode: process.env.CHARTER_SIGNING_MODE ?? 'unsigned',
  });
  results.push({
    name: 'release policy',
    command: `version=${pkg.version} channel=${policy.channel}`,
    passed: true,
    exitCode: 0,
    durationMs: 0,
  });
  gate('static checks', npm, ['run', 'check']);
  gate('unit and integration', npm, ['test']);
  gate('performance', npm, ['run', 'test:perf']);
  if (!quick) {
    gate('Electron E2E', npm, ['run', 'test:e2e']);
    gate('security', npm, ['run', 'test:security']);
    gate('50-task soak', npm, ['run', 'test:soak']);
    gate('installed dependency versions', process.execPath, [
      'scripts/dependency-safety.mjs',
      '--check',
    ]);
    gate('production dependency audit (Critical/High)', npm, [
      'audit',
      '--omit=dev',
      '--audit-level=high',
    ]);
  }
  gate('package', npm, ['run', 'package', '--', ...(quick ? ['--dir-only'] : [])]);
  gate(quick ? 'packaged Electron smoke' : 'clean install, launch, and uninstall', npm, [
    'run',
    quick ? 'test:package:e2e' : 'test:install:e2e',
  ]);
  if (!quick) gate('release metadata', npm, ['run', 'release:metadata']);
} catch (error) {
  failure = error;
  console.error(`\n[release-verify] ${error instanceof Error ? error.message : String(error)}`);
}

const report = writeReport(failure);
console.log(`\n[release-verify] ${report.passed ? 'PASS' : 'FAIL'} (${report.scope})`);
if (!report.passed) process.exitCode = 1;
