export interface TerminalInputWrite {
  id: string;
  data: string;
  userInitiated: boolean;
}

interface TerminalInputEnqueue extends TerminalInputWrite {
  paste?: boolean;
}

export type SendTerminalInput = (input: TerminalInputWrite) => void | Promise<unknown>;

interface TerminalInputWriterOptions {
  /** Confirmed transport path used only for large/pasted input. */
  sendAccepted?: SendTerminalInput;
  wait?: (milliseconds: number) => Promise<void>;
  startupDelayMs?: number;
}

const MAX_CHUNK_BYTES = 16 * 1024;
// Interactive TTY line disciplines can have input queues far smaller than an
// IPC payload (macOS's default shell is a common example). Native paste must
// therefore be paced independently from ordinary large transport writes.
const MAX_PASTE_CHUNK_BYTES = 512;
const MAX_COALESCED_CODE_UNITS = 4096;
const TERMINAL_SETTLE_MS = 50;
const COMMAND_START_TIMEOUT_MS = 500;

/** Split UTF-8 input without cutting a surrogate pair. */
export function splitTerminalInput(data: string, maxChunkBytes = MAX_CHUNK_BYTES): string[] {
  if (data.length === 0) return [];
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1) {
    throw new RangeError('maxChunkBytes must be a positive integer');
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = start;
    let bytes = 0;
    while (end < data.length) {
      const codePoint = data.codePointAt(end)!;
      const units = codePoint > 0xffff ? 2 : 1;
      const nextBytes =
        codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
      if (bytes + nextBytes > maxChunkBytes && end > start) break;
      bytes += nextBytes;
      end += units;
      // A byte limit smaller than one code point still emits that point whole.
      if (bytes > maxChunkBytes) break;
    }
    chunks.push(data.slice(start, end));
    start = end;
  }
  return chunks;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Ordered terminal input queue with two transport lanes:
 * - ordinary xterm input is coalesced and dispatched without an RPC round trip;
 * - paste/large input is chunked and waits for host acceptance between chunks.
 */
export class TerminalInputWriter {
  private readonly pending: TerminalInputEnqueue[] = [];
  private drainPromise: Promise<void> | null = null;
  private readonly ready: Promise<void>;
  private resolveReady: (() => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly sendAccepted: SendTerminalInput;
  private submittedLineVersion = 0;
  private commandStartVersion = 0;
  private commandStartSignal: Promise<void>;
  private resolveCommandStart: () => void = () => undefined;

  constructor(
    private readonly sendFast: SendTerminalInput,
    options: TerminalInputWriterOptions = {},
  ) {
    this.sendAccepted = options.sendAccepted ?? sendFast;
    this.wait = options.wait ?? pause;
    this.commandStartSignal = this.newCommandStartSignal();
    const startupDelayMs = options.startupDelayMs ?? 0;
    if (startupDelayMs <= 0) {
      this.ready = Promise.resolve();
      return;
    }
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
      this.startupTimer = setTimeout(() => this.markReady(), startupDelayMs);
    });
  }

  private newCommandStartSignal(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveCommandStart = resolve;
    });
  }

  markReady(): void {
    if (!this.resolveReady) return;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    const resolve = this.resolveReady;
    this.resolveReady = null;
    resolve();
  }

  markPrompt(): void {
    this.markReady();
  }

  markCommandStart(): void {
    this.commandStartVersion = this.submittedLineVersion;
    this.resolveCommandStart();
    this.commandStartSignal = this.newCommandStartSignal();
  }

  enqueue(input: TerminalInputEnqueue): void {
    const previous = this.pending.at(-1);
    if (
      input.paste !== true &&
      previous?.paste !== true &&
      previous?.id === input.id &&
      previous.userInitiated === input.userInitiated &&
      previous.data.length + input.data.length <= MAX_COALESCED_CODE_UNITS
    ) {
      previous.data += input.data;
    } else {
      this.pending.push({ ...input });
    }
    this.startDrain();
  }

  async settle(): Promise<void> {
    await this.drainPromise?.catch(() => undefined);
    if (this.commandStartVersion < this.submittedLineVersion) {
      // Shell integration reports command start just before the shell spawns
      // an external child. Unknown shells retain a bounded fallback.
      await Promise.race([this.commandStartSignal, this.wait(COMMAND_START_TIMEOUT_MS)]);
    }
    // Give the shell a turn to spawn a just-submitted child before close asks
    // the host whether confirmation is required.
    await this.wait(TERMINAL_SETTLE_MS);
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    const work = this.drain();
    this.drainPromise = work;
    void work.finally(() => {
      if (this.drainPromise === work) this.drainPromise = null;
      if (this.pending.length > 0) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    await this.ready;
    while (this.pending.length > 0) {
      const input = this.pending.shift()!;
      const chunks = splitTerminalInput(
        input.data,
        input.paste === true ? MAX_PASTE_CHUNK_BYTES : MAX_CHUNK_BYTES,
      );
      const accepted = input.paste === true || chunks.length > 1;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        if (input.userInitiated && /[\r\n]/.test(chunk)) this.submittedLineVersion += 1;
        const write = {
          id: input.id,
          data: chunk,
          userInitiated: input.userInitiated,
        };
        try {
          if (accepted) {
            await this.sendAccepted(write);
            if (index + 1 < chunks.length) await this.wait(0);
          } else {
            const result = this.sendFast(write);
            if (result instanceof Promise) void result.catch(() => undefined);
          }
        } catch {
          // A failed bridge call must not strand later keystrokes.
        }
      }
    }
  }
}
