import { create } from 'zustand';

interface QuickConsoleStore {
  open: boolean;
  terminalId: string | null;
  setOpen(open: boolean): void;
  toggle(): void;
  setTerminalId(id: string | null): void;
}

export const useQuickConsoleStore = create<QuickConsoleStore>((set, get) => ({
  open: false,
  terminalId: null,
  setOpen(open) {
    set({ open });
  },
  toggle() {
    set({ open: !get().open });
  },
  setTerminalId(terminalId) {
    set({ terminalId });
  },
}));
