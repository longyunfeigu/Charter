import { describe, expect, it } from 'vitest';
import type { TimelineEventDto, VerificationRunDto } from '@pi-ide/ipc-contracts';
import {
  currentVerificationRuns,
  isCurrentVerificationPass,
  latestFinalReport,
  reportExecutionFailed,
} from './verification-evidence.js';

function run(id: string, overrides: Partial<VerificationRunDto> = {}): VerificationRunDto {
  return {
    id,
    label: 'tests',
    state: 'passed',
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    stale: false,
    superseded: false,
    outputExcerpt: '',
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

describe('verification evidence', () => {
  it('does not present stale or superseded success as a current pass', () => {
    expect(isCurrentVerificationPass(run('current'))).toBe(true);
    expect(isCurrentVerificationPass(run('stale', { stale: true }))).toBe(false);
    expect(isCurrentVerificationPass(run('old', { superseded: true }))).toBe(false);
  });

  it('keeps only the current durable run for each label', () => {
    expect(
      currentVerificationRuns([
        run('old', { superseded: true }),
        run('new'),
        run('lint', { label: 'lint', state: 'failed', exitCode: 1 }),
      ]).map((item) => item.id),
    ).toEqual(['new', 'lint']);
  });

  it('uses the latest system report to gate failed execution evidence', () => {
    const timeline = [
      { type: 'report.final', payload: { outcome: 'completed' } },
      { type: 'agent.message', payload: { text: 'unverified claim' } },
      { type: 'report.final', payload: { outcome: 'failed' } },
    ] as TimelineEventDto[];
    const report = latestFinalReport(timeline);
    expect(reportExecutionFailed(report)).toBe(true);
    expect(report?.outcome).toBe('failed');
  });
});
