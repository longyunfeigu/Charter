import { describe, expect, it } from 'vitest';
import { WorkItemCreateInputSchema, WorkItemUpdateInputSchema } from './work-items.js';

describe('work item mutation contracts', () => {
  it('applies capture defaults without inventing an owner or starting stage', () => {
    const parsed = WorkItemCreateInputSchema.parse({
      typeId: 'work-type-generic',
      title: 'Prepare the partner briefing',
    });

    expect(parsed.assignee).toBe('');
    expect(parsed.columnId).toBeUndefined();
    expect(parsed.priority).toBe('none');
    expect(parsed.customFields).toEqual({});
  });

  it('keeps partial updates sparse instead of injecting creation defaults', () => {
    const acceptance = [{ id: 'criterion-1', text: 'Claims are sourced', checked: true }];
    const parsed = WorkItemUpdateInputSchema.parse({
      id: 'work-1',
      expectedVersion: 4,
      acceptance,
    });

    expect(parsed).toEqual({ id: 'work-1', expectedVersion: 4, acceptance });
    expect(parsed).not.toHaveProperty('customFields');
    expect(parsed).not.toHaveProperty('priority');
    expect(parsed).not.toHaveProperty('title');
  });

  it('rejects create-only workflow fields on an update', () => {
    expect(() =>
      WorkItemUpdateInputSchema.parse({
        id: 'work-1',
        expectedVersion: 1,
        columnId: 'work-col-review',
      }),
    ).toThrow();
  });
});
