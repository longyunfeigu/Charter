import React, { useMemo, useState } from 'react';
import type {
  WorkChecklistItem,
  WorkCustomFieldValue,
  WorkItemDto,
  WorkItemFieldDefinition,
  WorkItemTypeDto,
} from '@pi-ide/ipc-contracts';
import { useWorkItemStore } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';

function localInputValue(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function isoValue(local: string): string | null {
  if (!local) return null;
  const value = new Date(local);
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function checklistText(items: WorkChecklistItem[]): string {
  return items.map((item) => item.text).join('\n');
}

function checklistFromText(text: string, previous: WorkChecklistItem[]): WorkChecklistItem[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 100)
    .map((line, index) => ({
      id: previous[index]?.id ?? `check_${globalThis.crypto.randomUUID()}`,
      text: line,
      checked: previous[index]?.text === line ? previous[index]!.checked : false,
    }));
}

function CustomFieldInput(props: {
  definition: WorkItemFieldDefinition;
  value: WorkCustomFieldValue | undefined;
  onChange(value: WorkCustomFieldValue): void;
}): React.JSX.Element {
  const { definition, value, onChange } = props;
  const id = `work-custom-${definition.key}`;
  if (definition.kind === 'checkbox') {
    return (
      <label className="work-form-check" htmlFor={id}>
        <input
          id={id}
          data-testid={id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          {definition.label}
          {definition.required ? <em> required</em> : null}
        </span>
      </label>
    );
  }
  if (definition.kind === 'select') {
    return (
      <label htmlFor={id}>
        <span>
          {definition.label}
          {definition.required ? <em> required</em> : null}
        </span>
        <select
          id={id}
          data-testid={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose…</option>
          {definition.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (definition.kind === 'long_text') {
    return (
      <label className="work-form-span" htmlFor={id}>
        <span>
          {definition.label}
          {definition.required ? <em> required</em> : null}
        </span>
        <textarea
          id={id}
          data-testid={id}
          rows={3}
          value={typeof value === 'string' ? value : ''}
          placeholder={definition.placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  const inputType =
    definition.kind === 'number'
      ? 'number'
      : definition.kind === 'date'
        ? 'date'
        : definition.kind === 'url'
          ? 'url'
          : 'text';
  return (
    <label htmlFor={id}>
      <span>
        {definition.label}
        {definition.required ? <em> required</em> : null}
      </span>
      <input
        id={id}
        data-testid={id}
        type={inputType}
        value={typeof value === 'number' || typeof value === 'string' ? value : ''}
        placeholder={definition.placeholder}
        onChange={(event) =>
          onChange(
            definition.kind === 'number'
              ? event.target.value === ''
                ? null
                : Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  );
}

export function WorkItemForm(props: {
  item: WorkItemDto | null;
  types: WorkItemTypeDto[];
  onClose(): void;
}): React.JSX.Element {
  const { item, types, onClose } = props;
  const defaultType = item?.typeId ?? types[0]?.id ?? '';
  const [title, setTitle] = useState(item?.title ?? '');
  const [typeId, setTypeId] = useState(defaultType);
  const [description, setDescription] = useState(item?.descriptionMd ?? '');
  const [background, setBackground] = useState(item?.backgroundMd ?? '');
  const [sourcePerson, setSourcePerson] = useState(item?.sourcePerson ?? '');
  const [sourceChannel, setSourceChannel] = useState(item?.sourceChannel ?? '');
  const [sourceUrl, setSourceUrl] = useState(item?.sourceUrl ?? '');
  const [priority, setPriority] = useState(item?.priority ?? 'none');
  const [labels, setLabels] = useState((item?.labels ?? []).join(', '));
  const [startAt, setStartAt] = useState(localInputValue(item?.startAt ?? null));
  const [dueAt, setDueAt] = useState(localInputValue(item?.dueAt ?? null));
  const [reminderAt, setReminderAt] = useState('');
  const [acceptance, setAcceptance] = useState(checklistText(item?.acceptance ?? []));
  const [deliverables, setDeliverables] = useState(checklistText(item?.deliverables ?? []));
  const [customFields, setCustomFields] = useState<Record<string, WorkCustomFieldValue>>(
    item?.customFields ?? {},
  );
  const [saving, setSaving] = useState(false);
  const selectedType = useMemo(
    () => types.find((candidate) => candidate.id === typeId) ?? null,
    [typeId, types],
  );

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!title.trim() || !typeId) return;
    setSaving(true);
    const shared = {
      typeId,
      title: title.trim(),
      descriptionMd: description,
      backgroundMd: background,
      sourcePerson: sourcePerson.trim(),
      sourceChannel: sourceChannel.trim(),
      sourceUrl: sourceUrl.trim(),
      assignee: '',
      priority,
      labels: labels
        .split(',')
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 30),
      startAt: isoValue(startAt),
      dueAt: isoValue(dueAt),
      acceptance: checklistFromText(acceptance, item?.acceptance ?? []),
      deliverables: checklistFromText(deliverables, item?.deliverables ?? []),
      customFields,
    } as const;
    const saved = item
      ? await useWorkItemStore.getState().update({
          ...shared,
          id: item.id,
          expectedVersion: item.version,
        })
      : await useWorkItemStore.getState().create({
          ...shared,
          reminderAt: isoValue(reminderAt),
        });
    setSaving(false);
    if (saved) onClose();
  };

  return (
    <div
      className="modal-backdrop work-modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="work-form-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="work-form-title"
        data-testid="work-item-form"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <div>
            <span className="work-eyebrow">{item ? 'EDIT WORK ITEM' : 'CAPTURE OUTCOME'}</span>
            <h2 id="work-form-title">{item ? item.title : 'New work item'}</h2>
          </div>
          <button type="button" aria-label="Close" data-testid="work-form-close" onClick={onClose}>
            <Ic name="x" size={15} />
          </button>
        </header>

        <div className="work-form-grid">
          <label className="work-form-span" htmlFor="work-title">
            <span>
              Title <em>required</em>
            </span>
            <input
              id="work-title"
              data-testid="work-title"
              autoFocus
              required
              maxLength={500}
              value={title}
              placeholder="Describe the outcome, not just the activity"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label htmlFor="work-type">
            <span>
              Work type <small>optional</small>
            </span>
            <select
              id="work-type"
              data-testid="work-type"
              value={typeId}
              onChange={(event) => setTypeId(event.target.value)}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="work-priority">
            <span>Priority</span>
            <select
              id="work-priority"
              data-testid="work-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as typeof priority)}
            >
              <option value="none">No priority</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label className="work-form-span" htmlFor="work-description">
            <span>Outcome / request</span>
            <textarea
              id="work-description"
              data-testid="work-description"
              rows={3}
              value={description}
              placeholder="What should be true when this is done?"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="work-form-span" htmlFor="work-background">
            <span>Background and context</span>
            <textarea
              id="work-background"
              data-testid="work-background"
              rows={4}
              value={background}
              placeholder="Why now, relevant history, constraints, links, and decisions already made"
              onChange={(event) => setBackground(event.target.value)}
            />
          </label>

          <div className="work-form-section work-form-span">
            <strong>Source</strong>
            <span>Keep the original request and its context traceable.</span>
          </div>
          <label htmlFor="work-source-person">
            <span>Source person</span>
            <input
              id="work-source-person"
              data-testid="work-source-person"
              value={sourcePerson}
              placeholder="e.g. Maya Chen"
              onChange={(event) => setSourcePerson(event.target.value)}
            />
          </label>
          <label htmlFor="work-source-channel">
            <span>Channel</span>
            <input
              id="work-source-channel"
              data-testid="work-source-channel"
              value={sourceChannel}
              placeholder="e.g. Customer call / Slack #launch"
              onChange={(event) => setSourceChannel(event.target.value)}
            />
          </label>
          <label className="work-form-span" htmlFor="work-source-url">
            <span>Source link</span>
            <input
              id="work-source-url"
              data-testid="work-source-url"
              type="url"
              value={sourceUrl}
              placeholder="https://…"
              onChange={(event) => setSourceUrl(event.target.value)}
            />
          </label>

          <label htmlFor="work-start-at">
            <span>Start</span>
            <input
              id="work-start-at"
              data-testid="work-start-at"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          </label>
          <label htmlFor="work-due-at">
            <span>Deadline</span>
            <input
              id="work-due-at"
              data-testid="work-due-at"
              type="datetime-local"
              value={dueAt}
              onChange={(event) => setDueAt(event.target.value)}
            />
          </label>
          {!item ? (
            <label htmlFor="work-reminder-at">
              <span>First reminder</span>
              <input
                id="work-reminder-at"
                data-testid="work-reminder-at"
                type="datetime-local"
                value={reminderAt}
                onChange={(event) => setReminderAt(event.target.value)}
              />
            </label>
          ) : null}
          <label htmlFor="work-labels">
            <span>Labels</span>
            <input
              id="work-labels"
              data-testid="work-labels"
              value={labels}
              placeholder="launch, q3, customer"
              onChange={(event) => setLabels(event.target.value)}
            />
          </label>

          {selectedType?.fieldDefinitions.length ? (
            <div className="work-form-section work-form-span">
              <strong>{selectedType.name} fields</strong>
              <span>{selectedType.description}</span>
            </div>
          ) : null}
          {selectedType?.fieldDefinitions.map((definition) => (
            <CustomFieldInput
              key={definition.key}
              definition={definition}
              value={customFields[definition.key]}
              onChange={(value) => setCustomFields({ ...customFields, [definition.key]: value })}
            />
          ))}

          <label className="work-form-span" htmlFor="work-acceptance">
            <span>
              Acceptance criteria <small>one per line</small>
            </span>
            <textarea
              id="work-acceptance"
              data-testid="work-acceptance"
              rows={4}
              value={acceptance}
              placeholder={
                'Decision is documented with cited evidence\nStakeholders can review the final output'
              }
              onChange={(event) => setAcceptance(event.target.value)}
            />
          </label>
          <label className="work-form-span" htmlFor="work-deliverables">
            <span>
              Expected deliverables <small>one per line</small>
            </span>
            <textarea
              id="work-deliverables"
              data-testid="work-deliverables"
              rows={3}
              value={deliverables}
              placeholder={'Research brief\nLaunch checklist\nApproved final copy'}
              onChange={(event) => setDeliverables(event.target.value)}
            />
          </label>
        </div>

        <footer>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            data-testid="work-form-submit"
            disabled={saving || !title.trim() || !typeId}
          >
            {saving ? 'Saving…' : item ? 'Save changes' : 'Create work item'}
          </button>
        </footer>
      </form>
    </div>
  );
}
