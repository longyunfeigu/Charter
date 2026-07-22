import { describe, expect, it } from 'vitest';
import type { TimelineEventDto } from './agent-dto.js';
import {
  ActivityItemSchema,
  projectActivity,
  projectActivityEvent,
  toolPaths,
} from './activity.js';

let seq = 0;
function evt(type: string, payload: unknown): TimelineEventDto {
  seq += 1;
  return {
    id: `evt-${seq}`,
    taskId: 'task-1',
    sequence: seq,
    type,
    schemaVersion: 1,
    at: '2026-07-13T12:00:00.000Z',
    payload,
  };
}

describe('projectActivityEvent (ADR-0006 pure projection)', () => {
  it('maps agent messages, questions and user messages', () => {
    const message = projectActivityEvent(evt('agent.message', { text: 'Done with step one.' }))!;
    expect(message.kind).toBe('message');
    expect(message.label).toBe('Done with step one.');
    expect(message.author).toBe('agent');

    const question = projectActivityEvent(
      evt('agent.question', { prompt: { callId: 'c1', question: 'Which database?' } }),
    )!;
    expect(question.kind).toBe('question');
    expect(question.status).toBe('pending');
    expect(question.label).toContain('Which database?');
    expect(question.callId).toBe('c1');

    const answer = projectActivityEvent(
      evt('user.message', { text: 'Use sqlite', kind: 'answer', callId: 'c1' }),
    )!;
    expect(answer.kind).toBe('answer');
    expect(answer.author).toBe('user');

    const steer = projectActivityEvent(evt('user.message', { text: 'focus on tests' }))!;
    expect(steer.kind).toBe('user');
  });

  it('maps tool calls to semantic kinds with paths — actions, not file diffs', () => {
    const read = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-r',
        name: 'read_file',
        state: 'SUCCEEDED',
        ok: true,
        summary: 'read 120 lines',
        input: { path: './src/index.ts' },
      }),
    )!;
    expect(read.kind).toBe('read');
    expect(read.label).toBe('Read src/index.ts');
    expect(read.paths).toEqual(['src/index.ts']);
    expect(read.key).toBe('call-r'); // callId identity so running→terminal replaces

    const search = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-s',
        name: 'search_text',
        state: 'SUCCEEDED',
        ok: true,
        summary: '3 matches',
        input: { query: 'rate limit' },
      }),
    )!;
    expect(search.kind).toBe('search');
    expect(search.label).toContain('rate limit');

    const command = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-c',
        name: 'run_command',
        state: 'SUCCEEDED',
        ok: true,
        summary: 'exit 0',
        input: { executable: 'npm', args: ['test'], cwd: '' },
      }),
    )!;
    expect(command.kind).toBe('command');
    expect(command.label).toBe('Ran npm test');
    expect(command.detail).toBe('exit 0');

    const write = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-w',
        name: 'apply_patch',
        state: 'SUCCEEDED',
        ok: true,
        summary: 'patched',
        input: { path: 'src/auth/limiter.ts', patch: '...', baseHash: 'h' },
      }),
    )!;
    expect(write.kind).toBe('write');
    expect(write.label).toBe('Edited src/auth/limiter.ts');
    expect(write.paths).toEqual(['src/auth/limiter.ts']);

    const rename = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-m',
        name: 'rename_file',
        state: 'SUCCEEDED',
        ok: true,
        summary: 'moved',
        input: { from: 'a.ts', to: 'b.ts' },
      }),
    )!;
    expect(rename.paths).toEqual(['a.ts', 'b.ts']);
    expect(rename.label).toBe('Renamed a.ts → b.ts');
  });

  it('shows live running state and failure/denial states', () => {
    const running = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-1',
        name: 'run_command',
        state: 'RUNNING',
        ok: null,
        summary: null,
        input: { executable: 'npm', args: ['test'] },
      }),
    )!;
    expect(running.status).toBe('running');
    expect(running.label).toBe('Running npm test…');

    const denied = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-2',
        name: 'apply_patch',
        state: 'DENIED',
        ok: false,
        summary: 'denied by user',
        input: { path: 'x.ts' },
      }),
    )!;
    expect(denied.status).toBe('denied');

    const failed = projectActivityEvent(
      evt('tool.call', {
        callId: 'call-3',
        name: 'apply_patch',
        state: 'FAILED',
        ok: false,
        summary: 'CHG_VERSION_CONFLICT',
        input: { path: 'x.ts' },
      }),
    )!;
    expect(failed.status).toBe('error');
    expect(failed.label).toBe('Edit failed: x.ts');
  });

  it('silences tool lifecycles that have richer dedicated events', () => {
    for (const name of ['ask_user', 'propose_plan', 'update_plan']) {
      expect(
        projectActivityEvent(
          evt('tool.call', { callId: 'c', name, state: 'SUCCEEDED', ok: true, input: {} }),
        ),
      ).toBeNull();
    }
    expect(
      projectActivityEvent(
        evt('agent.toolProposed', { call: { callId: 'c', toolName: 'ask_user', input: {} } }),
      ),
    ).toBeNull();
  });

  it('maps plan, permission, verification and review events', () => {
    const plan = projectActivityEvent(
      evt('agent.planProposed', {
        plan: { version: 1, summary: 'Do it in 3 steps', steps: [{}, {}, {}] },
      }),
    )!;
    expect(plan.kind).toBe('plan');
    expect(plan.label).toBe('Proposed a plan (3 steps)');
    expect(plan.status).toBe('pending');
    // V3.2: the recorded plan version is the id-backed join key its decision carries.
    expect(plan.parentKey).toBe('plan-v1');

    const decision = projectActivityEvent(
      evt('user.planDecision', { decision: 'approved', auto: true, edited: false, version: 1 }),
    )!;
    expect(decision.label).toContain('auto-approved');
    expect(decision.author).toBe('system');
    expect(decision.parentKey).toBe('plan-v1');

    // No recorded version → no join key (never inferred from adjacency).
    const versionless = projectActivityEvent(
      evt('user.planDecision', { decision: 'approved', auto: false, edited: false }),
    )!;
    expect(versionless.parentKey).toBeUndefined();

    const requested = projectActivityEvent(
      evt('permission.requested', {
        card: { preview: { summary: 'Modify 1 file', targets: ['src/a.ts'] } },
      }),
    )!;
    expect(requested.kind).toBe('permission');
    expect(requested.status).toBe('pending');
    expect(requested.paths).toEqual(['src/a.ts']);

    const terminalRequested = projectActivityEvent(
      evt('permission.requested', {
        card: {
          toolName: 'terminal.send',
          preview: { summary: 'Send to worker', targets: ['term_worker'] },
        },
      }),
    )!;
    expect(terminalRequested.paths).toEqual([]);
    expect(terminalRequested.evidenceKinds).toEqual(['terminal']);

    const decided = projectActivityEvent(
      evt('permission.decided', { outcome: 'allowed', actor: 'user', summary: 'Modify 1 file' }),
    )!;
    expect(decided.status).toBe('ok');
    expect(decided.author).toBe('user');

    const verification = projectActivityEvent(
      evt('verification.completed', {
        run: { label: 'npm test', state: 'failed', exitCode: 1, outputExcerpt: '2 failing' },
      }),
    )!;
    expect(verification.status).toBe('error');
    expect(verification.label).toBe('Verification failed: npm test (exit 1)');

    const review = projectActivityEvent(
      evt('review.decision', { path: 'src/a.ts', scope: 'hunk', decision: 'reject' }),
    )!;
    expect(review.author).toBe('user');
    expect(review.label).toContain('rejected a change block in src/a.ts');
  });

  it('maps lifecycle/state events and drops noise', () => {
    const state = projectActivityEvent(
      evt('task.stateChanged', { from: 'PLANNING', to: 'AWAITING_PLAN_APPROVAL' }),
    )!;
    expect(state.label).toBe('Waiting for your plan approval');
    expect(state.status).toBe('pending');

    const failed = projectActivityEvent(
      evt('run.failed', { runId: 'r', error: { userMessage: 'Provider rejected the key.' } }),
    )!;
    expect(failed.status).toBe('error');
    expect(failed.detail).toBe('Provider rejected the key.');

    const report = projectActivityEvent(
      evt('report.final', { changed: { files: 3 }, unverified: true }),
    )!;
    expect(report.label).toBe('Final report — 3 files changed');
    expect(report.status).toBe('warn');

    expect(projectActivityEvent(evt('agent.usage', { usage: {} }))).toBeNull();
    expect(projectActivityEvent(evt('totally.unknown', {}))).toBeNull();
  });

  it('marks a full rollback as a touched-files reset (turn rollback stays additive)', () => {
    // task.rolledBack restored EVERYTHING byte-exact: any touched-files fold
    // must start over, or the Diff tool keeps counting restored files.
    const full = projectActivityEvent(evt('task.rolledBack', { restored: ['add.py'] }))!;
    expect(full.kind).toBe('state');
    expect(full.status).toBe('warn');
    expect(full.filesReset).toBe(true);
    expect(() => ActivityItemSchema.parse(full)).not.toThrow();

    // One-turn rollback leaves earlier turns' changes in place — no reset.
    const turn = projectActivityEvent(evt('turn.rolledBack', { restored: ['add.py'] }))!;
    expect(turn.filesReset).toBeUndefined();
    expect(turn.paths).toEqual(['add.py']);
  });

  it('never throws on malformed payloads and validates against the schema', () => {
    const types = [
      'user.message',
      'agent.message',
      'agent.question',
      'agent.toolProposed',
      'tool.call',
      'agent.planProposed',
      'user.planDecision',
      'permission.requested',
      'permission.decided',
      'verification.completed',
      'review.decision',
      'task.stateChanged',
      'run.failed',
      'report.final',
    ];
    for (const type of types) {
      for (const payload of [null, 'garbage', 42, {}, { nested: { junk: true } }]) {
        const item = projectActivityEvent(evt(type, payload));
        if (item) expect(() => ActivityItemSchema.parse(item)).not.toThrow();
      }
    }
  });

  it('projects batches in order, dropping nulls', () => {
    const items = projectActivity([
      evt('agent.message', { text: 'a' }),
      evt('agent.usage', {}),
      evt('agent.message', { text: 'b' }),
    ]);
    expect(items.map((i) => i.label)).toEqual(['a', 'b']);
  });

  it('projects external evidence with explicit provenance and no invented semantics', () => {
    const file = projectActivityEvent(
      evt('external.fileChanged', {
        cli: 'claude',
        captureGrade: 'observed',
        changeId: 'chg-1',
        path: 'report.md',
        kind: 'modified',
        additions: 4,
        deletions: 1,
      }),
    )!;
    expect(file.source).toBe('claude');
    expect(file.captureGrade).toBe('observed');
    expect(file.changeIds).toEqual(['chg-1']);
    expect(file.evidenceKinds).toEqual(['file']);

    const structured = projectActivityEvent(
      evt('external.observation', {
        cli: 'codex',
        captureGrade: 'structured',
        kind: 'permission',
        label: 'Codex requested command approval',
        status: 'pending',
        evidenceKinds: ['permission', 'tool'],
      }),
    )!;
    expect(structured.source).toBe('codex');
    expect(structured.captureGrade).toBe('structured');
    expect(structured.kind).toBe('permission');
    expect(structured.evidenceKinds).toEqual(['permission', 'tool']);
  });

  it('toolPaths cleans ./ prefixes and handles renames', () => {
    expect(toolPaths('read_file', { path: './x/y.ts' })).toEqual(['x/y.ts']);
    expect(toolPaths('rename_file', { from: './a', to: 'b' })).toEqual(['a', 'b']);
    expect(toolPaths('run_command', { executable: 'npm' })).toEqual([]);
  });
});
