import { beforeEach, describe, expect, it } from 'vitest';
import { mainSurfaceOf, railGroupOf, useAppStore } from './appStore.js';

/**
 * ADR-0042 — left nav and main content always correspond. Crossing nav groups
 * (workbench ⇄ projects) swaps the main surface with the rail and restores
 * what the target group last showed; switches inside one group never touch
 * the main surface (ADR-0024 context feeding relies on that).
 */

function reset(): void {
  useAppStore.setState({
    railView: 'sessions',
    savedSurfaces: {
      workbench: { kind: 'home' },
      projects: { kind: 'home' },
      skills: { kind: 'home' },
    },
    navigationBack: [],
    navigationForward: [],
    taskRoomTaskId: null,
    missionCenter: null,
    sessionRoomView: 'conversation',
    sessionTerminalId: null,
    sessionTerminalScope: 'single',
    archaeology: null,
    remotesOpen: false,
    remoteSelectedHostId: null,
    remoteSubview: 'overview',
    projectTool: null,
    projectCenter: null,
    projectBottomTab: null,
    surface: 'home',
    peek: null,
  });
}

beforeEach(reset);

describe('railGroupOf / mainSurfaceOf', () => {
  it('groups sessions, Missions, inbox and files into one workbench; projects and Skills stand alone', () => {
    expect(railGroupOf('sessions')).toBe('workbench');
    expect(railGroupOf('missions')).toBe('workbench');
    expect(railGroupOf('inbox')).toBe('workbench');
    expect(railGroupOf('files')).toBe('workbench');
    expect(railGroupOf('projects')).toBe('projects');
    expect(railGroupOf('skills')).toBe('skills');
  });

  it('derives the surface identity with the same priority as HomeShell', () => {
    expect(
      mainSurfaceOf({
        taskRoomTaskId: 't1',
        missionCenter: null,
        sessionTerminalId: 'term1',
        archaeology: { scope: null },
        projectTool: 'editor',
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'terminal', terminalId: 'term1' });
    expect(
      mainSurfaceOf({
        taskRoomTaskId: 't1',
        missionCenter: null,
        sessionTerminalId: null,
        archaeology: null,
        projectTool: null,
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'room', taskId: 't1' });
    expect(
      mainSurfaceOf({
        taskRoomTaskId: null,
        missionCenter: null,
        sessionTerminalId: null,
        archaeology: null,
        projectTool: null,
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'home' });
  });

  it('treats Mission Center as an independent main surface', () => {
    useAppStore.getState().openMission('mission-1');
    expect(mainSurfaceOf(useAppStore.getState())).toEqual({
      kind: 'mission',
      missionId: 'mission-1',
    });
    expect(useAppStore.getState().taskRoomTaskId).toBeNull();
    expect(useAppStore.getState().railView).toBe('missions');
  });
});

describe('unified page history', () => {
  it('returns from a Session to the exact Project tab that opened it', () => {
    useAppStore.getState().openProjectCenter('/saved/project', 'changes');
    useAppStore.getState().openTaskRoom('task-from-project');

    expect(useAppStore.getState().railView).toBe('sessions');
    useAppStore.getState().navigateBack();

    const restored = useAppStore.getState();
    expect(restored.railView).toBe('projects');
    expect(restored.projectCenter).toEqual({ path: '/saved/project', tab: 'changes' });
    expect(restored.taskRoomTaskId).toBeNull();
  });

  it('supports forward navigation and restores Session-local tool state', () => {
    useAppStore.getState().openProjectCenter('/saved/project', 'sessions');
    useAppStore.getState().openTaskRoom('task-1');
    useAppStore.getState().openPeek('task-1', 'src/index.ts', 'diff');

    useAppStore.getState().navigateBack();
    useAppStore.getState().navigateForward();

    const restored = useAppStore.getState();
    expect(restored.taskRoomTaskId).toBe('task-1');
    expect(restored.peek).toEqual({
      taskId: 'task-1',
      paths: ['src/index.ts'],
      active: 'src/index.ts',
      mode: 'diff',
    });
    expect(restored.sessionTool).toBe('diff');
    expect(restored.sessionToolsOpen).toBe(true);
  });

  it('restores the selected Mission assignment and inspector tab', () => {
    useAppStore.getState().openMission('mission-1', 'assignment-2', 'session');
    useAppStore.getState().openTaskRoom('worker-task');

    useAppStore.getState().navigateBack();

    expect(useAppStore.getState().railView).toBe('missions');
    expect(useAppStore.getState().missionCenter).toEqual({
      missionId: 'mission-1',
      assignmentId: 'assignment-2',
      inspectorTab: 'session',
    });
  });

  it('clears the forward branch after a new destination is opened', () => {
    useAppStore.getState().openProjectCenter('/project-a');
    useAppStore.getState().openTaskRoom('task-a');
    useAppStore.getState().navigateBack();
    expect(useAppStore.getState().navigationForward).toHaveLength(1);

    useAppStore.getState().openArchaeology(null);
    expect(useAppStore.getState().navigationForward).toHaveLength(0);
  });

  it('removes deleted Sessions from both history directions', () => {
    useAppStore.getState().openTaskRoom('dead-task');
    useAppStore.getState().openProjectCenter('/project');
    useAppStore.getState().navigateBack();
    expect(
      useAppStore.getState().navigationForward.some((entry) => entry.taskRoomTaskId === null),
    ).toBe(true);

    useAppStore.getState().forgetTaskNavigation('dead-task');
    expect(
      [...useAppStore.getState().navigationBack, ...useAppStore.getState().navigationForward].some(
        (entry) => entry.taskRoomTaskId === 'dead-task',
      ),
    ).toBe(false);
  });
});

describe('setRailView across groups (the stale-main bug class)', () => {
  it('leaving Sessions for Projects clears the open room from the main area', () => {
    useAppStore.getState().openTaskRoom('t1');
    useAppStore.getState().setRailView('projects');
    const s = useAppStore.getState();
    expect(s.railView).toBe('projects');
    expect(s.taskRoomTaskId).toBeNull();
    expect(mainSurfaceOf(s)).toEqual({ kind: 'home' });
  });

  it('returning to Sessions restores the room that was open there', () => {
    useAppStore.getState().openTaskRoom('t1');
    useAppStore.getState().setRailView('projects');
    useAppStore.getState().setRailView('sessions');
    const s = useAppStore.getState();
    expect(s.railView).toBe('sessions');
    expect(s.taskRoomTaskId).toBe('t1');
  });

  it('Skills is a main page and restores the open Session on return', () => {
    useAppStore.getState().openTaskRoom('t-skills');
    useAppStore.getState().setRailView('skills');
    expect(useAppStore.getState().taskRoomTaskId).toBeNull();
    expect(useAppStore.getState().railView).toBe('skills');
    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t-skills');
  });

  it('keeps Session Archive inside the workbench and restores it after visiting Projects', () => {
    useAppStore.getState().openArchaeology('/p');
    useAppStore.getState().setRailView('inbox');
    expect(useAppStore.getState().archaeology).toEqual({ scope: '/p' });
    useAppStore.getState().setRailView('projects');
    expect(useAppStore.getState().archaeology).toBeNull();
    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().archaeology).toEqual({ scope: '/p' });
  });

  it('keeps Project Center selection and tab inside the Projects navigation group', () => {
    useAppStore.getState().openProjectCenter('/saved/project');
    useAppStore.getState().setProjectCenterTab('changes');
    expect(useAppStore.getState().railView).toBe('projects');
    expect(mainSurfaceOf(useAppStore.getState())).toEqual({
      kind: 'project-center',
      path: '/saved/project',
      tab: 'changes',
    });

    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().projectCenter).toBeNull();
    useAppStore.getState().setRailView('projects');
    expect(useAppStore.getState().projectCenter).toEqual({
      path: '/saved/project',
      tab: 'changes',
    });
  });

  it('switches inside the workbench group never touch the main surface', () => {
    useAppStore.getState().openTaskRoom('t1');
    useAppStore.getState().setRailView('files');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t1');
    useAppStore.getState().setRailView('inbox');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t1');
    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t1');
  });
});

describe('surface openers keep the rail in step (reverse direction)', () => {
  it('opens a Mission independently and returns to its origin conversation explicitly', () => {
    useAppStore.getState().openTaskRoom('t-origin');
    useAppStore.getState().openMission('mission-1');
    expect(useAppStore.getState().missionCenter).toEqual({ missionId: 'mission-1' });
    expect(useAppStore.getState().taskRoomTaskId).toBeNull();

    useAppStore.getState().openTaskRoom('t-origin');
    expect(useAppStore.getState().missionCenter).toBeNull();
    expect(useAppStore.getState().taskRoomTaskId).toBe('t-origin');
    expect(useAppStore.getState().railView).toBe('sessions');
  });

  it('opening a terminal from Mission replaces the Mission rail with Sessions', () => {
    useAppStore.getState().openMission('mission-1');
    useAppStore.getState().openTerminalSession('term-mission-worker');
    const state = useAppStore.getState();
    expect(state.railView).toBe('sessions');
    expect(state.missionCenter).toBeNull();
    expect(state.sessionTerminalId).toBe('term-mission-worker');
  });

  it('opening Session Archive from Project Center flips to Sessions and remembers the project', () => {
    useAppStore.getState().openProjectCenter('/saved/project', 'sessions');
    useAppStore.getState().openArchaeology(null);
    useAppStore.getState().openTaskRoom('t2'); // e.g. Open on a tracked row
    const s = useAppStore.getState();
    expect(s.railView).toBe('sessions');
    expect(s.taskRoomTaskId).toBe('t2');
    expect(s.archaeology).toBeNull();
    // The Projects group remembers its own center for the way back.
    useAppStore.getState().setRailView('projects');
    expect(useAppStore.getState().projectCenter).toEqual({
      path: '/saved/project',
      tab: 'sessions',
    });
    expect(useAppStore.getState().archaeology).toBeNull();
    expect(useAppStore.getState().taskRoomTaskId).toBeNull();
  });

  it('opening a terminal session from Projects flips the rail to Sessions', () => {
    useAppStore.getState().setRailView('projects');
    useAppStore.getState().openTerminalSession('term1');
    expect(useAppStore.getState().railView).toBe('sessions');
    expect(useAppStore.getState().sessionTerminalId).toBe('term1');
    expect(useAppStore.getState().sessionTerminalScope).toBe('single');
  });

  it('opens the global terminal manager only through explicit intent', () => {
    useAppStore.getState().openAllTerminals('term1');
    expect(useAppStore.getState().sessionTerminalId).toBe('term1');
    expect(useAppStore.getState().sessionTerminalScope).toBe('all');

    useAppStore.getState().openTerminalSession('term2');
    expect(useAppStore.getState().sessionTerminalId).toBe('term2');
    expect(useAppStore.getState().sessionTerminalScope).toBe('single');
  });

  it('keeps a remote terminal inside its host context', () => {
    useAppStore.getState().openRemotes('host-1');
    useAppStore.getState().openRemoteTerminalSession('term-remote', 'host-1');
    const state = useAppStore.getState();
    expect(state.remotesOpen).toBe(true);
    expect(state.remoteSelectedHostId).toBe('host-1');
    expect(state.sessionTerminalId).toBe('term-remote');
    expect(state.sessionTerminalScope).toBe('single');
    expect(mainSurfaceOf(state)).toEqual({ kind: 'terminal', terminalId: 'term-remote' });
  });

  it('leaves Remote Explorer when a regular terminal opens', () => {
    useAppStore.getState().openRemoteTerminalSession('term-remote', 'host-1');
    useAppStore.getState().openTerminalSession('term-local');
    const state = useAppStore.getState();
    expect(state.remotesOpen).toBe(false);
    expect(state.sessionTerminalId).toBe('term-local');
  });

  it('returns from a remote terminal to the selected host overview', () => {
    useAppStore.getState().openRemoteTerminalSession('term-remote', 'host-1');
    useAppStore.getState().selectRemoteHost('host-1');
    const state = useAppStore.getState();
    expect(state.remotesOpen).toBe(true);
    expect(state.remoteSelectedHostId).toBe('host-1');
    expect(state.remoteSubview).toBe('overview');
    expect(state.sessionTerminalId).toBeNull();
  });

  it('opening a project tool from Projects pairs the rail Files view (ADR-0029)', () => {
    useAppStore.getState().setRailView('projects');
    useAppStore.getState().setProjectTool('editor');
    const s = useAppStore.getState();
    expect(s.railView).toBe('files');
    expect(s.projectTool).toBe('editor');
  });

  it('opening a project tool from inside the workbench leaves the rail view alone', () => {
    useAppStore.getState().setRailView('sessions');
    useAppStore.getState().setProjectTool('editor');
    expect(useAppStore.getState().railView).toBe('sessions');
  });

  it('opening Session Archive stays in Sessions and replaces the room', () => {
    useAppStore.getState().openTaskRoom('t3');
    useAppStore.getState().openArchaeology('/x');
    const s = useAppStore.getState();
    expect(s.railView).toBe('sessions');
    expect(s.taskRoomTaskId).toBeNull();
    expect(s.archaeology).toEqual({ scope: '/x' });
    useAppStore.getState().setRailView('files');
    expect(useAppStore.getState().archaeology).toEqual({ scope: '/x' });
  });

  it('opening a room from inside the workbench never yanks the Inbox panel away', () => {
    useAppStore.getState().setRailView('inbox');
    useAppStore.getState().openTaskRoom('t4');
    expect(useAppStore.getState().railView).toBe('inbox');
  });
});
