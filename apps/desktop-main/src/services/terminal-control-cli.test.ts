import { describe, expect, it } from 'vitest';
import {
  orchestrationCliHelp,
  parseTerminalControlCli,
  TERMINAL_CONTROL_CLI_USAGE,
  validateOrchestrationCliInput,
} from './terminal-control-cli.js';

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

  it('parses semantic Agent status, explain, result, read, wait and prompt calls', () => {
    expect(parseTerminalControlCli(['agent', 'status', 'Reviewer'])).toEqual({
      kind: 'call',
      name: 'agent_status',
      input: { id: 'Reviewer' },
    });
    expect(parseTerminalControlCli(['agent', 'explain', 'term_2'])).toEqual({
      kind: 'call',
      name: 'agent_explain',
      input: { id: 'term_2' },
    });
    expect(
      parseTerminalControlCli(['agent', 'result', 'Reviewer', '--max-bytes', '90000']),
    ).toEqual({
      kind: 'call',
      name: 'agent_result',
      input: { id: 'Reviewer', maxBytes: 90000 },
    });
    expect(
      parseTerminalControlCli([
        'agent',
        'read',
        'Reviewer',
        '--mode',
        'transcript',
        '--lines',
        '400',
        '--max-bytes',
        '90000',
        '--no-unwrap',
      ]),
    ).toEqual({
      kind: 'call',
      name: 'agent_read',
      input: {
        id: 'Reviewer',
        mode: 'transcript',
        lines: 400,
        maxBytes: 90000,
        unwrap: false,
      },
    });
    expect(
      parseTerminalControlCli([
        'agent',
        'wait',
        'Reviewer',
        '--until',
        'idle,blocked,exited',
        '--after-seq',
        '12',
        '--identity-seq',
        '3',
        '--timeout-ms',
        '9000',
      ]),
    ).toEqual({
      kind: 'call',
      name: 'agent_wait',
      input: {
        id: 'Reviewer',
        until: ['idle', 'blocked', 'exited'],
        afterSeq: 12,
        identitySeq: 3,
        timeoutMs: 9000,
      },
    });
    expect(
      parseTerminalControlCli([
        'agent',
        'prompt',
        'Reviewer',
        'review the patch',
        '--timeout-ms',
        '5000',
      ]),
    ).toEqual({
      kind: 'call',
      name: 'agent_prompt',
      input: { id: 'Reviewer', text: 'review the patch', timeoutMs: 5000 },
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

  it('serves command-specific orchestration help without contacting Charter', () => {
    expect(parseTerminalControlCli(['orchestration', 'delegate', '--help', '--json'])).toEqual({
      kind: 'orchestration-help',
      command: 'delegate',
      json: true,
    });
    const help = orchestrationCliHelp('delegate');
    expect(help.description).toMatch(/durable child/i);
    expect(help.inputSchema).toMatchObject({ type: 'object' });
    expect(help.example).toMatchObject({
      goal: expect.any(String),
      acceptanceCriteria: [],
      requestedRuntime: 'managed',
      workMode: 'auto',
    });
  });

  it('validates and normalizes dry-run requests locally without creating an Assignment', () => {
    const request = {
      goal: 'Implement the API',
      reason: 'Keep the work bounded',
      idempotencyKey: 'api-v1',
    };
    expect(
      parseTerminalControlCli([
        'orchestration',
        'delegate',
        '--request-json',
        JSON.stringify(request),
        '--dry-run',
      ]),
    ).toEqual({ kind: 'dry-run', command: 'delegate', input: request });
    expect(validateOrchestrationCliInput('delegate', request)).toEqual({
      ok: true,
      command: 'delegate',
      normalizedInput: {
        ...request,
        acceptanceCriteria: [],
        requestedRuntime: 'managed',
        workMode: 'auto',
      },
    });

    const invalid = validateOrchestrationCliInput('delegate', { goal: '' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining(['goal', 'reason', 'idempotencyKey']),
      );
    }
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
