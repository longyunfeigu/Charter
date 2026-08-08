import { create } from 'zustand';
import type {
  ChannelRequest,
  WorkBoardColumnDto,
  WorkBoardSnapshotDto,
  WorkEvidenceDto,
  WorkExecutionDto,
  WorkItemDetailDto,
  WorkItemDto,
  WorkItemTypeDto,
  WorkReminderDto,
} from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from './appStore.js';

export interface WorkReminderAlert {
  item: WorkItemDto;
  reminder: WorkReminderDto;
}

interface WorkItemStore {
  initialized: boolean;
  loading: boolean;
  snapshot: WorkBoardSnapshotDto;
  selectedId: string | null;
  detail: WorkItemDetailDto | null;
  reminderAlerts: WorkReminderAlert[];
  init(): void;
  refresh(): Promise<void>;
  select(id: string | null): Promise<void>;
  create(input: ChannelRequest<'workItem.create'>): Promise<WorkItemDto | null>;
  update(input: ChannelRequest<'workItem.update'>): Promise<WorkItemDto | null>;
  move(input: ChannelRequest<'workItem.move'>): Promise<boolean>;
  archive(id: string, archived: boolean, expectedVersion: number): Promise<boolean>;
  createReminder(workItemId: string, remindAt: string, message?: string): Promise<boolean>;
  snoozeReminder(id: string, remindAt: string): Promise<boolean>;
  cancelReminder(id: string): Promise<boolean>;
  dismissReminderAlert(id: string): void;
  linkExecution(input: ChannelRequest<'workItem.execution.link'>): Promise<WorkExecutionDto | null>;
  unlinkExecution(id: string): Promise<boolean>;
  addEvidence(input: ChannelRequest<'workItem.evidence.add'>): Promise<WorkEvidenceDto | null>;
  removeEvidence(id: string): Promise<boolean>;
  createType(input: ChannelRequest<'workItem.type.create'>): Promise<WorkItemTypeDto | null>;
  createColumn(input: ChannelRequest<'workItem.column.create'>): Promise<WorkBoardColumnDto | null>;
}

const EMPTY_SNAPSHOT: WorkBoardSnapshotDto = {
  columns: [],
  types: [],
  items: [],
  executions: [],
  reminders: [],
};

// Main broadcasts changes before the mutation RPC resolves. Those broadcasts
// deliberately trigger background reads, but an older read must never land on
// top of a newer optimistic mutation. Sequence guards make the last requested
// board/detail state authoritative without hiding real version conflicts.
let snapshotRequestSequence = 0;
let detailRequestSequence = 0;

function toastError(message: string): void {
  useAppStore.getState().pushToast('error', message);
}

function replaceItem(snapshot: WorkBoardSnapshotDto, item: WorkItemDto): WorkBoardSnapshotDto {
  const found = snapshot.items.some((candidate) => candidate.id === item.id);
  return {
    ...snapshot,
    items: found
      ? snapshot.items.map((candidate) => (candidate.id === item.id ? item : candidate))
      : [...snapshot.items, item],
  };
}

export function workAttentionCount(snapshot: WorkBoardSnapshotDto, now = Date.now()): number {
  const category = new Map(snapshot.columns.map((column) => [column.id, column.category]));
  const fired = new Set(
    snapshot.reminders
      .filter((reminder) => reminder.state === 'fired')
      .map((reminder) => reminder.workItemId),
  );
  return snapshot.items.filter((item) => {
    const state = category.get(item.columnId);
    if (state === 'completed' || state === 'cancelled') return false;
    return (
      fired.has(item.id) ||
      state === 'waiting' ||
      state === 'review' ||
      (item.dueAt !== null && Date.parse(item.dueAt) < now)
    );
  }).length;
}

