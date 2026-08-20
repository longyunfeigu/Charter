import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ChannelRequest,
  WorkChecklistItem,
  WorkCustomFieldValue,
  WorkItemDto,
  WorkItemFieldDefinition,
  WorkItemPriority,
  WorkItemTypeDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { t } from '../i18n.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import { Ic } from './home-icons.js';
import {
  calendarMonth,
  formatWorkDate,
  isoForDay,
  parseWorkDateInput,
  timeOfIso,
  workDateQuickOptions,
} from './workDates.js';

export function workReference(id: string): string {
  const compact = id.replace(/^work[_-]?/i, '').replace(/[^a-z0-9]/gi, '');
  return `WORK-${compact.slice(-5).toUpperCase() || 'LOCAL'}`;
}

const PRIORITIES: Array<{ id: WorkItemPriority; label: string }> = [
  { id: 'none', label: 'No priority' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'urgent', label: 'Urgent' },
];

const DRAFT_KEY = 'charter.work.newItemDraft.v1';

/** Queued on the create page, persisted as file/link evidence after the item
 * exists. Edit mode skips the queue and writes evidence directly. */
interface WorkAttachmentDraft {
  kind: 'file' | 'link';
  label: string;
  value: string;
}

interface PageModel {
  attachments: WorkAttachmentDraft[];
  typeId: string;
  title: string;
  descriptionMd: string;
  backgroundMd: string;
  sourcePerson: string;
  sourceChannel: string;
  sourceUrl: string;
  priority: WorkItemPriority;
  labels: string[];
  startAt: string | null;
  dueAt: string | null;
  reminderAt: string | null;
  acceptance: WorkChecklistItem[];
  deliverables: WorkChecklistItem[];
  customFields: Record<string, WorkCustomFieldValue>;
}

function emptyModel(typeId: string): PageModel {
  return {
    attachments: [],
    typeId,
    title: '',
    descriptionMd: '',
    backgroundMd: '',
    sourcePerson: '',
    sourceChannel: '',
    sourceUrl: '',
    priority: 'none',
    labels: [],
    startAt: null,
    dueAt: null,
    reminderAt: null,
    acceptance: [],
    deliverables: [],
    customFields: {},
  };
}

function modelFromItem(item: WorkItemDto): PageModel {
  return {
    attachments: [],
    typeId: item.typeId,
    title: item.title,
    descriptionMd: item.descriptionMd,
    backgroundMd: item.backgroundMd,
    sourcePerson: item.sourcePerson,
    sourceChannel: item.sourceChannel,
    sourceUrl: item.sourceUrl,
    priority: item.priority,
    labels: item.labels,
    startAt: item.startAt,
    dueAt: item.dueAt,
    reminderAt: null,
    acceptance: item.acceptance,
    deliverables: item.deliverables,
    customFields: item.customFields,
  };
}

function isDirty(model: PageModel): boolean {
  return Boolean(
    model.title.trim() ||
    model.descriptionMd.trim() ||
    model.backgroundMd.trim() ||
    model.sourcePerson.trim() ||
    model.sourceChannel.trim() ||
    model.sourceUrl.trim() ||
    model.priority !== 'none' ||
    model.labels.length ||
    model.startAt ||
    model.dueAt ||
    model.reminderAt ||
    model.attachments.length ||
    model.acceptance.some((entry) => entry.text.trim()) ||
    model.deliverables.some((entry) => entry.text.trim()) ||
    Object.values(model.customFields).some(
      (value) => value !== undefined && value !== null && value !== '' && value !== false,
    ),
  );
}

function loadDraft(): PageModel | null {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PageModel;
    if (typeof parsed?.title !== 'string' || typeof parsed?.typeId !== 'string') return null;
    return { ...parsed, attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [] };
  } catch {
    return null;
  }
}

function clearDraft(): void {
  try {
    globalThis.localStorage?.removeItem(DRAFT_KEY);
  } catch {
    /* draft persistence is best-effort */
  }
}

function newChecklistLine(): WorkChecklistItem {
  return { id: `check_${globalThis.crypto.randomUUID()}`, text: '', checked: false };
}

function pruneChecklist(items: WorkChecklistItem[]): WorkChecklistItem[] {
  return items
    .map((entry) => ({ ...entry, text: entry.text.trim() }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, 100);
}

type PopoverState = { key: string; anchor: DOMRect } | null;

function Popover(props: {
  anchor: DOMRect;
  onClose(): void;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    const { anchor } = props;
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - width - 8);
    let top = anchor.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.top - height - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  });

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) props.onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  });

  return (
    <div ref={ref} className="work-pop" role="menu">
      {props.children}
    </div>
  );
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const TIME_CHIPS = [
  { label: '09:00', hours: 9, minutes: 0 },
  { label: '12:00', hours: 12, minutes: 0 },
  { label: '15:00', hours: 15, minutes: 0 },
  { label: '18:00', hours: 18, minutes: 0 },
];

/** Calendar-first date picker: month grid, wall-clock chips, two quick
 * shortcuts, and a typed fallback ("aug 20 3pm"). No native controls. */
