/**
 * ADR-0017 amendment — product-launched CLI sessions carry a launch intent:
 * the pre-assigned claude conversation id (`claude --session-id <uuid>`) and
 * the composer's first prompt. `terminal.create` registers it, and
 * ExternalSessionService consumes it when agent detection confirms the CLI
 * actually started in that terminal. Entries are one-shot and expire, so an
 * aborted launch (command not found, instant Ctrl-C) can never leak a prompt
 * or id into a later, unrelated session on the same terminal.
 */
export interface ExternalLaunchIntent {
  cli: string;
  /** Pre-assigned conversation id; null when the CLI picks its own (codex). */
  sessionId: string | null;
  /** Composer text to deliver once the TUI is ready; null for bare launches. */
  prompt: string | null;
}

const INTENT_TTL_MS = 120_000;

export class ExternalLaunchIntents {
  private readonly byTerminal = new Map<
    string,
    ExternalLaunchIntent & { registeredAtMs: number }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  register(terminalId: string, intent: ExternalLaunchIntent): void {
    this.sweep();
    this.byTerminal.set(terminalId, { ...intent, registeredAtMs: this.now() });
  }

  /** One-shot: the first agent-enter on the terminal owns (or voids) the intent. */
  consume(terminalId: string, cli: string): ExternalLaunchIntent | null {
    const entry = this.byTerminal.get(terminalId);
    if (!entry) return null;
    this.byTerminal.delete(terminalId);
    if (entry.cli !== cli) return null;
    if (this.now() - entry.registeredAtMs > INTENT_TTL_MS) return null;
    return { cli: entry.cli, sessionId: entry.sessionId, prompt: entry.prompt };
  }

  private sweep(): void {
    const cutoff = this.now() - INTENT_TTL_MS;
    for (const [key, entry] of this.byTerminal) {
      if (entry.registeredAtMs < cutoff) this.byTerminal.delete(key);
    }
  }
}
