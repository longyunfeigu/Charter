import React, { useEffect, useMemo, useState } from 'react';
import type {
  WorkEvidenceKind,
  WorkExecutionRole,
  WorkItemDetailDto,
  WorkItemDto,
  WorkItemTypeDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useOrchestrationStore } from '../store/orchestrationStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';
import { WorkItemForm } from './WorkItemForm.js';

function humanDate(iso: string | null): string {
  if (!iso) return 'No deadline';
  const value = new Date(iso);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function dueClass(iso: string | null): string {
  if (!iso) return '';
  const distance = Date.parse(iso) - Date.now();
  if (distance < 0) return 'overdue';
  if (distance < 24 * 60 * 60_000) return 'soon';
  return '';
}

function executionStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .replaceAll('_', ' ')
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    'work_item.created': 'Created the work item',
    'work_item.updated': 'Updated task details',
    'work_item.moved': 'Changed workflow stage',
    'work_item.archived': 'Archived the work item',
    'execution.linked': 'Linked an execution',
    'execution.updated': 'Updated an execution link',
    'execution.unlinked': 'Removed an execution link',
    'evidence.added': 'Added review evidence',
    'evidence.removed': 'Removed review evidence',
    'reminder.scheduled': 'Scheduled a reminder',
    'reminder.snoozed': 'Snoozed a reminder',
    'reminder.fired': 'Reminder became due',
    'reminder.cancelled': 'Dismissed a reminder',
  };
  return labels[type] ?? type.replaceAll('.', ' ');
}

function evidenceHint(typeId: string): string {
  if (typeId.includes('engineering'))
    return 'Attach test results, diff notes, build output, or a review link.';
  if (typeId.includes('research'))
    return 'Attach source links, citations, synthesis, and the resulting decision.';
  if (typeId.includes('operations'))
    return 'Record exact payloads, approvals, runbook output, and external action receipts.';
  if (typeId.includes('data'))
    return 'Record source datasets, formula checks, result links, and metric validation.';
  if (typeId.includes('content'))
    return 'Attach the final asset, approval, preview, and published destination.';
  if (typeId.includes('approval'))
    return 'Record the decision, approver, rationale, and effective date.';
  return 'Attach the evidence a reviewer needs to accept this outcome.';
}

function buildHandoffPrompt(item: WorkItemDto, type: WorkItemTypeDto | null): string {
  const custom = type?.fieldDefinitions
    .map((field) => {
      const value = item.customFields[field.key];
      if (value === undefined || value === null || value === '' || value === false) return null;
      return `- ${field.label}: ${Array.isArray(value) ? value.join(', ') : String(value)}`;
    })
    .filter(Boolean)
    .join('\n');
  return [
    `Work item: ${item.title}`,
    `Type: ${type?.name ?? 'General'}`,
    item.descriptionMd ? `\nRequested outcome:\n${item.descriptionMd}` : '',
    item.backgroundMd ? `\nBackground:\n${item.backgroundMd}` : '',
    item.sourcePerson || item.sourceChannel
      ? `\nSource: ${[item.sourcePerson, item.sourceChannel].filter(Boolean).join(' · ')}`
      : '',
    item.dueAt ? `Deadline: ${humanDate(item.dueAt)}` : '',
    custom ? `\nType-specific context:\n${custom}` : '',
    item.acceptance.length
      ? `\nAcceptance criteria:\n${item.acceptance.map((entry) => `- ${entry.text}`).join('\n')}`
      : '',
    item.deliverables.length
      ? `\nExpected deliverables:\n${item.deliverables.map((entry) => `- ${entry.text}`).join('\n')}`
      : '',
    '\nReturn the finished deliverables and concrete evidence needed for review. Keep the Work item context intact.',
  ]
    .filter(Boolean)
    .join('\n');
}

