import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ProductFailure } from '@pi-ide/foundation';
import { openDatabase, MIGRATIONS, type SqlDatabase } from '@pi-ide/persistence';
import { WorkItemService } from './work-item-service.js';
import {
  extractTaskList,
  GithubIssueService,
  ownerRepoFromRemoteUrl,
  parseGithubIssueUrl,
  type GithubTokenVault,
} from './github-issue-service.js';

let root: string;
let db: SqlDatabase;
let workItems: WorkItemService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'charter-github-import-'));
  db = openDatabase({
    file: join(root, 'state.db'),
    backupDir: join(root, 'backups'),
    migrations: MIGRATIONS,
  }).db;
  workItems = new WorkItemService(db, createLogger('test', { write: () => undefined }), {
    now: () => new Date('2026-08-09T09:00:00.000Z'),
  });
});

afterEach(() => {
  workItems.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function fakeVault(initialToken: string | null = null): GithubTokenVault {
  let token = initialToken;
  let login: string | null = initialToken ? 'stored-user' : null;
  return {
    has: () => token !== null,
    get: () => token,
    set: (value, user) => {
      token = value;
      login = user;
    },
    clear: () => {
      const existed = token !== null;
      token = null;
      login = null;
      return existed;
    },
    login: () => login,
  };
}

interface SeenRequest {
  url: string;
  auth: string | null;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ISSUE = {
  number: 128,
  title: 'Mission state does not update after closing all Sessions',
  body: [
    'When I close every Session the Mission stays Running.',
    '',
    '- [ ] Mission leaves Running when its final Session closes',
    '- [x] Completed work remains Completed',
  ].join('\n'),
  state: 'open',
  html_url: 'https://github.com/edy/charter/issues/128',
  comments: 2,
  created_at: '2026-08-09T05:18:00Z',
  user: { login: 'edy' },
  labels: [{ name: 'bug' }, { name: 'missions' }],
};

const COMMENTS = [
  {
    body: 'Also happens from the terminal toolbar.',
    created_at: '2026-08-09T06:00:00Z',
    user: { login: 'edy' },
  },
  {
    body: 'Likely a missing aggregate refresh.',
    created_at: '2026-08-09T06:10:00Z',
    user: { login: 'claude' },
  },
];

function makeService(options: {
  vault?: GithubTokenVault;
  responses?: Record<string, Response | (() => Response)>;
  seen?: SeenRequest[];
  ghToken?: string | null;
  ghTokenResolver?: () => Promise<string | null>;
  projects?: Array<{ path: string; displayName: string }>;
  remotes?: Record<string, string | null>;
}): GithubIssueService {
  const responses = options.responses ?? {
    '/repos/edy/charter/issues/128': jsonResponse(ISSUE),
    '/repos/edy/charter/issues/128/comments?per_page=100&page=1': jsonResponse(COMMENTS),
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    options.seen?.push({ url, auth: headers.Authorization ?? null });
    const path = url.replace('https://api.test', '');
    const found = responses[path];
    if (!found) return jsonResponse({ message: 'Not Found' }, 404);
    return typeof found === 'function' ? found() : found.clone();
  };
  return new GithubIssueService(
    db,
    workItems,
    options.vault ?? fakeVault(),
    () => options.projects ?? [],
    createLogger('test', { write: () => undefined }),
    {
      apiBase: 'https://api.test',
      fetchImpl,
      ghCliToken: options.ghTokenResolver ?? (async () => options.ghToken ?? null),
      remoteUrlFor: async (path) => options.remotes?.[path] ?? null,
      now: () => new Date('2026-08-09T09:00:00.000Z'),
    },
  );
}

describe('parseGithubIssueUrl', () => {
  it('accepts canonical, schemeless, Markdown-wrapped, suffixed, and shorthand forms', () => {
    expect(parseGithubIssueUrl('https://github.com/edy/charter/issues/128')).toEqual({
      owner: 'edy',
      repo: 'charter',
      number: 128,
    });
    expect(parseGithubIssueUrl('github.com/edy/charter/issues/128?tab=x#issuecomment-1')).toEqual({
      owner: 'edy',
      repo: 'charter',
      number: 128,
    });
    expect(parseGithubIssueUrl('edy/charter#7')).toEqual({
      owner: 'edy',
      repo: 'charter',
      number: 7,
    });
    expect(parseGithubIssueUrl('[Fix this](https://github.com/edy/charter/issues/8)')).toEqual({
      owner: 'edy',
      repo: 'charter',
      number: 8,
    });
    expect(parseGithubIssueUrl('<https://github.com/edy/charter/issues/9>')).toEqual({
      owner: 'edy',
      repo: 'charter',
      number: 9,
    });
  });

  it('rejects pull requests and non-issue URLs with dedicated codes', () => {
    expect(() => parseGithubIssueUrl('https://github.com/edy/charter/pull/9')).toThrowError(
      ProductFailure,
    );
    try {
      parseGithubIssueUrl('https://github.com/edy/charter/pull/9');
    } catch (e) {
      expect((e as ProductFailure).error.code).toBe('GITHUB_URL_IS_PR');
    }
    try {
      parseGithubIssueUrl('https://example.com/whatever');
    } catch (e) {
      expect((e as ProductFailure).error.code).toBe('GITHUB_URL_INVALID');
    }
    expect(() => parseGithubIssueUrl('edy/charter#0')).toThrowError(ProductFailure);
  });
});

describe('ownerRepoFromRemoteUrl', () => {
  it('normalizes ssh, git@, and https remotes to lowercase owner/repo', () => {
    expect(ownerRepoFromRemoteUrl('git@github.com:Edy/Charter.git')).toBe('edy/charter');
    expect(ownerRepoFromRemoteUrl('https://github.com/edy/charter')).toBe('edy/charter');
    expect(ownerRepoFromRemoteUrl('ssh://git@github.com/edy/charter.git')).toBe('edy/charter');
    expect(ownerRepoFromRemoteUrl('https://gitlab.com/edy/charter')).toBeNull();
  });
});

describe('extractTaskList', () => {
  it('turns markdown task lists into acceptance entries', () => {
    const items = extractTaskList('intro\n- [ ] first\n* [x] second\n- not a task');
    expect(items.map((i) => [i.text, i.checked])).toEqual([
      ['first', false],
      ['second', true],
    ]);
  });
});

describe('GithubIssueService.resolveIssue', () => {
  it('returns a complete preview without creating work, then reuses it on confirmation', async () => {
    const seen: SeenRequest[] = [];
    const service = makeService({
      seen,
      projects: [{ path: '/tmp/charter', displayName: 'Charter' }],
      remotes: { '/tmp/charter': 'git@github.com:edy/charter.git' },
    });

    const resolved = await service.resolveIssue(
      '[Issue](https://github.com/edy/charter/issues/128)',
    );
    expect(resolved.duplicateItemId).toBeNull();
    expect(resolved.preview).toMatchObject({
      ref: 'edy/charter#128',
      title: ISSUE.title,
      commentCount: 2,
      recentCommentCount: 2,
      localProject: { path: '/tmp/charter', displayName: 'Charter' },
    });
    expect(resolved.preview!.acceptance).toHaveLength(2);
    expect(workItems.snapshot().items).toHaveLength(0);

    const imported = await service.importIssue('edy/charter#128', '/tmp/charter');
    expect(imported.item).not.toBeNull();
    expect(workItems.snapshot().items).toHaveLength(1);
    expect(seen.filter((request) => request.url.endsWith('/issues/128'))).toHaveLength(1);
  });

  it('surfaces an existing item before making another GitHub request', async () => {
    const service = makeService({});
    const imported = await service.importIssue('edy/charter#128');
    const seen: SeenRequest[] = [];
    const resolved = await makeService({ seen }).resolveIssue('edy/charter#128');
    expect(resolved).toEqual({ preview: null, duplicateItemId: imported.item!.id });
    expect(seen).toHaveLength(0);
  });
});

describe('GithubIssueService.importIssue', () => {
  it('creates a work item carrying issue body, labels, tasks, discussion, and mapping', async () => {
    const service = makeService({
      projects: [{ path: '/tmp/charter', displayName: 'Charter' }],
      remotes: { '/tmp/charter': 'git@github.com:edy/charter.git' },
    });
    const result = await service.importIssue('https://github.com/edy/charter/issues/128');
    expect(result.duplicateItemId).toBeNull();
    const item = result.item!;
    expect(item.title).toBe(ISSUE.title);
    expect(item.descriptionMd).toContain('Mission stays Running');
    expect(item.sourcePerson).toBe('edy');
    expect(item.sourceChannel).toBe('GitHub');
    expect(item.sourceUrl).toBe(ISSUE.html_url);
    expect(item.labels).toEqual(['bug', 'missions']);
    expect(item.typeId).toBe('work-type-engineering');
    expect(item.customFields.repository).toBe('edy/charter');
    expect(item.customFields.githubState).toBe('open');
    expect(item.customFields.githubAuthor).toBe('edy');
    expect(item.customFields.githubCommentCount).toBe(2);
    expect(item.customFields.githubLocalPath).toBe('/tmp/charter');
    expect(item.customFields.githubLocalProject).toBe('Charter');
    const discussion = JSON.parse(String(item.customFields.githubComments)) as Array<{
      login: string;
      body: string;
    }>;
    expect(discussion).toHaveLength(2);
    expect(discussion[1]).toMatchObject({ login: 'claude' });
    expect(item.acceptance.map((a) => a.checked)).toEqual([false, true]);
    expect(item.backgroundMd).toContain('edy/charter#128');
    expect(item.backgroundMd).toContain('Local repository: /tmp/charter');
    expect(item.backgroundMd).toContain('Likely a missing aggregate refresh.');
    const detail = workItems.detail(item.id);
    expect(detail.evidence.some((e) => e.kind === 'link' && e.value === ISSUE.html_url)).toBe(true);
  });

  it('is idempotent: the second import surfaces the existing card', async () => {
    const service = makeService({});
    const first = await service.importIssue('https://github.com/edy/charter/issues/128');
    const second = await service.importIssue('edy/charter#128');
    expect(second.item).toBeNull();
    expect(second.duplicateItemId).toBe(first.item!.id);
  });

  it('releases the ref of an archived card so re-import restores visibility', async () => {
    const service = makeService({});
    const first = await service.importIssue('https://github.com/edy/charter/issues/128');
    workItems.archive(first.item!.id, true, first.item!.version);
    const second = await service.importIssue('https://github.com/edy/charter/issues/128');
    expect(second.item).not.toBeNull();
    expect(second.item!.id).not.toBe(first.item!.id);
  });

  it('prefers the stored PAT and falls back to the gh CLI token', async () => {
    const seenWithPat: SeenRequest[] = [];
    await makeService({
      vault: fakeVault('pat-token'),
      ghToken: 'gh-token',
      seen: seenWithPat,
    }).importIssue('edy/charter#128');
    expect(seenWithPat[0]!.auth).toBe('Bearer pat-token');

    // A different issue key: the first sub-case already imported #128 and the
    // duplicate short-circuit would return before any request is made.
    const seenWithGh: SeenRequest[] = [];
    await makeService({
      ghToken: 'gh-token',
      seen: seenWithGh,
      responses: {
        '/repos/edy/charter/issues/129': jsonResponse({ ...ISSUE, number: 129, comments: 0 }),
      },
    }).importIssue('edy/charter#129');
    expect(seenWithGh[0]!.auth).toBe('Bearer gh-token');
  });

  it('maps 404 without a token to a settings hint', async () => {
    const service = makeService({ responses: {} });
    await expect(service.importIssue('edy/private/#1'.replace('/#', '#'))).rejects.toMatchObject({
      error: { code: 'GITHUB_ISSUE_NOT_FOUND' },
    });
    try {
      await service.importIssue('edy/private#1');
    } catch (e) {
      expect((e as ProductFailure).error.userMessage).toContain('Settings → GitHub');
    }
  });

  it('maps an exhausted rate limit to a reset-time message', async () => {
    const reset = Math.floor(new Date('2026-08-09T09:20:00.000Z').getTime() / 1000);
    const service = makeService({
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse({ message: 'rate limited' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset),
        }),
      },
    });
    try {
      await service.importIssue('edy/charter#128');
      expect.unreachable();
    } catch (e) {
      expect((e as ProductFailure).error.code).toBe('GITHUB_RATE_LIMITED');
      expect((e as ProductFailure).error.userMessage).toContain('20 minute');
    }
  });

  it('rejects issues that are actually pull requests', async () => {
    const service = makeService({
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse({ ...ISSUE, pull_request: { url: 'x' } }),
      },
    });
    await expect(service.importIssue('edy/charter#128')).rejects.toMatchObject({
      error: { code: 'GITHUB_URL_IS_PR' },
    });
  });

  it('degrades gracefully when the comment fetch fails', async () => {
    const service = makeService({
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse(ISSUE),
        // comments endpoint intentionally missing → 404
      },
    });
    const result = await service.importIssue('edy/charter#128');
    expect(result.item).not.toBeNull();
    expect(result.item!.backgroundMd).not.toContain('Recent discussion');
  });

  it('honors choosing the repository later and rejects a stale Project choice', async () => {
    const service = makeService({
      projects: [{ path: '/tmp/charter', displayName: 'Charter' }],
      remotes: { '/tmp/charter': 'git@github.com:edy/charter.git' },
    });
    await service.resolveIssue('edy/charter#128');
    const imported = await service.importIssue('edy/charter#128', null);
    expect(imported.item!.customFields.githubLocalPath).toBeUndefined();

    const next = makeService({
      responses: {
        '/repos/edy/charter/issues/129': jsonResponse({ ...ISSUE, number: 129, comments: 0 }),
      },
    });
    await expect(next.importIssue('edy/charter#129', '/gone/project')).rejects.toMatchObject({
      error: { code: 'GITHUB_PROJECT_INVALID' },
    });
    expect(workItems.snapshot().items).toHaveLength(1);
  });

  it('loads the complete discussion tail when the final page is partial', async () => {
    const comments = Array.from({ length: 105 }, (_, index) => ({
      body: `comment-${index + 1}`,
      created_at: `2026-08-09T06:${String(index % 60).padStart(2, '0')}:00Z`,
      user: { login: 'edy' },
    }));
    const service = makeService({
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse({ ...ISSUE, comments: 105 }),
        '/repos/edy/charter/issues/128/comments?per_page=100&page=2': jsonResponse(
          comments.slice(100),
        ),
        '/repos/edy/charter/issues/128/comments?per_page=100&page=1': jsonResponse(
          comments.slice(0, 100),
        ),
      },
    });
    const imported = await service.importIssue('edy/charter#128');
    const discussion = JSON.parse(String(imported.item!.customFields.githubComments)) as Array<{
      body: string;
    }>;
    expect(discussion.map((comment) => comment.body)).toEqual(
      comments.slice(-10).map((comment) => comment.body),
    );
  });

  it('allows only one card when two imports resolve concurrently', async () => {
    const service = makeService({});
    const results = await Promise.all([
      service.importIssue('https://github.com/edy/charter/issues/128'),
      service.importIssue('edy/charter#128'),
    ]);
    expect(results.filter((result) => result.item !== null)).toHaveLength(1);
    expect(results.filter((result) => result.duplicateItemId !== null)).toHaveLength(1);
    expect(workItems.snapshot().items).toHaveLength(1);
  });

  it('rejects a malformed API payload without creating a partial card', async () => {
    const service = makeService({
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse({ title: 'missing required fields' }),
      },
    });
    await expect(service.importIssue('edy/charter#128')).rejects.toMatchObject({
      error: { code: 'GITHUB_RESPONSE_INVALID' },
    });
    expect(workItems.snapshot().items).toHaveLength(0);
  });
});

