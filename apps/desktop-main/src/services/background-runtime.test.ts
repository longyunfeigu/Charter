import { describe, expect, it } from 'vitest';
import {
  backgroundActivity,
  backgroundActivityLines,
  backgroundTrayTitle,
  rendererCrashAction,
  windowCloseAction,
} from './background-runtime.js';

describe('background runtime close policy', () => {
  it('normalizes counts and does not hold an idle application open', () => {
    const activity = backgroundActivity({
      managedAgents: -1,
      externalAgents: 0,
      terminalJobs: 0,
      missions: 0,
      remoteConnections: Number.NaN,
    });
    expect(activity).toMatchObject({ agentCount: 0, hasRunningWork: false });
    expect(windowCloseAction('keep-running', activity)).toBe('close');
  });

  it('keeps managed and external Agents distinct while presenting one total', () => {
    const activity = backgroundActivity({
      managedAgents: 2,
      externalAgents: 3,
      terminalJobs: 1,
      missions: 1,
      remoteConnections: 1,
    });
    expect(activity).toMatchObject({
      agentCount: 5,
      managedAgentCount: 2,
      externalAgentCount: 3,
      hasRunningWork: true,
    });
    expect(windowCloseAction('ask', activity)).toBe('ask');
    expect(windowCloseAction('keep-running', activity)).toBe('keep-running');
    expect(windowCloseAction('quit', activity)).toBe('quit');
    expect(backgroundActivityLines(activity)).toEqual([
      '5 Agents',
      '1 Mission',
      '1 terminal job',
      '1 remote connection',
    ]);
    expect(backgroundTrayTitle(activity)).toBe(
      'Charter — 5 Agents, 1 Mission, 1 terminal job, 1 remote connection',
    );
  });

  it('deduplicates unsaved blockers and treats them as work that needs a decision', () => {
    const activity = backgroundActivity({
      managedAgents: 0,
      externalAgents: 0,
      terminalJobs: 0,
      missions: 0,
      remoteConnections: 0,
      blockers: ['2 unsaved files', '2 unsaved files'],
    });
    expect(activity.blockers).toEqual(['2 unsaved files']);
    expect(activity.hasRunningWork).toBe(true);
    expect(windowCloseAction('ask', activity)).toBe('ask');
    expect(windowCloseAction('quit', activity)).toBe('ask');
    expect(windowCloseAction('keep-running', activity)).toBe('keep-running');
  });
});

describe('renderer crash recovery policy', () => {
  it('reloads in place for isolated crashes', () => {
    expect(rendererCrashAction([1000], 1000).action).toBe('reload');
    expect(rendererCrashAction([0, 30_000], 30_000).action).toBe('reload');
  });

  it('escalates to asking only on a crash loop (3+ within the window)', () => {
    const now = 60_000;
    expect(rendererCrashAction([now - 50_000, now - 20_000, now], now).action).toBe('ask');
  });

  it('forgets crashes older than the loop window', () => {
    const now = 200_000;
    // Two stale crashes + one fresh: not a loop.
    const verdict = rendererCrashAction([1000, 2000, now], now);
    expect(verdict.action).toBe('reload');
    expect(verdict.recentCrashes).toEqual([now]);
  });
});
