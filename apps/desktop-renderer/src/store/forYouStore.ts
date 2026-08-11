import { create } from 'zustand';
import type {
  WorkBoardSnapshotDto,
  WorkExecutionDto,
  WorkItemDetailDto,
  WorkItemDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';

/**
 * For-you inbox (ADR-0056/0057 — external-work-inbox mock). One queue over
 * three buckets: Attention (sessions and reminders needing a decision),
 * Incoming (imported external work ready to start), Review (work sitting in a
 * review-category column, through the approval-gated GitHub update). Buckets
 * are projections over the same Work items the board owns plus the existing
 * task-attention signal — no second data store.
 */

export type ForYouTab = 'attention' | 'incoming' | 'review';
export type ForYouSource = 'all' | 'github' | 'charter';
export type ForYouSelection = { kind: 'item'; id: string } | { kind: 'task'; id: string } | null;

export interface ForYouGithubComment {
  login: string;
  at: string;
  body: string;
}

export function isExternalItem(item: WorkItemDto): boolean {
  return item.sourceChannel === 'GitHub' && item.sourceUrl.length > 0;
}

/** `owner/repo · #N` reference line, mirroring the mock's item rows. */
export function externalRef(item: WorkItemDto): string | null {
  const match = item.sourceUrl.match(
    /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/i,
  );
  return match ? `${match[1]}/${match[2]} · #${match[3]}` : null;
}

function categoryOf(item: WorkItemDto, snapshot: WorkBoardSnapshotDto): string {
  return snapshot.columns.find((column) => column.id === item.columnId)?.category ?? 'inbox';
}

export function incomingItems(snapshot: WorkBoardSnapshotDto): WorkItemDto[] {
  return snapshot.items.filter((item) => {
    if (item.archived || !isExternalItem(item)) return false;
    const category = categoryOf(item, snapshot);
    return category !== 'review' && category !== 'completed' && category !== 'cancelled';
  });
}

export function reviewItems(snapshot: WorkBoardSnapshotDto): WorkItemDto[] {
  return snapshot.items.filter((item) => !item.archived && categoryOf(item, snapshot) === 'review');
}

/** Work items whose reminder fired — they join the Attention queue. */
export function attentionItems(snapshot: WorkBoardSnapshotDto): WorkItemDto[] {
  const fired = new Set(
    snapshot.reminders
      .filter((reminder) => reminder.state === 'fired')
      .map((reminder) => reminder.workItemId),
  );
  return snapshot.items.filter((item) => {
    if (item.archived || !fired.has(item.id)) return false;
    const category = categoryOf(item, snapshot);
    return category !== 'completed' && category !== 'cancelled';
  });
}

export type ForYouStatus =
  'ready' | 'running' | 'review' | 'done' | 'posted' | 'blocked' | 'stopped';

export type ExecutionPhase = 'linked' | 'running' | 'waiting' | 'review' | 'completed' | 'stopped';

const RUNNING_EXECUTION_STATES = new Set([
  'ACTIVE',
  'EXPLORING',
  'IN_PROGRESS',
  'PLANNING',
  'READY',
  'RUNNING',
  'STARTING',
  'VERIFYING',
  'WORKING',
]);
const WAITING_EXECUTION_STATES = new Set([
  'AWAITING_PERMISSION',
  'AWAITING_PLAN_APPROVAL',
  'AWAITING_USER',
  'BLOCKED',
  'PAUSED',
  'WAITING',
]);
const REVIEW_EXECUTION_STATES = new Set(['REVIEW', 'REVIEW_READY']);
const COMPLETED_EXECUTION_STATES = new Set(['ACCEPTED', 'COMPLETED', 'DONE']);
const STOPPED_EXECUTION_STATES = new Set([
  'ARCHIVED',
  'CANCELLED',
  'ENDED',
  'FAILED',
  'IDLE',
  'INTERRUPTED',
  'MISSING',
  'ROLLED_BACK',
  'STOPPED',
  'TRASHED',
]);

function normalizedExecutionStatus(status: string): string {
  return status
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

export function executionPhase(executions: WorkExecutionDto[]): ExecutionPhase {
  if (executions.length === 0) return 'linked';
  const states = executions.map((execution) => normalizedExecutionStatus(execution.status));
  if (states.some((state) => RUNNING_EXECUTION_STATES.has(state))) return 'running';
  if (states.some((state) => WAITING_EXECUTION_STATES.has(state))) return 'waiting';
  if (states.some((state) => REVIEW_EXECUTION_STATES.has(state))) return 'review';
  if (states.every((state) => COMPLETED_EXECUTION_STATES.has(state))) return 'completed';
  if (states.some((state) => STOPPED_EXECUTION_STATES.has(state))) return 'stopped';
  return 'linked';
}

/** Live status projected from linked executions and the posted audit — never
 * self-declared. */
export function itemStatus(
  item: WorkItemDto,
  snapshot: WorkBoardSnapshotDto,
  executions: WorkExecutionDto[],
): ForYouStatus {
  if (typeof item.customFields.githubPostedUrl === 'string' && item.customFields.githubPostedUrl) {
    return 'posted';
  }
  const category = categoryOf(item, snapshot);
  if (category === 'completed') return 'done';
  const linked = executions.filter((execution) => execution.workItemId === item.id);
  const phase = executionPhase(linked);
  switch (phase) {
    case 'running':
      return 'running';
    case 'waiting':
      return 'blocked';
    case 'review':
      return 'review';
    case 'completed':
      return 'done';
    case 'stopped':
      return 'stopped';
    case 'linked':
      break;
  }
  if (category === 'review') return 'review';
  if (category === 'waiting') return 'blocked';
  return 'ready';
}

export function statusLabel(status: ForYouStatus): string {
  switch (status) {
    case 'ready':
      return 'Ready';
    case 'running':
      return 'Running';
    case 'review':
      return 'Review';
    case 'done':
      return 'Done';
    case 'posted':
      return 'Posted';
    case 'blocked':
      return 'Needs input';
    case 'stopped':
      return 'Stopped';
  }
}

export function parseGithubComments(item: WorkItemDto): ForYouGithubComment[] {
  const raw = item.customFields.githubComments;
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is ForYouGithubComment =>
        !!entry &&
        typeof entry === 'object' &&
        typeof (entry as { body?: unknown }).body === 'string',
    );
  } catch {
    return [];
  }
}

