import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeProjectDirName,
  discoverCliSessionId,
  isSafeCliSessionId,
} from './cli-session-locator.js';

const ID_A = '11111111-2222-3333-4444-555555555555';
const ID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

function touch(path: string, mtimeMs: number): void {
  writeFileSync(path, '{"sessionId":"x"}\n');
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

function dayKey(timeMs: number): string {
  const date = new Date(timeMs);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
}

function writeCodexRollout(input: {
  codexHome: string;
  id: string;
  cwd: string;
  startedAtMs: number;
  mtimeMs: number;
}): void {
  const dir = join(input.codexHome, 'sessions', dayKey(input.startedAtMs));
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date(input.startedAtMs).toISOString();
  const path = join(dir, `rollout-${timestamp.replaceAll(':', '-')}-${input.id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp,
      type: 'session_meta',
      payload: { id: input.id, timestamp, cwd: input.cwd },
    })}\n`,
  );
  utimesSync(path, new Date(input.mtimeMs), new Date(input.mtimeMs));
}

describe('claudeProjectDirName', () => {
  it('replaces every non-alphanumeric character with a dash (verified against real installs)', () => {
    expect(claudeProjectDirName('/Users/x/git/bullpen')).toBe('-Users-x-git-bullpen');
    // Underscores and dots are munged too — the fixture dirs prove it.
    expect(claudeProjectDirName('/var/folders/ab_cd/T/pi-ide.fixture')).toBe(
      '-var-folders-ab-cd-T-pi-ide-fixture',
    );
  });
});

describe('isSafeCliSessionId', () => {
  it('accepts exactly UUIDs and nothing shell-shaped', () => {
    expect(isSafeCliSessionId(ID_A)).toBe(true);
    expect(isSafeCliSessionId('abc; rm -rf .')).toBe(false);
    expect(isSafeCliSessionId('$(evil)')).toBe(false);
    expect(isSafeCliSessionId('')).toBe(false);
  });
});

describe('discoverCliSessionId — claude transcripts', () => {
  it('picks the newest transcript inside the session window and ignores older sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const cwd = '/work/app';
    const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const start = Date.now() - 10 * 60_000;
    touch(join(dir, `${ID_A}.jsonl`), start - 60 * 60_000); // an hour-old session
    touch(join(dir, `${ID_B}.jsonl`), start + 5 * 60_000); // this session
    writeFileSync(join(dir, 'not-a-session.jsonl'), ''); // non-UUID ignored

    await expect(
      discoverCliSessionId({ cli: 'claude', cwd, startedAtMs: start, endedAtMs: Date.now(), home }),
    ).resolves.toBe(ID_B);
  });

  it('resolves null when the project has no transcript directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    await expect(
      discoverCliSessionId({
        cli: 'claude',
        cwd: '/nowhere',
        startedAtMs: Date.now() - 1000,
        endedAtMs: Date.now(),
        home,
      }),
    ).resolves.toBeNull();
  });

  it('resolves null when every transcript predates the session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const cwd = '/work/app';
    const dir = join(home, '.claude', 'projects', claudeProjectDirName(cwd));
    mkdirSync(dir, { recursive: true });
    const start = Date.now();
    touch(join(dir, `${ID_A}.jsonl`), start - 3 * 60 * 60_000);
    await expect(
      discoverCliSessionId({
        cli: 'claude',
        cwd,
        startedAtMs: start,
        endedAtMs: start + 1000,
        home,
      }),
    ).resolves.toBeNull();
  });
});

describe('discoverCliSessionId — codex rollouts', () => {
  it('walks the date-partitioned tree and extracts the matching rollout UUID', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const codexHome = join(home, '.codex');
    const cwd = '/work/app';
    const start = Date.now() - 5 * 60_000;
    writeCodexRollout({
      codexHome,
      id: ID_A,
      cwd,
      startedAtMs: start - 60 * 60_000,
      mtimeMs: start - 60 * 60_000,
    });
    writeCodexRollout({
      codexHome,
      id: ID_B,
      cwd,
      startedAtMs: start + 1_000,
      mtimeMs: start + 60_000,
    });

    await expect(
      discoverCliSessionId({
        cli: 'codex',
        cwd,
        startedAtMs: start,
        endedAtMs: Date.now(),
        home,
      }),
    ).resolves.toBe(ID_B);
  });

  it('finds rollouts in an explicit alternate Codex home', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const codexHome = join(fixture, '.codex-app');
    const start = Date.now() - 5_000;
    writeCodexRollout({
      codexHome,
      id: ID_A,
      cwd: '/work/app',
      startedAtMs: start,
      mtimeMs: start + 1_000,
    });

    await expect(
      discoverCliSessionId({
        cli: 'codex',
        cwd: '/work/app',
        startedAtMs: start,
        endedAtMs: start + 2_000,
        codexHomes: [codexHome],
      }),
    ).resolves.toBe(ID_A);
  });

  it('uses session_meta.cwd instead of taking a newer rollout from another project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const codexHome = join(home, '.codex');
    const start = Date.now() - 10_000;
    writeCodexRollout({
      codexHome,
      id: ID_A,
      cwd: '/work/app',
      startedAtMs: start + 500,
      mtimeMs: start + 2_000,
    });
    writeCodexRollout({
      codexHome,
      id: ID_B,
      cwd: '/work/other',
      startedAtMs: start + 1_000,
      mtimeMs: start + 8_000,
    });

    await expect(
      discoverCliSessionId({
        cli: 'codex',
        cwd: '/work/app',
        startedAtMs: start,
        endedAtMs: start + 9_000,
        home,
      }),
    ).resolves.toBe(ID_A);
  });

  it('chooses the same-cwd rollout created closest to the observed agent start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const codexHome = join(home, '.codex');
    const start = Date.now() - 20_000;
    writeCodexRollout({
      codexHome,
      id: ID_A,
      cwd: '/work/app',
      startedAtMs: start + 250,
      mtimeMs: start + 5_000,
    });
    writeCodexRollout({
      codexHome,
      id: ID_B,
      cwd: '/work/app',
      startedAtMs: start + 10_000,
      mtimeMs: start + 19_000,
    });

    await expect(
      discoverCliSessionId({
        cli: 'codex',
        cwd: '/work/app',
        startedAtMs: start,
        endedAtMs: start + 20_000,
        home,
      }),
    ).resolves.toBe(ID_A);
  });

  it('does not scan outside explicit Codex homes', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cli-loc-'));
    const listedHome = join(fixture, 'listed');
    const unlistedHome = join(fixture, 'unlisted');
    const start = Date.now() - 5_000;
    mkdirSync(join(listedHome, 'sessions'), { recursive: true });
    writeCodexRollout({
      codexHome: unlistedHome,
      id: ID_B,
      cwd: '/work/app',
      startedAtMs: start,
      mtimeMs: start + 1_000,
    });

    await expect(
      discoverCliSessionId({
        cli: 'codex',
        cwd: '/work/app',
        startedAtMs: start,
        endedAtMs: start + 2_000,
        codexHomes: [listedHome],
      }),
    ).resolves.toBeNull();
  });

  it('resolves null for unknown CLIs', async () => {
    await expect(
      discoverCliSessionId({
        cli: 'fakeagent',
        cwd: '/any',
        startedAtMs: 0,
        endedAtMs: 1,
        home: '/nonexistent',
      }),
    ).resolves.toBeNull();
  });
});
