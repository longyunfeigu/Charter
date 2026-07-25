import { describe, expect, it } from 'vitest';
import {
  CHARTER_TERMINAL_AGENTS_SNIPPET,
  CHARTER_TERMINAL_SKILL,
} from './terminal-control-manual.js';

describe('terminal control manual worker lifecycle', () => {
  it('keeps completed workers resident and limits closure to an explicit user request', () => {
    expect(CHARTER_TERMINAL_SKILL).toContain('leave every worker open');
    expect(CHARTER_TERMINAL_SKILL).toContain('only when the user explicitly asks');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain(
      'Workers remain open after completion for follow-up',
    );
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain('call terminal_kill only when the user');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).not.toContain('read -> kill');
  });

  it('documents prompt-free tools, queued delivery, and resident TUI busy semantics', () => {
    expect(CHARTER_TERMINAL_SKILL).toContain('do not open permission cards');
    expect(CHARTER_TERMINAL_SKILL).toContain('`queued: true`');
    expect(CHARTER_TERMINAL_SKILL).toContain('keeps `busy: true`');
    expect(CHARTER_TERMINAL_SKILL).toContain('`wait --mode turn`');
    expect(CHARTER_TERMINAL_SKILL).toContain('instead of a polling interval');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain('run without permission cards');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain('queued=true has not been delivered');
    expect(CHARTER_TERMINAL_AGENTS_SNIPPET).toContain('event-driven turn wait');
  });

  it('carries the trigger conditions a hand-launched CLI needs (ADR-0045)', () => {
    // The frontmatter description is all a skill-scanning CLI sees up front:
    // it must name the trigger scenarios and the availability gate.
    expect(CHARTER_TERMINAL_SKILL).toContain('CHARTER_CTL environment variable is present');
    expect(CHARTER_TERMINAL_SKILL).toContain('开个窗口');
    // The body opens with a door self-check and a non-MCP fallback path.
    expect(CHARTER_TERMINAL_SKILL).toContain('[ -n "$CHARTER_CTL" ]');
    expect(CHARTER_TERMINAL_SKILL).toContain('same door, same host-enforced rules');
  });
});