export const useWorkItemStore = create<WorkItemStore>((set, get) => ({
  initialized: false,
  loading: false,
  snapshot: EMPTY_SNAPSHOT,
  selectedId: null,
  detail: null,
  reminderAlerts: [],

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('workItem.changed', ({ itemId }) => {
      void get().refresh();
      if (itemId && itemId === get().selectedId) void get().select(itemId);
    });
    onEvent('workItem.reminderDue', (alert) => {
      const alerts = [
        alert,
        ...get().reminderAlerts.filter((item) => item.reminder.id !== alert.reminder.id),
      ];
      set({ reminderAlerts: alerts.slice(0, 5) });
      useAppStore.getState().pushToast('warning', `Reminder: ${alert.item.title}`);
      void get().refresh();
    });
    onEvent('app.focusWorkItem', ({ itemId }) => {
      useAppStore.getState().setRailView('work');
      void get().select(itemId);
    });
    // Execution status is projected from the linked Session/Mission. Refetch
    // whenever one of those durable aggregates changes.
    onEvent('task.stateChanged', () => void get().refresh());
    onEvent('task.deleted', () => void get().refresh());
    onEvent('mission.changed', () => void get().refresh());
    void get().refresh();
  },

  async refresh() {
    const requestSequence = ++snapshotRequestSequence;
    set({ loading: true });
    const result = await rpcResult('workItem.snapshot', { includeArchived: false });
    if (requestSequence !== snapshotRequestSequence) return;
    if (!result.ok) {
      toastError(result.error.userMessage);
      set({ loading: false });
      return;
    }
    set({ snapshot: result.data, loading: false });
  },

  async select(id) {
    const requestSequence = ++detailRequestSequence;
    if (!id) {
      set({ selectedId: null, detail: null });
      return;
    }
    set({ selectedId: id });
    const result = await rpcResult('workItem.get', { id });
    if (requestSequence !== detailRequestSequence || get().selectedId !== id) return;
    if (!result.ok) {
      toastError(result.error.userMessage);
      if (get().selectedId === id) set({ selectedId: null, detail: null });
      return;
    }
    if (get().selectedId === id) set({ detail: result.data });
  },

  async create(input) {
    const result = await rpcResult('workItem.create', input);
    if (!result.ok) {
      toastError(result.error.userMessage);
      return null;
    }
    set({ snapshot: replaceItem(get().snapshot, result.data.item) });
    await get().refresh();
    await get().select(result.data.item.id);
    return result.data.item;
  },

  async update(input) {
    // Invalidate reads started before this mutation. The change event and the
    // successful response below will request fresh authoritative state.
    snapshotRequestSequence += 1;
    detailRequestSequence += 1;
    const beforeSnapshot = get().snapshot;
    const beforeDetail = get().detail;
    const snapshotItem = beforeSnapshot.items.find((item) => item.id === input.id) ?? null;
    const detailItem = beforeDetail?.item.id === input.id ? beforeDetail.item : null;
    const current =
      detailItem && (!snapshotItem || detailItem.version >= snapshotItem.version)
        ? detailItem
        : snapshotItem;
    if (current) {
      const patch = Object.fromEntries(
        Object.entries(input).filter(
          ([key, value]) => key !== 'id' && key !== 'expectedVersion' && value !== undefined,
        ),
      ) as Partial<WorkItemDto>;
      const optimistic = { ...current, ...patch, version: current.version + 1 };
      set({
        snapshot: replaceItem(beforeSnapshot, optimistic),
        ...(beforeDetail?.item.id === input.id
          ? { detail: { ...beforeDetail, item: optimistic } }
          : {}),
      });
    }
    const result = await rpcResult('workItem.update', input);
    if (!result.ok) {
      set({ snapshot: beforeSnapshot, detail: beforeDetail });
      toastError(result.error.userMessage);
      await get().refresh();
      if (get().selectedId === input.id) await get().select(input.id);
      return null;
    }
    set({ snapshot: replaceItem(get().snapshot, result.data.item) });
    await get().select(result.data.item.id);
    return result.data.item;
  },

  async move(input) {
    // Optimistic movement makes drag-and-drop feel direct; versioned Main-side
    // mutation remains the authority and rolls this back on a conflict/WIP gate.
    const before = get().snapshot;
    const item = before.items.find((candidate) => candidate.id === input.id);
    if (item) set({ snapshot: replaceItem(before, { ...item, columnId: input.columnId }) });
    const result = await rpcResult('workItem.move', input);
    if (!result.ok) {
      set({ snapshot: before });
      toastError(result.error.userMessage);
      await get().refresh();
      return false;
    }
    set({ snapshot: replaceItem(get().snapshot, result.data.item) });
    if (get().selectedId === input.id) void get().select(input.id);
    return true;
  },

  async archive(id, archived, expectedVersion) {
    const result = await rpcResult('workItem.archive', { id, archived, expectedVersion });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    await get().refresh();
    if (archived && get().selectedId === id) set({ selectedId: null, detail: null });
    return true;
  },

  async createReminder(workItemId, remindAt, message = '') {
    const result = await rpcResult('workItem.reminder.create', { workItemId, remindAt, message });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    await Promise.all([get().refresh(), get().select(workItemId)]);
    return true;
  },

  async snoozeReminder(id, remindAt) {
    const result = await rpcResult('workItem.reminder.snooze', { id, remindAt });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    get().dismissReminderAlert(id);
    await get().refresh();
    if (get().selectedId) await get().select(get().selectedId);
    return true;
  },

  async cancelReminder(id) {
    const result = await rpcResult('workItem.reminder.cancel', { id });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    get().dismissReminderAlert(id);
    await get().refresh();
    if (get().selectedId) await get().select(get().selectedId);
    return true;
  },

  dismissReminderAlert(id) {
    set({ reminderAlerts: get().reminderAlerts.filter((alert) => alert.reminder.id !== id) });
  },

  async linkExecution(input) {
    const result = await rpcResult('workItem.execution.link', input);
    if (!result.ok) {
      toastError(result.error.userMessage);
      return null;
    }
    await Promise.all([get().refresh(), get().select(input.workItemId)]);
    return result.data.execution;
  },

  async unlinkExecution(id) {
    const result = await rpcResult('workItem.execution.unlink', { id });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    await get().refresh();
    if (get().selectedId) await get().select(get().selectedId);
    return true;
  },

  async addEvidence(input) {
    const result = await rpcResult('workItem.evidence.add', input);
    if (!result.ok) {
      toastError(result.error.userMessage);
      return null;
    }
    await get().select(input.workItemId);
    return result.data.evidence;
  },

  async removeEvidence(id) {
    const result = await rpcResult('workItem.evidence.remove', { id });
    if (!result.ok) {
      toastError(result.error.userMessage);
      return false;
    }
    if (get().selectedId) await get().select(get().selectedId);
    return true;
  },

  async createType(input) {
    const result = await rpcResult('workItem.type.create', input);
    if (!result.ok) {
      toastError(result.error.userMessage);
      return null;
    }
    await get().refresh();
    return result.data.type;
  },

  async createColumn(input) {
    const result = await rpcResult('workItem.column.create', input);
    if (!result.ok) {
      toastError(result.error.userMessage);
      return null;
    }
    await get().refresh();
    return result.data.column;
  },
}));
