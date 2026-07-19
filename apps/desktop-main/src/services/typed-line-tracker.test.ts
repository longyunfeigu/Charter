import { describe, expect, it } from 'vitest';
import { TypedLineTracker } from './typed-line-tracker.js';

const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const CTRL_U = String.fromCharCode(0x15);
const CR = '\r';

describe('TypedLineTracker (notification copy from raw PTY input)', () => {
  it('captures plain typing committed by Enter', () => {
    const tracker = new TypedLineTracker();
    expect(tracker.feed('who are yo')).toBeNull();
    expect(tracker.feed('u')).toBeNull();
    expect(tracker.feed(CR)).toBe('who are you');
  });

  it('applies backspace edits', () => {
    const tracker = new TypedLineTracker();
    tracker.feed('hii' + DEL);
    expect(tracker.feed(CR)).toBe('hi');
  });

  it('ignores escape sequences (arrows, bracketed-paste markers)', () => {
    const tracker = new TypedLineTracker();
    const paste = ESC + '[200~fix the bug' + ESC + '[201~';
    tracker.feed(ESC + '[A' + paste);
    expect(tracker.feed(CR)).toBe('fix the bug');
  });

  it('treats ^U as kill-line', () => {
    const tracker = new TypedLineTracker();
    tracker.feed('draft' + CTRL_U + 'final');
    expect(tracker.feed(CR)).toBe('final');
  });

  it('returns the last non-empty commit in a chunk and null for blank Enters', () => {
    const tracker = new TypedLineTracker();
    expect(tracker.feed('one\rtwo\r')).toBe('two');
    expect(tracker.feed(CR)).toBeNull();
    expect(tracker.feed('   ' + CR)).toBeNull();
  });
});
