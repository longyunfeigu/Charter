import { describe, expect, it } from 'vitest';
import type { ActivityItem } from './activity.js';
import { IDLE_FOLD_MS, STORY_MAX_MS, projectReplay, type ReplayTaskContext } from './replay.js';

let seq = 0;

function item(at: string, overrides: Partial<ActivityItem> = {}): ActivityItem {
  seq += 1;
  return {
    key: overrides.key ?? `evt-${seq}`,
    taskId: 'task-1',
    sequence: overrides.sequence ?? seq,
    at,
    kind: 'message',
    label: 'event',
    status: 'ok',
    paths: [],
    author: 'agent',
    source: 'pi',
    captureGrade: 'full',
    ...overrides,
  };
}

function task(overrides: Partial<ReplayTaskContext> = {}): ReplayTaskContext {
  return {
    id: 'task-1',
    goalMd: 'Fix the flaky login test',
    state: 'REVIEW_READY',
    createdAt: '2026-07-15T00:00:00.000Z',
    external: null,
    ...overrides,
  };
}

function at(seconds: number): string {
  return new Date(Date.parse('2026-07-15T00:00:00.000Z') + seconds * 1000).toISOString();
}

describe('replay projection — evidence levels', () => {
  it('maps capture grades to per-fact levels and never upgrades observed facts', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), { captureGrade: 'full' }),
        item(at(1), { source: 'claude', captureGrade: 'observed', kind: 'command' }),
        item(at(2), { source: 'claude', captureGrade: 'structured', kind: 'command' }),
      ],
    });
    expect(facts.map((f) => f.level)).toEqual(['recorded', 'observed', 'recorded']);
    expect(facts.map((f) => f.capture)).toEqual(['full', 'observed', 'structured']);
  });

  it('marks only passed verification facts as verified', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'verification', status: 'ok' }),
        item(at(1), { kind: 'verification', status: 'error' }),
        item(at(2), { kind: 'write', status: 'ok', changeIds: ['chg-1'] }),
      ],
    });
    expect(facts[0]!.level).toBe('verified');
    expect(facts[1]!.level).toBe('recorded');
    // A file change alone is recorded, never verified (§5.2).
    expect(facts[2]!.level).toBe('recorded');
  });

  it('never emits a session-global grade: mixed sessions keep per-fact levels', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { captureGrade: 'observed', source: 'claude', kind: 'command' }),
        item(at(1), {
          captureGrade: 'structured',
          source: 'claude',
          kind: 'write',
          changeIds: ['c1'],
        }),
        item(at(2), { captureGrade: 'observed', source: 'claude', kind: 'command' }),
      ],
    });
    expect(facts.map((f) => f.level)).toEqual(['observed', 'recorded', 'observed']);
    // Coverage keeps an observed interval; a single structured event cannot paint the run.
    expect(session.coverage.some((c) => c.level === 'observed')).toBe(true);
  });
});

