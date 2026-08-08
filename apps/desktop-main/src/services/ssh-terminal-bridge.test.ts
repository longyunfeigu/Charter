import { describe, expect, it } from 'vitest';
import {
  remoteCliProbeCommand,
  remoteLaunchSequence,
  shellSingleQuote,
} from './ssh-terminal-bridge.js';

describe('remoteCliProbeCommand', () => {
  it('falls back to the remote user login and interactive shells for profile-managed CLIs', () => {
    const command = remoteCliProbeCommand('claude');

    expect(command).toContain('command -v claude');
    expect(command).toContain('"$SHELL" -l -i -c \'command -v claude\'');
    expect(command).toContain('"$SHELL" -i -c \'command -v claude\'');
  });

  it('rejects shell syntax in a CLI name', () => {
    expect(() => remoteCliProbeCommand('claude; touch /tmp/pwned')).toThrow(
      'unsupported characters',
    );
  });
});

describe('remoteLaunchSequence', () => {
  it('starts an Agent in the remote folder without an initial prompt', () => {
    expect(remoteLaunchSequence('codex', '/srv/project')).toBe(
      "cd -- '/srv/project' && exec codex\r",
    );
  });

  it('quotes the folder and first prompt as independent POSIX shell arguments', () => {
    const folder = "/srv/Edy's project";
    const prompt = "Review SSH reconnects; don't run `touch /tmp/pwned`";

    expect(remoteLaunchSequence('claude', folder, `  ${prompt}\n`)).toBe(
      `cd -- ${shellSingleQuote(folder)} && exec claude ${shellSingleQuote(prompt)}\r`,
    );
  });
});
