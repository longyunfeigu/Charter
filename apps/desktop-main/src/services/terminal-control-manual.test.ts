import { describe, expect, it } from 'vitest';
import {
  CHARTER_TERMINAL_AGENTS_SNIPPET,
  CHARTER_TERMINAL_SKILL,
} from './terminal-control-manual.js';

describe('terminal control manual worker lifecycle', () => {
  it('keeps completed workers resident and reserves closure for the user', () => {
    expect(CHARTER_TERMINAL_SKILL).toContain('leave every worker open');
    expect(CHARTER_TERMINAL_SKILL).toContain('Never call `terminal.kill`');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain(
      'Workers remain open after completion for follow-up',
    );
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain('never call terminal_kill');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).not.toContain('read -> kill');
  });
});
