import { describe, expect, it } from 'vitest';
import { cleanTerminalText, ExternalStructuredReplayParser } from './external-replay-parser.js';

describe('ExternalStructuredReplayParser', () => {
  it('projects Claude stream-json tool lifecycles without persisting thinking', () => {
    const parser = new ExternalStructuredReplayParser();
    const input = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'private chain of thought' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'ls', api_key: 'sk-supersecret123456789' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: 'README.md', is_error: false },
          ],
        },
      }),
      '',
    ].join('\n');

    const first = parser.feed('claude', input.slice(0, 90));
    const second = parser.feed('claude', input.slice(90));
    const observations = [...first.observations, ...second.observations];
    const terminalText = first.terminalText + second.terminalText;
    expect(second.structured || first.structured).toBe(true);
    expect(observations.map((item) => item.label)).toContain('Claude called Bash');
    expect(observations.map((item) => item.label)).toContain('Bash completed');
    expect(JSON.stringify(observations)).not.toContain('private chain of thought');
    expect(JSON.stringify(observations)).not.toContain('sk-supersecret');
    expect(terminalText).toContain('Claude called Bash');
    expect(terminalText).toContain('README.md');
    expect(terminalText).not.toContain('private chain of thought');
    expect(terminalText).not.toContain('sk-supersecret');
  });

  it('projects Codex JSONL commands and deliberately ignores reasoning items', () => {
    const parser = new ExternalStructuredReplayParser();
    const result = parser.feed(
      'codex',
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
        JSON.stringify({
          type: 'item.started',
          item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'cmd-1',
            type: 'command_execution',
            command: 'npm test',
            aggregated_output: '42 passed',
            exit_code: 0,
          },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'reason-1', type: 'reasoning', text: 'hidden internal reasoning' },
        }),
        '',
      ].join('\n'),
    );

    expect(result.structured).toBe(true);
    expect(result.observations.some((item) => item.label === 'Ran npm test')).toBe(true);
    expect(JSON.stringify(result.observations)).not.toContain('hidden internal reasoning');
    expect(result.terminalText).toContain('42 passed');
    expect(result.terminalText).not.toContain('hidden internal reasoning');
  });

  it('does not release a partial structured envelope before it can be classified', () => {
    const parser = new ExternalStructuredReplayParser();
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'never persist this' }] },
    });
    const first = parser.feed('claude', line.slice(0, 45));
    const second = parser.feed('claude', `${line.slice(45)}\n`);
    expect(first.terminalText).toBe('');
    expect(second.structured).toBe(true);
    expect(second.terminalText).toBe('');
  });

  it('maps Claude TodoWrite/ExitPlanMode tool calls to plan observations (V3.1 pivot source)', () => {
    const parser = new ExternalStructuredReplayParser();
    const result = parser.feed(
      'claude',
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'todo-1',
                name: 'TodoWrite',
                input: { todos: [{ content: 'switch to single-flight refresh' }] },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'todo-1', content: 'ok' }],
          },
        }),
        '',
      ].join('\n'),
    );
    const plans = result.observations.filter((item) => item.kind === 'plan');
    expect(plans.length).toBe(2); // running + terminal, same key (one proposal)
    expect(plans[0]!.label).toContain('Claude updated its plan');
    expect(plans[0]!.key).toBe('todo-1');
    expect(plans[1]!.key).toBe('todo-1');
    expect(plans[0]!.evidenceKinds).toContain('plan');
    expect(plans[0]!.detail).toContain('single-flight');
  });

  it('maps Codex todo_list items to plan observations', () => {
    const parser = new ExternalStructuredReplayParser();
    const result = parser.feed(
      'codex',
      [
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'todo-9',
            type: 'todo_list',
            items: [{ text: 'retry with replay queue', completed: false }],
          },
        }),
        '',
      ].join('\n'),
    );
    expect(result.structured).toBe(true);
    const plan = result.observations.find((item) => item.kind === 'plan');
    expect(plan).toBeDefined();
    expect(plan!.label).toBe('Codex updated its plan');
    expect(plan!.detail).toContain('replay queue');
    expect(plan!.evidenceKinds).toContain('plan');
  });

  it('strips terminal control sequences and redacts credential-shaped text', () => {
    const cleaned = cleanTerminalText('\u001b[32mok\u001b[0m token=secret-value');
    expect(cleaned).toContain('ok');
    expect(cleaned).toContain('token=[REDACTED]');
    expect(cleaned).not.toContain('\u001b');
  });
});
