import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pi-ide/ipc-contracts';
import {
  ACTIVE_SESSION_GROUP_LIMIT,
  buildRailGroups,
  recordedTasksByProject,
  visibleRailGroupEntries,
  type SessionEntry,
} from '../../apps/desktop-renderer/src/views/rail-groups.js';

/**
 * Rail grouping is pure so the Projects panel can count over the COMPLETE
 * entry list — the three-row project-group cap is a display concern and must
 * never shrink a project card's session count.
 */

function taskEntry(
  id: string,
  project: { name: string; path: string },
  state = 'IDLE',
  changedFiles: number | null = null,
  external: { cli: string; status: 'active' | 'ended' } | null = null,
): SessionEntry {
  const task = {
    id,
    projectName: project.name,
    projectPath: project.path,
    state,
    changedFiles,
    external,
  } as unknown as TaskDto;
  return { key: `task:${id}`, kind: 'task', task };
}

function terminalEntry(id: string, projectName: string, exited = false): SessionEntry {
  return {
    key: `terminal:${id}`,
    kind: 'terminal',
    terminalId: id,
    launch: 'claude',
    projectName,
    exited,
  };
}

const FABLE = { name: 'fable5', path: '/u/fable5' };
const CHARTER = { name: 'charter', path: '/u/charter' };

describe('buildRailGroups', () => {
  it('groups entries by project and appends History last', () => {
    const groups = buildRailGroups([
      taskEntry('t1', FABLE, 'IN_PROGRESS'),
      taskEntry('t2', CHARTER, 'IDLE'),
      taskEntry('t3', FABLE, 'ACCEPTED'),
      terminalEntry('x1', 'fable5', true),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['fable5', 'charter', 'History']);
    expect(groups[0]?.path).toBe(FABLE.path);
    expect(groups[0]?.entries.map((e) => e.key)).toEqual(['task:t1']);
    expect(groups[2]?.entries.map((e) => e.key)).toEqual(['task:t3', 'terminal:x1']);
  });

  it('keeps ended-and-answered external sessions out of the project count', () => {
    const groups = buildRailGroups([
      taskEntry('t1', FABLE, 'IN_PROGRESS', null, { cli: 'codex', status: 'active' }),
      // Exited with zero changes — settled, lives in History.
      taskEntry('t2', FABLE, 'REVIEW_READY', 0, { cli: 'claude', status: 'ended' }),
      // Exited with changes — still wants a decision, stays in the group.
      taskEntry('t3', FABLE, 'REVIEW_READY', 2, { cli: 'claude', status: 'ended' }),
    ]);
    const fable = groups.find((g) => g.path === FABLE.path);
    expect(fable?.entries.map((e) => e.key)).toEqual(['task:t1', 'task:t3']);
    expect(fable?.needs).toBe(1);
  });

  it('counts the complete list — a paginated slice must not be the count source', () => {
    const entries = [
      taskEntry('t1', CHARTER, 'IN_PROGRESS'),
      taskEntry('t2', FABLE, 'IDLE'),
      taskEntry('t3', FABLE, 'IDLE'),
    ];
    const paged = buildRailGroups(entries.slice(0, 2));
    const full = buildRailGroups(entries);
    expect(paged.find((g) => g.path === FABLE.path)?.entries.length).toBe(1);
    expect(full.find((g) => g.path === FABLE.path)?.entries.length).toBe(2);
  });
});

describe('visibleRailGroupEntries', () => {
  const entries = Array.from({ length: 7 }, (_, index) =>
    taskEntry(`t${index + 1}`, FABLE, 'IN_PROGRESS'),
  );
  const group = buildRailGroups(entries)[0]!;

  it('shows at most five active sessions until that directory is expanded', () => {
    expect(ACTIVE_SESSION_GROUP_LIMIT).toBe(5);
    expect(
      visibleRailGroupEntries(group, { expanded: false, filtering: false }).map(
        (entry) => entry.key,
      ),
    ).toEqual(['task:t1', 'task:t2', 'task:t3', 'task:t4', 'task:t5']);
    expect(visibleRailGroupEntries(group, { expanded: true, filtering: false })).toHaveLength(7);
  });

  it('does not hide matching search/filter results or History rows', () => {
    expect(visibleRailGroupEntries(group, { expanded: false, filtering: true })).toHaveLength(7);
    const history = buildRailGroups(
      entries.map((entry, index) => taskEntry(`h${index + 1}`, FABLE, 'ACCEPTED')),
    )[0]!;
    expect(visibleRailGroupEntries(history, { expanded: false, filtering: false })).toHaveLength(7);
  });
});

describe('recordedTasksByProject', () => {
  it('counts active and History tasks alike, ignoring bare terminals', () => {
    const counts = recordedTasksByProject([
      taskEntry('t1', FABLE, 'IN_PROGRESS'),
      taskEntry('t2', FABLE, 'ACCEPTED'),
      taskEntry('t3', CHARTER, 'IDLE'),
      terminalEntry('x1', 'fable5'),
    ]);
    expect(counts.get(FABLE.path)).toBe(2);
    expect(counts.get(CHARTER.path)).toBe(1);
  });
});
