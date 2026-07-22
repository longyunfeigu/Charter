interface TerminalViewportSource {
  term: {
    rows: number;
    buffer: {
      active: {
        baseY: number;
        length: number;
        getLine(index: number): { translateToString(trimRight: boolean): string } | undefined;
      };
    };
  };
}

/** Read the terminal emulator's current screen, not its raw repaint stream.
 * Full-screen TUIs rewrite cells with cursor controls, so only xterm's VT
 * model can produce a faithful plain-text fleet preview. */
export function terminalViewportText(item: TerminalViewportSource): string {
  const buffer = item.term.buffer.active;
  const start = buffer.baseY;
  const end = Math.min(buffer.length, start + item.term.rows);
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n').slice(-16_000);
}
