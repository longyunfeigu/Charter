import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attributeProject,
  parseClaudeTranscript,
  parseCodexRollout,
  parseKimiSession,
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
const KIMI_ID = 'session_b04b292c-b7b4-456a-893c-3a22675771f9';

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
    // The `/clear` built-in lands as a raw event here; the catalog join in
    // skill-usage is what drops non-skill command names.
    expect(summary.skillEvents).toEqual([
      { skill: 'clear', at: '2026-07-17T09:00:01.000Z' },
      { skill: 'baoyu-format-markdown', at: '2026-07-17T09:01:00.000Z' },
    ]);
  });

  it('counts `/skill` slash expansions as invocations (the Skill tool never fires)', () => {
    const extended =
      claudeTranscript() +
      '\n' +
      lines(
        // Real slash expansion: content is exactly the command wrapper tags.
        {
          type: 'user',
          timestamp: '2026-07-17T09:05:00.000Z',
          message: {
            content:
              '<command-message>web-access</command-message>\n' +
              '<command-name>/web-access</command-name>\n' +
              '<command-args>打开 example.com</command-args>',
          },
        },
        // Pasted text that merely mentions the tag mid-content never counts.
        {
          type: 'user',
          timestamp: '2026-07-17T09:06:00.000Z',
          message: { content: '帮我看下 <command-name>/web-access</command-name> 是什么意思' },
        },
        // Sidechain expansions stay out, like every other sidechain entry.
        {
          type: 'user',
          isSidechain: true,
          timestamp: '2026-07-17T09:07:00.000Z',
          message: { content: '<command-name>/web-access</command-name>' },
        },
      );
    const summary = parseClaudeTranscript(extended);
    expect(summary.skillEvents).toEqual([
      { skill: 'clear', at: '2026-07-17T09:00:01.000Z' },
      { skill: 'baoyu-format-markdown', at: '2026-07-17T09:01:00.000Z' },
      { skill: 'web-access', at: '2026-07-17T09:05:00.000Z' },
    ]);
    // Chips stay Skill-tool-only; the expansion is a usage event, not a load.
    expect(summary.skills).toEqual(['baoyu-format-markdown']);
  });

  it('skill events skip sidechains and unstamped lines (ADR-0040)', () => {
    const extended =
      claudeTranscript() +
      '\n' +
      lines(
        // Subagent Skill loads never count toward usage.
        {
          type: 'assistant',
          isSidechain: true,
          timestamp: '2026-07-17T09:05:00.000Z',
          message: {
            content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'from-sidechain' } }],
          },
        },
        // A line without a timestamp still lists the skill, but no event.
        {
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'unstamped' } }],
          },
        },
      );
    const summary = parseClaudeTranscript(extended);
    expect(summary.skills).toEqual(['baoyu-format-markdown', 'unstamped']);
    expect(summary.skillEvents).toEqual([
      { skill: 'clear', at: '2026-07-17T09:00:01.000Z' },
      { skill: 'baoyu-format-markdown', at: '2026-07-17T09:01:00.000Z' },
    ]);
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

  it('counts real SKILL.md reads once per turn and ignores path searches', () => {
    const skillRollout =
      rollout +
      '\n' +
      lines(
        {
          timestamp: '2026-06-30T01:07:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: "sed -n '1,260p' /Users/dev/.agents/skills/web-access/SKILL.md",
            }),
          },
        },
        // A segmented second read in the same turn is still one invocation.
        {
          timestamp: '2026-06-30T01:08:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: "sed -n '261,520p' /Users/dev/.agents/skills/web-access/SKILL.md",
            }),
          },
        },
        // Searching for manuals is discovery, not skill activation.
        {
          timestamp: '2026-06-30T01:09:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: "rg -n 'SKILL.md' /Users/dev/.agents/skills" }),
          },
        },
        {
          timestamp: '2026-06-30T01:10:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'now compare the source documents' },
        },
        // Free-form wrapper calls can read more than one selected skill.
        {
          timestamp: '2026-06-30T01:11:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'functions.exec',
            arguments:
              'const r = await tools.exec_command({cmd: "cat /Users/dev/.agents/skills/web-access/SKILL.md /Users/dev/.codex/skills/pdf/SKILL.md"});',
          },
        },
      );

    const summary = parseCodexRollout(skillRollout);
    expect(summary.turnCount).toBe(2);
    expect(summary.skills).toEqual(['web-access', 'web-access', 'web-access', 'pdf']);
    expect(summary.skillEvents).toEqual([
      { skill: 'web-access', at: '2026-06-30T01:07:00.000Z' },
      { skill: 'web-access', at: '2026-06-30T01:11:00.000Z' },
      { skill: 'pdf', at: '2026-06-30T01:11:00.000Z' },
    ]);
  });
});

