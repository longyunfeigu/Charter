import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attributeProject,
  parseClaudeTranscript,
  parseCodexRollout,
  SessionArchaeologyService,
} from './session-archaeology.js';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => silentLogger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const CLAUDE_ID = '6f3a92c1-aaaa-4bbb-8ccc-0123456789ab';
const CODEX_ID = '019f1609-996f-7633-b306-921acdf80a78';

const lines = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join('\n');

function claudeTranscript(): string {
  return lines(
    { type: 'mode', sessionId: CLAUDE_ID },
    {
      type: 'user',
      sessionId: CLAUDE_ID,
      cwd: '/Users/dev/git/blog',
      timestamp: '2026-07-17T09:00:00.000Z',
      message: { content: 'Caveat: The messages below were generated locally.' },
    },
    {
      type: 'user',
      cwd: '/Users/dev/git/blog',
      timestamp: '2026-07-17T09:00:01.000Z',
      message: { content: '<command-name>/clear</command-name>' },
    },
    {
      type: 'user',
      cwd: '/Users/dev/git/blog',
      timestamp: '2026-07-17T09:00:02.000Z',
      message: { content: '给博客加一个 RSS 输出，全文带图片。' },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-17T09:01:00.000Z',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Write',
            input: { file_path: '/Users/dev/git/blog/layouts/index.rss.xml' },
          },
          {
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: '/Users/dev/git/blog/config.toml' },
          },
          { type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } },
          { type: 'tool_use', name: 'Skill', input: { skill: 'baoyu-format-markdown' } },
        ],
      },
    },
    // Subagent branch: never counts toward the main conversation.
    {
      type: 'user',
      isSidechain: true,
      timestamp: '2026-07-17T09:02:00.000Z',
      message: { content: 'subagent inner prompt' },
    },
    // Tool results come back as user entries — not human turns.
    {
      type: 'user',
      timestamp: '2026-07-17T09:03:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'wrote file' }] },
    },
    {
      type: 'user',
      timestamp: '2026-07-17T09:04:00.000Z',
      message: { content: '继续，图片用绝对路径。' },
    },
  );
}

describe('parseClaudeTranscript (ADR-0038)', () => {
  it('reduces a transcript to cwd, first-message title, writes and skills', () => {
    const summary = parseClaudeTranscript(claudeTranscript());
    expect(summary.sessionId).toBe(CLAUDE_ID);
    expect(summary.cwd).toBe('/Users/dev/git/blog');
    expect(summary.title).toBe('给博客加一个 RSS 输出，全文带图片。');
    expect(summary.turnCount).toBe(2);
    expect(summary.startedAt).toBe('2026-07-17T09:00:00.000Z');
    expect(summary.endedAt).toBe('2026-07-17T09:04:00.000Z');
    expect(summary.filesTouched).toEqual([
      '/Users/dev/git/blog/layouts/index.rss.xml',
      '/Users/dev/git/blog/config.toml',
    ]);
    expect(summary.skills).toEqual(['baoyu-format-markdown']);
  });

  it("prefers the CLI's own ai-title when present, ignores empty ones", () => {
    const withTitle =
      claudeTranscript() + '\n' + lines({ type: 'ai-title', aiTitle: 'RSS 全文输出' });
    expect(parseClaudeTranscript(withTitle).title).toBe('RSS 全文输出');
    const emptyTitle = claudeTranscript() + '\n' + lines({ type: 'ai-title', aiTitle: null });
    expect(parseClaudeTranscript(emptyTitle).title).toBe('给博客加一个 RSS 输出，全文带图片。');
  });

  it('survives half-written tail lines from live sessions', () => {
    const summary = parseClaudeTranscript(claudeTranscript() + '\n{"type":"assis');
    expect(summary.turnCount).toBe(2);
  });
});

describe('parseCodexRollout (ADR-0038)', () => {
  const rollout = lines(
    {
      timestamp: '2026-06-30T00:59:47.107Z',
      type: 'session_meta',
      payload: {
        id: CODEX_ID,
        timestamp: '2026-06-30T00:59:15.777Z',
        cwd: '/Users/dev/git/vibeai',
      },
    },
    {
      timestamp: '2026-06-30T01:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'fix flaky e2e on CI' },
    },
    {
      timestamp: '2026-06-30T01:05:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        success: true,
        changes: { '/Users/dev/git/vibeai/tests/e2e.spec.ts': { type: 'update' } },
      },
    },
    {
      timestamp: '2026-06-30T01:06:00.000Z',
      type: 'event_msg',
      payload: { type: 'patch_apply_end', success: false, changes: { '/tmp/failed.ts': {} } },
    },
  );

  it('reads id/cwd from session_meta and files from successful patches', () => {
    const summary = parseCodexRollout(rollout);
    expect(summary.sessionId).toBe(CODEX_ID);
    expect(summary.cwd).toBe('/Users/dev/git/vibeai');
    expect(summary.title).toBe('fix flaky e2e on CI');
    expect(summary.turnCount).toBe(1);
    expect(summary.startedAt).toBe('2026-06-30T00:59:15.777Z');
    expect(summary.filesTouched).toEqual(['/Users/dev/git/vibeai/tests/e2e.spec.ts']);
  });
});