interface ForYouStore {
  tab: ForYouTab;
  selection: ForYouSelection;
  detail: WorkItemDetailDto | null;
  query: string;
  source: ForYouSource;
  importOpen: boolean;
  setTab(tab: ForYouTab): void;
  setQuery(query: string): void;
  setSource(source: ForYouSource): void;
  setImportOpen(open: boolean): void;
  selectItem(id: string | null): Promise<void>;
  selectTask(id: string): void;
  /** Re-read the selected item detail after a board change event. */
  refreshDetail(): Promise<void>;
}

let detailSequence = 0;

export const useForYouStore = create<ForYouStore>((set, get) => ({
  tab: 'attention',
  selection: null,
  detail: null,
  query: '',
  source: 'all',
  importOpen: false,

  setTab(tab) {
    set({ tab });
  },
  setQuery(query) {
    set({ query });
  },
  setSource(source) {
    set({ source });
  },
  setImportOpen(importOpen) {
    set({ importOpen });
  },

  async selectItem(id) {
    const sequence = ++detailSequence;
    if (!id) {
      set({ selection: null, detail: null });
      return;
    }
    set({ selection: { kind: 'item', id } });
    const result = await rpcResult('workItem.get', { id });
    const selection = get().selection;
    if (sequence !== detailSequence || selection?.kind !== 'item' || selection.id !== id) return;
    if (!result.ok) {
      set({ selection: null, detail: null });
      return;
    }
    set({ detail: result.data });
  },

  selectTask(id) {
    detailSequence += 1;
    set({ selection: { kind: 'task', id }, detail: null });
  },

  async refreshDetail() {
    const selection = get().selection;
    if (selection?.kind === 'item') await get().selectItem(selection.id);
  },
}));
