import React, { useMemo } from 'react';
import { useMemoryStore } from '../store/memoryStore.js';
import { useMemoryViewStore, type MemoryAgent } from '../store/memoryViewStore.js';

const AGENTS: ReadonlyArray<{
  id: MemoryAgent;
  mark: string;
  label: string;
  description: string;
}> = [
  {
    id: 'claude',
    mark: '✳',
    label: 'Claude Code',
    description: 'Instructions and private project notes',
  },
  { id: 'codex', mark: '▣', label: 'Codex', description: 'Global Agent instructions' },
  { id: 'charter', mark: '◆', label: 'Charter', description: 'Reviewed project rules' },
];

export function MemoryRailPanel(): React.JSX.Element {
  const tree = useMemoryStore((state) => state.tree);
  const agent = useMemoryViewStore((state) => state.agent);
  const setAgent = useMemoryViewStore((state) => state.setAgent);
  const counts = useMemo(
    () => ({
      claude: tree
        ? tree.claude.global.length +
          tree.claude.projects.reduce((sum, group) => sum + group.files.length, 0)
        : 0,
      codex: tree?.codex.global.length ?? 0,
      charter: tree
        ? tree.charter.projects.reduce(
            (sum, project) => sum + project.ruleCount + project.candidateCount,
            0,
          )
        : 0,
    }),
    [tree],
  );

  return (
    <div className="memory-rail-panel" data-testid="memory-rail-panel">
      <header className="memory-rail-head">
        <small>Knowledge</small>
        <strong>Memory</strong>
        <p>See what each Agent carries between Sessions and projects.</p>
      </header>
      <nav className="memory-rail-nav" aria-label="Memory agents">
        <span className="memory-rail-label">Agents</span>
        {AGENTS.map((item) => (
          <button
            key={item.id}
            className={agent === item.id ? 'on' : ''}
            data-testid={`memory-nav-${item.id}`}
            aria-current={agent === item.id ? 'page' : undefined}
            onClick={() => setAgent(item.id)}
          >
            <span className="mv-agent-logo" aria-hidden="true">
              {item.mark}
            </span>
            <span className="memory-rail-copy">
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
            <span className="memory-rail-count">{counts[item.id]}</span>
          </button>
        ))}
      </nav>
      <aside className="memory-rail-note">
        Charter rules are explicit and reviewable. Claude and Codex files stay owned by their
        respective tools.
      </aside>
    </div>
  );
}
