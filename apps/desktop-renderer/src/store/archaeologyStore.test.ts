import { describe, expect, it } from 'vitest';
import type { DiscoveredSessionDto } from '@pi-ide/ipc-contracts';
import { isDiscoveryStale, sessionsInScope, unknownDirectories } from './archaeologyStore.js';

function session(partial: Partial<DiscoveredSessionDto>): DiscoveredSessionDto {
  return {
    cli: 'claude',
    sessionId: '6f3a92c1-0000-4000-8000-000000000001',
    cwd: '/Users/dev/git/blog',
    projectPath: '/Users/dev/git/blog',
    attribution: 'cwd',
    title: 't',
    startedAt: null,
    endedAt: null,
    filesTouched: [],
    skills: [],
    turnCount: 1,
    trackedTaskId: null,
    ...partial,
  };
}

describe('sessionsInScope (ADR-0038)', () => {
  const sessions = [
    session({ sessionId: '6f3a92c1-0000-4000-8000-000000000001' }),
    // Attributed by files, launched from home — still belongs to the project.
    session({
      sessionId: '6f3a92c1-0000-4000-8000-000000000002',
      cwd: '/Users/dev',
      attribution: 'files',
    }),
    // Subdirectory launch inside the scope path.
    session({
      sessionId: '6f3a92c1-0000-4000-8000-000000000003',
      cwd: '/Users/dev/git/blog/apps/web',
    }),
    session({
      sessionId: '6f3a92c1-0000-4000-8000-000000000004',
      cwd: '/opt/elsewhere',
      projectPath: null,
      attribution: 'none',
    }),
  ];

  it('matches by attributed project, exact cwd and cwd prefix', () => {
    const scoped = sessionsInScope(sessions, '/Users/dev/git/blog');
    expect(scoped.map((s) => s.sessionId.slice(-1))).toEqual(['1', '2', '3']);
  });

  it('null scope means everything', () => {
    expect(sessionsInScope(sessions, null)).toHaveLength(4);
  });

  it('never matches sibling directories that merely share a prefix', () => {
    const sibling = [session({ cwd: '/Users/dev/git/blog-gen', projectPath: null })];
    expect(sessionsInScope(sibling, '/Users/dev/git/blog')).toHaveLength(0);
  });
});

describe('unknownDirectories (Agent activity list)', () => {
  it('groups unattributed sessions by cwd, newest first, merging CLIs', () => {
    const dirs = unknownDirectories([
      session({ projectPath: null, cwd: '/a', endedAt: '2026-07-01T00:00:00Z' }),
      session({
        projectPath: null,
        cwd: '/a',
        cli: 'codex',
        sessionId: '6f3a92c1-0000-4000-8000-00000000000a',
        endedAt: '2026-07-10T00:00:00Z',
      }),
      session({ projectPath: null, cwd: '/b', endedAt: '2026-07-20T00:00:00Z' }),
      session({ cwd: '/tracked-project' }), // attributed → never an unknown dir
    ]);
    expect(dirs).toEqual([
      { cwd: '/b', count: 1, lastAt: '2026-07-20T00:00:00Z', clis: ['claude'] },
      { cwd: '/a', count: 2, lastAt: '2026-07-10T00:00:00Z', clis: ['claude', 'codex'] },
    ]);
  });
});

describe('isDiscoveryStale', () => {
  it('treats missing, unparsable and old scans as stale; fresh ones not', () => {
    const now = Date.parse('2026-07-20T12:00:00Z');
    expect(isDiscoveryStale(null, now)).toBe(true);
    expect(isDiscoveryStale('garbage', now)).toBe(true);
    expect(isDiscoveryStale('2026-07-20T11:00:00Z', now)).toBe(true);
    expect(isDiscoveryStale('2026-07-20T11:59:30Z', now)).toBe(false);
  });
});
