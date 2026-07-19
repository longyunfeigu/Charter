import { describe, expect, it } from 'vitest';
import { terminalLaunchCommand } from './m4-handlers.js';

describe('terminalLaunchCommand (product-owned launch presets)', () => {
  it('pre-assigns the claude conversation id so resume can target it exactly', () => {
    const id = '924241d6-f2e8-444d-8d75-0386362bf52f';
    expect(terminalLaunchCommand('claude', id)).toBe(`claude --session-id ${id}`);
  });

  it('launches bare without an id — codex has no pre-assignment flag', () => {
    expect(terminalLaunchCommand('claude')).toBe('claude');
    expect(terminalLaunchCommand('claude', null)).toBe('claude');
    expect(terminalLaunchCommand('codex', '924241d6-f2e8-444d-8d75-0386362bf52f')).toBe('codex');
    expect(terminalLaunchCommand('shell')).toBeNull();
  });

  it('never embeds a non-UUID id into PTY input', () => {
    expect(terminalLaunchCommand('claude', 'abc; rm -rf .')).toBe('claude');
    expect(terminalLaunchCommand('claude', '$(evil)')).toBe('claude');
  });
});
