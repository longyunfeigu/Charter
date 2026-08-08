import React, { useEffect, useMemo, useState } from 'react';
import type {
  WorkBoardColumnDto,
  WorkItemDto,
  WorkItemFieldDefinition,
  WorkItemStatusCategory,
} from '@pi-ide/ipc-contracts';
import { useWorkItemStore, workAttentionCount } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';
import { WorkItemDetail } from './WorkItemDetail.js';
import { WorkItemForm } from './WorkItemForm.js';
import '../styles/work.css';

function columnIcon(category: WorkItemStatusCategory): string {
  switch (category) {
    case 'inbox':
      return 'sliders';
    case 'planned':
      return 'clock';
    case 'active':
      return 'pencil';
    case 'waiting':
      return 'alert';
    case 'review':
      return 'checkCircle';
    case 'completed':
      return 'check';
    case 'cancelled':
      return 'ban';
  }
}

function workReference(id: string): string {
  const compact = id.replace(/^work[_-]?/i, '').replace(/[^a-z0-9]/gi, '');
  return `WORK-${compact.slice(-5).toUpperCase() || 'LOCAL'}`;
}

function priorityLabel(priority: WorkItemDto['priority']): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

function duePresentation(dueAt: string | null): { label: string; tone: string } | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  const distance = date.getTime() - Date.now();
  const day = 24 * 60 * 60_000;
  const formatted = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    date,
  );
  if (distance < 0) return { label: `Overdue · ${formatted}`, tone: 'overdue' };
  if (distance < day) return { label: `Due today · ${formatted}`, tone: 'soon' };
  return { label: `Due ${formatted}`, tone: '' };
}

function isAttention(
  item: WorkItemDto,
  columns: WorkBoardColumnDto[],
  reminderIds: Set<string>,
): boolean {
  const category = columns.find((column) => column.id === item.columnId)?.category;
  return (
    category !== 'completed' &&
    category !== 'cancelled' &&
    (category === 'waiting' ||
      category === 'review' ||
      reminderIds.has(item.id) ||
      (item.dueAt !== null && Date.parse(item.dueAt) < Date.now()))
  );
}

function WorkCard(props: {
  item: WorkItemDto;
  column: WorkBoardColumnDto;
  onDropBefore(id: string, beforeId: string): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
}): React.JSX.Element {
  const { item, column, onDropBefore, onDragStart, onDragEnd } = props;
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const type = snapshot.types.find((candidate) => candidate.id === item.typeId) ?? null;
  const executions = snapshot.executions.filter((execution) => execution.workItemId === item.id);
  const activeReminder = snapshot.reminders.some(
    (reminder) => reminder.workItemId === item.id && reminder.state !== 'cancelled',
  );
  const due = duePresentation(item.dueAt);
  const checks = [...item.acceptance, ...item.deliverables];
  const checked = checks.filter((entry) => entry.checked).length;
  const progress = checks.length === 0 ? 0 : Math.round((checked / checks.length) * 100);

  return (
    <article
      className={`work-card priority-${item.priority}`}
      data-testid={`work-card-${item.id}`}
      draggable
      tabIndex={0}
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-charter-work-item', item.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart(item.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const dragged = event.dataTransfer.getData('application/x-charter-work-item');
        if (dragged && dragged !== item.id) onDropBefore(dragged, item.id);
      }}
      onClick={() => void useWorkItemStore.getState().select(item.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void useWorkItemStore.getState().select(item.id);
        }
      }}
    >
      <div className="work-card-top">
        <span className="work-card-reference">{workReference(item.id)}</span>
        {activeReminder ? (
          <span
            className="work-card-attention-dot"
            title="Reminder configured"
            aria-label="Reminder configured"
          />
        ) : null}
      </div>
      <h3 title={item.title}>{item.title}</h3>
      {checks.length ? (
        <div className="work-card-progress" aria-label={`${progress}% complete`}>
          <span style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      <div className="work-card-meta">
        {item.priority !== 'none' ? (
          <span className={`work-meta-pill priority-${item.priority}`}>
            <Ic name={item.priority === 'urgent' ? 'alert' : 'chart'} size={11} />
            {priorityLabel(item.priority)}
          </span>
        ) : null}
        <span
          className="work-type-pill"
          style={{ '--work-type-color': type?.color ?? column.color } as React.CSSProperties}
        >
          <i /> {type?.name ?? 'General'}
        </span>
        {item.labels.slice(0, 2).map((label) => (
          <span className="work-meta-pill" key={label}>
            {label}
          </span>
        ))}
        {due ? (
          <span className={`work-meta-pill work-card-due ${due.tone}`}>
            <Ic name="clock" size={11} /> {due.label}
          </span>
        ) : null}
        {checks.length ? (
          <span className={`work-meta-stat ${checked === checks.length ? 'complete' : ''}`}>
            <Ic name="check" size={11} /> {checked}/{checks.length}
          </span>
        ) : null}
        {activeReminder ? (
          <span
            className="work-meta-stat"
            title="Reminder configured"
            aria-label="Reminder configured"
          >
            <Ic name="alert" size={11} />
          </span>
        ) : null}
        {executions.length ? (
          <span
            className="work-meta-stat"
            title={`${executions.length} linked execution(s)`}
            aria-label={`${executions.length} linked execution(s)`}
          >
            <Ic name="bot" size={11} /> {executions.length}
          </span>
        ) : null}
      </div>
    </article>
  );
}

