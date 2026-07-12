export interface Clock {
  nowMs(): number;
  isoNow(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

export function fixedClock(atMs: number): Clock {
  return {
    nowMs: () => atMs,
    isoNow: () => new Date(atMs).toISOString(),
  };
}
