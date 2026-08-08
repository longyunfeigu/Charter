import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';

interface WorkerReply {
  ok: boolean;
  error?: string;
  sessionId?: string;
  entries?: Array<{
    path: string;
    beforeHash: string | null;
    afterHash: string | null;
    beforeBase64: string | null;
    afterBase64: string | null;
    beforeMode: number | null;
    afterMode: number | null;
  }>;
  conflicts?: Array<{ path: string }>;
}

const scratch = mkdtempSync(join(tmpdir(), 'charter-worker-unit-'));
const bundle = join(scratch, 'remote-session-worker.cjs');
const stateRoot = join(scratch, 'state');
const workerHome = join(scratch, 'home');

function invoke(args: string[], input?: unknown): { status: number | null; reply: WorkerReply } {
  const result = spawnSync(process.execPath, [bundle, ...args], {
    env: { ...process.env, HOME: workerHome, CHARTER_WORKER_STATE: stateRoot },
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
  });
  const line = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error(result.stderr || 'Worker returned no JSON');
  return { status: result.status, reply: JSON.parse(line) as WorkerReply };
}

function id(): string {
  return `rws_${randomUUID().replaceAll('-', '')}`;
}

beforeAll(() => {
  buildSync({
    entryPoints: [fileURLToPath(new URL('./remote-session-worker.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    outfile: bundle,
    logLevel: 'silent',
  });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('bundled remote session Worker', () => {
  it('owns and removes only the exact isolated root used by a local bridge', () => {
    const sessionId = id();
    const root = join(workerHome, '.charter', 'workspaces', sessionId);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'local.txt'), 'seeded from local\n');

    expect(
      invoke(['start', '--session', sessionId, '--root', root, '--workspace', 'local']).reply.ok,
    ).toBe(true);
    const destroyed = invoke(['destroy', '--session', sessionId]).reply;
    expect(destroyed.error).toBeUndefined();
    expect(destroyed.ok).toBe(true);
    expect(existsSync(root)).toBe(false);

    const invalidId = id();
    const invalidRoot = join(workerHome, 'user-owned-project');
    mkdirSync(invalidRoot, { recursive: true });
    expect(
      invoke(['start', '--session', invalidId, '--root', invalidRoot, '--workspace', 'local']).reply
        .ok,
    ).toBe(false);
    expect(existsSync(invalidRoot)).toBe(true);
  });

  it('captures, inspects and conflict-protects a non-git folder', () => {
    const root = join(scratch, 'plain-project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'a.txt'), 'baseline\n');
    const sessionId = id();

    expect(
      invoke(['start', '--session', sessionId, '--root', root, '--workspace', 'remote']).reply.ok,
    ).toBe(true);
    writeFileSync(join(root, 'a.txt'), 'remote current\n');

    const changed = invoke(['changes', '--session', sessionId]).reply.entries?.[0];
    expect(changed).toMatchObject({ path: 'a.txt', beforeMode: 0o644, afterMode: 0o644 });
    const inspected = invoke(['inspect', '--session', sessionId], { paths: ['a.txt'] }).reply
      .entries?.[0];
    expect(inspected?.beforeBase64).toBe(Buffer.from('baseline\n').toString('base64'));
    expect(inspected?.afterBase64).toBe(Buffer.from('remote current\n').toString('base64'));

    writeFileSync(join(root, 'a.txt'), 'raced after sync\n');
    const conflict = invoke(['apply', '--session', sessionId], {
      entries: [
        {
          path: 'a.txt',
          expectedHash: changed!.afterHash,
          dataBase64: changed!.beforeBase64,
          mode: changed!.beforeMode,
        },
      ],
    });
    expect(conflict.status).toBe(1);
    expect(conflict.reply.conflicts).toEqual([
      { path: 'a.txt', expectedHash: changed!.afterHash, actualHash: expect.any(String) },
    ]);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('raced after sync\n');
    expect(invoke(['destroy', '--session', sessionId]).reply.ok).toBe(true);
  });

  it('preserves executable mode when a git-backed Review restores a file', () => {
    const root = join(scratch, 'git-project');
    mkdirSync(root, { recursive: true });
    execFileSync('git', ['init', '-q', root]);
    const script = join(root, 'run.sh');
    writeFileSync(script, '#!/bin/sh\necho baseline\n');
    chmodSync(script, 0o755);
    const sessionId = id();

    expect(
      invoke(['start', '--session', sessionId, '--root', root, '--workspace', 'remote']).reply.ok,
    ).toBe(true);
    writeFileSync(script, '#!/bin/sh\necho changed\n');
    chmodSync(script, 0o644);
    const changed = invoke(['changes', '--session', sessionId]).reply.entries?.[0];
    expect(changed).toMatchObject({ path: 'run.sh', beforeMode: 0o755, afterMode: 0o644 });

    const applied = invoke(['apply', '--session', sessionId], {
      entries: [
        {
          path: 'run.sh',
          expectedHash: changed!.afterHash,
          dataBase64: changed!.beforeBase64,
          mode: changed!.beforeMode,
        },
      ],
    });
    expect(applied.reply.ok).toBe(true);
    expect(readFileSync(script, 'utf8')).toBe('#!/bin/sh\necho baseline\n');
    expect(statSync(script).mode & 0o777).toBe(0o755);

    expect(invoke(['destroy', '--session', sessionId]).reply.ok).toBe(true);
    const retainedRef = spawnSync('git', [
      '-C',
      root,
      'show-ref',
      '--verify',
      `refs/charter/worker/${sessionId}`,
    ]);
    expect(retainedRef.status).not.toBe(0);
  });
});
