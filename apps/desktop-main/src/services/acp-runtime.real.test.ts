import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@pi-ide/foundation';
import { AcpProcessPool, type AcpProvider } from './acp-runtime.js';

const requested = new Set(
  (process.env.RUN_REAL_ACP ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

const providers = ['codex', 'claude'] as const;

describe('real installed ACP providers', () => {
  for (const provider of providers) {
    const enabled = requested.has(provider);
    it.skipIf(!enabled)(
      `${provider} runs two isolated sessions through one provider pool`,
      async () => {
        const packageName = provider === 'codex' ? 'codex-acp' : 'claude-agent-acp';
        const entry = join(
          process.cwd(),
          'node_modules',
          '@agentclientprotocol',
          packageName,
          'dist',
          'index.js',
        );
        expect(existsSync(entry)).toBe(true);
        const pool = new AcpProcessPool(
          () => ({ command: process.execPath, args: [entry] }),
          createLogger(`real-acp-${provider}`, { write: () => undefined }),
        );
        const output = new Map<string, string[]>();
        try {
          const sessions = await Promise.all(
            ['B', 'C'].map(async (name) => {
              const chunks: string[] = [];
              const session = await pool.newSession(
                provider as AcpProvider,
                process.cwd(),
                [],
                (notification) => {
                  const update = notification.update;
                  if (
                    update.sessionUpdate === 'agent_message_chunk' &&
                    update.content.type === 'text'
                  ) {
                    chunks.push(update.content.text);
                  }
                },
              );
              output.set(name, chunks);
              return { name, session };
            }),
          );
          expect(new Set(sessions.map((item) => item.session.processKey)).size).toBe(1);
          const results = await Promise.all(
            sessions.map((item) =>
              pool.prompt(
                provider as AcpProvider,
                item.session.sessionId,
                `Do not use tools. Reply with exactly ${item.name}_READY.`,
              ),
            ),
          );
          expect(results.every((result) => result.stopReason === 'end_turn')).toBe(true);
          for (const item of sessions) {
            expect(output.get(item.name)?.join('')).toContain(`${item.name}_READY`);
          }
        } finally {
          await pool.shutdown();
        }
      },
      180_000,
    );
  }
});
