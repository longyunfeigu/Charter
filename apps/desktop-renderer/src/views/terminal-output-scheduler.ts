export interface ScheduledTerminalOutput {
  id: string;
  data: string;
  sequence?: number;
  deliveryId?: number;
}

export interface TerminalOutputSchedulerOptions {
  foregroundDelayMs?: number;
  backgroundDelayMs?: number;
  maxForegroundWrites?: number;
  maxBackgroundWrites?: number;
  timeBudgetMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

type OutputWriter = (output: ScheduledTerminalOutput, done: () => void) => boolean;
type ReplacementWriter = (done: () => void) => void;

const DEFAULT_FOREGROUND_DELAY_MS = 0;
const DEFAULT_BACKGROUND_DELAY_MS = 50;
const DEFAULT_MAX_FOREGROUND_WRITES = 8;
const DEFAULT_MAX_BACKGROUND_WRITES = 2;
const DEFAULT_TIME_BUDGET_MS = 8;

/**
 * Browser-side fairness scheduler. Visible xterm output gets a low-latency
 * lane; background sessions are drained in small round-robin slices.
 */
export class TerminalOutputScheduler {
  private readonly queues = new Map<string, ScheduledTerminalOutput[]>();
  private readonly inFlight = new Map<string, number>();
  private readonly barriers = new Map<string, Array<() => void>>();
  private readonly replacements = new Map<string, ReplacementWriter>();
  private readonly replacing = new Set<string>();
  private foregroundId: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledDelay = Infinity;
  private backgroundCursor = 0;
  private readonly foregroundDelayMs: number;
  private readonly backgroundDelayMs: number;
  private readonly maxForegroundWrites: number;
  private readonly maxBackgroundWrites: number;
  private readonly timeBudgetMs: number;
  private readonly now: () => number;
  private readonly schedule: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly write: OutputWriter,
    private readonly acknowledge: (id: string, deliveryId: number) => void,
    options: TerminalOutputSchedulerOptions = {},
  ) {
    this.foregroundDelayMs = options.foregroundDelayMs ?? DEFAULT_FOREGROUND_DELAY_MS;
    this.backgroundDelayMs = options.backgroundDelayMs ?? DEFAULT_BACKGROUND_DELAY_MS;
    this.maxForegroundWrites = options.maxForegroundWrites ?? DEFAULT_MAX_FOREGROUND_WRITES;
    this.maxBackgroundWrites = options.maxBackgroundWrites ?? DEFAULT_MAX_BACKGROUND_WRITES;
    this.timeBudgetMs = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }

  enqueue(output: ScheduledTerminalOutput): void {
    const queue = this.queues.get(output.id) ?? [];
    queue.push(output);
    this.queues.set(output.id, queue);
    if (this.replacing.has(output.id) || this.replacements.has(output.id)) return;
    this.ensureDrain(
      output.id === this.foregroundId ? this.foregroundDelayMs : this.backgroundDelayMs,
    );
  }

  setForeground(id: string | null): void {
    this.foregroundId = id;
    if (id && this.queues.get(id)?.length) this.ensureDrain(0);
  }

  /** Retry a queue that arrived before its xterm instance was adopted. */
  wake(id: string): void {
    if (this.queues.get(id)?.length) {
      this.ensureDrain(id === this.foregroundId ? 0 : this.backgroundDelayMs);
    }
  }

  /** Run after all output already queued for a terminal has been parsed. */
  after(id: string, callback: () => void): void {
    const barriers = this.barriers.get(id) ?? [];
    barriers.push(callback);
    this.barriers.set(id, barriers);
    this.runBarriers(id);
    if (this.queues.get(id)?.length) this.ensureDrain(0);
  }

  /**
   * A full replay supersedes queued deliveries, but cannot interrupt data
   * already handed to xterm. Acknowledge discarded deliveries and replace
   * after outstanding parser callbacks complete.
   */
  replace(id: string, callback: ReplacementWriter): void {
    this.discardQueued(id);
    this.replacements.set(id, callback);
    this.startReplacementWhenReady(id);
  }

  discard(id: string): void {
    this.discardQueued(id);
    this.barriers.delete(id);
    this.inFlight.delete(id);
    this.replacements.delete(id);
    this.replacing.delete(id);
  }

  dispose(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    for (const id of this.queues.keys()) this.discardQueued(id);
    this.queues.clear();
    this.inFlight.clear();
    this.barriers.clear();
    this.replacements.clear();
    this.replacing.clear();
  }

