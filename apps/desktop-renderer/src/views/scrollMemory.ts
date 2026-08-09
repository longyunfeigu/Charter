/**
 * Per-task timeline scroll memory (ADR-0014, PIVOT-036) — session-scoped.
 * Keyed by taskId and shared by the Task Room timeline and the Editor agent
 * panel, so the reading position survives surface round-trips. Positions are
 * approximate across the two layouts by design; "was pinned to the bottom"
 * carries exactly.
 */

const positions = new Map<string, number>();
/** Sentinel meaning "stick to the live bottom". */
export const AT_BOTTOM = -1;

export function saveScroll(taskId: string, el: HTMLElement, nearBottom?: boolean): void {
  // A detached or zero-height element measures scrollHeight/scrollTop/
  // clientHeight as 0/0/0, which reads as "pinned to bottom" — a save at
  // teardown time would overwrite a real reading position with AT_BOTTOM.
  // Refuse those measurements entirely; the position saved by the last
  // completed frame stands.
  if (!el.isConnected || el.clientHeight === 0) return;
  // Callers that already measured this frame pass the pin verdict along so a
  // scroll event never reads the same layout properties twice.
  const pinned = nearBottom ?? el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  positions.set(taskId, pinned ? AT_BOTTOM : el.scrollTop);
}

/** Forget a deleted task's reading position (the map is session-scoped). */
export function clearScroll(taskId: string): void {
  positions.delete(taskId);
}

/**
 * Non-mutating read: AT_BOTTOM, a saved offset, or undefined when the task
 * has no remembered position. Lets the timeline pick its initial window size
 * (a mid-transcript reading position needs the full window to restore into).
 */
export function peekScroll(taskId: string): number | undefined {
  return positions.get(taskId);
}

export function restoreScroll(taskId: string, el: HTMLElement): boolean {
  const saved = positions.get(taskId);
  if (saved === undefined || saved === AT_BOTTOM) {
    el.scrollTop = el.scrollHeight;
    return true; // pinned to the bottom
  }
  el.scrollTop = saved;
  return false;
}