describe('GithubIssueService.postIssueComment (ADR-0057)', () => {
  it('posts one comment, records the audit trail, and marks the item posted', async () => {
    const posted: Array<{ url: string; body: string }> = [];
    const service = makeService({
      vault: fakeVault('pat-token'),
      responses: {
        '/repos/edy/charter/issues/128': jsonResponse(ISSUE),
        '/repos/edy/charter/issues/128/comments?per_page=100&page=1': jsonResponse(COMMENTS),
      },
    });
    const imported = await service.importIssue('edy/charter#128');
    const itemId = imported.item!.id;

    const posting = new GithubIssueService(
      db,
      workItems,
      fakeVault('pat-token'),
      () => [],
      createLogger('test', { write: () => undefined }),
      {
        apiBase: 'https://api.test',
        fetchImpl: async (input, init) => {
          posted.push({ url: String(input), body: String(init?.body ?? '') });
          return jsonResponse(
            { html_url: 'https://github.com/edy/charter/issues/128#issuecomment-9' },
            201,
          );
        },
        ghCliToken: async () => null,
        now: () => new Date('2026-08-09T10:00:00.000Z'),
      },
    );
    const result = await posting.postIssueComment(itemId, 'All checks pass.');
    expect(result.url).toBe('https://github.com/edy/charter/issues/128#issuecomment-9');
    expect(posted[0]!.url).toBe('https://api.test/repos/edy/charter/issues/128/comments');
    expect(JSON.parse(posted[0]!.body)).toEqual({ body: 'All checks pass.' });
    const detail = workItems.detail(itemId);
    expect(detail.item.customFields.githubPostedUrl).toBe(result.url);
    expect(detail.item.customFields.githubPostedBody).toBe('All checks pass.');
    expect(detail.evidence.some((entry) => entry.label.startsWith('Posted GitHub update'))).toBe(
      true,
    );
  });

  it('refuses without a credential and without an external link', async () => {
    const service = makeService({});
    const imported = await service.importIssue('edy/charter#128');
    await expect(
      makeService({ vault: fakeVault(null), ghToken: null }).postIssueComment(
        imported.item!.id,
        'x',
      ),
    ).rejects.toMatchObject({ error: { code: 'GITHUB_AUTH_REQUIRED' } });

    const plain = workItems.create({
      typeId: 'work-type-generic',
      title: 'Local-only item',
      descriptionMd: '',
      backgroundMd: '',
      sourcePerson: '',
      sourceChannel: '',
      sourceUrl: '',
      assignee: '',
      priority: 'none',
      labels: [],
      startAt: null,
      dueAt: null,
      reminderAt: null,
      acceptance: [],
      deliverables: [],
      customFields: {},
    });
    await expect(
      makeService({ vault: fakeVault('t') }).postIssueComment(plain.id, 'x'),
    ).rejects.toMatchObject({ error: { code: 'GITHUB_NOT_LINKED' } });
  });

  it('maps a declined write to a permission hint', async () => {
    const service = makeService({ vault: fakeVault('pat') });
    const imported = await service.importIssue('edy/charter#128');
    const denied = new GithubIssueService(
      db,
      workItems,
      fakeVault('pat'),
      () => [],
      createLogger('test', { write: () => undefined }),
      {
        apiBase: 'https://api.test',
        fetchImpl: async () => jsonResponse({ message: 'Forbidden' }, 403),
        ghCliToken: async () => null,
        now: () => new Date('2026-08-09T10:00:00.000Z'),
      },
    );
    await expect(denied.postIssueComment(imported.item!.id, 'x')).rejects.toMatchObject({
      error: { code: 'GITHUB_WRITE_FORBIDDEN' },
    });
  });
});

