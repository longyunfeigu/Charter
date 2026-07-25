import { useAppStore } from '../store/appStore.js';
import { useTerminalStore, type TerminalLaunch } from './TerminalPanel.js';

/** Select both layers of a Terminal Session: the shell route and the PTY dock. */
export function focusRemoteSession(terminalId: string, hostId: string): void {
  useTerminalStore.getState().setActive(terminalId);
  useAppStore.getState().openRemoteTerminalSession(terminalId, hostId);
}

/** Create a remote PTY and keep Remote Explorer as the owning navigation context. */
export async function openRemoteSession(
  hostId: string,
  launch: TerminalLaunch = 'shell',
): Promise<string | null> {
  const id = await useTerminalStore
    .getState()
    .create({ launch, target: { kind: 'ssh', hostId }, reveal: false });
  if (id) focusRemoteSession(id, hostId);
  return id;
}
