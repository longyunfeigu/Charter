import { describe, expect, it } from 'vitest';
import type { SkillDto, SkillUsageDto } from '@pi-ide/ipc-contracts';
import { groupSkills, isAgentEnabled } from './skills-model.js';

function skill(source: SkillDto['source'], patch: Partial<SkillDto> = {}): SkillDto {
  return {
    id: `${source}-skill`,
    name: `${source}-skill`,
    displayName: 'shared-skill',
    description: 'Shared skill.',
    enabled: false,
    explicitOnly: false,
    source,
    sourceId: source,
    sourceLabel: source,
    sourcePath: `~/.${source}/skills/shared-skill`,
    live: source !== 'managed',
    status: 'ready',
    compatibility: 'compatible',
    issues: [],
    revision: 'r'.repeat(64),
    files: ['SKILL.md'],
    scriptCount: 0,
    importedAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    ...patch,
  };
}

function usage(name: string, charterUses = 0, claudeUses = 0): SkillUsageDto {
  const empty = { uses: 0, lastUsedAt: null, weekly: [0] };
  const uses = charterUses + claudeUses;
  return {
    name,
    preambleTokens: 0,
    uses,
    lastUsedAt: uses > 0 ? '2026-07-30T00:00:00.000Z' : null,
    weekly: [uses],
    byConsumer: {
      charter: {
        uses: charterUses,
        lastUsedAt: charterUses > 0 ? '2026-07-30T00:00:00.000Z' : null,
        weekly: [charterUses],
      },
      claude: {
        uses: claudeUses,
        lastUsedAt: claudeUses > 0 ? '2026-07-30T00:00:00.000Z' : null,
        weekly: [claudeUses],
      },
      codex: empty,
    },
  };
}

describe('Agent-native Skill status', () => {
  it('does not mistake Charter trust for Claude/Codex native availability', () => {
    expect(isAgentEnabled(skill('claude'))).toBe(true);
    expect(isAgentEnabled(skill('codex'))).toBe(true);
    expect(isAgentEnabled(skill('managed'))).toBe(false);
  });

  it('honors an explicit parked-copy state from the current main process', () => {
    expect(isAgentEnabled(skill('claude', { agentEnabled: false }))).toBe(false);
    expect(isAgentEnabled(skill('claude', { agentEnabled: true }))).toBe(true);
  });
});

describe('Skills review evidence', () => {
  it('flags an enabled tracked copy only after usage evidence has loaded', () => {
    const tracked = skill('managed', { enabled: true, agentEnabled: true });
    expect(groupSkills([tracked], [], false)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
    expect(groupSkills([tracked], [], true)[0]).toMatchObject({
      noObservedUse: true,
      review: true,
    });
  });

  it('does not call a Codex-only skill unused while Codex evidence is unavailable', () => {
    const codexOnly = skill('codex', { agentEnabled: true });
    expect(groupSkills([codexOnly], [], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
  });

  it('clears the no-observed-use reason when Charter or Claude usage exists', () => {
    const tracked = skill('managed', { enabled: true, agentEnabled: true });
    expect(groupSkills([tracked], [usage(tracked.name, 1)], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
    expect(groupSkills([tracked], [usage(tracked.name, 0, 1)], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
  });

  it('keeps invalid or incompatible copies reviewable without usage evidence', () => {
    const invalid = skill('managed', {
      status: 'invalid',
      compatibility: 'needs-review',
    });
    expect(groupSkills([invalid], [], false)[0]).toMatchObject({
      needsTechnicalReview: true,
      review: true,
    });
  });
});
