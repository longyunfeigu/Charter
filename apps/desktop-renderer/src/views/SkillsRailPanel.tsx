import React, { useEffect, useMemo } from 'react';
import { useSkillsStore } from '../store/skillsStore.js';
import { useSkillsViewStore } from '../store/skillsViewStore.js';
import { Ic } from './home-icons.js';
import {
  groupSkills,
  scopeSkillGroups,
  skillGroupCounts,
  SKILL_AGENTS,
  type SkillStatusFilter,
} from './skills-model.js';

const NAV: ReadonlyArray<{ id: SkillStatusFilter; label: string; icon: string }> = [
  { id: 'all', label: 'All skills', icon: 'puzzle' },
  { id: 'active', label: 'Observed use', icon: 'checkCircle' },
  { id: 'review', label: 'Needs review', icon: 'alert' },
  { id: 'disabled', label: 'Disabled', icon: 'ban' },
];

export function SkillsRailPanel(): React.JSX.Element {
  const skills = useSkillsStore((state) => state.skills);
  const usage = useSkillsStore((state) => state.usage);
  const usageLoaded = useSkillsStore((state) => state.usageLoaded);
  const init = useSkillsStore((state) => state.init);
  const status = useSkillsViewStore((state) => state.status);
  const agent = useSkillsViewStore((state) => state.agent);
  const setStatus = useSkillsViewStore((state) => state.setStatus);
  const allGroups = useMemo(
    () => groupSkills(skills, usage, usageLoaded),
    [skills, usage, usageLoaded],
  );
  const groups = useMemo(
    () => scopeSkillGroups(allGroups, agent, usageLoaded),
    [agent, allGroups, usageLoaded],
  );
  const counts = useMemo(() => skillGroupCounts(groups), [groups]);
  const selectedAgent = agent === 'all' ? null : SKILL_AGENTS.find((item) => item.id === agent)!;

  useEffect(() => init(), [init]);

  return (
    <div className="skills-rail-panel" data-testid="skills-rail-panel">
      <header className="skills-rail-head">
        <strong>Skills</strong>
        <small>
          Installed copies and observed usage{' '}
          {selectedAgent ? `for ${selectedAgent.label}.` : 'across Agents.'}
        </small>
      </header>

      <nav className="skills-rail-nav" aria-label="Skill views">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={status === item.id ? 'on' : ''}
            data-testid={`skills-rail-${item.id}`}
            onClick={() => setStatus(item.id)}
          >
            <Ic name={item.icon} size={13} />
            <span>{item.label}</span>
            <b>
              {!usageLoaded && (item.id === 'active' || item.id === 'review')
                ? '—'
                : counts[item.id]}
            </b>
          </button>
        ))}
      </nav>

      <div className="skills-rail-section">Usage evidence</div>
      <div className="skills-rail-coverage">
        <div>
          <i className="agent-pi" />
          <span>Charter Agent</span>
          <small>exact ledger</small>
        </div>
        <div>
          <i className="agent-claude" />
          <span>Claude Code</span>
          <small>transcript-derived</small>
        </div>
        <div>
          <i className="agent-codex" />
          <span>Codex</span>
          <small>transcript-derived</small>
        </div>
      </div>
    </div>
  );
}
