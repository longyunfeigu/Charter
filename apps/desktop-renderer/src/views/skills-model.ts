import type { SkillConsumer, SkillDto, SkillUsageDto } from '@pi-ide/ipc-contracts';

export type SkillAgent = 'pi' | 'claude' | 'codex';
export type SkillStatusFilter = 'all' | 'active' | 'review' | 'disabled';
export type SkillAgentFilter = 'all' | SkillAgent;
export type SkillSort = 'uses' | 'recent' | 'name';

export const SKILL_AGENTS: ReadonlyArray<{
  id: SkillAgent;
  label: string;
  shortLabel: string;
  consumer: SkillConsumer;
}> = [
  { id: 'pi', label: 'Charter Agent', shortLabel: 'Charter', consumer: 'charter' },
  { id: 'claude', label: 'Claude Code', shortLabel: 'Claude', consumer: 'claude' },
  { id: 'codex', label: 'Codex', shortLabel: 'Codex', consumer: 'codex' },
];

export interface SkillGroup {
  key: string;
  displayName: string;
  description: string;
  copies: SkillDto[];
  agents: SkillAgent[];
  uses: number;
  usesByAgent: Record<SkillAgent, number>;
  lastUsedAt: string | null;
  lastUsedByAgent: Record<SkillAgent, string | null>;
  preambleTokens: number;
  preambleTokensByAgent: Record<SkillAgent, number>;
  needsTechnicalReview: boolean;
  noObservedUse: boolean;
  review: boolean;
  disabledAnywhere: boolean;
  protectedOnly: boolean;
}

export function skillAgent(skill: SkillDto): SkillAgent {
  if (skill.source === 'claude') return 'claude';
  if (skill.source === 'codex') return 'codex';
  return 'pi';
}

export function isAgentEnabled(skill: SkillDto): boolean {
  if (skill.agentEnabled !== undefined) return skill.agentEnabled;
  // Backward-compatible truth for a renderer talking to an older main
  // process: a discovered Claude/Codex folder is natively available to that
  // Agent even when Charter has not trusted it for Pi context. Newer main
  // processes send agentEnabled=false explicitly for parked copies.
  if (skill.source === 'claude' || skill.source === 'codex') return true;
  return skill.enabled;
}

export function skillNeedsReview(skill: SkillDto): boolean {
  return skill.status === 'invalid' || skill.compatibility === 'needs-review';
}

export function skillReviewReasons(skill: SkillDto): string[] {
  if (!skillNeedsReview(skill)) return [];
  if (skill.issues.length > 0) return skill.issues;
  const reasons: string[] = [];
  if (skill.status === 'invalid') reasons.push('SKILL.md failed validation.');
  if (skill.compatibility === 'needs-review') {
    reasons.push('Instructions require a compatibility review for this Agent.');
  }
  return reasons;
}

function maxDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

