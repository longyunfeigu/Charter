export interface SequenceAllocator {
  next(key: string): number;
  seed(key: string, lastUsed: number): void;
  current(key: string): number;
}

/** Strictly monotonic per-key sequence numbers (used for task event ordering). */
export function createSequenceAllocator(): SequenceAllocator {
  const state = new Map<string, number>();
  return {
    next(key) {
      const value = (state.get(key) ?? 0) + 1;
      state.set(key, value);
      return value;
    },
    seed(key, lastUsed) {
      const current = state.get(key) ?? 0;
      if (lastUsed > current) state.set(key, lastUsed);
    },
    current(key) {
      return state.get(key) ?? 0;
    },
  };
}