describe('replay projection — story time', () => {
  it('keeps the same fact when switching between story and actual time', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [item(at(0)), item(at(7)), item(at(600)), item(at(610))],
    });
    for (const fact of facts) {
      expect(fact.storyEndMs).toBeGreaterThan(fact.storyStartMs);
      expect(fact.actualEndMs).toBeGreaterThanOrEqual(fact.actualStartMs);
    }
    // Story order matches sequence order — a fact identifies the same moment in both modes.
    const sorted = [...facts].sort((a, b) => a.storyStartMs - b.storyStartMs);
    expect(sorted.map((f) => f.id)).toEqual(facts.map((f) => f.id));
  });

  it('folds long idle gaps instead of stretching story time', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task(),
      items: [item(at(0)), item(at(1)), item(at(1800)), item(at(1801))],
    });
    expect(facts[2]!.idleBeforeMs).toBeGreaterThanOrEqual(IDLE_FOLD_MS);
    // The 30-minute gap must not become 30 minutes of story time.
    expect(session.storyDurationMs).toBeLessThanOrEqual(STORY_MAX_MS);
    // The folded gap is honest: coverage reports it as missing, not as recorded.
    expect(session.coverage.some((c) => c.level === 'missing')).toBe(true);
  });

  it('does not stretch a short task to fill the recap window', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [item(at(0)), item(at(2)), item(at(4))],
    });
    expect(session.storyDurationMs).toBeLessThan(20_000);
  });

  it('groups repeated low-impact reads and keeps mandatory events full-size', () => {
    seq = 0;
    const reads = Array.from({ length: 12 }, (_, i) =>
      item(at(10 + i), {
        kind: 'read',
        toolName: 'read_file',
        paths: ['src/a.ts'],
        label: `Read src/a.ts`,
      }),
    );
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'user', author: 'user', label: 'You: fix it' }),
        ...reads,
        item(at(30), { kind: 'permission', status: 'ok', label: 'Approved: run tests' }),
        item(at(40), {
          kind: 'write',
          changeIds: ['chg-1'],
          diffstat: { additions: 4, deletions: 1 },
          paths: ['src/a.ts'],
        }),
      ],
    });
    const readFacts = facts.filter((f) => f.kind === 'read');
    expect(new Set(readFacts.map((f) => f.groupKey)).size).toBe(1);
    expect(readFacts[0]!.groupSize).toBe(12);
    const groupSpan = readFacts.at(-1)!.storyEndMs - readFacts[0]!.storyStartMs;
    const permission = facts.find((f) => f.kind === 'permission')!;
    const write = facts.find((f) => f.kind === 'write')!;
    expect(permission.mandatory).toBe(true);
    expect(write.mandatory).toBe(true);
    // The whole repeated-read run gets less story time than one approval.
    expect(permission.storyEndMs - permission.storyStartMs).toBeGreaterThanOrEqual(groupSpan / 2);
  });

  it('gives every mandatory fact a perceivable story frame in a long run', () => {
    seq = 0;
    const items: ActivityItem[] = [];
    for (let i = 0; i < 400; i += 1) {
      items.push(
        item(at(i * 4), {
          kind: i % 50 === 0 ? 'write' : 'read',
          ...(i % 50 === 0 ? { changeIds: [`c${i}`] } : {}),
        }),
      );
    }
    items.push(
      item(at(1700), { kind: 'verification', status: 'error', label: 'Verification failed' }),
    );
    items.push(item(at(1710), { kind: 'report', label: 'Final report — 3 files changed' }));
    const { facts, session } = projectReplay({ task: task(), items });
    expect(session.storyDurationMs).toBeLessThanOrEqual(STORY_MAX_MS * 1.5);
    for (const fact of facts.filter((f) => f.mandatory)) {
      expect(fact.storyEndMs - fact.storyStartMs).toBeGreaterThanOrEqual(300);
    }
  });
});

describe('replay projection — relations', () => {
  it('links permission facts to tool calls only through recorded ids', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), {
          kind: 'command',
          callId: 'call-1',
          key: 'call-1',
          label: 'Running npm test…',
          status: 'running',
        }),
        item(at(1), {
          kind: 'permission',
          status: 'pending',
          callId: 'call-1',
          parentKey: 'req-1',
          label: 'Waiting for approval: run npm test',
        }),
        item(at(2), {
          kind: 'permission',
          status: 'ok',
          parentKey: 'req-1',
          label: 'Approved: run npm test',
        }),
      ],
    });
    const requested = facts[1]!;
    const decided = facts[2]!;
    expect(requested.relations).toContainEqual({ type: 'requested-by', factId: facts[0]!.id });
    expect(decided.relations).toContainEqual({ type: 'requested-by', factId: requested.id });
  });

  it('creates no relations from temporal adjacency', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'command' }),
        item(at(0.5), { kind: 'write', changeIds: ['c1'] }),
      ],
    });
    expect(facts.every((f) => f.relations.length === 0)).toBe(true);
  });
});

