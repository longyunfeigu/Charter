import { describe, expect, it } from 'vitest';
import { createSequenceAllocator } from './sequence.js';

describe('sequence allocator', () => {
  it('produces strictly monotonic sequences per key', () => {
    const alloc = createSequenceAllocator();
    expect(alloc.next('task-a')).toBe(1);
    expect(alloc.next('task-a')).toBe(2);
    expect(alloc.next('task-b')).toBe(1);
    expect(alloc.next('task-a')).toBe(3);
  });

  it('can be seeded from persisted state and never goes backwards', () => {
    const alloc = createSequenceAllocator();
    alloc.seed('task-a', 41);
    expect(alloc.next('task-a')).toBe(42);
    alloc.seed('task-a', 10); // stale seed must not rewind
    expect(alloc.next('task-a')).toBe(43);
  });
});
