import { describe, expect, it } from 'vitest';
import { parseTerminalControlCli, TERMINAL_CONTROL_CLI_USAGE } from './terminal-control-cli.js';

describe('terminal-control CLI parser', () => {
  it('treats help flags as documentation instead of creating a terminal', () => {
    expect(parseTerminalControlCli(['create', '--help'])).toEqual({ kind: 'help' });
    expect(parseTerminalControlCli(['--help'])).toEqual({ kind: 'help' });
    expect(TERMINAL_CONTROL_CLI_USAGE).toContain('create');
  });

  it('parses create and send calls', () => {
    expect(parseTerminalControlCli(['create', '--launch', 'codex'])).toEqual({
      kind: 'call',
      name: 'terminal_create',
      input: { launch: 'codex', submit: true },
    });
    expect(parseTerminalControlCli(['send', 'term_1', 'review this', '--no-submit'])).toEqual({
      kind: 'call',
      name: 'terminal_send',
      input: { id: 'term_1', text: 'review this', submit: false },
    });
    expect(parseTerminalControlCli(['wait', 'term_1', '--mode', 'turn'])).toEqual({
      kind: 'call',
      name: 'terminal_wait',
      input: { id: 'term_1', mode: 'turn' },
    });
  });

  it('parses recursive Mission orchestration commands', () => {
    expect(parseTerminalControlCli(['orchestration', 'inspect', '--json'])).toEqual({
      kind: 'call',
      name: 'orchestration_inspect',
      input: {},
    });
    expect(
      parseTerminalControlCli([
        'orchestration',
        'wait',
        '--types',
        'question,completion',
        '--timeout-ms',
        '600000',
      ]),
    ).toEqual({
      kind: 'call',
      name: 'orchestration_wait',
      input: { types: ['question', 'completion'], timeoutMs: 600000 },
    });
    expect(
      parseTerminalControlCli([
        'orchestration',
        'cancel',
        '--assignment',
        'assign-b',
        '--reason',
        'superseded',
      ]),
    ).toEqual({
      kind: 'call',
      name: 'orchestration_cancel',
      input: { assignmentId: 'assign-b', reason: 'superseded' },
    });
    expect(
      parseTerminalControlCli(['orchestration', 'continue', '--continuation', 'continuation-1']),
    ).toEqual({
      kind: 'call',
      name: 'orchestration_continue',
      input: { continuationId: 'continuation-1' },
    });
  });

  it('fails before contacting Charter when required arguments are missing', () => {
    expect(parseTerminalControlCli(['send', 'term_1'])).toEqual({
      kind: 'error',
      message: 'send requires non-empty text.',
    });
    expect(parseTerminalControlCli(['read'])).toEqual({
      kind: 'error',
      message: 'read requires a Session name or terminal id.',
    });
    expect(parseTerminalControlCli(['unknown'])).toEqual({
      kind: 'error',
      message: 'Unknown terminal command: unknown',
    });
  });
});
