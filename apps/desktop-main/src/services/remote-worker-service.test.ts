import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, ProductFailure } from '@pi-ide/foundation';
import type { ExecResult, SftpSession } from '@pi-ide/ssh-service';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import type { AppPaths } from '../app-paths.js';
import type { ExternalSessionService, RemoteExternalChange } from './external-session-service.js';
import { RemoteWorkerService } from './remote-worker-service.js';

const ok = (payload: Record<string, unknown>): ExecResult => ({
  code: 0,
  stdout: `${JSON.stringify({ ok: true, ...payload })}\n`,
  stderr: '',
});

function task(projectPath: string): TaskDto {
  return {
    id: 'task-remote',
    workspaceId: 'ws-remote',
    title: 'remote',
    goalMd: '',
    acceptance: [],
    mode: 'ask',
    state: 'REVIEW_READY',
    model: { providerId: 'external', modelId: 'claude' },
    verification: [],
    archived: false,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:01:00.000Z',
    gitBaseline: null,
    projectName: 'server · project',
    projectPath,
    changedFiles: 1,
    worktree: null,
    external: {
      cli: 'claude',
      terminalId: 'term-old',
      cwd: '/srv/project',
      snapshotRef: null,
      status: 'ended',
      sessionId: null,
      remote: {
        hostId: 'host-1',
        hostLabel: 'server',
        root: '/srv/project',
        workerSessionId: 'rws_recovered123',
        workerVersion: '1.2.0',
      },
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'charter-remote-worker-test-'));
  const bundlePath = join(root, 'remote-session-worker.cjs');
  writeFileSync(bundlePath, 'worker bytes');
  const bundleHash = createHash('sha256').update('worker bytes').digest('hex');
  const baseline = Buffer.from('baseline\n');
  const current = Buffer.from('remote current\n');
  let netEntries: Array<Record<string, unknown>> = [
    {
      path: 'a.txt',
      kind: 'modified',
      beforeHash: createHash('sha256').update(baseline).digest('hex'),
      afterHash: createHash('sha256').update(current).digest('hex'),
      beforeBase64: baseline.toString('base64'),
      afterBase64: current.toString('base64'),
      beforeMode: 0o644,
      afterMode: 0o644,
    },
  ];
  let connected = true;
  const exec = vi.fn(async (_hostId: string, command: string, input?: string) => {
    if (command === "'/usr/bin/node' -p 'process.versions.node'") {
      return { code: 0, stdout: '20.18.0\n', stderr: '' } satisfies ExecResult;
    }
    if (command.endsWith(' hello')) {
      return ok({
        protocol: 1,
        version: '1.2.0',
        sha256: bundleHash,
        capabilities: [
          'baseline',
          'changes',
          'inspect',
          'apply',
          'conflict-check',
          'local-workspace-bridge',
        ],
      });
    }
    if (command.includes(' inspect ')) {
      expect(JSON.parse(input ?? '{}')).toEqual({ paths: ['a.txt'] });
      return ok({
        sessionId: 'rws_recovered123',
        root: '/srv/project',
        entries: [
          {
            path: 'a.txt',
            kind: 'modified',
            beforeHash: createHash('sha256').update(baseline).digest('hex'),
            afterHash: createHash('sha256').update(baseline).digest('hex'),
            beforeBase64: baseline.toString('base64'),
            afterBase64: baseline.toString('base64'),
            beforeMode: 0o644,
            afterMode: 0o644,
          },
        ],
      });
    }
    if (command.includes(' changes ')) {
      return ok({ sessionId: 'rws_recovered123', root: '/srv/project', entries: netEntries });
    }
    if (command.includes(' apply ')) {
      return {
        code: 1,
        stdout: `${JSON.stringify({
          ok: false,
          error: 'Remote files changed after the last sync.',
          conflicts: [{ path: 'a.txt' }],
        })}\n`,
        stderr: '',
      } satisfies ExecResult;
    }
    return { code: 127, stdout: '', stderr: 'unexpected command' } satisfies ExecResult;
  });
  const sftp = {
    realpath: vi.fn(async () => '/home/tester'),
    stat: vi.fn(async () => ({ type: 'file' as const, size: 12 })),
    close: vi.fn(),
  } as unknown as SftpSession;
  const service = new RemoteWorkerService({
    exec,
    probeNode: async () => ({ found: true, path: '/usr/bin/node' }),
    openSftp: async () => sftp,
    bundlePath,
    paths: { remoteMirrorsDir: root } as AppPaths,
    logger: createLogger('test', { write: () => {} }),
    isConnected: () => connected,
  });
  const ingestRemoteChanges = vi.fn(
    async (
      _terminalId: string | null,
      _taskId: string,
      _changes: RemoteExternalChange[],
    ): Promise<void> => undefined,
  );
  service.attachExternalSessions({
    ingestRemoteChanges,
    noteRemoteSyncFailure: vi.fn(),
  } as unknown as ExternalSessionService);
  service.attachTaskLookup(() => task(root));
  service.attachChangedPathLookup(async () => [
    { path: 'a.txt', currentHash: createHash('sha256').update('after').digest('hex') },
  ]);
  return {
    service,
    exec,
    sftp,
    ingestRemoteChanges,
    setNetEntries: (entries: Array<Record<string, unknown>>) => {
      netEntries = entries;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

describe('RemoteWorkerService', () => {
  it('inspects durable paths once after restart before accepting an empty net diff', async () => {
    const { service, sftp, ingestRemoteChanges, setNetEntries } = fixture();
    setNetEntries([]);

    await service.syncTask('task-remote');

    expect(ingestRemoteChanges).toHaveBeenCalledTimes(2);
    expect(ingestRemoteChanges.mock.calls[0]![2]).toMatchObject([
      { path: 'a.txt', beforeHash: expect.any(String), afterHash: expect.any(String) },
    ]);
    expect(ingestRemoteChanges.mock.calls[1]![2]).toEqual([]);
    expect(sftp.realpath).toHaveBeenCalledWith('.');
    service.dispose();
  });

  it('fails closed when a remote Review apply loses its expected-hash race', async () => {
    const { service } = fixture();
    await service.syncTask('task-remote');

    await expect(service.pushMirrorPaths('task-remote', ['a.txt'])).rejects.toBeInstanceOf(
      ProductFailure,
    );
    service.dispose();
  });

  it('does not reconnect a server just to discover an Agent id during terminal exit', async () => {
    const { service, exec, setConnected } = fixture();
    setConnected(false);
    const calls = exec.mock.calls.length;

    await expect(service.discoverCliSession('task-remote', 'claude')).resolves.toBeNull();
    expect(exec).toHaveBeenCalledTimes(calls);
    service.dispose();
  });
});
