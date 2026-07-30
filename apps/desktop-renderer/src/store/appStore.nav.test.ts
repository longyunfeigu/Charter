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
    taskRoomTaskId: null,
    sessionRoomView: 'conversation',
    sessionTerminalId: null,
    sessionTerminalScope: 'single',
    archaeology: null,
    remotesOpen: false,
    remoteSelectedHostId: null,
    remoteSubview: 'overview',
    projectTool: null,
    projectBottomTab: null,
    surface: 'home',
    peek: null,
  });
}

beforeEach(reset);

describe('railGroupOf / mainSurfaceOf', () => {
  it('groups sessions, inbox and files into one workbench; projects and Skills stand alone', () => {
    expect(railGroupOf('sessions')).toBe('workbench');
    expect(railGroupOf('inbox')).toBe('workbench');
    expect(railGroupOf('files')).toBe('workbench');
    expect(railGroupOf('projects')).toBe('projects');
    expect(railGroupOf('skills')).toBe('skills');
  });

  it('derives the surface identity with the same priority as HomeShell', () => {
    expect(
      mainSurfaceOf({
        taskRoomTaskId: 't1',
        sessionTerminalId: 'term1',
        archaeology: { scope: null },
        projectTool: 'editor',
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'terminal', terminalId: 'term1' });
    expect(
      mainSurfaceOf({
        taskRoomTaskId: 't1',
        sessionTerminalId: null,
        archaeology: null,
        projectTool: null,
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'room', taskId: 't1' });
    expect(
      mainSurfaceOf({
        taskRoomTaskId: null,
        sessionTerminalId: null,
        archaeology: null,
        projectTool: null,
        remotesOpen: false,
      }),
    ).toEqual({ kind: 'home' });
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

  it('leaving Projects for Sessions clears the archaeology page and restores it on return', () => {
    useAppStore.getState().setRailView('projects');
    useAppStore.getState().openArchaeology('/p');
    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().archaeology).toBeNull();
    useAppStore.getState().setRailView('projects');
    expect(useAppStore.getState().archaeology).toEqual({ scope: '/p' });
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
  it('keeps Fleet as a Session-local view and resets normal room entry to conversation', () => {
    useAppStore.getState().openTaskRoom('t-fleet');
    useAppStore.getState().setSessionRoomView('fleet');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t-fleet');
    expect(useAppStore.getState().sessionRoomView).toBe('fleet');

    useAppStore.getState().openTaskRoom('t-fleet');
    expect(useAppStore.getState().sessionRoomView).toBe('conversation');
  });

  it('opening a room from the Projects page flips the rail to Sessions and remembers the page', () => {
    useAppStore.getState().setRailView('projects');
    useAppStore.getState().openArchaeology(null);
    useAppStore.getState().openTaskRoom('t2'); // e.g. Open on a tracked row
    const s = useAppStore.getState();
    expect(s.railView).toBe('sessions');
    expect(s.taskRoomTaskId).toBe('t2');
    expect(s.archaeology).toBeNull();
    // The projects group remembers its page for the way back.
    useAppStore.getState().setRailView('projects');
    expect(useAppStore.getState().archaeology).toEqual({ scope: null });
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

  it('opening archaeology from the workbench flips the rail to Projects and remembers the room', () => {
    useAppStore.getState().openTaskRoom('t3');
    useAppStore.getState().openArchaeology('/x');
    const s = useAppStore.getState();
    expect(s.railView).toBe('projects');
    expect(s.taskRoomTaskId).toBeNull();
    useAppStore.getState().setRailView('sessions');
    expect(useAppStore.getState().taskRoomTaskId).toBe('t3');
  });

  it('opening a room from inside the workbench never yanks the Inbox panel away', () => {
    useAppStore.getState().setRailView('inbox');
    useAppStore.getState().openTaskRoom('t4');
    expect(useAppStore.getState().railView).toBe('inbox');
  });
});
