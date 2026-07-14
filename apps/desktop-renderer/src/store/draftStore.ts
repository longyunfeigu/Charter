import { create } from 'zustand';

/**
 * Per-task reply drafts (ADR-0014, PIVOT-036): session-scoped, shared by the
 * Task Room composer and the Editor agent panel so a half-typed reply survives
 * room → Editor → room round-trips. Never persisted to disk.
 */
interface DraftStore {
  drafts: Record<string, string>;
  setDraft(taskId: string, text: string): void;
  clearDraft(taskId: string): void;
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  drafts: {},
  setDraft(taskId, text) {
    set({ drafts: { ...get().drafts, [taskId]: text } });
  },
  clearDraft(taskId) {
    const drafts = { ...get().drafts };
    delete drafts[taskId];
    set({ drafts });
  },
}));