function DatePicker(props: {
  heading: string;
  value: string | null;
  onPick(iso: string | null): void;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const selected = useMemo(() => {
    if (!props.value) return null;
    const date = new Date(props.value);
    return Number.isFinite(date.getTime()) ? date : null;
  }, [props.value]);
  const [view, setView] = useState(() => {
    const base = selected ?? new Date();
    return { year: base.getFullYear(), month: base.getMonth() };
  });
  const [pendingTime, setPendingTime] = useState(() => timeOfIso(props.value));
  const quick = useMemo(() => workDateQuickOptions(), []);
  const weeks = calendarMonth(view.year, view.month);
  const today = new Date();
  const shiftMonth = (delta: number): void => {
    setView((current) => {
      const date = new Date(current.year, current.month + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() };
    });
  };
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(
    new Date(view.year, view.month, 1),
  );
  const inView = (date: Date | null): boolean =>
    date !== null && date.getFullYear() === view.year && date.getMonth() === view.month;

  return (
    <>
      <div className="work-pop-head">{props.heading}</div>
      <div className="work-cal-quick">
        {quick.map((option, index) => (
          <button
            key={option.label}
            type="button"
            data-testid={`work-date-quick-${index}`}
            onClick={() => props.onPick(option.iso)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="work-cal-head">
        <button
          type="button"
          data-testid="work-cal-prev"
          aria-label="Previous month"
          onClick={() => shiftMonth(-1)}
        >
          <Ic name="chevron" size={11} />
        </button>
        <strong>{monthLabel}</strong>
        <button
          type="button"
          data-testid="work-cal-next"
          aria-label="Next month"
          onClick={() => shiftMonth(1)}
        >
          <Ic name="chevron" size={11} />
        </button>
      </div>
      <div className="work-cal-grid" role="grid" aria-label={monthLabel}>
        {WEEKDAYS.map((day, index) => (
          <span key={`${day}-${index}`} className="work-cal-dow">
            {day}
          </span>
        ))}
        {weeks.flat().map((day, index) =>
          day === null ? (
            <span key={`pad-${index}`} />
          ) : (
            <button
              key={`day-${index}`}
              type="button"
              data-testid={`work-cal-day-${day}`}
              className={`work-cal-day ${
                inView(selected) && selected!.getDate() === day ? 'selected' : ''
              } ${inView(today) && today.getDate() === day ? 'today' : ''}`}
              onClick={() => props.onPick(isoForDay(view.year, view.month, day, pendingTime))}
            >
              {day}
            </button>
          ),
        )}
      </div>
      <div className="work-cal-times">
        {TIME_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={
              pendingTime.hours === chip.hours && pendingTime.minutes === chip.minutes
                ? 'selected'
                : ''
            }
            onClick={() => {
              setPendingTime({ hours: chip.hours, minutes: chip.minutes });
              // With a day already chosen, a time click is a complete answer.
              if (selected) {
                props.onPick(
                  isoForDay(selected.getFullYear(), selected.getMonth(), selected.getDate(), chip),
                );
              }
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>
      <input
        className="work-pop-input"
        data-testid="work-date-input"
        placeholder="Or type — “aug 20 3pm”, “tomorrow”, “2026-09-01 09:00”"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const iso = parseWorkDateInput(text);
          if (iso) props.onPick(iso);
          else setInvalid(true);
        }}
      />
      {invalid ? (
        <div className="work-pop-error">Couldn’t read that date — try “aug 20”.</div>
      ) : null}
      {props.value ? (
        <button
          type="button"
          className="work-pop-item danger"
          data-testid="work-date-clear"
          onClick={() => props.onPick(null)}
        >
          <Ic name="x" size={12} /> Clear
        </button>
      ) : null}
    </>
  );
}

function autoGrow(element: HTMLTextAreaElement | null): void {
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

/**
 * Direction-D capture surface (ADR-0053): creating or editing a work item is a
 * document page, not a form. Creation keeps a local crash-safe draft and the
 * item is committed when you leave the page with a title; edits on an existing
 * item are committed field-by-field through the versioned update channel.
 */
export function WorkItemPage(props: {
  item: WorkItemDto | null;
  types: WorkItemTypeDto[];
  onClose(): void;
}): React.JSX.Element {
  const { item, types, onClose } = props;
  const mode: 'create' | 'edit' = item ? 'edit' : 'create';
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const detail = useWorkItemStore((state) => state.detail);
  const initial = useMemo(() => {
    if (item) return { model: modelFromItem(item), restored: false };
    const draft = loadDraft();
    if (draft && isDirty(draft)) {
      return {
        model: {
          ...draft,
          typeId: types.some((t) => t.id === draft.typeId) ? draft.typeId : (types[0]?.id ?? ''),
        },
        restored: true,
      };
    }
    return { model: emptyModel(types[0]?.id ?? ''), restored: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial state only
  }, []);
  const [model, setModel] = useState<PageModel>(initial.model);
  const restoredDraft = initial.restored;
  const [popover, setPopover] = useState<PopoverState>(null);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const [focusLineId, setFocusLineId] = useState<string | null>(null);
  const activeFieldRef = useRef<keyof PageModel | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  /* Durable mutations run strictly one after another so each carries the
   * version produced by the previous one — parallel blur+click commits would
   * otherwise race the optimistic-version window and trip the conflict gate. */
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueSave = (operation: () => Promise<void>): void => {
    setPendingSaves((count) => count + 1);
    saveQueueRef.current = saveQueueRef.current
      .then(operation)
      .catch(() => undefined)
      .finally(() => setPendingSaves((count) => count - 1));
  };

  const type = types.find((candidate) => candidate.id === model.typeId) ?? null;
  const column = item
    ? (snapshot.columns.find((candidate) => candidate.id === item.columnId) ?? null)
    : (snapshot.columns.find((candidate) => candidate.category === 'inbox') ??
      snapshot.columns[0] ??
      null);

  /* Crash-safe local draft: nothing typed on the create page is ever lost. */
  useEffect(() => {
    if (mode !== 'create') return;
    const timer = setTimeout(() => {
      try {
        if (isDirty(model)) globalThis.localStorage?.setItem(DRAFT_KEY, JSON.stringify(model));
        else clearDraft();
      } catch {
        /* best-effort */
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [mode, model]);

  /* Edit mode: the store is authoritative. After every committed change (ours
   * or a concurrent one) reconcile local state, preserving only the field the
   * user is actively typing in. */
  useEffect(() => {
    if (mode !== 'edit' || !item) return;
    setModel((previous) => {
      const next = modelFromItem(item);
      const active = activeFieldRef.current;
      if (active) {
        return { ...next, [active]: previous[active] };
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity churn of `item` is irrelevant
  }, [mode, item?.id, item?.version]);

  const freshVersion = (): number => {
    if (!item) return 1;
    const state = useWorkItemStore.getState();
    const inSnapshot = state.snapshot.items.find((candidate) => candidate.id === item.id);
    const inDetail = state.detail?.item.id === item.id ? state.detail.item : null;
    const best =
      inDetail && (!inSnapshot || inDetail.version >= inSnapshot.version) ? inDetail : inSnapshot;
    return best?.version ?? item.version;
  };

  const commitUpdate = (
    patch: Omit<ChannelRequest<'workItem.update'>, 'id' | 'expectedVersion'>,
  ): void => {
    if (!item) return;
    enqueueSave(async () => {
      await useWorkItemStore.getState().update({
        id: item.id,
        expectedVersion: freshVersion(),
        ...patch,
      });
    });
  };

  /* Local change; in edit mode optionally durable at the same time. */
  const apply = (patch: Partial<PageModel>, commit: boolean): void => {
    setModel((previous) => ({ ...previous, ...patch }));
    if (mode === 'edit' && commit) {
      const { reminderAt: _reminderAt, ...durable } = patch;
      if (Object.keys(durable).length) {
        commitUpdate(durable as Omit<ChannelRequest<'workItem.update'>, 'id' | 'expectedVersion'>);
      }
    }
  };

  /* Blur-commit for typed fields: one durable update per finished thought,
   * so the activity log records edits, not keystrokes. Checklists are pruned
   * of empty lines before the diff — the contract requires non-empty text. */
  const commitText = (field: keyof PageModel): void => {
    activeFieldRef.current = null;
    if (mode !== 'edit' || !item) return;
    const isChecklist = field === 'acceptance' || field === 'deliverables';
    const value = isChecklist
      ? pruneChecklist(modelRef.current[field] as WorkChecklistItem[])
      : modelRef.current[field];
    const currentModel = modelFromItem(item);
    const current = isChecklist
      ? pruneChecklist(currentModel[field] as WorkChecklistItem[])
      : currentModel[field];
    if (JSON.stringify(value) === JSON.stringify(current)) return;
    commitUpdate({ [field]: value } as Omit<
      ChannelRequest<'workItem.update'>,
      'id' | 'expectedVersion'
    >);
  };

  const finish = async (): Promise<void> => {
    if (finishing) return;
    if (mode === 'edit') {
      onClose();
      return;
    }
    const title = model.title.trim();
    if (!title) {
      clearDraft();
      if (isDirty(model)) {
        useAppStore.getState().pushToast('info', 'Draft discarded — a work item needs a title');
      }
      onClose();
      return;
    }
    setFinishing(true);
    const created = await useWorkItemStore.getState().create({
      typeId: model.typeId,
      title,
      assignee: '',
      descriptionMd: model.descriptionMd,
      backgroundMd: model.backgroundMd,
      sourcePerson: model.sourcePerson.trim(),
      sourceChannel: model.sourceChannel.trim(),
      sourceUrl: model.sourceUrl.trim(),
      priority: model.priority,
      labels: model.labels.slice(0, 30),
      startAt: model.startAt,
      dueAt: model.dueAt,
      reminderAt: model.reminderAt,
      acceptance: pruneChecklist(model.acceptance),
      deliverables: pruneChecklist(model.deliverables),
      customFields: model.customFields,
    });
    if (!created) {
      setFinishing(false);
      return; // Store surfaced the error; the draft stays intact.
    }
    // Queued attachments become durable evidence now that the item exists.
    for (const draft of modelRef.current.attachments) {
      await useWorkItemStore.getState().addEvidence({
        workItemId: created.id,
        kind: draft.kind,
        label: draft.label,
        value: draft.value,
        createdBy: 'You',
      });
    }
    setFinishing(false);
    clearDraft();
    onClose();
  };

  const discard = (): void => {
    // window.confirm never enters the DOM, so the compatibility layer cannot
    // localize it — this one goes through t() directly.
    if (isDirty(model) && !window.confirm(t('Discard this draft? Nothing has been created yet.'))) {
      return;
    }
    clearDraft();
    onClose();
  };

  const openPopover = (key: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
    setPopover({ key, anchor: event.currentTarget.getBoundingClientRect() });
  };
  const closePopover = (): void => setPopover(null);

  const setCustomField = (key: string, value: WorkCustomFieldValue, commit: boolean): void => {
    const customFields = { ...modelRef.current.customFields, [key]: value };
    apply({ customFields }, commit);
  };

  const labelInputRef = useRef<HTMLInputElement>(null);
  const addLabel = (raw: string): void => {
    const value = raw.trim().replace(/,+$/, '').slice(0, 100);
    if (!value || model.labels.includes(value) || model.labels.length >= 30) return;
    apply({ labels: [...model.labels, value] }, true);
  };
  const removeLabel = (label: string): void => {
    apply({ labels: model.labels.filter((candidate) => candidate !== label) }, true);
  };

  /* ── Attachments & links ──────────────────────────────────────────────
   * Create mode queues locally (part of the crash-safe draft) and persists
   * as evidence right after the item exists; edit mode writes evidence
   * directly, so the drawer and the page always show the same rows. */
  const [attachmentText, setAttachmentText] = useState('');
  const evidenceAttachments =
    mode === 'edit' && item && detail && detail.item.id === item.id
      ? detail.evidence.filter((entry) => entry.kind === 'file' || entry.kind === 'link')
      : [];

  const attachmentFromValue = (raw: string): WorkAttachmentDraft | null => {
    const value = raw.trim();
    if (!value) return null;
    const kind: WorkAttachmentDraft['kind'] = /^https?:\/\//i.test(value) ? 'link' : 'file';
    const trimmed =
      kind === 'link' ? value.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '') : value;
    const label = trimmed.split(/[\\/]/).filter(Boolean).pop() || value;
    return { kind, label: label.slice(0, 500), value };
  };

  const addAttachment = (draft: WorkAttachmentDraft): void => {
    if (mode === 'create') {
      apply({ attachments: [...modelRef.current.attachments, draft] }, false);
      return;
    }
    enqueueSave(async () => {
      await useWorkItemStore.getState().addEvidence({
        workItemId: item!.id,
        kind: draft.kind,
        label: draft.label,
        value: draft.value,
        createdBy: 'You',
      });
    });
  };

  const addAttachmentFromInput = (): void => {
    const draft = attachmentFromValue(attachmentText);
    if (!draft) return;
    addAttachment(draft);
    setAttachmentText('');
  };

  const pickAttachmentFiles = async (): Promise<void> => {
    const result = await rpcResult('workItem.attachment.pick', {});
    if (!result.ok) {
      useAppStore.getState().pushToast('error', result.error.userMessage);
      return;
    }
    for (const path of result.data.paths ?? []) {
      const draft = attachmentFromValue(path);
      if (draft) addAttachment(draft);
    }
  };

  const openAttachment = (kind: 'file' | 'link', value: string): void => {
    if (kind === 'link') void rpcResult('app.openExternal', { url: value });
    else void rpcResult('app.revealPath', { path: value });
  };

  const checklistSection = (
    field: 'acceptance' | 'deliverables',
    heading: string,
    addLabelText: string,
    lineTestPrefix: string,
    addTestId: string,
  ): React.JSX.Element => {
    const entries = model[field];
    const setEntries = (next: WorkChecklistItem[], commit: boolean): void => {
      if (commit && mode === 'edit') {
        apply({ [field]: pruneChecklist(next) } as Partial<PageModel>, true);
      } else {
        apply({ [field]: next } as Partial<PageModel>, false);
      }
    };
    const addLine = (afterIndex?: number): void => {
      const line = newChecklistLine();
      const next = [...entries];
      next.splice(afterIndex === undefined ? next.length : afterIndex + 1, 0, line);
      setEntries(next, false);
      setFocusLineId(line.id);
    };
    return (
      <section className="work-page-section">
        <h2>{heading}</h2>
        {entries.map((entry, index) => (
          <div key={entry.id} className={`work-page-check ${entry.checked ? 'checked' : ''}`}>
            <input
              type="checkbox"
              checked={entry.checked}
              aria-label={entry.checked ? 'Mark as open' : 'Mark as done'}
              onChange={() =>
                setEntries(
                  entries.map((candidate) =>
                    candidate.id === entry.id
                      ? { ...candidate, checked: !candidate.checked }
                      : candidate,
                  ),
                  true,
                )
              }
            />
            <input
              className="work-page-check-text"
              data-testid={`${lineTestPrefix}-${index}`}
              value={entry.text}
              placeholder="Describe a verifiable outcome"
              autoFocus={focusLineId === entry.id}
              onFocus={() => {
                activeFieldRef.current = field;
                if (focusLineId === entry.id) setFocusLineId(null);
              }}
              onChange={(event) =>
                setEntries(
                  entries.map((candidate) =>
                    candidate.id === entry.id
                      ? { ...candidate, text: event.target.value }
                      : candidate,
                  ),
                  false,
                )
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitText(field);
                  addLine(index);
                }
              }}
              onBlur={() => {
                if (!entry.text.trim()) {
                  setEntries(
                    entries.filter((candidate) => candidate.id !== entry.id),
                    false,
                  );
                }
                commitText(field);
              }}
            />
          </div>
        ))}
        <button
          type="button"
          className="work-page-addline"
          data-testid={addTestId}
          onClick={() => addLine()}
        >
          <Ic name="plus" size={12} /> {addLabelText}
        </button>
      </section>
    );
  };

  const propRow = (
    icon: string,
    label: string,
    control: React.ReactNode,
    key?: string,
  ): React.JSX.Element => (
    <div className="work-page-prop" key={key ?? label}>
      <span className="work-page-prop-label">
        <Ic name={icon} size={13} /> {label}
      </span>
      {control}
    </div>
  );

  const valueButton = (
    testId: string,
    popKey: string,
    content: React.ReactNode,
    empty: string,
  ): React.JSX.Element => (
    <button
      type="button"
      className={`work-page-value ${content ? '' : 'empty'}`}
      data-testid={testId}
      onClick={openPopover(popKey)}
    >
      {content ?? empty}
      <Ic name="chevron" size={10} />
    </button>
  );

  const chip = (
    testId: string,
    popKey: string | null,
    icon: string | null,
    content: React.ReactNode,
    empty: string,
  ): React.JSX.Element =>
    popKey ? (
      <button
        key={testId}
        type="button"
        className={`work-page-chip ${content ? '' : 'ghost'}`}
        data-testid={testId}
        onClick={openPopover(popKey)}
      >
        {icon ? <Ic name={icon} size={12} /> : null}
        {content ?? empty}
      </button>
    ) : (
      <span key={testId} className="work-page-chip static" data-testid={testId}>
        {icon ? <Ic name={icon} size={12} /> : null}
        {content ?? empty}
      </span>
    );

  const customFieldRow = (definition: WorkItemFieldDefinition): React.JSX.Element | null => {
    const value = model.customFields[definition.key];
    const requiredMark = definition.required ? (
      <em className="work-page-required">required</em>
    ) : null;
    if (definition.kind === 'checkbox') {
      return propRow(
        'check',
        definition.label,
        <label className="work-page-value-check">
          <input
            type="checkbox"
            data-testid={`work-custom-${definition.key}`}
            checked={value === true}
            onChange={(event) => setCustomField(definition.key, event.target.checked, true)}
          />
          {value === true ? 'Yes' : 'No'}
          {requiredMark}
        </label>,
        definition.key,
      );
    }
    if (definition.kind === 'select') {
      return propRow(
        'chevron',
        definition.label,
        <>
          {valueButton(
            `work-custom-${definition.key}`,
            `custom-select-${definition.key}`,
            typeof value === 'string' && value ? value : null,
            definition.placeholder || 'Choose…',
          )}
          {requiredMark}
        </>,
        definition.key,
      );
    }
    if (definition.kind === 'date') {
      return propRow(
        'clock',
        definition.label,
        <>
          {valueButton(
            `work-custom-${definition.key}`,
            `custom-date-${definition.key}`,
            typeof value === 'string' && value ? formatWorkDate(value) || value : null,
            'Set date',
          )}
          {requiredMark}
        </>,
        definition.key,
      );
    }
    if (definition.kind === 'long_text') return null; // Rendered as a body section below.
    return propRow(
      'file',
      definition.label,
      <span className="work-page-value-input">
        <input
          data-testid={`work-custom-${definition.key}`}
          type={
            definition.kind === 'number' ? 'number' : definition.kind === 'url' ? 'url' : 'text'
          }
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          placeholder={definition.placeholder || 'Empty'}
          onFocus={() => {
            activeFieldRef.current = 'customFields';
          }}
          onChange={(event) =>
            setCustomField(
              definition.key,
              definition.kind === 'number'
                ? event.target.value === ''
                  ? null
                  : Number(event.target.value)
                : event.target.value,
              false,
            )
          }
          onBlur={() => commitText('customFields')}
        />
        {requiredMark}
      </span>,
      definition.key,
    );
  };

  const renderPopover = (): React.ReactNode => {
    if (!popover) return null;
    const { key, anchor } = popover;
    let body: React.ReactNode = null;
    if (key === 'type') {
      body = (
        <>
          <div className="work-pop-head">WORK TYPE</div>
          {types.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`work-pop-item ${candidate.id === model.typeId ? 'selected' : ''}`}
              data-testid={`work-type-option-${candidate.id}`}
              onClick={() => {
                apply({ typeId: candidate.id }, true);
                closePopover();
              }}
            >
              <i className="work-pop-dot" style={{ background: candidate.color }} />
              {candidate.name}
            </button>
          ))}
        </>
      );
    } else if (key === 'priority') {
      body = (
        <>
          <div className="work-pop-head">PRIORITY</div>
          {PRIORITIES.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`work-pop-item ${candidate.id === model.priority ? 'selected' : ''}`}
              data-testid={`work-priority-${candidate.id}`}
              onClick={() => {
                apply({ priority: candidate.id }, true);
                closePopover();
              }}
            >
              <span className={`work-pop-flag priority-${candidate.id}`}>
                <Ic name="flag" size={12} />
              </span>
              {candidate.label}
            </button>
          ))}
        </>
      );
    } else if (key === 'stage' && item) {
      body = (
        <>
          <div className="work-pop-head">STAGE</div>
          {snapshot.columns.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={`work-pop-item ${candidate.id === item.columnId ? 'selected' : ''}`}
              data-testid={`work-stage-option-${candidate.id}`}
              onClick={() => {
                closePopover();
                enqueueSave(async () => {
                  await useWorkItemStore.getState().move({
                    id: item.id,
                    columnId: candidate.id,
                    beforeId: null,
                    expectedVersion: freshVersion(),
                  });
                });
              }}
            >
              <i className="work-pop-dot" style={{ background: candidate.color }} />
              {candidate.name}
            </button>
          ))}
        </>
      );
    } else if (key.startsWith('date-')) {
      const field = key.slice('date-'.length) as 'dueAt' | 'reminderAt';
      const headings = { dueAt: 'DEADLINE', reminderAt: 'FIRST REMINDER' };
      body = (
        <DatePicker
          heading={headings[field]}
          value={model[field]}
          onPick={(iso) => {
            apply({ [field]: iso } as Partial<PageModel>, true);
            closePopover();
          }}
        />
      );
    } else if (key.startsWith('custom-date-')) {
      const fieldKey = key.slice('custom-date-'.length);
      const current = model.customFields[fieldKey];
      body = (
        <DatePicker
          heading={(
            type?.fieldDefinitions.find((d) => d.key === fieldKey)?.label ?? 'DATE'
          ).toUpperCase()}
          value={typeof current === 'string' && current ? current : null}
          onPick={(iso) => {
            setCustomField(fieldKey, iso ?? '', true);
            closePopover();
          }}
        />
      );
    } else if (key.startsWith('custom-select-')) {
      const fieldKey = key.slice('custom-select-'.length);
      const definition = type?.fieldDefinitions.find((d) => d.key === fieldKey);
      const current = model.customFields[fieldKey];
      body = (
        <>
          <div className="work-pop-head">{definition?.label.toUpperCase()}</div>
          {(definition?.options ?? []).map((option, index) => (
            <button
              key={option}
              type="button"
              className={`work-pop-item ${current === option ? 'selected' : ''}`}
              data-testid={`work-select-option-${index}`}
              onClick={() => {
                setCustomField(fieldKey, option, true);
                closePopover();
              }}
            >
              {option}
            </button>
          ))}
          {typeof current === 'string' && current ? (
            <button
              type="button"
              className="work-pop-item danger"
              onClick={() => {
                setCustomField(fieldKey, '', true);
                closePopover();
              }}
            >
              <Ic name="x" size={12} /> Clear
            </button>
          ) : null}
        </>
      );
    }
    return (
      <Popover anchor={anchor} onClose={closePopover}>
        {body}
      </Popover>
    );
  };

  const saveState = (() => {
    if (mode === 'edit') {
      return pendingSaves > 0 ? 'Saving…' : 'All changes saved';
    }
    if (finishing) return 'Creating…';
    if (!isDirty(model)) return 'Draft · nothing typed yet';
    return restoredDraft ? 'Draft restored · kept on this device' : 'Draft · kept on this device';
  })();

  const priority = PRIORITIES.find((candidate) => candidate.id === model.priority)!;
  const longTextFields = type?.fieldDefinitions.filter((d) => d.kind === 'long_text') ?? [];
  const rowFields = type?.fieldDefinitions.filter((d) => d.kind !== 'long_text') ?? [];

  return (
    <section
      className="work-page"
      data-testid="work-item-page"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !popover) void finish();
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void finish();
      }}
    >
      <div className="work-page-topbar">
        <button
          type="button"
          className="work-page-back"
          data-testid="work-page-back"
          onClick={() => void finish()}
        >
          <Ic name="chevron" size={12} /> Board
        </button>
        <span className="work-page-crumb">
          Work / <b>{mode === 'create' ? 'New item' : workReference(item!.id)}</b>
        </span>
        <span
          className={`work-page-state ${pendingSaves > 0 || finishing ? 'busy' : ''}`}
          data-testid="work-page-state"
        >
          <i /> {saveState}
        </span>
        {mode === 'create' ? (
          <button
            type="button"
            className="work-page-discard"
            data-testid="work-page-discard"
            onClick={discard}
          >
            Discard
          </button>
        ) : null}
      </div>

      <div className="work-page-scroll">
        <div className="work-page-doc">
          <div
            className="work-page-eyebrow"
            style={{ '--work-type-color': type?.color ?? '#64748b' } as React.CSSProperties}
          >
            <i />
            <span>{type?.name ?? 'General'}</span>
            <span className="sep">·</span>
            {mode === 'create' ? (
              <span>Draft — becomes a card on the board when it has a title</span>
            ) : (
              <span>
                {workReference(item!.id)} · captured {formatWorkDate(item!.createdAt)}
              </span>
            )}
          </div>
          <textarea
            className="work-page-title"
            data-testid="work-title"
            rows={1}
            maxLength={500}
            autoFocus={mode === 'create'}
            placeholder="Untitled outcome"
            value={model.title}
            ref={autoGrow}
            onFocus={() => {
              activeFieldRef.current = 'title';
            }}
            onChange={(event) => {
              autoGrow(event.currentTarget);
              apply({ title: event.target.value.replace(/\n/g, ' ') }, false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey))
                event.preventDefault();
            }}
            onBlur={() => {
              if (mode === 'edit' && !modelRef.current.title.trim()) {
                // A durable item never loses its title; restore instead of saving ''.
                apply({ title: item!.title }, false);
                activeFieldRef.current = null;
                return;
              }
              commitText('title');
            }}
          />

          {/* One glanceable line of enumerable properties — pull, don't push. */}
          <div className="work-page-chips">
            {mode === 'edit'
              ? chip(
                  'work-page-stage',
                  'stage',
                  null,
                  column ? (
                    <>
                      <i className="work-pop-dot" style={{ background: column.color }} />
                      {column.name}
                    </>
                  ) : null,
                  'Stage',
                )
              : chip(
                  'work-page-stage',
                  null,
                  null,
                  <>
                    <i
                      className="work-pop-dot"
                      style={{ background: column?.color ?? '#64748b' }}
                    />
                    {column?.name ?? 'Inbox'}
                  </>,
                  'Inbox',
                )}
            {chip(
              'work-type',
              'type',
              null,
              type ? (
                <>
                  <i className="work-pop-dot" style={{ background: type.color }} />
                  {type.name}
                </>
              ) : null,
              'Type',
            )}
            {chip(
              'work-priority',
              'priority',
              'flag',
              model.priority !== 'none' ? (
                <span className={`work-page-priority priority-${model.priority}`}>
                  {priority.label}
                </span>
              ) : null,
              'Priority',
            )}
            {chip(
              'work-due-at',
              'date-dueAt',
              'clock',
              model.dueAt ? formatWorkDate(model.dueAt) : null,
              'Deadline',
            )}
            {mode === 'create'
              ? chip(
                  'work-reminder-at',
                  'date-reminderAt',
                  'alert',
                  model.reminderAt ? formatWorkDate(model.reminderAt) : null,
                  'Remind me',
                )
              : null}
            {model.labels.map((label) => (
              <button
                key={label}
                type="button"
                className="work-page-chip label"
                title="Remove label"
                onClick={() => removeLabel(label)}
              >
                <Ic name="pin" size={11} />
                {label} <Ic name="x" size={9} />
              </button>
            ))}
            <span className="work-page-chip input">
              <Ic name="pin" size={11} />
              <input
                ref={labelInputRef}
                data-testid="work-labels"
                placeholder={model.labels.length ? 'Label…' : 'Add label'}
                size={model.labels.length ? 7 : 9}
                onKeyDown={(event) => {
                  const input = event.currentTarget;
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault();
                    addLabel(input.value);
                    input.value = '';
                  } else if (event.key === 'Backspace' && !input.value && model.labels.length) {
                    removeLabel(model.labels[model.labels.length - 1]!);
                  }
                }}
                onBlur={(event) => {
                  addLabel(event.currentTarget.value);
                  event.currentTarget.value = '';
                }}
              />
            </span>
          </div>

          <div className="work-page-props">
            {(
              [
                ['at', 'Source person', 'sourcePerson', 'work-source-person', 'e.g. Maya Chen'],
                [
                  'sessions',
                  'Source channel',
                  'sourceChannel',
                  'work-source-channel',
                  'e.g. Customer call / Slack #launch',
                ],
                ['external', 'Source link', 'sourceUrl', 'work-source-url', 'https://…'],
              ] as const
            ).map(([icon, label, field, testId, placeholder]) =>
              propRow(
                icon,
                label,
                <span className="work-page-value-input">
                  <input
                    data-testid={testId}
                    value={model[field]}
                    placeholder={placeholder}
                    onFocus={() => {
                      activeFieldRef.current = field;
                    }}
                    onChange={(event) =>
                      apply({ [field]: event.target.value } as Partial<PageModel>, false)
                    }
                    onBlur={() => commitText(field)}
                  />
                </span>,
                field,
              ),
            )}
            {rowFields.map((definition) => customFieldRow(definition))}
          </div>

          <hr className="work-page-rule" />

          <section className="work-page-section">
            <h2>Outcome / request</h2>
            <textarea
              className="work-page-text"
              data-testid="work-description"
              rows={2}
              placeholder="What should be true when this is done?"
              value={model.descriptionMd}
              ref={autoGrow}
              onFocus={() => {
                activeFieldRef.current = 'descriptionMd';
              }}
              onChange={(event) => {
                autoGrow(event.currentTarget);
                apply({ descriptionMd: event.target.value }, false);
              }}
              onBlur={() => commitText('descriptionMd')}
            />
          </section>

          <section className="work-page-section">
            <h2>Background and context</h2>
            <textarea
              className="work-page-text"
              data-testid="work-background"
              rows={2}
              placeholder="Why now, relevant history, constraints, links, and decisions already made"
              value={model.backgroundMd}
              ref={autoGrow}
              onFocus={() => {
                activeFieldRef.current = 'backgroundMd';
              }}
              onChange={(event) => {
                autoGrow(event.currentTarget);
                apply({ backgroundMd: event.target.value }, false);
              }}
              onBlur={() => commitText('backgroundMd')}
            />
          </section>

          {longTextFields.map((definition) => (
            <section className="work-page-section" key={definition.key}>
              <h2>
                {definition.label}
                {definition.required ? <em className="work-page-required">required</em> : null}
              </h2>
              <textarea
                className="work-page-text"
                data-testid={`work-custom-${definition.key}`}
                rows={2}
                placeholder={definition.placeholder || 'Empty'}
                value={
                  typeof model.customFields[definition.key] === 'string'
                    ? (model.customFields[definition.key] as string)
                    : ''
                }
                ref={autoGrow}
                onFocus={() => {
                  activeFieldRef.current = 'customFields';
                }}
                onChange={(event) => {
                  autoGrow(event.currentTarget);
                  setCustomField(definition.key, event.target.value, false);
                }}
                onBlur={() => commitText('customFields')}
              />
            </section>
          ))}

          {checklistSection(
            'acceptance',
            'Acceptance criteria',
            'Add criterion',
            'work-acceptance-line',
            'work-acceptance-add',
          )}
          {checklistSection(
            'deliverables',
            'Expected deliverables',
            'Add deliverable',
            'work-deliverable-line',
            'work-deliverables-add',
          )}

          <section className="work-page-section" data-testid="work-attachments">
            <h2>Attachments &amp; links</h2>
            {(mode === 'create'
              ? model.attachments.map((entry, index) => ({
                  key: `draft-${index}`,
                  kind: entry.kind,
                  label: entry.label,
                  value: entry.value,
                  remove: () =>
                    apply(
                      {
                        attachments: model.attachments.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      },
                      false,
                    ),
                }))
              : evidenceAttachments.map((entry) => ({
                  key: entry.id,
                  kind: entry.kind as 'file' | 'link',
                  label: entry.label,
                  value: entry.value,
                  remove: () =>
                    enqueueSave(async () => {
                      await useWorkItemStore.getState().removeEvidence(entry.id);
                    }),
                }))
            ).map((entry) => (
              <div key={entry.key} className="work-page-att">
                <span className="work-page-att-kind">
                  <Ic name={entry.kind === 'link' ? 'external' : 'file'} size={12} />
                </span>
                <button
                  type="button"
                  className="work-page-att-open"
                  title={entry.kind === 'link' ? 'Open link' : 'Reveal in file manager'}
                  onClick={() => openAttachment(entry.kind, entry.value)}
                >
                  <strong>{entry.label}</strong>
                  <small>{entry.value}</small>
                </button>
                <button
                  type="button"
                  className="work-page-att-remove"
                  aria-label="Remove attachment"
                  onClick={entry.remove}
                >
                  <Ic name="x" size={11} />
                </button>
              </div>
            ))}
            <div className="work-page-att-add">
              <input
                data-testid="work-attachment-input"
                value={attachmentText}
                placeholder="Paste a link or a file path"
                onChange={(event) => setAttachmentText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addAttachmentFromInput();
                  }
                }}
              />
              <button
                type="button"
                className="work-page-addline"
                data-testid="work-attachment-add"
                disabled={!attachmentText.trim()}
                onClick={addAttachmentFromInput}
              >
                <Ic name="plus" size={12} /> Add
              </button>
              <button
                type="button"
                className="work-page-addline"
                data-testid="work-attachment-pick"
                onClick={() => void pickAttachmentFiles()}
              >
                <Ic name="folder" size={12} /> Choose files…
              </button>
            </div>
          </section>

          <p className="work-page-hint">
            {mode === 'create'
              ? 'This page is the work item — leave with the Board button (or Esc) and it lands on the board. There is nothing to submit.'
              : 'Every change on this page saves as you make it. Reminders, evidence and executions live in the card panel on the board.'}
          </p>
        </div>
      </div>
      {renderPopover()}
    </section>
  );
}
