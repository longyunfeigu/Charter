import React from 'react';
import type { RailView } from '../store/appStore.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { visibleAttentionTasks } from '../store/attentionDismissals.js';
import { Ic } from './home-icons.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import { TERMINAL_MISSION_STATES } from './mission/mission-view-model.js';

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
    (state) => visibleAttentionTasks(state.tasks, state.attentionDismissals).length,
  );
  const sessionsActive = active === 'sessions' || active === 'files';
  const activeMissionCount = useOrchestrationStore(
    (state) =>
      state.missionOrder.filter((id) => {
        const snapshot = state.missionsById[id];
        return snapshot && !TERMINAL_MISSION_STATES.has(snapshot.mission.state);
      }).length,
  );

  return (
    <nav className="sr-activity" aria-label="Application">
      <button
        className={`sr-activity-item ${sessionsActive ? 'active' : ''}`}
        data-testid="rail-view-sessions"
        aria-label="Sessions"
        title="Sessions"
        onClick={() => onSelect('sessions')}
      >
        <Ic name="sessions" size={17} />
        <span className="sr-activity-label">Sessions</span>
      </button>
      <button
        className={`sr-activity-item ${active === 'missions' ? 'active' : ''}`}
        data-testid="rail-view-missions"
        aria-label="Missions"
        title="Missions"
        onClick={() => onSelect('missions')}
      >
        <Ic name="compass" size={17} />
        <span className="sr-activity-label">Missions</span>
        {activeMissionCount > 0 ? (
          <span className="sr-mini-badge mission-count">{activeMissionCount}</span>
        ) : null}
      </button>
      <button
        className={`sr-activity-item ${active === 'inbox' ? 'active' : ''}`}
        data-testid="rail-needs-you"
        aria-label="Needs attention"
        title="Needs attention"
        onClick={() => onSelect('inbox')}
      >
        <Ic name="inbox" size={16} />
        <span className="sr-activity-label">For you</span>
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
        <span className="sr-activity-label">Projects</span>
      </button>
      <button
        className={`sr-activity-item ${active === 'remotes' ? 'active' : ''}`}
        data-testid="rail-view-remotes"
        aria-label="Remote Explorer"
        title="Remote Explorer"
        onClick={onRemotes}
      >
        <Ic name="remote-terminal" size={17} />
        <span className="sr-activity-label">Remotes</span>
      </button>
      <button
        className={`sr-activity-item ${active === 'memory' ? 'active' : ''}`}
        data-testid="rail-view-memory"
        aria-label="Memory"
        title="Memory — project rules & agent memories"
        onClick={() => onSelect('memory')}
      >
        <Ic name="brain" size={16} />
        <span className="sr-activity-label">Memory</span>
      </button>
      <button
        className={`sr-activity-item ${active === 'skills' ? 'active' : ''}`}
        data-testid="rail-view-skills"
        aria-label="Skills"
        title="Skills — usage and Agent installations"
        onClick={() => onSelect('skills')}
      >
        <Ic name="puzzle" size={17} />
        <span className="sr-activity-label">Skills</span>
      </button>
      <span className="sr-activity-spacer" />
      <button
        className="sr-activity-item"
        data-testid="home-open-ide"
        aria-label="Editor"
        title="Editor"
        onClick={() => app.setSurface('workspace')}
      >
        <Ic name="layout" size={16} />
        <span className="sr-activity-label">Editor</span>
      </button>
      <button
        className="sr-activity-item"
        data-testid="home-settings"
        aria-label="Settings"
        title="Settings"
        onClick={() => app.openSettings()}
      >
        <Ic name="sliders" size={16} />
        <span className="sr-activity-label">Settings</span>
      </button>
    </nav>
  );
}
