import { describe, expect, it } from 'vitest';
import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import {
  terminalMissionOwnedTaskIds,
  visibleProjectSessionTasks,
} from './mission-session-visibility.js';

function task(id: string, terminalId?: string): TaskDto {
  return {
    id,
    ...(terminalId
      ? {
          external: {
            cli: 'claude',
            terminalId,
            status: 'active',
          },
        }
      : {}),
  } as unknown as TaskDto;
}

function mission(input: {
  state: MissionSnapshotDto['mission']['state'];
  runtimeSessionId: string;
  terminalId?: string | null;
  deleted?: boolean;
}): MissionSnapshotDto {
  return {
    mission: {
      id: 'mission-1',
      state: input.state,
      originConversationTaskId: 'origin',
      leadAssignmentId: 'lead',
      deletedAt: input.deleted ? '2026-08-05T00:00:00.000Z' : null,
    },
    assignments: [
      { id: 'lead', activeAttemptId: 'lead-attempt' },
      { id: 'child', activeAttemptId: 'child-attempt' },
    ],
    attempts: [
      {
        id: 'lead-attempt',
        runtimeSessionId: 'managed-task:origin',
        terminalId: null,
      },
      {
        id: 'child-attempt',
        runtimeSessionId: input.runtimeSessionId,
        terminalId: input.terminalId ?? null,
      },
    ],
  } as unknown as MissionSnapshotDto;
}

describe('terminal Mission Session visibility', () => {
  it('hides a completed Mission child while preserving its origin Session', () => {
    const tasks = [task('origin'), task('child-task'), task('standalone')];
    const snapshot = mission({
      state: 'COMPLETED',
      runtimeSessionId: 'managed-task:child-task',
    });

    expect(terminalMissionOwnedTaskIds([snapshot], tasks)).toEqual(new Set(['child-task']));
    expect(visibleProjectSessionTasks(tasks, [snapshot]).map((item) => item.id)).toEqual([
      'origin',
      'standalone',
    ]);
  });

  it('keeps children visible while their Mission is still active', () => {
    const tasks = [task('origin'), task('child-task')];
    const snapshot = mission({
      state: 'RUNNING',
      runtimeSessionId: 'managed-task:child-task',
    });

    expect(visibleProjectSessionTasks(tasks, [snapshot])).toEqual(tasks);
  });

  it('matches visible terminal children for cancelled and deleted Missions', () => {
    const tasks = [task('origin'), task('child-task', 'terminal-child')];
    const snapshot = mission({
      state: 'RUNNING',
      runtimeSessionId: 'terminal:terminal-child',
      terminalId: null,
      deleted: true,
    });

    expect(terminalMissionOwnedTaskIds([snapshot], tasks)).toEqual(new Set(['child-task']));
  });
});