export function groupSkills(
  skills: SkillDto[],
  usage: SkillUsageDto[],
  usageLoaded = true,
): SkillGroup[] {
  const usageByName = new Map(usage.map((row) => [row.name, row]));
  const grouped = new Map<string, SkillDto[]>();
  for (const skill of skills) {
    const key = skill.displayName.trim().toLocaleLowerCase() || skill.name.toLocaleLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), skill]);
  }

  return [...grouped.entries()]
    .map(([key, copies]): SkillGroup => {
      const usesByAgent: Record<SkillAgent, number> = { pi: 0, claude: 0, codex: 0 };
      const lastUsedByAgent: Record<SkillAgent, string | null> = {
        pi: null,
        claude: null,
        codex: null,
      };
      const preambleTokensByAgent: Record<SkillAgent, number> = { pi: 0, claude: 0, codex: 0 };
      let uses = 0;
      let lastUsedAt: string | null = null;
      let preambleTokens = 0;
      for (const copy of copies) {
        const row = usageByName.get(copy.name);
        if (!row) continue;
        uses += row.uses;
        preambleTokens += row.preambleTokens;
        lastUsedAt = maxDate(lastUsedAt, row.lastUsedAt);
        const owner = skillAgent(copy);
        preambleTokensByAgent[owner] += row.preambleTokens;
        for (const agent of SKILL_AGENTS) {
          const series = row.byConsumer[agent.consumer];
          usesByAgent[agent.id] += series.uses;
          lastUsedByAgent[agent.id] = maxDate(lastUsedByAgent[agent.id], series.lastUsedAt);
        }
      }
      const agents = SKILL_AGENTS.map((agent) => agent.id).filter((agent) =>
        copies.some((copy) => skillAgent(copy) === agent),
      );
      const disabledAnywhere = copies.some((copy) => !isAgentEnabled(copy));
      const needsTechnicalReview = copies.some(skillNeedsReview);
      const hasObservedConsumerCopy = copies.some(isAgentEnabled);
      const noObservedUse = usageLoaded && hasObservedConsumerCopy && uses === 0;
      return {
        key,
        displayName: copies[0]?.displayName ?? key,
        description: copies.find((copy) => copy.description)?.description ?? '',
        copies,
        agents,
        uses,
        usesByAgent,
        lastUsedAt,
        lastUsedByAgent,
        preambleTokens,
        preambleTokensByAgent,
        needsTechnicalReview,
        noObservedUse,
        review: needsTechnicalReview || noObservedUse,
        disabledAnywhere,
        protectedOnly: copies.every((copy) => copy.protected === true),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Project grouped catalog data into one Agent's point of view. The selected
 * Agent owns every row-level decision: installed copies, usage, recency,
 * review state and sort metrics. `all` preserves the comparison view. */
export function scopeSkillGroups(
  groups: SkillGroup[],
  agent: SkillAgentFilter,
  usageLoaded = true,
): SkillGroup[] {
  if (agent === 'all') return groups;
  return groups.flatMap((group) => {
    const copies = group.copies.filter((copy) => skillAgent(copy) === agent);
    if (copies.length === 0) return [];
    const uses = group.usesByAgent[agent];
    const needsTechnicalReview = copies.some(skillNeedsReview);
    const noObservedUse = usageLoaded && copies.some(isAgentEnabled) && uses === 0;
    return [
      {
        ...group,
        description: copies.find((copy) => copy.description)?.description ?? '',
        copies,
        agents: [agent],
        uses,
        lastUsedAt: group.lastUsedByAgent[agent],
        preambleTokens: group.preambleTokensByAgent[agent],
        needsTechnicalReview,
        noObservedUse,
        review: needsTechnicalReview || noObservedUse,
        disabledAnywhere: copies.some((copy) => !isAgentEnabled(copy)),
        protectedOnly: copies.every((copy) => copy.protected === true),
      },
    ];
  });
}

export function filterSkillGroups(
  groups: SkillGroup[],
  options: {
    status: SkillStatusFilter;
    agent: SkillAgentFilter;
    query: string;
    sort: SkillSort;
  },
): SkillGroup[] {
  const query = options.query.trim().toLocaleLowerCase();
  const filtered = groups.filter((group) => {
    if (options.status === 'active' && group.uses === 0) return false;
    if (options.status === 'review' && !group.review) return false;
    if (options.status === 'disabled' && !group.disabledAnywhere) return false;
    if (options.agent !== 'all' && !group.agents.includes(options.agent)) return false;
    if (
      query &&
      !`${group.displayName} ${group.description} ${group.copies.map((copy) => copy.sourceLabel).join(' ')}`
        .toLocaleLowerCase()
        .includes(query)
    ) {
      return false;
    }
    return true;
  });

  return filtered.sort((a, b) => {
    if (options.sort === 'name') return a.displayName.localeCompare(b.displayName);
    if (options.sort === 'recent') {
      return (
        (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0) -
          (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0) || b.uses - a.uses
      );
    }
    return b.uses - a.uses || b.preambleTokens - a.preambleTokens;
  });
}

export function skillGroupCounts(groups: SkillGroup[]): Record<SkillStatusFilter, number> {
  return {
    all: groups.length,
    active: groups.filter((group) => group.uses > 0).length,
    review: groups.filter((group) => group.review).length,
    disabled: groups.filter((group) => group.disabledAnywhere).length,
  };
}