function ExecutionPicker(props: { detail: WorkItemDetailDto; onClose(): void }): React.JSX.Element {
  const tasks = useTaskStore((state) => state.tasks);
  const missionOrder = useOrchestrationStore((state) => state.missionOrder);
  const missionsById = useOrchestrationStore((state) => state.missionsById);
  const missions = useMemo(
    () =>
      missionOrder.flatMap((id) => {
        const snapshot = missionsById[id];
        return snapshot ? [snapshot] : [];
      }),
    [missionOrder, missionsById],
  );
  const [role, setRole] = useState<WorkExecutionRole>('collaborator');
  const [approach, setApproach] = useState('');
  const [manualLabel, setManualLabel] = useState('');

  useEffect(() => {
    useTaskStore.getState().init();
    void useTaskStore.getState().refreshTasks();
    useOrchestrationStore.getState().init();
    void useOrchestrationStore.getState().refreshMissions();
  }, []);

  const linked = new Set(
    props.detail.executions.map((execution) => `${execution.targetKind}:${execution.targetId}`),
  );

  return (
    <div
      className="modal-backdrop work-modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        className="work-link-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Link execution"
        data-testid="work-execution-picker"
      >
        <header>
          <div>
            <span className="work-eyebrow">EXECUTION HISTORY</span>
            <h2>Link work already in progress</h2>
          </div>
          <button aria-label="Close" onClick={props.onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="work-link-options">
          <label>
            <span>Role</span>
            <select
              data-testid="work-execution-role"
              value={role}
              onChange={(event) => setRole(event.target.value as WorkExecutionRole)}
            >
              <option value="primary">Primary</option>
              <option value="collaborator">Collaborator</option>
              <option value="reviewer">Reviewer</option>
              <option value="alternative">Alternative approach</option>
            </select>
          </label>
          <label>
            <span>Approach / responsibility</span>
            <input
              data-testid="work-execution-approach"
              value={approach}
              placeholder="e.g. source research, copy review, alternative plan"
              onChange={(event) => setApproach(event.target.value)}
            />
          </label>
        </div>
        <div className="work-link-list">
          <h3>Sessions</h3>
          {tasks
            .filter((task) => !task.archived)
            .map((task) => {
              const isLinked = linked.has(`session:${task.id}`);
              return (
                <button
                  key={task.id}
                  disabled={isLinked}
                  data-testid={`work-link-session-${task.id}`}
                  onClick={async () => {
                    const result = await useWorkItemStore.getState().linkExecution({
                      workItemId: props.detail.item.id,
                      targetKind: 'session',
                      targetId: task.id,
                      role,
                      approach,
                      displayLabel: task.title,
                      agentLabel: task.external?.cli ?? 'Charter Agent',
                      summary: '',
                    });
                    if (result) props.onClose();
                  }}
                >
                  <Ic name="sessions" size={14} />
                  <span>
                    <strong>{task.title}</strong>
                    <small>
                      {task.projectName} · {executionStatusLabel(task.state)}
                    </small>
                  </span>
                  <em>{isLinked ? 'Linked' : 'Link'}</em>
                </button>
              );
            })}
          {tasks.filter((task) => !task.archived).length === 0 ? (
            <p>No recorded Sessions yet.</p>
          ) : null}
          <h3>Missions</h3>
          {missions.map((snapshot) => {
            const mission = snapshot.mission;
            const isLinked = linked.has(`mission:${mission.id}`);
            return (
              <button
                key={mission.id}
                disabled={isLinked}
                data-testid={`work-link-mission-${mission.id}`}
                onClick={async () => {
                  const result = await useWorkItemStore.getState().linkExecution({
                    workItemId: props.detail.item.id,
                    targetKind: 'mission',
                    targetId: mission.id,
                    role,
                    approach,
                    displayLabel: mission.title,
                    agentLabel: 'Mission team',
                    summary: '',
                  });
                  if (result) props.onClose();
                }}
              >
                <Ic name="compass" size={14} />
                <span>
                  <strong>{mission.title}</strong>
                  <small>{executionStatusLabel(mission.state)}</small>
                </span>
                <em>{isLinked ? 'Linked' : 'Link'}</em>
              </button>
            );
          })}
          {missions.length === 0 ? <p>No Missions yet.</p> : null}
          <h3>Human / offline work</h3>
          <div className="work-manual-link">
            <input
              data-testid="work-manual-label"
              value={manualLabel}
              placeholder="e.g. Legal review by Morgan"
              onChange={(event) => setManualLabel(event.target.value)}
            />
            <button
              className="btn"
              data-testid="work-link-manual"
              disabled={!manualLabel.trim()}
              onClick={async () => {
                const result = await useWorkItemStore.getState().linkExecution({
                  workItemId: props.detail.item.id,
                  targetKind: 'manual',
                  targetId: null,
                  role,
                  approach,
                  displayLabel: manualLabel.trim(),
                  agentLabel: 'Human',
                  summary: '',
                });
                if (result) props.onClose();
              }}
            >
              Add
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function WorkItemDetail(props: {
  detail: WorkItemDetailDto;
  type: WorkItemTypeDto | null;
  onClose(): void;
}): React.JSX.Element {
  const { detail, type, onClose } = props;
  const item = detail.item;
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [remindAt, setRemindAt] = useState('');
  const [reminderMessage, setReminderMessage] = useState('');
  const [evidenceKind, setEvidenceKind] = useState<WorkEvidenceKind>('note');
  const [evidenceLabel, setEvidenceLabel] = useState('');
  const [evidenceValue, setEvidenceValue] = useState('');
  const [checklists, setChecklists] = useState({
    acceptance: item.acceptance,
    deliverables: item.deliverables,
  });
  const [checklistSaving, setChecklistSaving] = useState(false);
  const column = snapshot.columns.find((candidate) => candidate.id === item.columnId) ?? null;
  const completion = useMemo(() => {
    const all = [...checklists.acceptance, ...checklists.deliverables];
    return { checked: all.filter((entry) => entry.checked).length, total: all.length };
  }, [checklists]);

  useEffect(() => {
    if (checklistSaving) return;
    setChecklists({ acceptance: item.acceptance, deliverables: item.deliverables });
  }, [checklistSaving, item.acceptance, item.deliverables, item.id, item.version]);

  const updateChecklist = async (key: 'acceptance' | 'deliverables', id: string): Promise<void> => {
    const previous = checklists[key];
    const next = previous.map((entry) =>
      entry.id === id ? { ...entry, checked: !entry.checked } : entry,
    );
    // Local state changes in the input event itself so a controlled checkbox
    // never visibly snaps back while the durable/versioned mutation crosses IPC.
    setChecklists({ ...checklists, [key]: next });
    setChecklistSaving(true);
    const saved = await useWorkItemStore.getState().update({
      id: item.id,
      expectedVersion: item.version,
      [key]: next,
    });
    if (!saved) {
      setChecklists({ ...checklists, [key]: previous });
    } else {
      setChecklists((current) => ({ ...current, [key]: saved[key] }));
    }
    setChecklistSaving(false);
  };

  const openExecution = async (kind: string, id: string | null): Promise<void> => {
    if (!id) return;
    if (kind === 'session') {
      await useTaskStore.getState().openTask(id);
      useAppStore.getState().openTaskRoom(id);
    } else if (kind === 'mission') {
      useAppStore.getState().openMission(id);
    } else if (kind === 'terminal') {
      useAppStore.getState().openTerminalSession(id);
    }
  };

  return (
    <>
      <button className="work-drawer-scrim" aria-label="Close task" onClick={onClose} />
      <aside
        className="work-drawer"
        data-testid="work-item-detail"
        aria-label={`Work item: ${item.title}`}
      >
        <header className="work-drawer-header">
          <div
            className="work-drawer-type"
            style={{ '--work-type-color': type?.color ?? '#64748b' } as React.CSSProperties}
          >
            <span>{type?.name ?? 'General'}</span>
            <strong data-testid="work-detail-title">{item.title}</strong>
          </div>
          <div className="work-drawer-head-actions">
            <button data-testid="work-edit" title="Edit task" onClick={() => setEditing(true)}>
              <Ic name="pencil" size={14} />
            </button>
            <button data-testid="work-detail-close" aria-label="Close task" onClick={onClose}>
              <Ic name="x" size={15} />
            </button>
          </div>
        </header>

        <div className="work-drawer-scroll">
          <section className="work-detail-overview">
            <label>
              <span>Stage</span>
              <select
                data-testid="work-detail-stage"
                value={item.columnId}
                onChange={(event) =>
                  void useWorkItemStore.getState().move({
                    id: item.id,
                    columnId: event.target.value,
                    beforeId: null,
                    expectedVersion: item.version,
                  })
                }
              >
                {snapshot.columns.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <span>Priority</span>
              <strong className={`priority-${item.priority}`}>
                {executionStatusLabel(item.priority)}
              </strong>
            </div>
            <div>
              <span>Deadline</span>
              <strong className={dueClass(item.dueAt)}>{humanDate(item.dueAt)}</strong>
            </div>
          </section>

          {item.sourcePerson || item.sourceChannel || item.sourceUrl ? (
            <section className="work-detail-source" data-testid="work-detail-source">
              <span className="work-section-label">SOURCE</span>
              <div>
                <Ic name="at" size={14} />
                <strong>{item.sourcePerson || 'Unknown source'}</strong>
                {item.sourceChannel ? <span>{item.sourceChannel}</span> : null}
                {item.sourceUrl ? (
                  <button
                    onClick={() => void rpcResult('app.openExternal', { url: item.sourceUrl })}
                  >
                    Open source <Ic name="arrowRight" size={12} />
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {item.descriptionMd || item.backgroundMd ? (
            <section className="work-detail-copy">
              {item.descriptionMd ? (
                <>
                  <span className="work-section-label">OUTCOME</span>
                  <p>{item.descriptionMd}</p>
                </>
              ) : null}
              {item.backgroundMd ? (
                <>
                  <span className="work-section-label">BACKGROUND</span>
                  <p>{item.backgroundMd}</p>
                </>
              ) : null}
            </section>
          ) : null}

          {type?.fieldDefinitions.some(
            (field) =>
              item.customFields[field.key] !== undefined && item.customFields[field.key] !== '',
          ) ? (
            <section>
              <span className="work-section-label">{type.name.toUpperCase()} CONTEXT</span>
              <dl className="work-custom-values">
                {type.fieldDefinitions.map((field) => {
                  const value = item.customFields[field.key];
                  if (value === undefined || value === null || value === '') return null;
                  return (
                    <div key={field.key}>
                      <dt>{field.label}</dt>
                      <dd>
                        {Array.isArray(value)
                          ? value.join(', ')
                          : typeof value === 'boolean'
                            ? value
                              ? 'Yes'
                              : 'No'
                            : String(value)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ) : null}

          <section className="work-checklists">
            <div className="work-section-heading">
              <span className="work-section-label">ACCEPTANCE & DELIVERABLES</span>
              <em>
                {completion.total
                  ? `${completion.checked}/${completion.total}`
                  : 'No checklist yet'}
              </em>
            </div>
            {checklists.acceptance.length ? <h4>Acceptance criteria</h4> : null}
            {checklists.acceptance.map((entry) => (
              <label key={entry.id} className={entry.checked ? 'checked' : ''}>
                <input
                  type="checkbox"
                  data-testid={`work-acceptance-${entry.id}`}
                  checked={entry.checked}
                  disabled={checklistSaving}
                  onChange={() => void updateChecklist('acceptance', entry.id)}
                />
                <span>{entry.text}</span>
              </label>
            ))}
            {checklists.deliverables.length ? <h4>Expected deliverables</h4> : null}
            {checklists.deliverables.map((entry) => (
              <label key={entry.id} className={entry.checked ? 'checked' : ''}>
                <input
                  type="checkbox"
                  data-testid={`work-deliverable-${entry.id}`}
                  checked={entry.checked}
                  disabled={checklistSaving}
                  onChange={() => void updateChecklist('deliverables', entry.id)}
                />
                <span>{entry.text}</span>
              </label>
            ))}
          </section>

          <section className="work-executions" data-testid="work-executions">
            <div className="work-section-heading">
              <div>
                <span className="work-section-label">EXECUTIONS</span>
                <p>One outcome can have many agents, people, reviews, or alternatives.</p>
              </div>
              <button
                className="btn"
                data-testid="work-link-execution"
                onClick={() => setLinking(true)}
              >
                Link existing
              </button>
            </div>
            <button
              className="work-start-agent"
              data-testid="work-start-agent"
              onClick={() => {
                useAppStore.getState().queueWorkHandoff({
                  workItemId: item.id,
                  title: item.title,
                  prompt: buildHandoffPrompt(item, type),
                  acceptance: item.acceptance.map((entry) => entry.text),
                });
                useAppStore.getState().openSessionHome();
                useAppStore.getState().focusComposer();
              }}
            >
              <span>
                <Ic name="bot" size={17} />
              </span>
              <div>
                <strong>Start Agent Session</strong>
                <small>
                  Choose Charter Agent, Claude, Codex, or another installed agent in the Composer.
                </small>
              </div>
              <Ic name="arrowRight" size={14} />
            </button>
            {detail.executions.map((execution) => (
              <article
                key={execution.id}
                className="work-execution-row"
                data-testid={`work-execution-${execution.id}`}
              >
                <button
                  className="work-execution-main"
                  onClick={() => void openExecution(execution.targetKind, execution.targetId)}
                >
                  <span className={`work-execution-kind kind-${execution.targetKind}`}>
                    <Ic
                      name={
                        execution.targetKind === 'mission'
                          ? 'compass'
                          : execution.targetKind === 'manual'
                            ? 'user'
                            : 'sessions'
                      }
                      size={14}
                    />
                  </span>
                  <div>
                    <strong>
                      {execution.displayLabel || execution.approach || 'Linked execution'}
                    </strong>
                    <small>
                      {execution.agentLabel || execution.targetKind} · {execution.role}
                    </small>
                  </div>
                  <em className={`execution-status status-${execution.status.toLowerCase()}`}>
                    {executionStatusLabel(execution.status)}
                  </em>
                </button>
                <button
                  aria-label="Unlink execution"
                  title="Unlink"
                  onClick={() => void useWorkItemStore.getState().unlinkExecution(execution.id)}
                >
                  <Ic name="x" size={12} />
                </button>
              </article>
            ))}
            {detail.executions.length === 0 ? (
              <p className="work-detail-empty">
                No execution linked yet. The task remains valid even before work starts.
              </p>
            ) : null}
          </section>

          <section className="work-reminders" data-testid="work-reminders">
            <span className="work-section-label">REMINDERS</span>
            <div className="work-reminder-create">
              <input
                type="datetime-local"
                data-testid="work-detail-reminder-at"
                value={remindAt}
                onChange={(event) => setRemindAt(event.target.value)}
              />
              <input
                data-testid="work-detail-reminder-message"
                value={reminderMessage}
                placeholder="Optional message"
                onChange={(event) => setReminderMessage(event.target.value)}
              />
              <button
                className="btn"
                data-testid="work-detail-reminder-add"
                disabled={!remindAt}
                onClick={async () => {
                  const value = new Date(remindAt);
                  if (!Number.isFinite(value.getTime())) return;
                  const ok = await useWorkItemStore
                    .getState()
                    .createReminder(item.id, value.toISOString(), reminderMessage);
                  if (ok) {
                    setRemindAt('');
                    setReminderMessage('');
                  }
                }}
              >
                Add
              </button>
            </div>
            {detail.reminders.map((reminder) => (
              <div key={reminder.id} className={`work-reminder-row state-${reminder.state}`}>
                <Ic name="clock" size={13} />
                <div>
                  <strong>{humanDate(reminder.remindAt)}</strong>
                  <small>{reminder.message || executionStatusLabel(reminder.state)}</small>
                </div>
                {reminder.state !== 'cancelled' ? (
                  <div className="work-reminder-row-actions">
                    <button
                      title="Snooze one hour"
                      onClick={() =>
                        void useWorkItemStore
                          .getState()
                          .snoozeReminder(
                            reminder.id,
                            new Date(Date.now() + 60 * 60_000).toISOString(),
                          )
                      }
                    >
                      +1h
                    </button>
                    <button
                      title="Dismiss"
                      onClick={() => void useWorkItemStore.getState().cancelReminder(reminder.id)}
                    >
                      <Ic name="x" size={11} />
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </section>

          <section className="work-evidence" data-testid="work-evidence">
            <span className="work-section-label">REVIEW EVIDENCE</span>
            <p>{evidenceHint(item.typeId)}</p>
            <div className="work-evidence-create">
              <select
                value={evidenceKind}
                onChange={(event) => setEvidenceKind(event.target.value as WorkEvidenceKind)}
                data-testid="work-evidence-kind"
              >
                <option value="note">Note</option>
                <option value="link">Link</option>
                <option value="file">File</option>
                <option value="metric">Metric</option>
                <option value="approval">Approval</option>
              </select>
              <input
                value={evidenceLabel}
                onChange={(event) => setEvidenceLabel(event.target.value)}
                placeholder="Evidence label"
                data-testid="work-evidence-label"
              />
              <input
                value={evidenceValue}
                onChange={(event) => setEvidenceValue(event.target.value)}
                placeholder="URL, path, result, or detail"
                data-testid="work-evidence-value"
              />
              <button
                className="btn"
                data-testid="work-evidence-add"
                disabled={!evidenceLabel.trim()}
                onClick={async () => {
                  const added = await useWorkItemStore.getState().addEvidence({
                    workItemId: item.id,
                    kind: evidenceKind,
                    label: evidenceLabel.trim(),
                    value: evidenceValue,
                    createdBy: 'You',
                  });
                  if (added) {
                    setEvidenceLabel('');
                    setEvidenceValue('');
                  }
                }}
              >
                Add
              </button>
            </div>
            {detail.evidence.map((evidence) => (
              <article key={evidence.id} className="work-evidence-row">
                <span>{executionStatusLabel(evidence.kind)}</span>
                <div>
                  <strong>{evidence.label}</strong>
                  {evidence.value ? <small>{evidence.value}</small> : null}
                </div>
                <button
                  aria-label="Remove evidence"
                  onClick={() => void useWorkItemStore.getState().removeEvidence(evidence.id)}
                >
                  <Ic name="x" size={11} />
                </button>
              </article>
            ))}
          </section>

          <section className="work-activity">
            <span className="work-section-label">ACTIVITY</span>
            {detail.events.map((event) => (
              <div key={event.id} className="work-activity-row">
                <span />
                <div>
                  <strong>{eventLabel(event.type)}</strong>
                  <small>
                    {event.actor} · {humanDate(event.createdAt)}
                  </small>
                </div>
              </div>
            ))}
          </section>

          <section className="work-danger-zone">
            <button
              data-testid="work-archive"
              onClick={() => {
                if (
                  window.confirm(
                    `Archive “${item.title}”? Its activity and evidence stay in the database.`,
                  )
                ) {
                  void useWorkItemStore.getState().archive(item.id, true, item.version);
                }
              }}
            >
              <Ic name="archive" size={13} /> Archive task
            </button>
            {column?.category === 'completed' ? (
              <span>Completed {humanDate(item.completedAt)}</span>
            ) : null}
          </section>
        </div>
      </aside>
      {editing ? (
        <WorkItemForm item={item} types={snapshot.types} onClose={() => setEditing(false)} />
      ) : null}
      {linking ? <ExecutionPicker detail={detail} onClose={() => setLinking(false)} /> : null}
    </>
  );
}
