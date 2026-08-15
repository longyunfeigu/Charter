import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentResultReader, type AgentResultSession } from './agent-result-reader.js';
import { claudeProjectDirName } from './cli-session-locator.js';

const UUID = '924241d6-f2e8-444d-8d75-0386362bf52f';
const KIMI_ID = `session_${UUID}`;

function jsonl(rows: unknown[]): string {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

describe('AgentResultReader', () => {
  let root: string;
  const now = new Date(2026, 7, 12, 12, 0, 0).getTime();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'charter-agent-result-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function session(patch: Partial<AgentResultSession>): AgentResultSession {
    return {
      taskId: 'task-1',
      agent: 'custom',
      connector: null,
      dataHome: root,
      cwd: '/repo',
      sessionId: UUID,
      startedAtMs: now - 1_000,
      endedAtMs: now + 1_000,
      remote: false,
      ...patch,
    };
  }

  it('projects only Claude Code final assistant text', async () => {
    const directory = join(root, 'projects', claudeProjectDirName('/repo'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${UUID}.jsonl`),
      jsonl([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: null,
            content: [{ type: 'thinking', thinking: 'private' }],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'first answer' }],
          },
        },
        { type: 'user', message: { role: 'user', content: 'next' } },
        {
          type: 'assistant',
          isSidechain: false,
          message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'latest Claude answer' }],
          },
        },
      ]),
    );

    await expect(
      new AgentResultReader().read(session({ agent: 'claude', connector: 'claude' }), 64_000),
    ).resolves.toMatchObject({
      answer: 'latest Claude answer',
      connector: 'claude',
      sessionId: UUID,
    });
  });

  it('projects only Codex final_answer messages', async () => {
    const date = new Date(now);
    const day = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}`;
    const directory = join(root, 'sessions', day);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `rollout-2026-08-12T12-00-00-${UUID}.jsonl`),
      jsonl([
        { type: 'session_meta', payload: { id: UUID, cwd: '/repo' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'working update' }],
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            phase: 'final_answer',
            content: [{ type: 'output_text', text: 'Codex final answer' }],
          },
        },
      ]),
    );

    await expect(
      new AgentResultReader().read(session({ agent: 'codex', connector: 'codex' }), 64_000),
    ).resolves.toMatchObject({ answer: 'Codex final answer', connector: 'codex' });
  });

  it('projects Kimi text from the latest end_turn step', async () => {
    const sessionDir = join(root, 'sessions', 'wd_repo', KIMI_ID);
    mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
    writeFileSync(
      join(root, 'session_index.jsonl'),
      jsonl([{ sessionId: KIMI_ID, sessionDir, workDir: '/repo' }]),
    );
    writeFileSync(
      join(sessionDir, 'agents', 'main', 'wire.jsonl'),
      jsonl([
        {
          type: 'context.append_loop_event',
          turnId: 'turn-1',
          event: { type: 'content.part', step: 1, part: { type: 'think', text: 'private' } },
        },
        {
          type: 'context.append_loop_event',
          turnId: 'turn-1',
          event: { type: 'content.part', step: 1, part: { type: 'text', text: 'Kimi final ' } },
        },
        {
          type: 'context.append_loop_event',
          turnId: 'turn-1',
          event: { type: 'content.part', step: 1, part: { type: 'text', text: 'answer' } },
        },
        {
          type: 'context.append_loop_event',
          turnId: 'turn-1',
          event: { type: 'step.end', step: 1, finishReason: 'end_turn' },
        },
      ]),
    );

    await expect(
      new AgentResultReader().read(
        session({ agent: 'kimi', connector: 'kimi', sessionId: KIMI_ID }),
        64_000,
      ),
    ).resolves.toMatchObject({ answer: 'Kimi final answer', connector: 'kimi' });
  });

  it('returns null for unknown connectors and remote histories', async () => {
    const reader = new AgentResultReader();
    await expect(reader.read(session({ connector: 'future-agent' }), 100)).resolves.toBeNull();
    await expect(
      reader.read(session({ connector: 'claude', remote: true }), 100),
    ).resolves.toBeNull();
  });
});
