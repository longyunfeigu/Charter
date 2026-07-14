/**
 * System notifications on attention-worthy task state edges (PIVOT-014,
 * ADR-0006): the user kicked off a task and walked away — call them back
 * exactly when the task needs them, never while they are already looking.
 */

export const NOTIFY_STATES: ReadonlySet<string> = new Set([
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_PERMISSION',
  'REVIEW_READY',
  'FAILED',
  // ADR-0012: full-auto tasks announce completion at ACCEPTED instead of
  // REVIEW_READY (which they pass through mechanically).
  'ACCEPTED',
]);

const BODIES: Record<string, string> = {
  AWAITING_PLAN_APPROVAL: 'The agent proposed a plan and is waiting for your approval.',
  AWAITING_PERMISSION: 'The agent needs your permission to continue.',
  REVIEW_READY: 'The task finished and is ready for your review.',
  FAILED: 'The task failed — open it for details.',
  ACCEPTED: 'Completed & applied — the changes are in your project. You can still roll back.',
};

export interface NotificationDeps {
  /** settings.notifications.enabled at fire time. */
  enabled(): boolean;
  /** True while any app window has focus — the user is already watching. */
  anyWindowFocused(): boolean;
  /** Show a system notification; onClick fires when the user activates it. */
  show(notification: { title: string; body: string }, onClick: () => void): void;
  /** Bring the app forward and route the renderer to the task. */
  focusTask(taskId: string): void;
}

export class NotificationService {
  /** Last state notified per task — one notification per edge, no spam. */
  private readonly lastNotified = new Map<string, string>();

  constructor(private readonly deps: NotificationDeps) {}

  onTaskState(info: {
    taskId: string;
    to: string;
    title: string;
    changedFiles?: number | null;
    mode?: string;
  }): void {
    if (!NOTIFY_STATES.has(info.to)) {
      // Leaving an attention state re-arms the edge for that task.
      this.lastNotified.delete(info.taskId);
      return;
    }
    // ADR-0012: full-auto passes through REVIEW_READY mechanically — stay
    // quiet (fallback paths ping explicitly via pingAttention); ACCEPTED is
    // its real completion edge. Other modes never notify on ACCEPTED (the
    // user just clicked accept themselves).
    if (info.mode === 'full' && info.to === 'REVIEW_READY') return;
    if (info.mode !== 'full' && info.to === 'ACCEPTED') return;
    if (this.lastNotified.get(info.taskId) === info.to) return;
    this.lastNotified.set(info.taskId, info.to);
    if (!this.deps.enabled()) return;
    if (this.deps.anyWindowFocused()) return;
    // ADR-0009: zero-change completion is an answer, not a review request.
    const body =
      info.to === 'REVIEW_READY' && info.changedFiles === 0
        ? 'The agent answered — nothing changed on disk.'
        : (BODIES[info.to] ?? info.to);
    this.deps.show({ title: info.title, body }, () => this.deps.focusTask(info.taskId));
  }

  /** Ad-hoc attention ping (ADR-0012 full-mode fallbacks). */
  pingAttention(info: { taskId: string; title: string; body: string }): void {
    if (!this.deps.enabled()) return;
    if (this.deps.anyWindowFocused()) return;
    this.deps.show({ title: info.title, body: info.body }, () => this.deps.focusTask(info.taskId));
  }
}