  private ensureDrain(delay: number): void {
    if (this.timer && delay >= this.scheduledDelay) return;
    if (this.timer) this.cancel(this.timer);
    this.scheduledDelay = delay;
    this.timer = this.schedule(() => {
      this.timer = null;
      this.scheduledDelay = Infinity;
      this.drain();
    }, delay);
  }

  private drain(): void {
    const startedAt = this.now();
    let foregroundWrites = 0;
    if (this.foregroundId) {
      foregroundWrites = this.drainTerminal(this.foregroundId, this.maxForegroundWrites, startedAt);
    }

    const backgroundIds = [...this.queues.keys()].filter(
      (id) => id !== this.foregroundId && (this.queues.get(id)?.length ?? 0) > 0,
    );
    let backgroundWrites = 0;
    if (backgroundIds.length > 0) {
      const start = this.backgroundCursor % backgroundIds.length;
      for (
        let offset = 0;
        offset < backgroundIds.length &&
        backgroundWrites < this.maxBackgroundWrites &&
        this.now() - startedAt < this.timeBudgetMs;
        offset += 1
      ) {
        const id = backgroundIds[(start + offset) % backgroundIds.length]!;
        backgroundWrites += this.drainTerminal(id, 1, startedAt);
      }
      this.backgroundCursor = (start + 1) % backgroundIds.length;
    }

    const hasForeground = Boolean(
      this.foregroundId && (this.queues.get(this.foregroundId)?.length ?? 0) > 0,
    );
    const hasBackground = [...this.queues.entries()].some(
      ([id, queue]) => id !== this.foregroundId && queue.length > 0,
    );
    if (hasForeground && foregroundWrites > 0) this.ensureDrain(this.foregroundDelayMs);
    else if (hasBackground && backgroundWrites > 0) this.ensureDrain(this.backgroundDelayMs);
    // If no writer accepted a queued item, wake() retries once its xterm exists.
  }

  private drainTerminal(id: string, limit: number, startedAt: number): number {
    if (this.replacing.has(id) || this.replacements.has(id) || (this.inFlight.get(id) ?? 0) > 0) {
      return 0;
    }
    const queue = this.queues.get(id);
    if (!queue) return 0;
    let writes = 0;
    while (queue[0] && writes < limit && this.now() - startedAt < this.timeBudgetMs) {
      const output = queue[0]!;
      this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
      const accepted = this.write(output, () => {
        const remaining = Math.max(0, (this.inFlight.get(id) ?? 1) - 1);
        if (remaining === 0) this.inFlight.delete(id);
        else this.inFlight.set(id, remaining);
        if (output.deliveryId !== undefined) this.acknowledge(id, output.deliveryId);
        this.runBarriers(id);
        this.startReplacementWhenReady(id);
        this.wake(id);
      });
      if (!accepted) {
        const remaining = Math.max(0, (this.inFlight.get(id) ?? 1) - 1);
        if (remaining === 0) this.inFlight.delete(id);
        else this.inFlight.set(id, remaining);
        break;
      }
      queue.shift();
      writes += 1;
      // xterm's parser is asynchronous. Keep one write in flight per terminal
      // so stateful VT sequences, full-screen redraws and acknowledgements stay
      // strictly ordered instead of building a second queue inside xterm.
      break;
    }
    if (queue.length === 0) {
      this.queues.delete(id);
      this.runBarriers(id);
    }
    return writes;
  }

  private discardQueued(id: string): void {
    const queue = this.queues.get(id);
    this.queues.delete(id);
    const lastDeliveryId = queue
      ?.flatMap((output) => (output.deliveryId === undefined ? [] : [output.deliveryId]))
      .at(-1);
    if (lastDeliveryId !== undefined) this.acknowledge(id, lastDeliveryId);
  }

  private runBarriers(id: string): void {
    if ((this.queues.get(id)?.length ?? 0) > 0 || (this.inFlight.get(id) ?? 0) > 0) return;
    const barriers = this.barriers.get(id);
    if (!barriers) return;
    this.barriers.delete(id);
    for (const callback of barriers) callback();
  }

  private startReplacementWhenReady(id: string): void {
    const replacement = this.replacements.get(id);
    if (!replacement || this.replacing.has(id) || (this.inFlight.get(id) ?? 0) > 0) return;
    this.replacements.delete(id);
    this.replacing.add(id);
    let completed = false;
    const done = (): void => {
      if (completed) return;
      completed = true;
      this.replacing.delete(id);
      this.runBarriers(id);
      this.wake(id);
    };
    try {
      replacement(done);
    } catch {
      done();
    }
  }
}
