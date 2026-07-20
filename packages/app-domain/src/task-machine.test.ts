import { describe, expect, it } from 'vitest';
import { ProductFailure } from '@pi-ide/foundation';
import { assertTransition, canTransition, TASK_STATES, isRunningState } from './task-machine.js';

describe('task state machine (spec §6.1)', () => {
  it('allows the documented happy path', () => {
    const path = [
      ['DRAFT', 'READY'],
      ['READY', 'EXPLORING'],
      ['EXPLORING', 'PLANNING'],
      ['PLANNING', 'AWAITING_PLAN_APPROVAL'],
      ['AWAITING_PLAN_APPROVAL', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'AWAITING_PERMISSION'],
      ['AWAITING_PERMISSION', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'VERIFYING'],
      ['VERIFYING', 'REVIEW_READY'],
      ['REVIEW_READY', 'ACCEPTED'],
      ['ACCEPTED', 'ARCHIVED'],
    ] as const;
    for (const [from, to] of path) {
      expect(canTransition(from, to), `${from}→${to}`).toBe(true);
    }
  });

  it('rejects forbidden transitions with a typed error', () => {
    expect(canTransition('DRAFT', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('ARCHIVED', 'READY')).toBe(false);
    expect(canTransition('REVIEW_READY', 'EXPLORING')).toBe(false);
    expect(() => assertTransition('ARCHIVED', 'READY')).toThrowError(ProductFailure);
  });

  it('any running state can be interrupted and interrupted tasks can resume or be reviewed', () => {
    for (const running of [
      'EXPLORING',
      'PLANNING',
      'IN_PROGRESS',
      'AWAITING_PERMISSION',
      'VERIFYING',
    ] as const) {
      expect(canTransition(running, 'INTERRUPTED'), running).toBe(true);
      expect(isRunningState(running)).toBe(true);
    }
    expect(canTransition('INTERRUPTED', 'READY')).toBe(true);
    expect(canTransition('INTERRUPTED', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('INTERRUPTED', 'REVIEW_READY')).toBe(true);
    expect(canTransition('INTERRUPTED', 'ROLLED_BACK')).toBe(true);
  });

  it('ACCEPTED can be rolled back while snapshots survive (ADR-0012)', () => {
    expect(canTransition('ACCEPTED', 'ROLLED_BACK')).toBe(true);
    expect(canTransition('ACCEPTED', 'ARCHIVED')).toBe(true);
    expect(canTransition('ACCEPTED', 'IN_PROGRESS')).toBe(false);
  });

  it('REVIEW_READY can return to IN_PROGRESS (continue) or ROLLED_BACK', () => {
    expect(canTransition('REVIEW_READY', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('REVIEW_READY', 'ROLLED_BACK')).toBe(true);
  });

  it('exposes the complete state list', () => {
    expect(TASK_STATES).toContain('AWAITING_PLAN_APPROVAL');
    expect(TASK_STATES).toContain('IDLE');
    expect(TASK_STATES).toHaveLength(16);
  });

  describe('ADR-0032 — session as conversation', () => {
    it('settlement lands on IDLE and the conversation can continue', () => {
      expect(canTransition('REVIEW_READY', 'IDLE')).toBe(true);
      expect(canTransition('IDLE', 'IN_PROGRESS')).toBe(true);
      expect(canTransition('IDLE', 'EXPLORING')).toBe(true);
      // Zero-change turns settle straight from the run states.
      expect(canTransition('IN_PROGRESS', 'IDLE')).toBe(true);
      expect(canTransition('VERIFYING', 'IDLE')).toBe(true);
      // Plan rejection settles the turn, not the Session.
      expect(canTransition('AWAITING_PLAN_APPROVAL', 'IDLE')).toBe(true);
    });

    it('archive is the only terminal; IDLE never reaches historic resting states', () => {
      expect(canTransition('IDLE', 'ARCHIVED')).toBe(true);
      expect(canTransition('REVIEW_READY', 'ARCHIVED')).toBe(true);
      expect(canTransition('IDLE', 'ACCEPTED')).toBe(false);
      expect(canTransition('IDLE', 'ROLLED_BACK')).toBe(false);
      expect(canTransition('ARCHIVED', 'IDLE')).toBe(false);
      expect(isRunningState('IDLE')).toBe(false);
    });
  });
});
