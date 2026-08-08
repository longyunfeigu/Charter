import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';

export function WorkReminderHost(): React.JSX.Element | null {
  const alerts = useWorkItemStore((state) => state.reminderAlerts);
  const init = useWorkItemStore((state) => state.init);
  const alert = alerts[0] ?? null;

  useEffect(() => init(), [init]);
  if (!alert) return null;

  const snooze = (minutes: number): void => {
    const remindAt = new Date(Date.now() + minutes * 60_000).toISOString();
    void useWorkItemStore.getState().snoozeReminder(alert.reminder.id, remindAt);
  };

  return (
    <aside
      className="work-reminder-popup"
      role="alertdialog"
      aria-labelledby="work-reminder-title"
      aria-describedby="work-reminder-message"
      data-testid="work-reminder-popup"
    >
      <div className="work-reminder-icon" aria-hidden>
        <Ic name="clock" size={18} />
      </div>
      <div className="work-reminder-copy">
        <span>WORK REMINDER</span>
        <strong id="work-reminder-title">{alert.item.title}</strong>
        <p id="work-reminder-message">
          {alert.reminder.message || 'This work item needs your attention.'}
        </p>
        <div className="work-reminder-actions">
          <button
            className="btn primary"
            data-testid="work-reminder-view"
            onClick={() => {
              useAppStore.getState().setRailView('work');
              void useWorkItemStore.getState().select(alert.item.id);
              useWorkItemStore.getState().dismissReminderAlert(alert.reminder.id);
            }}
          >
            View task
          </button>
          <button data-testid="work-reminder-snooze-10" onClick={() => snooze(10)}>
            Snooze 10m
          </button>
          <button data-testid="work-reminder-snooze-60" onClick={() => snooze(60)}>
            Snooze 1h
          </button>
          <button
            aria-label="Dismiss reminder"
            data-testid="work-reminder-dismiss"
            onClick={() => void useWorkItemStore.getState().cancelReminder(alert.reminder.id)}
          >
            <Ic name="x" size={13} />
          </button>
        </div>
      </div>
    </aside>
  );
}
