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
  preambleTokens: number;
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
      let uses = 0;
      let lastUsedAt: string | null = null;
      let preambleTokens = 0;
      for (const copy of copies) {
        const row = usageByName.get(copy.name);
        if (!row) continue;
        uses += row.uses;
        preambleTokens += row.preambleTokens;
        lastUsedAt = maxDate(lastUsedAt, row.lastUsedAt);
        usesByAgent.pi += row.byConsumer.charter.uses;
        usesByAgent.claude += row.byConsumer.claude.uses;
        usesByAgent.codex += row.byConsumer.codex.uses;
      }
      const agents = SKILL_AGENTS.map((agent) => agent.id).filter((agent) =>
        copies.some((copy) => skillAgent(copy) === agent),
      );
      const disabledAnywhere = copies.some((copy) => !isAgentEnabled(copy));
      const needsTechnicalReview = copies.some(
        (copy) => copy.status === 'invalid' || copy.compatibility === 'needs-review',
      );
      // Codex rollout files do not currently expose a verified implicit-skill
      // event. Only nominate an unused skill when at least one enabled copy is
      // installed in a consumer whose usage we can actually observe.
      const hasObservedConsumerCopy = copies.some(
        (copy) => skillAgent(copy) !== 'codex' && isAgentEnabled(copy),
      );
      const noObservedUse =
        usageLoaded && hasObservedConsumerCopy && usesByAgent.pi + usesByAgent.claude === 0;
      return {
        key,
        displayName: copies[0]?.displayName ?? key,
        description: copies.find((copy) => copy.description)?.description ?? '',
        copies,
        agents,
        uses,
        usesByAgent,
        lastUsedAt,
        preambleTokens,
        needsTechnicalReview,
        noObservedUse,
        review: needsTechnicalReview || noObservedUse,
        disabledAnywhere,
        protectedOnly: copies.every((copy) => copy.protected === true),
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
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