describe('GithubIssueService auth', () => {
  it('verifies and stores a valid token, reporting the login', async () => {
    const vault = fakeVault();
    const service = makeService({
      vault,
      responses: { '/user': jsonResponse({ login: 'edy' }) },
    });
    await expect(service.setToken('ghp_valid')).resolves.toEqual({ login: 'edy' });
    expect(vault.get()).toBe('ghp_valid');
    expect((await service.authStatus()).method).toBe('pat');
  });

  it('rejects an invalid token without storing it', async () => {
    const vault = fakeVault();
    const service = makeService({
      vault,
      responses: { '/user': jsonResponse({ message: 'Bad credentials' }, 401) },
    });
    await expect(service.setToken('ghp_bad')).rejects.toMatchObject({
      error: { code: 'GITHUB_TOKEN_INVALID' },
    });
    expect(vault.has()).toBe(false);
  });

  it('reports gh-cli when no PAT is stored but gh is logged in', async () => {
    const service = makeService({ ghToken: 'gh-token' });
    const status = await service.authStatus();
    expect(status).toMatchObject({ method: 'gh-cli', hasToken: false, ghCliAvailable: true });
  });

  it('does not let an old gh CLI probe overwrite a PAT saved while it was in flight', async () => {
    const vault = fakeVault();
    const probe = { finish: (_token: string | null): void => undefined };
    const service = makeService({
      vault,
      ghTokenResolver: () =>
        new Promise((resolve) => {
          probe.finish = resolve;
        }),
    });
    const pending = service.authStatus();
    await Promise.resolve();
    vault.set('pat-token', 'edy');
    probe.finish('gh-token');
    await expect(pending).resolves.toMatchObject({
      method: 'pat',
      hasToken: true,
      tokenLogin: 'edy',
    });
  });
});
