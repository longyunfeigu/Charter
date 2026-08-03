import { describe, expect, it } from 'vitest';
import type { SkillDto, SkillUsageDto } from '@pi-ide/ipc-contracts';
import {
  filterSkillGroups,
  groupSkills,
  isAgentEnabled,
  scopeSkillGroups,
  skillGroupCounts,
  skillNeedsReview,
  skillReviewReasons,
} from './skills-model.js';

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

function usage(name: string, charterUses = 0, claudeUses = 0, codexUses = 0): SkillUsageDto {
  const uses = charterUses + claudeUses + codexUses;
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
      codex: {
        uses: codexUses,
        lastUsedAt: codexUses > 0 ? '2026-07-30T00:00:00.000Z' : null,
        weekly: [codexUses],
      },
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
  it('explains review state with recorded issues or a useful fallback', () => {
    const compatibilityReview = skill('codex', {
      compatibility: 'needs-review',
      issues: ['Instructions reference an Agent-specific integration.'],
    });
    expect(skillNeedsReview(compatibilityReview)).toBe(true);
    expect(skillReviewReasons(compatibilityReview)).toEqual([
      'Instructions reference an Agent-specific integration.',
    ]);
    expect(skillReviewReasons(skill('managed', { status: 'invalid', issues: [] }))).toEqual([
      'SKILL.md failed validation.',
    ]);
  });

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

  it('flags a Codex-only skill when its rollout has no observed use', () => {
    const codexOnly = skill('codex', { agentEnabled: true });
    expect(groupSkills([codexOnly], [], true)[0]).toMatchObject({
      noObservedUse: true,
      review: true,
    });
  });

  it('clears the no-observed-use reason when any Agent usage exists', () => {
    const tracked = skill('managed', { enabled: true, agentEnabled: true });
    expect(groupSkills([tracked], [usage(tracked.name, 1)], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
    expect(groupSkills([tracked], [usage(tracked.name, 0, 1)], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
    });
    const codexOnly = skill('codex', { agentEnabled: true });
    expect(groupSkills([codexOnly], [usage(codexOnly.name, 0, 0, 1)], true)[0]).toMatchObject({
      noObservedUse: false,
      review: false,
      usesByAgent: { pi: 0, claude: 0, codex: 1 },
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

describe('Agent-scoped Skills perspective', () => {
  it('scopes copies, metrics and review decisions to the selected Agent', () => {
    const charter = skill('managed', {
      id: 'charter-copy',
      name: 'charter-copy',
      enabled: true,
      agentEnabled: true,
    });
    const claude = skill('claude', {
      id: 'claude-copy',
      name: 'claude-copy',
      agentEnabled: true,
      description: 'Claude-specific description.',
    });
    const codex = skill('codex', {
      id: 'codex-copy',
      name: 'codex-copy',
      agentEnabled: false,
      status: 'invalid',
      compatibility: 'needs-review',
    });
    const groups = groupSkills(
      [charter, claude, codex],
      [usage(charter.name, 2, 7), usage(codex.name, 0, 0, 11)],
      true,
    );

    const claudeView = scopeSkillGroups(groups, 'claude', true)[0]!;
    expect(claudeView).toMatchObject({
      description: 'Claude-specific description.',
      agents: ['claude'],
      uses: 7,
      needsTechnicalReview: false,
      noObservedUse: false,
      review: false,
      disabledAnywhere: false,
    });
    expect(claudeView.copies.map((copy) => copy.id)).toEqual(['claude-copy']);
    expect(skillGroupCounts([claudeView])).toEqual({ all: 1, active: 1, review: 0, disabled: 0 });

    const codexView = scopeSkillGroups(groups, 'codex', true)[0]!;
    expect(codexView).toMatchObject({
      agents: ['codex'],
      uses: 11,
      needsTechnicalReview: true,
      noObservedUse: false,
      review: true,
      disabledAnywhere: true,
    });
    expect(skillGroupCounts([codexView])).toEqual({ all: 1, active: 1, review: 1, disabled: 1 });
  });

  it('uses selected-Agent evidence for unused state and sorting', () => {
    const alphaClaude = skill('claude', {
      id: 'alpha-claude',
      name: 'alpha-claude',
      displayName: 'alpha',
      agentEnabled: true,
    });
    const alphaCodex = skill('codex', {
      id: 'alpha-codex',
      name: 'alpha-codex',
      displayName: 'alpha',
      agentEnabled: true,
    });
    const betaClaude = skill('claude', {
      id: 'beta-claude',
      name: 'beta-claude',
      displayName: 'beta',
      agentEnabled: true,
    });
    const groups = groupSkills(
      [alphaClaude, alphaCodex, betaClaude],
      [usage(alphaCodex.name, 0, 0, 50), usage(betaClaude.name, 0, 5)],
      true,
    );
    const claudeGroups = scopeSkillGroups(groups, 'claude', true);
    expect(claudeGroups.find((group) => group.key === 'alpha')).toMatchObject({
      uses: 0,
      noObservedUse: true,
      review: true,
    });
    expect(
      filterSkillGroups(claudeGroups, {
        status: 'all',
        agent: 'all',
        query: '',
        sort: 'uses',
      }).map((group) => group.key),
    ).toEqual(['beta', 'alpha']);
    expect(scopeSkillGroups(groups, 'pi', true)).toEqual([]);
  });
});
