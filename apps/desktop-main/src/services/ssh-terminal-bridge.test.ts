import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  remoteCliProbeCommand,
  remoteCwdSyncSequence,
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

  it('quotes the folder and manifest argv as independent POSIX shell arguments', () => {
    const folder = "/srv/Edy's project";
    const prompt = "Review SSH reconnects; don't run `touch /tmp/pwned`";

    expect(remoteLaunchSequence('claude', folder, [prompt])).toBe(
      `cd -- ${shellSingleQuote(folder)} && exec claude ${shellSingleQuote(prompt)}\r`,
    );
  });

  it('supports flag-based Agent prompt contracts and rejects command injection', () => {
    expect(remoteLaunchSequence('gemini', '/srv/project', ['--prompt-interactive', 'review'])).toBe(
      "cd -- '/srv/project' && exec gemini '--prompt-interactive' 'review'\r",
    );
    expect(() => remoteLaunchSequence('gemini; touch /tmp/pwned', null)).toThrow(
      'unsupported characters',
    );
  });
});

describe('remoteCwdSyncSequence (ADR-0059)', () => {
  const line = remoteCwdSyncSequence();
  const script = line.replace(/\r$/, '');
  const shellAvailable = (shell: string): boolean =>
    spawnSync('command', ['-v', shell], { shell: '/bin/sh' }).status === 0;

  it('is one history-hygienic line that degrades silently', () => {
    expect(line.startsWith(' ')).toBe(true); // HISTCONTROL/HIST_IGNORE_SPACE skip
    expect(line.endsWith('\r')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).toContain('2>/dev/null');
    expect(line).toContain('$ZSH_VERSION');
    expect(line).toContain('$BASH_VERSION');
  });

  it.skipIf(!shellAvailable('bash'))('emits OSC 7 with the cwd in real bash', () => {
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', cwd: '/tmp' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(']7;file://');
    // /tmp may resolve through a symlink (macOS /private/tmp) — match the tail.
    expect(result.stdout).toMatch(/\]7;file:\/\/[^/]*\/.*tmp/);
    // The hook must chain, not clobber, an existing PROMPT_COMMAND.
    const chained = spawnSync(
      'bash',
      ['-c', `PROMPT_COMMAND='echo kept';${script}; eval "$PROMPT_COMMAND"`],
      { encoding: 'utf8' },
    );
    expect(chained.stdout).toContain('kept');
  });

  it.skipIf(!shellAvailable('zsh'))('emits OSC 7 with the cwd in real zsh', () => {
    const result = spawnSync('zsh', ['-c', script], { encoding: 'utf8', cwd: '/tmp' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(']7;file://');
  });

  it.skipIf(!shellAvailable('dash'))('is a silent no-op in a plain POSIX shell', () => {
    const result = spawnSync('dash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