describe('attributeProject (ADR-0038: files beat cwd guessing)', () => {
  const projects = [
    '/Users/dev/git/blog',
    '/Users/dev/git/blog/vendor/theme',
    '/Users/dev/git/app',
  ];

  it('attributes by cwd, preferring the innermost project', () => {
    expect(attributeProject('/Users/dev/git/blog/content', [], projects)).toEqual({
      projectPath: '/Users/dev/git/blog',
      attribution: 'cwd',
    });
    expect(attributeProject('/Users/dev/git/blog/vendor/theme/css', [], projects)).toEqual({
      projectPath: '/Users/dev/git/blog/vendor/theme',
      attribution: 'cwd',
    });
  });

  it('falls back to the project owning the most touched files (home-dir launch)', () => {
    const files = [
      '/Users/dev/git/app/a.ts',
      '/Users/dev/git/app/b.ts',
      '/Users/dev/git/blog/c.md',
    ];
    expect(attributeProject('/Users/dev', files, projects)).toEqual({
      projectPath: '/Users/dev/git/app',
      attribution: 'files',
    });
  });

  it('stays honest when nothing matches', () => {
    expect(attributeProject('/opt/somewhere', ['/opt/x.ts'], projects)).toEqual({
      projectPath: null,
      attribution: 'none',
    });
  });
});

describe('SessionArchaeologyService.scan (read-only fs discovery)', () => {
  async function fakeHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'arch-'));
    const claudeDir = join(home, '.claude', 'projects', '-Users-dev-git-blog');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, `${CLAUDE_ID}.jsonl`), claudeTranscript());
    // Non-uuid transcript names and empty conversations never surface.
    await writeFile(join(claudeDir, 'agenda.jsonl'), claudeTranscript());
    await writeFile(
      join(claudeDir, '11111111-2222-4333-8444-555555555555.jsonl'),
      lines({ type: 'user', cwd: '/x', message: { content: [{ type: 'tool_result' }] } }),
    );
    const day = new Date();
    const codexDir = join(
      home,
      '.codex',
      'sessions',
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'),
      String(day.getDate()).padStart(2, '0'),
    );
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, `rollout-2026-06-30T08-59-15-${CODEX_ID}.jsonl`),
      lines(
        {
          timestamp: '2026-06-30T00:59:47.107Z',
          type: 'session_meta',
          payload: {
            id: CODEX_ID,
            timestamp: '2026-06-30T00:59:15.777Z',
            cwd: '/Users/dev/git/vibeai',
          },
        },
        {
          timestamp: '2026-06-30T01:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'fix flaky e2e on CI' },
        },
      ),
    );
    // A rollout outside the scan window must not be walked.
    const oldDir = join(home, '.codex', 'sessions', '2020', '01', '01');
    await mkdir(oldDir, { recursive: true });
    await writeFile(
      join(oldDir, `rollout-2020-01-01T00-00-00-${CODEX_ID.replace('9', '8')}.jsonl`),
      'not even json',
    );
    return home;
  }

  it('lists both stores, attributes, relativizes, dedupes tracked sessions', async () => {
    const home = await fakeHome();
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      homeDir: home,
      knownSessions: () => new Map([[CODEX_ID, 'task_42']]),
      projects: () => ['/Users/dev/git/blog'],
    });
    const sessions = await service.scan();
    expect(sessions).toHaveLength(2);
    const claude = sessions.find((s) => s.cli === 'claude')!;
    expect(claude).toMatchObject({
      sessionId: CLAUDE_ID,
      cwd: '/Users/dev/git/blog',
      projectPath: '/Users/dev/git/blog',
      attribution: 'cwd',
      title: '给博客加一个 RSS 输出，全文带图片。',
      turnCount: 2,
      trackedTaskId: null,
    });
    expect(claude.filesTouched).toEqual(['layouts/index.rss.xml', 'config.toml']);
    const codex = sessions.find((s) => s.cli === 'codex')!;
    expect(codex).toMatchObject({
      sessionId: CODEX_ID,
      projectPath: null,
      attribution: 'none',
      trackedTaskId: 'task_42',
    });
    // lookup serves adoption and the terminal context resolver.
    await expect(service.lookup('claude', CLAUDE_ID.toUpperCase())).resolves.toMatchObject({
      cwd: '/Users/dev/git/blog',
    });
    await expect(service.lookup('codex', CLAUDE_ID)).resolves.toBeNull();
  });

  it('returns nothing when disabled (E2E without a fake home)', async () => {
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      homeDir: await fakeHome(),
      enabled: false,
      knownSessions: () => new Map(),
      projects: () => [],
    });
    await expect(service.scan()).resolves.toEqual([]);
  });
});