describe('replay projection — chapters', () => {
  it('selects at most 8 chapters and prioritizes failures, approvals and verification', () => {
    seq = 0;
    const items: ActivityItem[] = [
      item(at(0), { kind: 'user', author: 'user', label: 'You: do the thing' }),
    ];
    for (let i = 0; i < 60; i += 1) {
      items.push(
        item(at(5 + i * 2), { kind: 'read', label: `Read file-${i}.ts`, paths: [`file-${i}.ts`] }),
      );
    }
    items.push(
      item(at(200), { kind: 'command', status: 'error', label: 'Command failed: npm test' }),
    );
    items.push(item(at(210), { kind: 'permission', status: 'ok', label: 'Approved: write file' }));
    items.push(
      item(at(220), {
        kind: 'write',
        changeIds: ['c1'],
        diffstat: { additions: 10, deletions: 2 },
        paths: ['src/x.ts'],
      }),
    );
    items.push(
      item(at(230), { kind: 'verification', status: 'ok', label: 'Verification passed: tests' }),
    );
    items.push(item(at(240), { kind: 'report', label: 'Final report — 1 file changed' }));
    const { session, facts } = projectReplay({ task: task(), items });
    expect(session.chapters.length).toBeLessThanOrEqual(8);
    const chapterFactIds = new Set(session.chapters.map((c) => c.factId));
    const byLabel = (label: string) => facts.find((f) => f.action.includes(label))!.id;
    expect(chapterFactIds.has(byLabel('failed'))).toBe(true);
    expect(chapterFactIds.has(byLabel('Approved'))).toBe(true);
    expect(chapterFactIds.has(byLabel('Verification passed'))).toBe(true);
    expect(chapterFactIds.has(byLabel('Final report'))).toBe(true);
    expect(chapterFactIds.has(byLabel('You:'))).toBe(true);
  });
});

describe('replay projection — session summary', () => {
  it('derives the result card deterministically with citations', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'user', author: 'user', label: 'You: fix login' }),
        item(at(10), {
          kind: 'write',
          changeIds: ['c1'],
          diffstat: { additions: 12, deletions: 3 },
          paths: ['src/login.ts'],
        }),
        item(at(20), {
          kind: 'verification',
          status: 'ok',
          label: 'Verification passed: npm test',
        }),
        item(at(30), {
          kind: 'report',
          label: 'Final report — 1 file changed',
          detail: 'Fixed the login race.',
        }),
      ],
    });
    expect(session.goal).toBe('Fix the flaky login test');
    expect(session.outcome).toBe('completed');
    expect(session.verification).toBe('verified');
    expect(session.summary.changed.length).toBeGreaterThan(0);
    expect(session.summary.changed[0]!.label).toContain('src/login.ts');
    expect(session.summary.citations.length).toBeGreaterThan(0);
  });

  it('downgrades verification when changes land after the last passed run', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'verification', status: 'ok' }),
        item(at(10), { kind: 'write', changeIds: ['c1'], paths: ['a.ts'] }),
      ],
    });
    expect(session.verification).toBe('partial');
  });

  it('reports failures and denials as attention items', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task({ state: 'FAILED' }),
      items: [
        item(at(0), { kind: 'command', status: 'error', label: 'Command failed: npm build' }),
        item(at(1), { kind: 'permission', status: 'denied', label: 'Denied: delete file' }),
      ],
    });
    expect(session.outcome).toBe('attention');
    expect(session.verification).toBe('unverified');
    expect(session.summary.attention.length).toBeGreaterThanOrEqual(2);
  });

  it('marks a missing goal honestly for external sessions', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task({ goalMd: '', external: { cli: 'claude', status: 'ended' } }),
      items: [item(at(0), { source: 'claude', captureGrade: 'observed', kind: 'state' })],
    });
    expect(session.goalRecorded).toBe(false);
  });

  it('treats running states as a provisional session', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task({ state: 'IN_PROGRESS' }),
      items: [item(at(0))],
      nowMs: Date.parse(at(120)),
    });
    expect(session.outcome).toBe('running');
    expect(session.actualDurationMs).toBeGreaterThanOrEqual(120_000);
  });
});

describe('replay projection — coverage', () => {
  it('computes interval coverage without letting one strong event paint neighbors', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { captureGrade: 'observed', source: 'claude', kind: 'command' }),
        item(at(60), {
          captureGrade: 'structured',
          source: 'claude',
          kind: 'write',
          changeIds: ['c1'],
        }),
        item(at(120), { captureGrade: 'observed', source: 'claude', kind: 'command' }),
      ],
    });
    const levels = session.coverage.map((c) => c.level);
    expect(levels.filter((l) => l === 'observed').length).toBeGreaterThanOrEqual(2);
    // Intervals are contiguous over actual time.
    for (let i = 1; i < session.coverage.length; i += 1) {
      expect(session.coverage[i]!.actualStartMs).toBe(session.coverage[i - 1]!.actualEndMs);
    }
  });
});

