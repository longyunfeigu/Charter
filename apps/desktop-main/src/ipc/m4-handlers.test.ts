import { describe, expect, it } from 'vitest';
import { terminalLaunchCommand } from './m4-handlers.js';

describe('terminalLaunchCommand (product-owned launch presets)', () => {
  it('renders a trusted manifest-resolved executable and argv', () => {
    expect(
      terminalLaunchCommand('claude', '/usr/local/bin/claude', [
        '--session-id',
        '924241d6-f2e8-444d-8d75-0386362bf52f',
      ]),
    ).toBe("'/usr/local/bin/claude' '--session-id' '924241d6-f2e8-444d-8d75-0386362bf52f'");
  });

  it('requires a host-resolved executable and never launches shell as an Agent', () => {
    expect(terminalLaunchCommand('claude')).toBeNull();
    expect(terminalLaunchCommand('kimi', null)).toBeNull();
    expect(terminalLaunchCommand('shell')).toBeNull();
  });

  it('quotes every manifest-provided argv token', () => {
    const wrapper = "/tmp/Charter user's data/claude";
    expect(terminalLaunchCommand('custom', wrapper, ['--mode', "user's choice"])).toBe(
      `'${wrapper.replaceAll("'", "'\\''")}' '--mode' 'user'\\''s choice'`,
    );
  });

  it('uses the trusted bare Agent command so the interactive shell can expand its alias', () => {
    expect(
      terminalLaunchCommand('codex', '/Users/edy/.local/bin/codex', ['--model', 'gpt-5'], 'codex'),
    ).toBe("codex '--model' 'gpt-5'");
  });

  it('falls back to the resolved executable for mismatched or unsafe shell commands', () => {
    expect(terminalLaunchCommand('codex', '/usr/local/bin/codex', [], 'claude')).toBe(
      "'/usr/local/bin/codex'",
    );
    expect(terminalLaunchCommand('codex', '/usr/local/bin/codex', [], 'codex; touch /tmp/x')).toBe(
      "'/usr/local/bin/codex'",
    );
  });
});
