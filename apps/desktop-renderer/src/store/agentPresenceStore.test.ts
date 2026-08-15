import { describe, expect, it } from 'vitest';
import type { AgentPresenceSnapshot } from '@pi-ide/ipc-contracts';
import { agentPresencePresentation } from './agentPresenceStore.js';

function presence(patch: Partial<AgentPresenceSnapshot> = {}): AgentPresenceSnapshot {
  return {
    terminalId: 'term-1',
    taskId: 'task-1',
    agent: 'claude',
    processState: 'running',
    lifecycle: 'unknown',
    attention: 'none',
    source: 'process',
    identitySeq: 1,
    stateChangeSeq: 1,
    changedAt: '2026-08-11T10:00:00.000Z',
    message: null,
    matchedRuleId: null,
    manifestVersion: '2026.08.11.1',
    ...patch,
  };
}

describe('agentPresencePresentation', () => {
  it('keeps process, lifecycle and attention meanings separate', () => {
    expect(agentPresencePresentation(presence()).label).toBe('Starting');
    expect(agentPresencePresentation(presence({ lifecycle: 'working' })).label).toBe('Working');
    expect(agentPresencePresentation(presence({ lifecycle: 'blocked' }))).toMatchObject({
      label: 'Needs you',
      tone: 'attention',
    });
    expect(
      agentPresencePresentation(presence({ lifecycle: 'idle', attention: 'done' })).label,
    ).toBe('Done');
    expect(agentPresencePresentation(presence({ lifecycle: 'idle' })).label).toBe('Ready');
    expect(agentPresencePresentation(presence({ processState: 'exited' })).label).toBe('Ended');
  });
});
