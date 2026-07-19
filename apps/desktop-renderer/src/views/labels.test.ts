import { describe, expect, it } from 'vitest';
import { isAnswered, presentedMeta } from './labels.js';

describe('presentedMeta (Answered veneer vs external session end)', () => {
  const answeredPi = { state: 'REVIEW_READY', changedFiles: 0 };
  const answeredExternal = { state: 'REVIEW_READY', changedFiles: 0, external: { cli: 'claude' } };

  it('keeps the Answered veneer for zero-change Pi runs', () => {
    expect(isAnswered(answeredPi)).toBe(true);
    expect(presentedMeta(answeredPi)).toEqual({
      label: 'Answered — nothing changed on disk',
      short: 'Answered',
      tone: 'ok',
    });
  });

  it('reports an exited external CLI as ended, not answered', () => {
    expect(presentedMeta(answeredExternal)).toEqual({
      label: 'Session ended — nothing changed on disk',
      short: 'Ended',
      tone: 'idle',
    });
  });

  it('external sessions with real changes keep the review presentation', () => {
    const review = { state: 'REVIEW_READY', changedFiles: 3, external: { cli: 'claude' } };
    expect(isAnswered(review)).toBe(false);
    expect(presentedMeta(review).short).toBe('Review');
  });
});
