/**
 * ADR-0021 — command-finish notifications: the user started a long command
 * and went back to editing (or left the app); call them back exactly when it
 * finished, and land them on the block, not just the app. Same hygiene as
 * PIVOT-014 task notifications: enabled-gated, muted while focused, one edge
 * = one notification.
 */

export interface CommandNotificationDeps {
  /** settings.notifications.enabled at fire time (and not PI_IDE_E2E). */
  enabled(): boolean;
  /** True while any app window has focus — the user is already watching. */
  anyWindowFocused(): boolean;
  /** settings.terminal.longCommandSeconds in ms at fire time. */
  minDurationMs(): number;
  show(notification: { title: string; body: string }, onClick: () => void): void;
  /** Bring the app forward and scroll the terminal to the block start. */
  reveal(terminalId: string, blockId: string): void;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds > 0 ? `${seconds}s` : ''}`;
}

export class CommandNotificationService {
  /** One notification per block edge, bounded. */
  private readonly notified: string[] = [];

  constructor(private readonly deps: CommandNotificationDeps) {}

  onCommandDone(info: {
    terminalId: string;
    blockId: string;
    command: string;
    exitCode: number;
    durationMs: number;
    contextLabel: string;
  }): boolean {
    if (info.durationMs < this.deps.minDurationMs()) return false;
    const key = `${info.terminalId}:${info.blockId}`;
    if (this.notified.includes(key)) return false;
    this.notified.push(key);
    if (this.notified.length > 200) this.notified.shift();
    if (!this.deps.enabled()) return false;
    // Focused = the renderer shows a tab bell instead; no system banner.
    if (this.deps.anyWindowFocused()) return false;
    const ok = info.exitCode === 0;
    const command = info.command.trim().slice(0, 60) || 'Command';
    this.deps.show(
      {
        title: ok ? `${command} — finished` : `${command} — failed`,
        body: `${ok ? '✓' : `✗ exit ${info.exitCode}`} · ${formatDuration(info.durationMs)} · ${info.contextLabel}`,
      },
      () => this.deps.reveal(info.terminalId, info.blockId),
    );
    return true;
  }
}