function TypeCreator(props: { onClose(): void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#7c5cff');
  const [fields, setFields] = useState<
    Array<{ label: string; kind: WorkItemFieldDefinition['kind']; required: boolean }>
  >([]);
  const [fieldLabel, setFieldLabel] = useState('');
  const [fieldKind, setFieldKind] = useState<WorkItemFieldDefinition['kind']>('text');
  const [required, setRequired] = useState(false);

  return (
    <div
      className="modal-backdrop work-modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        className="work-config-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create work type"
        data-testid="work-type-creator"
      >
        <header>
          <div>
            <span className="work-eyebrow">CUSTOM SCHEMA</span>
            <h2>Create work type</h2>
          </div>
          <button aria-label="Close" onClick={props.onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <label>
          <span>Name</span>
          <input
            autoFocus
            data-testid="work-new-type-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Customer escalation"
          />
        </label>
        <label>
          <span>Description</span>
          <textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>Color</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>
        <div className="work-config-fields">
          <strong>Type-specific fields</strong>
          {fields.map((field, index) => (
            <div key={`${field.label}-${index}`}>
              <span>{field.label}</span>
              <small>
                {field.kind}
                {field.required ? ' · required' : ''}
              </small>
              <button
                onClick={() => setFields(fields.filter((_, candidate) => candidate !== index))}
              >
                <Ic name="x" size={11} />
              </button>
            </div>
          ))}
          <div className="work-config-field-add">
            <input
              data-testid="work-new-field-label"
              value={fieldLabel}
              onChange={(event) => setFieldLabel(event.target.value)}
              placeholder="Field label"
            />
            <select
              value={fieldKind}
              onChange={(event) => setFieldKind(event.target.value as typeof fieldKind)}
            >
              <option value="text">Text</option>
              <option value="long_text">Long text</option>
              <option value="number">Number</option>
              <option value="date">Date</option>
              <option value="url">URL</option>
              <option value="checkbox">Checkbox</option>
            </select>
            <label>
              <input
                type="checkbox"
                checked={required}
                onChange={(event) => setRequired(event.target.checked)}
              />{' '}
              Required
            </label>
            <button
              className="btn"
              disabled={!fieldLabel.trim()}
              onClick={() => {
                setFields([...fields, { label: fieldLabel.trim(), kind: fieldKind, required }]);
                setFieldLabel('');
                setRequired(false);
              }}
            >
              Add field
            </button>
          </div>
        </div>
        <footer>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="work-new-type-submit"
            disabled={!name.trim()}
            onClick={async () => {
              const type = await useWorkItemStore.getState().createType({
                name: name.trim(),
                icon: 'circle',
                color,
                description,
                fieldDefinitions: fields.map((field) => ({
                  key:
                    field.label
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '_')
                      .replace(/^_|_$/g, '')
                      .slice(0, 80) || `field_${globalThis.crypto.randomUUID().slice(0, 8)}`,
                  label: field.label,
                  kind: field.kind,
                  required: field.required,
                  options: [],
                  placeholder: '',
                })),
              });
              if (type) props.onClose();
            }}
          >
            Create type
          </button>
        </footer>
      </section>
    </div>
  );
}

function StageCreator(props: { onClose(): void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<WorkItemStatusCategory>('active');
  const [color, setColor] = useState('#64748b');
  const [wipLimit, setWipLimit] = useState('');
  return (
    <div
      className="modal-backdrop work-modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        className="work-config-modal small"
        role="dialog"
        aria-modal="true"
        aria-label="Add workflow stage"
        data-testid="work-stage-creator"
      >
        <header>
          <div>
            <span className="work-eyebrow">WORKFLOW</span>
            <h2>Add stage</h2>
          </div>
          <button aria-label="Close" onClick={props.onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <label>
          <span>Name</span>
          <input
            autoFocus
            data-testid="work-new-stage-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Legal review"
          />
        </label>
        <label>
          <span>System behavior</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as WorkItemStatusCategory)}
          >
            <option value="inbox">Untriaged</option>
            <option value="planned">Planned</option>
            <option value="active">Active work</option>
            <option value="waiting">Waiting / blocked</option>
            <option value="review">Needs review</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          <span>WIP limit (optional)</span>
          <input
            type="number"
            min="1"
            value={wipLimit}
            onChange={(event) => setWipLimit(event.target.value)}
            placeholder="No limit"
          />
        </label>
        <label>
          <span>Color</span>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>
        <footer>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="work-new-stage-submit"
            disabled={!name.trim()}
            onClick={async () => {
              const column = await useWorkItemStore.getState().createColumn({
                name: name.trim(),
                category,
                color,
                wipLimit: wipLimit ? Number(wipLimit) : null,
              });
              if (column) props.onClose();
            }}
          >
            Add stage
          </button>
        </footer>
      </section>
    </div>
  );
}

export function WorkView(): React.JSX.Element {
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const detail = useWorkItemStore((state) => state.detail);
  const selectedId = useWorkItemStore((state) => state.selectedId);
  const loading = useWorkItemStore((state) => state.loading);
  const init = useWorkItemStore((state) => state.init);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [typeCreatorOpen, setTypeCreatorOpen] = useState(false);
  const [stageCreatorOpen, setStageCreatorOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragTargetColumnId, setDragTargetColumnId] = useState<string | null>(null);

  useEffect(() => init(), [init]);

  const firedReminderIds = useMemo(
    () =>
      new Set(
        snapshot.reminders
          .filter((reminder) => reminder.state === 'fired')
          .map((reminder) => reminder.workItemId),
      ),
    [snapshot.reminders],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return snapshot.items.filter((item) => {
      if (typeFilter !== 'all' && item.typeId !== typeFilter) return false;
      if (attentionOnly && !isAttention(item, snapshot.columns, firedReminderIds)) return false;
      if (!query) return true;
      return [
        item.title,
        item.descriptionMd,
        item.backgroundMd,
        item.sourcePerson,
        item.sourceChannel,
        ...item.labels,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [attentionOnly, firedReminderIds, search, snapshot.columns, snapshot.items, typeFilter]);
  const attention = workAttentionCount(snapshot);
  const activeCount = snapshot.items.filter(
    (item) => snapshot.columns.find((column) => column.id === item.columnId)?.category === 'active',
  ).length;
  const reviewCount = snapshot.items.filter(
    (item) => snapshot.columns.find((column) => column.id === item.columnId)?.category === 'review',
  ).length;
  const openCount = snapshot.items.filter((item) => {
    const category = snapshot.columns.find((column) => column.id === item.columnId)?.category;
    return category !== 'completed' && category !== 'cancelled';
  }).length;

  const move = (id: string, columnId: string, beforeId: string | null): void => {
    const item = snapshot.items.find((candidate) => candidate.id === id);
    if (!item) return;
    void useWorkItemStore
      .getState()
      .move({ id, columnId, beforeId, expectedVersion: item.version });
    setDraggedId(null);
    setDragTargetColumnId(null);
  };

  return (
    <main className="work-view" data-testid="work-view">
      <header className="work-header">
        <div className="work-header-nav">
          <h1>Work</h1>
          <span className="work-view-tab">
            <Ic name="layout" size={13} /> Board
          </span>
          <section className="work-summary" aria-label="Work summary">
            <div>
              <strong>{openCount}</strong>
              <span>Open</span>
            </div>
            <div>
              <strong>{activeCount}</strong>
              <span>In progress</span>
            </div>
            <div>
              <strong>{reviewCount}</strong>
              <span>Review</span>
            </div>
            <button
              className={attentionOnly ? 'active' : ''}
              data-testid="work-attention-filter"
              onClick={() => setAttentionOnly(!attentionOnly)}
            >
              <strong>{attention}</strong>
              <span>Attention</span>
            </button>
          </section>
        </div>
        <div className="work-header-actions">
          <button
            className="btn"
            data-testid="work-manage-types"
            onClick={() => setTypeCreatorOpen(true)}
          >
            <Ic name="sliders" size={13} /> <span>Types</span>
          </button>
          <button
            className="btn"
            data-testid="work-add-stage"
            onClick={() => setStageCreatorOpen(true)}
          >
            <Ic name="plus" size={13} /> <span>Stage</span>
          </button>
          <button
            className="btn primary"
            data-testid="work-new-item"
            onClick={() => setFormOpen(true)}
          >
            <Ic name="plus" size={14} /> <span>New work</span>
          </button>
        </div>
      </header>

      <section className="work-toolbar">
        <label className="work-search">
          <Ic name="search" size={14} />
          <input
            data-testid="work-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search work, sources, labels…"
          />
        </label>
        <select
          data-testid="work-type-filter"
          aria-label="Filter by work type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="all">All work types</option>
          {snapshot.types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
        {search || typeFilter !== 'all' || attentionOnly ? (
          <button
            className="work-clear-filter"
            onClick={() => {
              setSearch('');
              setTypeFilter('all');
              setAttentionOnly(false);
            }}
          >
            Clear filters
          </button>
        ) : null}
        <span className="work-save-state">{loading ? 'Syncing…' : 'Saved locally'}</span>
      </section>

      <div className="work-board" data-testid="work-board" aria-label="Work board">
        {snapshot.columns.map((column) => {
          const items = filtered
            .filter((item) => item.columnId === column.id)
            .sort((a, b) => a.position - b.position);
          const actualCount = snapshot.items.filter((item) => item.columnId === column.id).length;
          return (
            <section
              className={`work-column category-${column.category} ${
                dragTargetColumnId === column.id ? 'is-drag-target' : ''
              }`}
              key={column.id}
              data-testid={`work-column-${column.id}`}
              aria-label={`${column.name} status, ${actualCount} work item${actualCount === 1 ? '' : 's'}`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (draggedId) setDragTargetColumnId(column.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData('application/x-charter-work-item');
                if (id) move(id, column.id, null);
                else {
                  setDraggedId(null);
                  setDragTargetColumnId(null);
                }
              }}
            >
              <header>
                <span className="work-column-icon" style={{ color: column.color }}>
                  <Ic name={columnIcon(column.category)} size={15} />
                </span>
                <h2>{column.name}</h2>
                <span className="work-column-count">{actualCount}</span>
                {column.wipLimit ? (
                  <em className={actualCount >= column.wipLimit ? 'at-limit' : ''}>
                    WIP {actualCount}/{column.wipLimit}
                  </em>
                ) : null}
                <button
                  className="work-column-add"
                  data-testid={`work-add-${column.id}`}
                  aria-label={`Add work; new items start in Inbox`}
                  title="New work item (starts in Inbox)"
                  onClick={() => setFormOpen(true)}
                >
                  <Ic name="plus" size={14} />
                </button>
              </header>
              <div className="work-column-cards">
                {items.map((item) => (
                  <WorkCard
                    key={item.id}
                    item={item}
                    column={column}
                    onDropBefore={(id, beforeId) => move(id, column.id, beforeId)}
                    onDragStart={setDraggedId}
                    onDragEnd={() => {
                      setDraggedId(null);
                      setDragTargetColumnId(null);
                    }}
                  />
                ))}
                {items.length === 0 ? (
                  <div
                    className={`work-column-empty ${
                      draggedId || filtered.length !== snapshot.items.length ? 'is-visible' : ''
                    }`}
                  >
                    {filtered.length === snapshot.items.length
                      ? 'Drop work here'
                      : 'No matching work'}
                  </div>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {selectedId && detail?.item.id === selectedId ? (
        <WorkItemDetail
          detail={detail}
          type={snapshot.types.find((type) => type.id === detail.item.typeId) ?? null}
          onClose={() => void useWorkItemStore.getState().select(null)}
        />
      ) : null}
      {formOpen ? (
        <WorkItemForm item={null} types={snapshot.types} onClose={() => setFormOpen(false)} />
      ) : null}
      {typeCreatorOpen ? <TypeCreator onClose={() => setTypeCreatorOpen(false)} /> : null}
      {stageCreatorOpen ? <StageCreator onClose={() => setStageCreatorOpen(false)} /> : null}
    </main>
  );
}
