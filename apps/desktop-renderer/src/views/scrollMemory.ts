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

export function saveScroll(taskId: string, el: HTMLElement): void {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  positions.set(taskId, nearBottom ? AT_BOTTOM : el.scrollTop);
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
