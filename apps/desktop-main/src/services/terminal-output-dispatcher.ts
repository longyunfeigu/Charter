export interface TerminalOutputDelivery {
  id: string;
  data: string;
  sequence?: number;
  deliveryId: number;
}

interface PendingPart {
  data: string;
  sequence?: number;
}

interface InFlightDelivery {
  deliveryId: number;
  size: number;
  sentAt: number;
}

interface TerminalOutputState {
  pending: PendingPart[];
  pendingIndex: number;
  pendingSize: number;
  inFlight: InFlightDelivery[];
  inFlightSize: number;
  interactiveBudget: number;
  interactiveWindowStartedAt: number;
}

export interface TerminalOutputDispatcherOptions {
  batchDelayMs?: number;
  maxChunkSize?: number;
  maxWritesPerDrain?: number;
  terminalHighWaterMark?: number;
  globalHighWaterMark?: number;
  activeReserveBytes?: number;
  interactiveWindowMs?: number;
  interactiveBudget?: number;
  staleAckMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_BATCH_DELAY_MS = 2;
const DEFAULT_MAX_CHUNK_SIZE = 16 * 1024;
const DEFAULT_MAX_WRITES_PER_DRAIN = 2;
const DEFAULT_TERMINAL_HIGH_WATER_MARK = 512 * 1024;
const DEFAULT_GLOBAL_HIGH_WATER_MARK = 8 * 1024 * 1024;
const DEFAULT_ACTIVE_RESERVE_BYTES = 512 * 1024;
const DEFAULT_INTERACTIVE_WINDOW_MS = 100;
const DEFAULT_INTERACTIVE_BUDGET = 32 * 1024;
const DEFAULT_STALE_ACK_MS = 5000;

function likelyInteractiveRedraw(data: string): boolean {
  return data.length <= 1024 || (data.length <= 16 * 1024 && /(?:\u001b\[|\u001b\]|\r)/.test(data));
}

/**
 * Main→renderer terminal transport. It coalesces small PTY emissions, gives
 * input-adjacent foreground redraws a direct lane and bounds data already
 * handed to Chromium until xterm acknowledges parsing it.
 */
export class TerminalOutputDispatcher {
  private readonly states = new Map<string, TerminalOutputState>();
  private activeId: string | null = null;
  private lastInputAt = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private deliveryId = 0;
  private globalInFlightSize = 0;
  private roundRobinCursor = 0;
  private readonly batchDelayMs: number;
  private readonly maxChunkSize: number;
  private readonly maxWritesPerDrain: number;
  private readonly terminalHighWaterMark: number;
  private readonly globalHighWaterMark: number;
  private readonly activeReserveBytes: number;
  private readonly interactiveWindowMs: number;
  private readonly interactiveBudget: number;
  private readonly staleAckMs: number;
  private readonly now: () => number;
  private readonly schedule: (
    callback: () => void,
    milliseconds: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly cancel: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(
    private readonly deliver: (delivery: TerminalOutputDelivery) => void,
    options: TerminalOutputDispatcherOptions = {},
  ) {
    this.batchDelayMs = options.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS;
    this.maxChunkSize = options.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    this.maxWritesPerDrain = options.maxWritesPerDrain ?? DEFAULT_MAX_WRITES_PER_DRAIN;
    this.terminalHighWaterMark = options.terminalHighWaterMark ?? DEFAULT_TERMINAL_HIGH_WATER_MARK;
    this.globalHighWaterMark = options.globalHighWaterMark ?? DEFAULT_GLOBAL_HIGH_WATER_MARK;
    this.activeReserveBytes = Math.min(
      this.globalHighWaterMark,
      options.activeReserveBytes ?? DEFAULT_ACTIVE_RESERVE_BYTES,
    );
    this.interactiveWindowMs = options.interactiveWindowMs ?? DEFAULT_INTERACTIVE_WINDOW_MS;
    this.interactiveBudget = options.interactiveBudget ?? DEFAULT_INTERACTIVE_BUDGET;
    this.staleAckMs = options.staleAckMs ?? DEFAULT_STALE_ACK_MS;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.cancel = options.cancel ?? clearTimeout;
  }

  push(id: string, data: string, sequence?: number): void {
    if (!data) return;
    const state = this.state(id);
    state.pending.push({ data, sequence });
    state.pendingSize += data.length;
    const now = this.now();
    if (this.isInteractive(id, data, state, now)) {
      this.drainTerminal(id, state, 1, now);
      if (this.hasPending(state)) this.ensureDrain(0);
      return;
    }
    this.ensureDrain(this.batchDelayMs);
  }

  noteInput(id: string): void {
    this.lastInputAt.set(id, this.now());
  }

  setActive(id: string | null): void {
    this.activeId = id;
    const state = id ? this.states.get(id) : undefined;
    if (state && this.hasPending(state)) this.ensureDrain(0);
  }

  acknowledge(id: string, deliveryId: number): void {
    const state = this.states.get(id);
    if (!state) return;
    let released = 0;
    while (state.inFlight[0] && state.inFlight[0].deliveryId <= deliveryId) {
      released += state.inFlight.shift()!.size;
    }
    if (released === 0) return;
    state.inFlightSize -= released;
    this.globalInFlightSize -= released;
    if (this.hasPending(state)) this.ensureDrain(0);
    this.deleteIfEmpty(id, state);
  }

  /** Drop transport bookkeeping before a full VT snapshot replaces the stream. */
  reset(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.globalInFlightSize -= state.inFlightSize;
    this.states.delete(id);
    this.lastInputAt.delete(id);
  }

  /** Publish pending bytes before an ordered lifecycle event such as exit. */
  flush(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    this.expireStaleAcks(state, this.now());
    while (this.hasPending(state)) {
      const delivery = this.takeDelivery(id, state);
      if (!delivery) break;
      this.publish(state, delivery);
    }
  }

  dispose(): void {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.states.clear();
    this.lastInputAt.clear();
    this.globalInFlightSize = 0;
  }

  private state(id: string): TerminalOutputState {
    let state = this.states.get(id);
    if (!state) {
      state = {
        pending: [],
        pendingIndex: 0,
        pendingSize: 0,
        inFlight: [],
        inFlightSize: 0,
        interactiveBudget: 0,
        interactiveWindowStartedAt: 0,
      };
      this.states.set(id, state);
    }
    return state;
  }

  private isInteractive(
    id: string,
    data: string,
    state: TerminalOutputState,
    now: number,
  ): boolean {
    if (
      id !== this.activeId ||
      now - (this.lastInputAt.get(id) ?? -Infinity) > this.interactiveWindowMs
    ) {
      return false;
    }
    if (!likelyInteractiveRedraw(data)) return false;
    if (now - state.interactiveWindowStartedAt > this.interactiveWindowMs) {
      state.interactiveWindowStartedAt = now;
      state.interactiveBudget = 0;
    }
    if (state.interactiveBudget + data.length > this.interactiveBudget) return false;
    state.interactiveBudget += data.length;
    return true;
  }

  private ensureDrain(delay: number): void {
    if (this.timer) {
      if (delay > 0) return;
      this.cancel(this.timer);
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      this.drain();
    }, delay);
    this.timer.unref?.();
  }

