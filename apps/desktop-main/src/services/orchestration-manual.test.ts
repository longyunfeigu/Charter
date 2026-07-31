import { describe, expect, it } from 'vitest';
import { CHARTER_ORCHESTRATION_SKILL } from './orchestration-manual.js';

describe('charter-orchestration Skill', () => {
  it('teaches direct recursive delegation and structured lifecycle', () => {
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('Every Mission member may delegate recursively');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('never ask A to proxy');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('stable idempotency key');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('orchestration.complete');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('active Attempt');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('charter orchestration inspect');
  });
});
