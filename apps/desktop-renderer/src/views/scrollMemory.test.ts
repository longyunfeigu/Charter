import { beforeEach, describe, expect, it } from 'vitest';
import { AT_BOTTOM, clearScroll, restoreScroll, saveScroll } from './scrollMemory.js';

/**
 * ADR-0052 regression lock (adversarial finding): a detached element measures
 * scrollHeight/scrollTop/clientHeight as 0/0/0, which the pin heuristic reads
 * as "at bottom". A teardown-time save through such a node must never
 * overwrite a real reading position with the AT_BOTTOM sentinel — restoring
 * would throw the user to the very end of the transcript.
 *
 * saveScroll/restoreScroll only touch isConnected/clientHeight/scrollHeight/
 * scrollTop, so plain stubs stand in for HTMLElement (node environment).
 */

interface ScrollerStub {
  isConnected: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function scroller(overrides: Partial<ScrollerStub>): HTMLElement & ScrollerStub {
  return {
    isConnected: true,
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    ...overrides,
  } as HTMLElement & ScrollerStub;
}

beforeEach(() => clearScroll('t1'));

describe('saveScroll teardown safety', () => {
  it('a detached element must not overwrite the saved position', () => {
    const attached = scroller({ scrollHeight: 2000, clientHeight: 200, scrollTop: 400 });
    saveScroll('t1', attached);

    // Unmount-time node: 0/0/0 would read as "pinned to bottom".
    const detached = scroller({ isConnected: false });
    saveScroll('t1', detached);

    const restore = scroller({ scrollHeight: 2000, clientHeight: 200 });
    const pinned = restoreScroll('t1', restore);
    expect(pinned).toBe(false);
    expect(restore.scrollTop).toBe(400); // not thrown to the bottom
  });

  it('a zero-height (hidden but connected) element is refused too', () => {
    const attached = scroller({ scrollHeight: 2000, clientHeight: 200, scrollTop: 150 });
    saveScroll('t1', attached);

    const hidden = scroller({}); // connected, collapsed to 0/0/0
    saveScroll('t1', hidden);

    const restore = scroller({ scrollHeight: 2000, clientHeight: 200 });
    restoreScroll('t1', restore);
    expect(restore.scrollTop).toBe(150);
  });

  it('a genuine near-bottom save still pins', () => {
    // 1000 - 650 - 300 = 50 < 120 → pinned.
    const attached = scroller({ scrollHeight: 1000, clientHeight: 300, scrollTop: 650 });
    saveScroll('t1', attached);

    const restore = scroller({ scrollHeight: 5000, clientHeight: 300 });
    const pinned = restoreScroll('t1', restore);
    expect(pinned).toBe(true);
    expect(restore.scrollTop).toBe(5000); // AT_BOTTOM semantics
  });

  it('the precomputed pin verdict path respects the same refusal', () => {
    const attached = scroller({ scrollHeight: 2000, clientHeight: 200, scrollTop: 400 });
    saveScroll('t1', attached, false);

    const detached = scroller({ isConnected: false });
    saveScroll('t1', detached, true); // caller-computed verdict is still refused

    const restore = scroller({ scrollHeight: 2000, clientHeight: 200 });
    restoreScroll('t1', restore);
    expect(restore.scrollTop).toBe(400);
  });
});

describe('AT_BOTTOM sentinel', () => {
  it('is a negative sentinel distinct from any real scrollTop', () => {
    expect(AT_BOTTOM).toBeLessThan(0);
  });
});