describe('replay projection — non-coding work through the real ingest shape', () => {
  // These fixtures use the same normalized `external.observation` fields the
  // recorder emits (app/resource/evidenceKinds are recorded, never inferred).
  function appItem(atSeconds: number, overrides: Partial<ActivityItem>): ActivityItem {
    return item(at(atSeconds), {
      source: 'claude',
      captureGrade: 'structured',
      ...overrides,
    });
  }

  it('keeps recorded app/resource identity on facts and never invents one', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task({ goalMd: 'Research the Q2 market and mail the brief' }),
      items: [
        appItem(0, {
          kind: 'search',
          label: 'Checked 14 public sources',
          app: 'Browser',
          resource: 'https://research.example/q2',
          evidenceKinds: ['application'],
        }),
        appItem(10, {
          kind: 'message',
          label: 'Draft sent to product team',
          app: 'Mail',
          resource: 'thread-812',
          evidenceKinds: ['application'],
        }),
        appItem(20, { kind: 'command', label: 'terminal refresh', captureGrade: 'observed' }),
      ],
    });
    expect(facts[0]!.app).toBe('Browser');
    expect(facts[0]!.resource).toBe('https://research.example/q2');
    expect(facts[1]!.app).toBe('Mail');
    // The observed terminal fact gained no app identity from its neighbours.
    expect(facts[2]!.app).toBeUndefined();
    expect(facts[2]!.level).toBe('observed');
  });

  it('projects an approval-centric workflow with recorded risk and lanes', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task({ goalMd: 'Purchase approval for the vendor renewal' }),
      items: [
        item(at(0), { kind: 'user', author: 'user', label: 'You: renew the vendor contract' }),
        item(at(5), {
          kind: 'permission',
          status: 'pending',
          label: 'Waiting for approval: purchase order #81',
          callId: 'call-9',
          parentKey: 'req-9',
          riskLevel: 'R3',
        }),
        item(at(9), {
          kind: 'permission',
          status: 'ok',
          label: 'Approved: purchase order #81',
          parentKey: 'req-9',
          riskLevel: 'R3',
        }),
      ],
    });
    const decided = facts[2]!;
    expect(decided.lane).toBe('risk');
    expect(decided.risk).toBe('high');
    expect(decided.mandatory).toBe(true);
    expect(decided.relations).toContainEqual({ type: 'requested-by', factId: facts[1]!.id });
    expect(session.chapters.some((c) => c.category === 'decision')).toBe(true);
  });
});

describe('replay projection — V3.1 pivot detection', () => {
  it('marks a second agent plan proposal as a pivot with id-backed refs', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'user', author: 'user', label: 'You: fix it' }),
        item(at(5), { kind: 'plan', status: 'pending', label: 'Proposed a plan (2 steps)' }),
        item(at(60), { kind: 'command', status: 'error', label: 'Command failed: npm test' }),
        item(at(70), {
          kind: 'plan',
          status: 'pending',
          label: 'Proposed a plan (3 steps)',
          detail: 'Switch to single-flight refresh instead of a mutex.',
        }),
      ],
    });
    const first = facts[1]!;
    const failed = facts[2]!;
    const revised = facts[3]!;
    expect(first.pivot).toBeUndefined();
    expect(revised.pivot).toBeDefined();
    expect(revised.pivot!.reason).toContain('single-flight');
    expect(revised.pivot!.refFactIds).toContain(first.id);
    expect(revised.pivot!.refFactIds).toContain(failed.id);
    expect(session.chapters.some((c) => c.category === 'pivot')).toBe(true);
  });

  it('never marks plan progress ticks or same-call lifecycles as pivots', () => {
    seq = 0;
    const { facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'plan', status: 'pending', label: 'Proposed a plan' }),
        // Progress tick (agent.planUpdated → status info): not a revision.
        item(at(10), { kind: 'plan', status: 'info', label: 'Updated plan progress' }),
        // Same-key lifecycle pair (external TodoWrite running → ok): one proposal.
        item(at(20), { kind: 'plan', status: 'running', key: 'call-td', label: 'TodoWrite' }),
        item(at(21), { kind: 'plan', status: 'ok', key: 'call-td', label: 'TodoWrite done' }),
      ],
    });
    expect(facts.filter((f) => f.pivot).length).toBe(1); // only the call-td proposal after the first plan
    expect(facts[1]!.pivot).toBeUndefined();
    expect(facts[3]!.pivot).toBeUndefined();
  });
});