describe('parseKimiSession', () => {
  it('uses state identity and reduces user turns, file writes, and skills from the wire', () => {
    const summary = parseKimiSession(
      lines(
        {
          type: 'turn.prompt',
          input: [{ type: 'text', text: '实现登录页' }],
          origin: { kind: 'user' },
          time: Date.parse('2026-08-03T04:09:00.000Z'),
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'tool.call', name: 'Write', args: { path: 'src/login.tsx' } },
          time: Date.parse('2026-08-03T04:09:20.000Z'),
        },
        {
          type: 'context.append_loop_event',
          event: { type: 'tool.call', name: 'Skill', args: { skill: 'frontend-design' } },
          time: Date.parse('2026-08-03T04:09:21.000Z'),
        },
      ),
      JSON.stringify({
        workDir: '/Users/dev/git/app',
        title: '实现登录页',
        createdAt: '2026-08-03T04:08:53.976Z',
        updatedAt: '2026-08-03T04:09:34.218Z',
      }),
      KIMI_ID,
    );

    expect(summary).toMatchObject({
      sessionId: KIMI_ID,
      cwd: '/Users/dev/git/app',
      title: '实现登录页',
      turnCount: 1,
      filesTouched: ['/Users/dev/git/app/src/login.tsx'],
      skills: ['frontend-design'],
    });
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
        {
          timestamp: '2026-06-30T01:01:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({
              cmd: "sed -n '1,260p' /Users/dev/.agents/skills/web-access/SKILL.md",
            }),
          },
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
    await expect(service.skillUsageEvents()).resolves.toEqual([]);
  });

  it('does not resurrect an external transcript deleted from Charter', async () => {
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      homeDir: await fakeHome(),
      knownSessions: () => new Map(),
      ignoredSessions: () => new Set([`claude:${CLAUDE_ID}`]),
      projects: () => ['/Users/dev/git/blog'],
    });
    const sessions = await service.scan();
    expect(sessions.map((session) => `${session.cli}:${session.sessionId}`)).not.toContain(
      `claude:${CLAUDE_ID}`,
    );
    expect(sessions.map((session) => `${session.cli}:${session.sessionId}`)).toContain(
      `codex:${CODEX_ID}`,
    );
    await expect(service.skillUsageEvents()).resolves.toEqual([
      { skill: 'web-access', at: '2026-06-30T01:01:00.000Z', consumer: 'codex' },
    ]);
  });

  it('skillUsageEvents walks both CLI stores and tags each consumer (ADR-0040)', async () => {
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      homeDir: await fakeHome(),
      knownSessions: () => new Map(),
      projects: () => [],
    });
    // The non-uuid agenda.jsonl is not a session transcript and is skipped.
    await expect(service.skillUsageEvents()).resolves.toEqual([
      { skill: 'clear', at: '2026-07-17T09:00:01.000Z', consumer: 'claude' },
      { skill: 'baoyu-format-markdown', at: '2026-07-17T09:01:00.000Z', consumer: 'claude' },
      { skill: 'web-access', at: '2026-06-30T01:01:00.000Z', consumer: 'codex' },
    ]);
  });

  it('shares transcript parsing between concurrent archive and usage scans', async () => {
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      homeDir: await fakeHome(),
      knownSessions: () => new Map(),
      projects: () => [],
    });
    const internals = service as unknown as {
      summarizeOnce(candidate: unknown): Promise<unknown>;
    };
    const summarizeOnce = internals.summarizeOnce.bind(service);
    let parseCount = 0;
    internals.summarizeOnce = async (candidate) => {
      parseCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return summarizeOnce(candidate);
    };

    await Promise.all([service.scan(), service.skillUsageEvents()]);

    // fakeHome contains two UUID-named Claude files (one reduces to no human
    // turns) and one in-window Codex transcript. Each is parsed once even
    // though both consumers request it at the same time.
    expect(parseCount).toBe(3);
  });

  it('discovers a manifest-selected Kimi history store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'arch-kimi-'));
    const dataHome = join(home, '.kimi-code');
    const sessionDir = join(dataHome, 'sessions', 'wd_app', KIMI_ID);
    const wireDir = join(sessionDir, 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    await writeFile(
      join(dataHome, 'session_index.jsonl'),
      lines({ sessionId: KIMI_ID, sessionDir, workDir: '/Users/dev/git/app' }),
    );
    await writeFile(
      join(sessionDir, 'state.json'),
      JSON.stringify({
        workDir: '/Users/dev/git/app',
        title: 'Kimi login work',
        createdAt: '2026-08-03T04:08:53.976Z',
        updatedAt: '2026-08-03T04:09:34.218Z',
      }),
    );
    await writeFile(
      join(wireDir, 'wire.jsonl'),
      lines({
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'build login' }],
        origin: { kind: 'user' },
        time: Date.parse('2026-08-03T04:09:00.000Z'),
      }),
    );
    const service = new SessionArchaeologyService({
      logger: silentLogger,
      agentSources: [{ id: 'kimi', connector: 'kimi', dataHome }],
      knownSessions: () => new Map(),
      projects: () => ['/Users/dev/git/app'],
    });

    await expect(service.scan()).resolves.toEqual([
      expect.objectContaining({
        cli: 'kimi',
        sessionId: KIMI_ID,
        title: 'Kimi login work',
        projectPath: '/Users/dev/git/app',
        turnCount: 1,
      }),
    ]);
  });
});
