/**
 * Best-effort reconstruction of the line a user types into an external CLI's
 * TUI, from raw PTY input bytes. Powers the reply notification's "what did
 * this answer" copy - never Replay evidence, never persisted as a message.
 * Plain typing, IME-composed text, backspace and bracketed paste read
 * accurately; heavy line editing (arrows, history recall) degrades and the
 * caller falls back to the session title.
 */
const MAX_LINE_CHARS = 2000;

const ESC = '\u001b';
const DEL = '\u007f';
const CTRL_C = '\u0003';
const CTRL_U = '\u0015';
const BEL = '\u0007';

export class TypedLineTracker {
  private line = '';

  /**
   * Feed raw PTY input. Returns the committed line when Enter arrives (the
   * last non-empty commit in the chunk wins), else null.
   */
  feed(data: string): string | null {
    let committed: string | null = null;
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === ESC) {
        i = skipEscape(data, i);
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const line = this.line.trim();
        this.line = '';
        if (line) committed = line;
        i += 1;
        continue;
      }
      if (ch === DEL || ch === '\b') {
        this.line = this.line.slice(0, -1);
        i += 1;
        continue;
      }
      if (ch === '\t') {
        if (this.line.length < MAX_LINE_CHARS) this.line += ' ';
        i += 1;
        continue;
      }
      if (ch >= ' ') {
        if (this.line.length < MAX_LINE_CHARS) this.line += ch;
        i += 1;
        continue;
      }
      // ^C aborts the input, ^U kills the line - the closest safe reading is
      // an empty buffer. Other control bytes are editor chords; ignore them.
      if (ch === CTRL_C || ch === CTRL_U) this.line = '';
      i += 1;
    }
    return committed;
  }

  reset(): void {
    this.line = '';
  }
}

/** Skip one ANSI escape sequence starting at `start` (which is ESC). */
function skipEscape(data: string, start: number): number {
  const next = data[start + 1];
  if (next === '[') {
    // CSI ... final byte in @-~ (covers bracketed-paste markers 200~/201~).
    let i = start + 2;
    while (i < data.length) {
      const code = data.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
      i += 1;
    }
    return data.length;
  }
  if (next === ']') {
    // OSC - terminated by BEL or ST (ESC backslash).
    let i = start + 2;
    while (i < data.length) {
      if (data[i] === BEL) return i + 1;
      if (data[i] === ESC && data[i + 1] === '\\') return i + 2;
      i += 1;
    }
    return data.length;
  }
  return Math.min(start + 2, data.length);
}
