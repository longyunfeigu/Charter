import { create } from 'zustand';

export type MemoryAgent = 'claude' | 'codex' | 'charter';

interface MemoryViewStore {
  agent: MemoryAgent;
  setAgent(agent: MemoryAgent): void;
}

/** UI-only selection shared by Memory's contextual rail and main page. */
export const useMemoryViewStore = create<MemoryViewStore>((set) => ({
  agent: 'claude',
  setAgent: (agent) => set({ agent }),
}));