describe('replay projection — V3.1 outward actions and dual-track summary', () => {
  it('marks recorded-app agent actions as outward and lists them in the summary', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task({ goalMd: 'Compare vendors and notify procurement' }),
      items: [
        item(at(0), { kind: 'user', author: 'user', label: 'You: compare and notify' }),
        item(at(5), {
          kind: 'search',
          label: 'Web search: vendor pricing',
          app: 'Web',
        }),
        item(at(10), {
          kind: 'command',
          label: 'Sent the comparison to procurement',
          app: 'Mail',
          resource: 'thread-77',
        }),
        item(at(20), { kind: 'read', label: 'Read quote.pdf', app: 'Files' }),
      ],
    });
    expect(facts[1]!.outward).toBeUndefined(); // searches stay inward
    expect(facts[2]!.outward).toBe(true);
    expect(facts[3]!.outward).toBeUndefined(); // reads stay inward
    expect(session.summary.outward).toHaveLength(1);
    expect(session.summary.outward[0]!.label).toContain('procurement');
    // Dual-track result: zero files but recorded outward actions.
    expect(session.summary.result).toContain('对外动作');
    expect(session.summary.result).not.toContain('未记录文件变更或对外动作');
  });

  it('never infers outward identity without a recorded app', () => {
    seq = 0;
    const { facts, session } = projectReplay({
      task: task(),
      items: [item(at(0), { kind: 'command', label: 'Ran curl -X POST https://api.example' })],
    });
    expect(facts[0]!.outward).toBeUndefined();
    expect(session.summary.outward).toHaveLength(0);
    expect(session.summary.result).toContain('未记录文件变更或对外动作');
  });

  it('pins high-risk outward actions first in attention', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [
        item(at(0), { kind: 'command', status: 'error', label: 'Command failed: build' }),
        item(at(5), {
          kind: 'command',
          label: 'Posted the release note',
          app: 'Slack',
          riskLevel: 'R3',
        }),
      ],
    });
    expect(session.summary.attention[0]!.label).toContain('对外动作');
    expect(session.summary.attention.some((a) => a.label.includes('failed'))).toBe(true);
  });
});

describe('replay projection — V3.1 conclusion and inputs', () => {
  it('quotes the recorded final report verbatim as the conclusion, anchored to its fact', () => {
    seq = 0;
    const { session, facts } = projectReplay({
      task: task(),
      items: [
        item(at(0), {
          kind: 'report',
          label: 'Final report — 1 file changed',
          detail: 'Fixed the login race by single-flighting the token refresh.',
        }),
      ],
    });
    expect(session.summary.conclusion).not.toBeNull();
    expect(session.summary.conclusion!.text).toContain('single-flighting');
    expect(session.summary.conclusion!.factId).toBe(facts[0]!.id);
  });

  it('returns a null conclusion when no report prose was recorded', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [item(at(0), { kind: 'write', changeIds: ['c1'], paths: ['a.ts'] })],
    });
    expect(session.summary.conclusion).toBeNull();
  });

  it('collects user-attached code refs as recorded inputs', () => {
    seq = 0;
    const { session } = projectReplay({
      task: task(),
      items: [
        item(at(0), {
          kind: 'user',
          author: 'user',
          label: 'You: fix auth',
          paths: ['src/auth/client.ts', 'docs/auth.md'],
        }),
        item(at(5), { kind: 'read', paths: ['src/other.ts'] }),
      ],
    });
    expect(session.inputs.files).toEqual(['src/auth/client.ts', 'docs/auth.md']);
  });
});

describe('replay projection — scale', () => {
  it('projects 10k facts quickly', () => {
    seq = 0;
    const items: ActivityItem[] = [];
    for (let i = 0; i < 10_000; i += 1) {
      items.push(
        item(at(i), {
          kind: i % 200 === 0 ? 'write' : i % 3 === 0 ? 'read' : 'command',
          ...(i % 200 === 0 ? { changeIds: [`c${i}`] } : {}),
          paths: [`src/f${i % 40}.ts`],
        }),
      );
    }
    const started = performance.now();
    const { facts, session } = projectReplay({ task: task(), items });
    const elapsed = performance.now() - started;
    expect(facts.length).toBe(10_000);
    expect(session.chapters.length).toBeLessThanOrEqual(8);
    expect(elapsed).toBeLessThan(1_000);
  });
});
