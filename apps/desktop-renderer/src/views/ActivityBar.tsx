import React from 'react';
import type { RailView } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { needsAttention } from './labels.js';
import { Ic } from './home-icons.js';

export type ActivityDestination = RailView | 'remotes';

interface ActivityBarProps {
  active: ActivityDestination;
  projectsOpen?: boolean;
  onSelect(view: Exclude<RailView, 'files'>): void;
  onProjects(): void;
  onRemotes(): void;
}

/** The stable application-level navigation shared by local and Remote rails. */
export function ActivityBar({
  active,
  projectsOpen = false,
  onSelect,
  onProjects,
  onRemotes,
}: ActivityBarProps): React.JSX.Element {
  const app = useAppStore();
  const inboxCount = useTaskStore(
    (state) => state.tasks.filter((task) => !task.archived && needsAttention(task)).length,
  );
  const sessionsActive = active === 'sessions' || active === 'files';

  return (
    <nav className="sr-activity" aria-label="Application">
      <div className="sr-activity-brand" aria-label="Charter">
        <Ic name="flag" size={15} />
      </div>
      <button
        className={`sr-activity-item ${sessionsActive ? 'active' : ''}`}
        data-testid="rail-view-sessions"
        aria-label="Sessions"
        title="Sessions"
        onClick={() => onSelect('sessions')}
      >
        <Ic name="terminal" size={16} />
      </button>
      <button
        className={`sr-activity-item ${active === 'inbox' ? 'active' : ''}`}
        data-testid="rail-needs-you"
        aria-label="Needs attention"
        title="Needs attention"
        onClick={() => onSelect('inbox')}
      >
        <Ic name="inbox" size={16} />
        {inboxCount > 0 ? <span className="sr-mini-badge">{inboxCount}</span> : null}
      </button>
      <button
        className={`sr-activity-item ${active === 'projects' ? 'active' : ''}`}
        data-testid="rail-view-projects"
        aria-label="Projects"
        title="Projects"
        aria-pressed={active === 'projects' && projectsOpen}
        onClick={onProjects}
      >
        <Ic name="folder" size={16} />
      </button>
      <button
        className={`sr-activity-item ${active === 'remotes' ? 'active' : ''}`}
        data-testid="rail-view-remotes"
        aria-label="Remote Explorer"
        title="Remote Explorer"
        onClick={onRemotes}
      >
        <Ic name="server" size={16} />
      </button>
      <button
        className="sr-activity-item"
        data-testid="rail-search"
        aria-label="Search everything"
        title="Search everything · ⌘K"
        onClick={() => app.setLauncherOpen(true)}
      >
        <Ic name="search" size={16} />
      </button>
      <button
        className={`sr-activity-item ${app.overlay === 'memory' ? 'active' : ''}`}
        data-testid="rail-view-memory"
        aria-label="Memory"
        title="Memory — project rules & agent memories"
        onClick={() => app.setOverlay('memory')}
      >
        <Ic name="brain" size={16} />
      </button>
      <button
        className={`sr-activity-item ${active === 'skills' ? 'active' : ''}`}
        data-testid="rail-view-skills"
        aria-label="Skills"
        title="Skills — usage and Agent installations"
        onClick={() => onSelect('skills')}
      >
        <Ic name="puzzle" size={17} />
      </button>
      <span className="sr-activity-spacer" />
      <button
        className="sr-activity-item"
        data-testid="home-open-ide"
        aria-label="Editor"
        title="Editor · ⌘E"
        onClick={() => app.setSurface('workspace')}
      >
        <Ic name="layout" size={16} />
      </button>
      <button
        className="sr-activity-item"
        data-testid="home-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => app.openSettings()}
      >
        <Ic name="sliders" size={16} />
      </button>
    </nav>
  );
}