  private drain(): void {
    const now = this.now();
    let remaining = this.maxWritesPerDrain;
    const active = this.activeId ? this.states.get(this.activeId) : undefined;
    if (active && remaining > 0) {
      remaining -= this.drainTerminal(this.activeId!, active, remaining, now);
    }

    const background = [...this.states.entries()].filter(
      ([id, state]) => id !== this.activeId && this.hasPending(state),
    );
    if (background.length > 0 && remaining > 0) {
      const start = this.roundRobinCursor % background.length;
      for (let offset = 0; offset < background.length && remaining > 0; offset += 1) {
        const [id, state] = background[(start + offset) % background.length]!;
        remaining -= this.drainTerminal(id, state, 1, now);
      }
      this.roundRobinCursor = (start + 1) % background.length;
    }

    if ([...this.states.values()].some((state) => this.hasPending(state))) {
      this.ensureDrain(Math.min(50, this.staleAckMs));
    }
  }

  private drainTerminal(
    id: string,
    state: TerminalOutputState,
    limit: number,
    now: number,
  ): number {
    this.expireStaleAcks(state, now);
    let sent = 0;
    while (sent < limit && this.hasPending(state) && this.canPublish(id, state)) {
      const delivery = this.takeDelivery(id, state);
      if (!delivery) break;
      this.publish(state, delivery);
      sent += 1;
    }
    this.deleteIfEmpty(id, state);
    return sent;
  }

  private canPublish(id: string, state: TerminalOutputState): boolean {
    // Background chatter cannot consume the final slice of renderer credit.
    // The active terminal keeps that reserve for keystroke-adjacent redraws.
    const globalLimit =
      id === this.activeId
        ? this.globalHighWaterMark
        : this.globalHighWaterMark - this.activeReserveBytes;
    return state.inFlightSize < this.terminalHighWaterMark && this.globalInFlightSize < globalLimit;
  }

  private takeDelivery(id: string, state: TerminalOutputState): TerminalOutputDelivery | null {
    const first = state.pending[state.pendingIndex];
    if (!first) return null;
    let data = '';
    let sequence: number | undefined;
    // Preserve each backend emission whole. This keeps daemon sequence
    // deduplication correct even when a rare single emission exceeds 16 KiB.
    while (state.pending[state.pendingIndex]) {
      const next = state.pending[state.pendingIndex]!;
      if (data && data.length + next.data.length > this.maxChunkSize) break;
      state.pendingIndex += 1;
      state.pendingSize -= next.data.length;
      data += next.data;
      if (next.sequence !== undefined) sequence = next.sequence;
      if (data.length >= this.maxChunkSize) break;
    }
    if (state.pendingIndex > 1024 && state.pendingIndex * 2 >= state.pending.length) {
      state.pending = state.pending.slice(state.pendingIndex);
      state.pendingIndex = 0;
    }
    this.deliveryId += 1;
    return {
      id,
      data,
      ...(sequence === undefined ? {} : { sequence }),
      deliveryId: this.deliveryId,
    };
  }

  private publish(state: TerminalOutputState, delivery: TerminalOutputDelivery): void {
    const size = delivery.data.length;
    state.inFlight.push({ deliveryId: delivery.deliveryId, size, sentAt: this.now() });
    state.inFlightSize += size;
    this.globalInFlightSize += size;
    this.deliver(delivery);
  }

  private expireStaleAcks(state: TerminalOutputState, now: number): void {
    let released = 0;
    while (state.inFlight[0] && now - state.inFlight[0].sentAt >= this.staleAckMs) {
      released += state.inFlight.shift()!.size;
    }
    state.inFlightSize -= released;
    this.globalInFlightSize -= released;
  }

  private deleteIfEmpty(id: string, state: TerminalOutputState): void {
    if (!this.hasPending(state) && state.inFlight.length === 0) this.states.delete(id);
  }

  private hasPending(state: TerminalOutputState): boolean {
    return state.pendingIndex < state.pending.length;
  }
}
