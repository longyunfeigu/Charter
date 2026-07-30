import type { RecentWorkspaceDto } from '@pi-ide/ipc-contracts';

/** Project-picker entries must be actionable; stale history remains available elsewhere. */
export function selectableRecentWorkspaces(recent: RecentWorkspaceDto[]): RecentWorkspaceDto[] {
  return recent.filter((workspace) => workspace.exists);
}
