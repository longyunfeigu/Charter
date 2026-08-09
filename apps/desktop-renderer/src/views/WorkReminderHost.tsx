import React, { useEffect } from 'react';
import { useAppStore } from '../store/appStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';

/**
 * Due-reminder alarms (★A+B direction, user-picked over the old bottom-right
 * card): a top-right stack of cards that swing in, keep the bell rocking and
 * heartbeat every 10s until handled. Every action is a real resolution —
 * View routes to the item, Snooze reschedules durably, ✗ cancels the reminder
 * (which also clears its Dock badge count). Motion lives in work.css.
 */
export function WorkReminderHost(): React.JSX.Element | null {
  const alerts = useWorkItemStore((state) => state.reminderAlerts);
  const init = useWorkItemStore((state) => state.init);

  useEffect(() => init(), [init]);
  if (alerts.length === 0) return null;

  const snooze = (reminderId: string, minutes: number): void => {
    const remindAt = new Date(Date.now() + minutes * 60_000).toISOString();
    void useWorkItemStore.getState().snoozeReminder(reminderId, remindAt);
  };

  return (
    <aside className="work-reminder-popup" data-testid="work-reminder-popup" aria-live="assertive">
      {alerts.map((alert) => (
        <article
          key={alert.reminder.id}
          className="work-reminder-card"
          role="alertdialog"
          aria-label={`Reminder: ${alert.item.title}`}
          data-testid={`work-reminder-card-${alert.reminder.id}`}
        >
          <div className="work-reminder-icon" aria-hidden>
            <Ic name="clock" size={18} />
          </div>
          <div className="work-reminder-copy">
            <span>WORK REMINDER · DUE NOW</span>
            <strong>{alert.item.title}</strong>
            <p>{alert.reminder.message || 'This work item needs your attention.'}</p>
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
              <button
                data-testid="work-reminder-snooze-10"
                onClick={() => snooze(alert.reminder.id, 10)}
              >
                Snooze 10m
              </button>
              <button
                data-testid="work-reminder-snooze-60"
                onClick={() => snooze(alert.reminder.id, 60)}
              >
                Snooze 1h
              </button>
              <button
                aria-label="Dismiss reminder"
                title="Dismiss — cancels this reminder"
                data-testid="work-reminder-dismiss"
                onClick={() => void useWorkItemStore.getState().cancelReminder(alert.reminder.id)}
              >
                <Ic name="x" size={13} />
              </button>
            </div>
          </div>
        </article>
      ))}
    </aside>
  );
}
