import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectReleaseArtifacts,
  dependencyInventory,
  releaseChannel,
  sha256File,
  validateReleasePolicy,
  workflowGateReport,
} from '../../scripts/release-lib.mjs';

describe('release policy and metadata helpers', () => {
  it('maps prerelease versions to channels and forbids unsigned Stable', () => {
    expect(releaseChannel('1.0.0-beta.1')).toBe('beta');
    expect(releaseChannel('1.0.0-rc.2')).toBe('rc');
    expect(releaseChannel('1.0.0-preview.3')).toBe('preview');
    expect(releaseChannel('1.0.0')).toBe('stable');
    expect(() => validateReleasePolicy({ version: '1.0.0' })).toThrow(/unsigned Stable/);
    expect(validateReleasePolicy({ version: '1.0.0', signingMode: 'signed' }).signed).toBe(true);
  });

  it('requires the tag and package version to match exactly', () => {
    expect(
      validateReleasePolicy({ version: '1.0.0-beta.1', tag: 'v1.0.0-beta.1' }).prerelease,
    ).toBe(true);
    expect(() => validateReleasePolicy({ version: '1.0.0-beta.1', tag: 'v1.0.0' })).toThrow(
      /does not match/,
    );
  });

  it('publishes the unsigned tag workflow as a GitHub prerelease, never Latest', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    );
    const publishLine = workflow.split('\n').find((line) => line.includes('gh release create'));

    expect(publishLine).toContain('--prerelease --latest=false');
    expect(publishLine).not.toMatch(/--latest(?:\s|$)/);
  });

  it('emits updater metadata for the SemVer release channel', () => {
    const config = readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
    expect(config).toContain("channel: '${channel}'");
    expect(config).toContain('provider: github');
  });

  it('collects only distributable artifacts and hashes bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'charter-release-lib-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'nested', 'Charter.dmg'), 'release-bytes');
      writeFileSync(join(dir, 'nested', 'latest-mac.yml'), 'version: 1.0.0');
      writeFileSync(join(dir, 'nested', 'ignore.txt'), 'not-an-artifact');
      const artifacts = collectReleaseArtifacts(dir);
      expect(artifacts).toEqual([
        join(dir, 'nested', 'Charter.dmg'),
        join(dir, 'nested', 'latest-mac.yml'),
      ]);
      expect(sha256File(artifacts[0]!)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deduplicates dependency licenses from package-lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'charter-license-lib-'));
    try {
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          packages: {
            '': { name: 'app', version: '1.0.0' },
            'node_modules/a': { version: '2.0.0', license: 'MIT' },
            'node_modules/x/node_modules/a': { version: '2.0.0', license: 'MIT' },
            'node_modules/@scope/b': { version: '3.0.0', license: 'Apache-2.0', dev: true },
          },
        }),
      );
      expect(dependencyInventory(dir)).toEqual([
        {
          name: '@scope/b',
          version: '3.0.0',
          license: 'Apache-2.0',
          developmentOnly: true,
          optional: false,
          source: null,
        },
        {
          name: 'a',
          version: '2.0.0',
          license: 'MIT',
          developmentOnly: false,
          optional: false,
          source: null,
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders immutable CI release evidence without claiming a signed Stable release', () => {
    const report = workflowGateReport({
      version: '1.0.0-beta.1',
      tag: 'v1.0.0-beta.1',
      commit: 'abc123',
      runUrl: 'https://github.com/example/charter/actions/runs/42',
      signingMode: 'unsigned',
    });
    expect(report).toContain('Result: PASS');
    expect(report).toContain('macOS, Windows and Linux');
    expect(report).toContain('unsigned prerelease');
    expect(report).toContain('/actions/runs/42');
  });
});
