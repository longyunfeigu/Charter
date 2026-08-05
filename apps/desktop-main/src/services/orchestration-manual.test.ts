import { describe, expect, it } from 'vitest';
import { CHARTER_ORCHESTRATION_SKILL } from './orchestration-manual.js';

describe('charter-orchestration Skill', () => {
  it('teaches direct recursive delegation and structured lifecycle', () => {
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('Every task begins as an ordinary Session');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('Do not promote solely because a keyword');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('`orchestration.promote`');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('there is no confirmation step');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('never replace');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('Mission Assignments');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('Every Mission member may delegate recursively');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('never ask A to proxy');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('stable idempotency key');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('orchestration.complete');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('active Attempt');
    expect(CHARTER_ORCHESTRATION_SKILL).toContain('charter orchestration inspect');
  });
});
