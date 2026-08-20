export type WindowCloseBehavior = 'ask' | 'keep-running' | 'quit';

export interface BackgroundActivityInput {
  managedAgents: number;
  externalAgents: number;
  terminalJobs: number;
  missions: number;
  remoteConnections: number;
  blockers?: readonly string[];
}

export interface BackgroundActivitySnapshot {
  agentCount: number;
  managedAgentCount: number;
  externalAgentCount: number;
  terminalJobCount: number;
  missionCount: number;
  remoteConnectionCount: number;
  blockers: string[];
  hasRunningWork: boolean;
}

export type WindowCloseAction = 'close' | 'ask' | 'keep-running' | 'quit';

function count(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/** One host-owned view of work that would be interrupted by quitting Main. */
export function backgroundActivity(input: BackgroundActivityInput): BackgroundActivitySnapshot {
  const managedAgentCount = count(input.managedAgents);
  const externalAgentCount = count(input.externalAgents);
  const terminalJobCount = count(input.terminalJobs);
  const missionCount = count(input.missions);
  const remoteConnectionCount = count(input.remoteConnections);
  const blockers = [...new Set(input.blockers ?? [])].filter(Boolean);
  return {
    agentCount: managedAgentCount + externalAgentCount,
    managedAgentCount,
    externalAgentCount,
    terminalJobCount,
    missionCount,
    remoteConnectionCount,
    blockers,
    hasRunningWork:
      managedAgentCount +
        externalAgentCount +
        terminalJobCount +
        missionCount +
        remoteConnectionCount >
        0 || blockers.length > 0,
  };
}

/** A remembered choice applies only while work is live; an idle window closes normally. */
export function windowCloseAction(
  behavior: WindowCloseBehavior,
  activity: BackgroundActivitySnapshot,
): WindowCloseAction {
  if (!activity.hasRunningWork) return 'close';
  // A remembered destructive preference never bypasses unsaved editor data.
  if (behavior === 'quit' && activity.blockers.length > 0) return 'ask';
  return behavior;
}

export function backgroundActivityLines(activity: BackgroundActivitySnapshot): string[] {
  const lines: string[] = [];
  if (activity.agentCount > 0)
    lines.push(`${activity.agentCount} Agent${activity.agentCount === 1 ? '' : 's'}`);
  if (activity.missionCount > 0)
    lines.push(`${activity.missionCount} Mission${activity.missionCount === 1 ? '' : 's'}`);
  if (activity.terminalJobCount > 0)
    lines.push(
      `${activity.terminalJobCount} terminal job${activity.terminalJobCount === 1 ? '' : 's'}`,
    );
  if (activity.remoteConnectionCount > 0)
    lines.push(
      `${activity.remoteConnectionCount} remote connection${activity.remoteConnectionCount === 1 ? '' : 's'}`,
    );
  lines.push(...activity.blockers);
  return lines;
}

export function backgroundTrayTitle(activity: BackgroundActivitySnapshot): string {
  if (!activity.hasRunningWork) return 'Charter — no running work';
  const summary = backgroundActivityLines(activity).filter(
    (line) => !activity.blockers.includes(line),
  );
  return `Charter — ${summary.join(', ') || 'work in progress'}`;
}

/** Renderer crash recovery: reload in place — a synchronous dialog here would
 * block the main-process event loop and freeze the (already blank) window,
 * which is exactly the outage it is meant to resolve. Only a crash loop
 * (repeated renderer deaths in a short window) escalates to asking the user,
 * and that dialog must be shown asynchronously. */
export const RENDERER_CRASH_LOOP_WINDOW_MS = 60_000;
export const RENDERER_CRASH_LOOP_THRESHOLD = 3;

export function rendererCrashAction(
  crashTimesMs: number[],
  nowMs: number,
): { action: 'reload' | 'ask'; recentCrashes: number[] } {
  const recentCrashes = crashTimesMs.filter((t) => nowMs - t <= RENDERER_CRASH_LOOP_WINDOW_MS);
  return {
    action: recentCrashes.length >= RENDERER_CRASH_LOOP_THRESHOLD ? 'ask' : 'reload',
    recentCrashes,
  };
}
