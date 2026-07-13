import { describe, expect, it } from 'vitest';
import { TaskStateSchema } from '@pi-ide/ipc-contracts';
import {
  TASK_STATE_META,
  stateLabel,
  stateShort,
  stateTone,
  toolVerb,
  toolStateWord,
  modeLabel,
} from '../../apps/desktop-renderer/src/views/labels.js';

describe('shared state vocabulary (PIVOT-023)', () => {
  it('maps every task state to a human label (no raw enums can leak)', () => {
    for (const state of TaskStateSchema.options) {
      const meta = TASK_STATE_META[state];
      expect(meta, `missing label for ${state}`).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.short.length).toBeGreaterThan(0);
      // Human labels never look like the raw enum.
      expect(meta.label).not.toMatch(/^[A-Z_]+$/);
      expect(meta.short).not.toMatch(/^[A-Z_]+$/);
    }
  });

  it('falls back gracefully for unknown states', () => {
    expect(stateLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(stateShort('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(stateTone('SOMETHING_NEW')).toBe('idle');
  });

  it('humanizes tool names, including unknown ones', () => {
    expect(toolVerb('apply_patch')).toBe('Edited file');
    expect(toolVerb('propose_plan')).toBe('Proposed a plan');
    expect(toolVerb('brand_new_tool')).toBe('Brand new tool');
  });

  it('humanizes tool lifecycle states', () => {
    expect(toolStateWord('SUCCEEDED')).toBe('');
    expect(toolStateWord('FAILED')).toBe('failed');
    expect(toolStateWord('RUNNING')).toBe('running…');
  });

  it('maps approval modes to plain labels', () => {
    expect(modeLabel('ask')).toBe('Read-only');
    expect(modeLabel('edit')).toBe('Approve changes');
    expect(modeLabel('auto')).toBe('Auto · pause on risk');
  });
});

describe('ADR-0009 light completion presentation', () => {
  it('REVIEW_READY with zero net changes presents as Answered (state untouched)', async () => {
    const { presentedMeta, isAnswered } = await import(
      '../../apps/desktop-renderer/src/views/labels.js'
    );
    expect(isAnswered({ state: 'REVIEW_READY', changedFiles: 0 })).toBe(true);
    expect(presentedMeta({ state: 'REVIEW_READY', changedFiles: 0 }).short).toBe('Answered');
    // Real changes keep full review weight.
    expect(isAnswered({ state: 'REVIEW_READY', changedFiles: 2 })).toBe(false);
    expect(presentedMeta({ state: 'REVIEW_READY', changedFiles: 2 }).short).toBe('Review');
    // Unknown (pre-finalize) counts never fake an answer.
    expect(isAnswered({ state: 'REVIEW_READY', changedFiles: null })).toBe(false);
    expect(isAnswered({ state: 'IN_PROGRESS', changedFiles: 0 })).toBe(false);
  });
});
