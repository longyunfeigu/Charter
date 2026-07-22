import { describe, expect, it } from 'vitest';
import { terminalViewportText } from './terminal-viewport-text.js';

describe('terminalViewportText', () => {
  it('reads the VT model current screen instead of stale repaint fragments in scrollback', () => {
    const lines = [
      'stale partial redraw',
      'another old frame',
      '',
      'Claude Code: finished the review',
      '> waiting for input',
      '',
    ];
    const item = {
      term: {
        rows: 4,
        buffer: {
          active: {
            baseY: 2,
            length: lines.length,
            getLine(index: number) {
              return { translateToString: () => lines[index] ?? '' };
            },
          },
        },
      },
    };

    expect(terminalViewportText(item)).toBe(
      'Claude Code: finished the review\n> waiting for input',
    );
  });
});
