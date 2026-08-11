import { execFile } from 'node:child_process';
import { newId, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import { GitService } from '@pi-ide/git-service';
import type { SqlDatabase } from '@pi-ide/persistence';
import type {
  GithubAuthStatusDto,
  GithubIssueImportResult,
  GithubIssuePreviewDto,
  GithubIssueResolveResult,
  WorkChecklistItem,
} from '@pi-ide/ipc-contracts';
import type { WorkItemService } from './work-item-service.js';

/**
 * Read-only GitHub issue import (ADR-0056).
 *
 * One explicit user action pulls one issue into the Work board: fetch the
 * issue (and the tail of its discussion), map the repository to a known local
 * project via each project's `remote.origin.url`, and create a Work item that
 * flows through the existing card → handoff → Session path. Nothing is ever
 * written back to GitHub — the ADR-0022 external-write boundary is untouched.
 *
 * Credentials: a stored PAT wins; otherwise the logged-in `gh` CLI supplies a
 * token (zero-setup path). Public repositories work with no credential at all.
 */

const DEFAULT_API_BASE = 'https://api.github.com';
const COMMENT_PAGE_SIZE = 100;
const DISCUSSION_TAIL = 10;
const RESOLUTION_CACHE_MS = 5 * 60_000;
const RESOLUTION_CACHE_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 15_000;
const IMPORTED_TYPE_ID = 'work-type-engineering';

export interface GithubProjectCandidate {
  path: string;
  displayName: string;
}

/** Structural view of GithubVaultService (electron-free for unit coverage). */
export interface GithubTokenVault {
  has(): boolean;
  get(): string | null;
  set(token: string, login: string): void;
  clear(): boolean;
  login(): string | null;
}

interface GithubIssueServiceOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Test seam: resolve a token from the gh CLI (null = unavailable). */
  ghCliToken?: () => Promise<string | null>;
  /** Test seam: read a project's remote.origin.url. */
  remoteUrlFor?: (projectPath: string) => Promise<string | null>;
  apiBase?: string;
}

interface ParsedIssueUrl {
  owner: string;
  repo: string;
  number: number;
}

interface GithubUser {
  login: string;
}

interface GithubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  comments: number;
  created_at: string;
  user: GithubUser | null;
  labels: Array<{ name?: string } | string>;
  pull_request?: unknown;
}

interface GithubComment {
  body: string | null;
  created_at: string;
  user: GithubUser | null;
}

interface ResolvedIssue {
  ref: ParsedIssueUrl;
  refKey: string;
  issue: GithubIssue;
  comments: GithubComment[];
  project: GithubProjectCandidate | null;
}

function failure(code: string, userMessage: string): ProductFailure {
  return new ProductFailure(productError(code, { userMessage }));
}

/** `https://github.com/o/r/issues/1`, host without scheme, or `o/r#1`. */
export function parseGithubIssueUrl(raw: string): ParsedIssueUrl {
  let input = raw.trim();
  const markdownLink = input.match(/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/i);
  if (markdownLink) input = markdownLink[1]!;
  if (input.startsWith('<') && input.endsWith('>')) input = input.slice(1, -1).trim();
  const shorthand = input.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (shorthand) {
    return validRef(shorthand[1]!, shorthand[2]!, shorthand[3]!);
  }
  const url = input.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(issues|pull|pulls)\/(\d+)(?:[/?#].*)?$/i,
  );
  if (!url) {
    throw failure(
      'GITHUB_URL_INVALID',
      'That does not look like a GitHub issue URL. Expected https://github.com/owner/repo/issues/123.',
    );
  }
  if (url[3]!.toLowerCase() !== 'issues') {
    throw failure(
      'GITHUB_URL_IS_PR',
      'That URL points to a pull request. Import works with issues for now.',
    );
  }
  return validRef(url[1]!, url[2]!, url[4]!);
}

function validRef(owner: string, repo: string, numberText: string): ParsedIssueUrl {
  const number = Number(numberText);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw failure('GITHUB_URL_INVALID', 'A GitHub issue number must be a positive integer.');
  }
  return { owner, repo, number };
}

/** git@/ssh/https remote forms → lowercase `owner/repo`, or null. */
export function ownerRepoFromRemoteUrl(remoteUrl: string): string | null {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:git@|(?:ssh|https?):\/\/(?:[\w.-]+@)?)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i,
    );
  if (!match) return null;
  return `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
}

/** Markdown task-list entries become the card's acceptance checklist. */
export function extractTaskList(body: string): WorkChecklistItem[] {
  const items: WorkChecklistItem[] = [];
  for (const line of body.split('\n')) {
    const match = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/);
    if (!match) continue;
    const text = match[2]!.trim().slice(0, 1000);
    if (!text) continue;
    items.push({ id: newId('ghcheck'), text, checked: match[1] !== ' ' });
    if (items.length >= 100) break;
  }
  return items;
}

function defaultGhCliToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile('gh', ['auth', 'token'], { timeout: 4000 }, (error, stdout) => {
      const token = stdout?.toString().trim();
      resolve(!error && token ? token : null);
    });
    child.on('error', () => resolve(null));
  });
}

export class GithubIssueService {
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  private readonly ghCliToken: () => Promise<string | null>;
  private readonly remoteUrlFor: (projectPath: string) => Promise<string | null>;
  private readonly apiBase: string;
  private ghCliCache: { token: string | null; at: number } | null = null;
  private readonly resolutionCache = new Map<string, { at: number; value: ResolvedIssue }>();

  constructor(
    private readonly db: SqlDatabase,
    private readonly workItems: WorkItemService,
    private readonly vault: GithubTokenVault,
    private readonly listProjects: () => GithubProjectCandidate[],
    private readonly logger: Logger,
    options: GithubIssueServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ghCliToken = options.ghCliToken ?? defaultGhCliToken;
    this.remoteUrlFor =
      options.remoteUrlFor ?? ((projectPath) => new GitService(projectPath).remoteOriginUrl());
    this.apiBase = (
      options.apiBase ??
      process.env.CHARTER_GITHUB_API_URL ??
      DEFAULT_API_BASE
    ).replace(/\/$/, '');
  }

  async authStatus(): Promise<GithubAuthStatusDto> {
    if (this.vault.has()) {
      return {
        method: 'pat',
        hasToken: true,
        tokenLogin: this.vault.login(),
        ghCliAvailable: false,
      };
    }
    const cliToken = await this.cachedGhCliToken();
    // A token can be saved while the slower gh CLI probe is in flight. Read
    // the vault again so an old status request cannot overwrite the new PAT.
    if (this.vault.has()) {
      return {
        method: 'pat',
        hasToken: true,
        tokenLogin: this.vault.login(),
        ghCliAvailable: cliToken !== null,
      };
    }
    return {
      method: cliToken ? 'gh-cli' : 'none',
      hasToken: false,
      tokenLogin: null,
      ghCliAvailable: cliToken !== null,
    };
  }

  /** Verify against /user before storing, so Settings never keeps a dead token. */
  async setToken(token: string): Promise<{ login: string }> {
    const response = await this.request('/user', token);
    if (response.status === 401) {
      throw failure(
        'GITHUB_TOKEN_INVALID',
        'GitHub rejected that token. Check that it is not expired and has repo read access.',
      );
    }
    if (!response.ok) throw await this.httpFailure(response, null);
    const user = (await response.json()) as GithubUser;
    if (!user || typeof user.login !== 'string') {
      throw failure('GITHUB_TOKEN_INVALID', 'GitHub returned an unexpected /user response.');
    }
    this.vault.set(token, user.login);
    return { login: user.login };
  }

  clearToken(): boolean {
    return this.vault.clear();
  }

  /** Resolve and cache the source without creating local work. The renderer
   * uses this to show the exact issue and repository mapping for confirmation. */
  async resolveIssue(rawUrl: string): Promise<GithubIssueResolveResult> {
    const ref = parseGithubIssueUrl(rawUrl);
    const refKey = this.refKey(ref);
    const existing = this.findExisting(refKey);
    if (existing) return { preview: null, duplicateItemId: existing };

    const resolved = await this.resolveSource(ref);
    return { preview: this.toPreview(resolved), duplicateItemId: null };
  }

  async importIssue(rawUrl: string, projectPath?: string | null): Promise<GithubIssueImportResult> {
    const ref = parseGithubIssueUrl(rawUrl);
    const refKey = this.refKey(ref);
    const existingBeforeResolve = this.findExisting(refKey);
    if (existingBeforeResolve) return { item: null, duplicateItemId: existingBeforeResolve };

    const resolved = await this.resolveSource(ref);

    // Two dialogs can resolve the same source concurrently. Re-check after
    // the network awaits and before the synchronous transaction creates work.
    const existingAfterResolve = this.findExisting(refKey);
    if (existingAfterResolve) return { item: null, duplicateItemId: existingAfterResolve };

    const project = this.selectProject(projectPath, resolved.project);
    const { issue, comments } = resolved;

    const body = issue.body ?? '';
    const labels = this.issueLabels(issue);

    const item = this.db.transaction(() => {
      const created = this.workItems.create({
        typeId: IMPORTED_TYPE_ID,
        title: issue.title.trim().slice(0, 500) || `${ref.owner}/${ref.repo}#${ref.number}`,
        descriptionMd: body.slice(0, 50_000),
        backgroundMd: this.buildBackground(ref, issue, comments, project).slice(0, 100_000),
        sourcePerson: issue.user?.login ?? '',
        sourceChannel: 'GitHub',
        sourceUrl: issue.html_url,
        assignee: '',
        priority: 'none',
        labels,
        startAt: null,
        dueAt: null,
        reminderAt: null,
        acceptance: extractTaskList(body),
        deliverables: [],
        // Structured source facts for the For-you inbox detail (ADR-0056).
        // Keys outside the Engineering field definitions stay invisible on the
        // generic board detail; backgroundMd remains the flattened handoff copy.
        customFields: {
          repository: `${ref.owner}/${ref.repo}`,
          githubState: issue.state,
          githubAuthor: issue.user?.login ?? '',
          githubCreatedAt: issue.created_at,
          githubCommentCount: issue.comments,
          githubComments: JSON.stringify(
            comments.map((comment) => ({
              login: comment.user?.login ?? 'unknown',
              at: comment.created_at,
              body: (comment.body ?? '').trim().slice(0, 1500),
            })),
          ),
          ...(project
            ? {
                githubLocalPath: project.path,
                githubLocalProject: project.displayName,
                githubMappingSource: resolved.project?.path === project.path ? 'remote' : 'manual',
              }
            : {}),
        },
      });
      this.db
        .prepare(
          `INSERT INTO work_item_external_refs (work_item_id, source, ref_key, url, imported_at)
           VALUES (?, 'github', ?, ?, ?)`,
        )
        .run(created.id, refKey, issue.html_url, this.now().toISOString());
      this.workItems.addEvidence({
        workItemId: created.id,
        kind: 'link',
        label: `GitHub issue ${ref.owner}/${ref.repo}#${ref.number}`,
        value: issue.html_url,
        createdBy: 'Charter',
      });
      return created;
    });
    this.resolutionCache.delete(refKey);
    this.logger.info('github issue imported', { refKey, itemId: item.id });
    return { item, duplicateItemId: null };
  }

  private refKey(ref: ParsedIssueUrl): string {
    return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
  }

  private async resolveSource(ref: ParsedIssueUrl): Promise<ResolvedIssue> {
    const refKey = this.refKey(ref);
    const cached = this.resolutionCache.get(refKey);
    if (cached && this.now().getTime() - cached.at < RESOLUTION_CACHE_MS) return cached.value;
    if (cached) this.resolutionCache.delete(refKey);

    const token = await this.resolveToken();
    const issue = await this.fetchIssue(ref, token);
    // Repository matching is local I/O and can run while GitHub returns the
    // discussion tail. This removes avoidable wait from the preview.
    const [comments, project] = await Promise.all([
      this.fetchDiscussionTail(ref, issue, token),
      this.matchLocalProject(ref),
    ]);
    const value = { ref, refKey, issue, comments, project };
    this.resolutionCache.set(refKey, { at: this.now().getTime(), value });
    while (this.resolutionCache.size > RESOLUTION_CACHE_LIMIT) {
      const oldest = this.resolutionCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.resolutionCache.delete(oldest);
    }
    return value;
  }

  private toPreview(resolved: ResolvedIssue): GithubIssuePreviewDto {
    const { ref, issue, comments, project } = resolved;
    const body = issue.body ?? '';
    return {
      ref: `${ref.owner}/${ref.repo}#${ref.number}`,
      url: issue.html_url,
      title: issue.title.trim().slice(0, 500) || `${ref.owner}/${ref.repo}#${ref.number}`,
      body: body.slice(0, 50_000),
      state: issue.state.slice(0, 40),
      author: issue.user?.login ?? '',
      createdAt: issue.created_at,
      labels: this.issueLabels(issue),
      commentCount: issue.comments,
      recentCommentCount: comments.length,
      acceptance: extractTaskList(body),
      localProject: project,
    };
  }

  private issueLabels(issue: GithubIssue): string[] {
    return issue.labels
      .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .map((name) => name.slice(0, 100))
      .slice(0, 30);
  }

  private selectProject(
    projectPath: string | null | undefined,
    automatic: GithubProjectCandidate | null,
  ): GithubProjectCandidate | null {
    if (projectPath === undefined) return automatic;
    if (projectPath === null) return null;
    const selected = this.listProjects().find((project) => project.path === projectPath);
    if (!selected) {
      throw failure(
        'GITHUB_PROJECT_INVALID',
        'That local Project is no longer available. Choose another Project and try again.',
      );
    }
    return selected;
  }

  /**
   * ADR-0057: the one approval-gated external write. Called only from the
   * user's explicit "Post update" click after an exact-payload preview; posts
   * one comment to the imported issue and records the payload + resulting URL
   * in the work item's evidence/audit trail. Agent tools cannot reach this —
   * the tool-gateway R4 line is untouched.
   */
  async postIssueComment(workItemId: string, body: string): Promise<{ url: string }> {
    const ref = this.db
      .prepare(
        `SELECT ref_key AS refKey FROM work_item_external_refs
         WHERE work_item_id = ? AND source = 'github'`,
      )
      .get(workItemId) as { refKey: string } | undefined;
    if (!ref) {
      throw failure(
        'GITHUB_NOT_LINKED',
        'This work item is not linked to a GitHub issue, so there is nothing to post to.',
      );
    }
    const match = ref.refKey.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    if (!match) throw failure('GITHUB_NOT_LINKED', 'The stored GitHub reference is unreadable.');
    const token = await this.resolveToken();
    if (!token) {
      throw failure(
        'GITHUB_AUTH_REQUIRED',
        'Posting needs a GitHub credential. Add a token in Settings → GitHub or sign in to the gh CLI.',
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBase}/repos/${match[1]}/${match[2]}/issues/${match[3]}/comments`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Charter-Desktop',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ body }),
        },
      );
    } catch {
      throw failure(
        'GITHUB_NETWORK',
        'Could not reach GitHub. Check your network connection and try again.',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw failure(
        'GITHUB_WRITE_FORBIDDEN',
        'GitHub declined the write. The credential needs comment permission on this repository.',
      );
    }
    if (!response.ok) throw await this.httpFailure(response, token);
    const comment = (await response.json()) as { html_url?: string };
    const url = typeof comment.html_url === 'string' ? comment.html_url : '';
    const at = this.now().toISOString();
    // Audit: the exact payload and where it landed, on the item itself.
    this.workItems.addEvidence({
      workItemId,
      kind: 'link',
      label: `Posted GitHub update (${ref.refKey})`,
      value: url || `posted at ${at}`,
      createdBy: 'You',
    });
    const item = this.workItems.detail(workItemId).item;
    this.workItems.update({
      id: workItemId,
      expectedVersion: item.version,
      customFields: {
        ...item.customFields,
        githubPostedAt: at,
        githubPostedUrl: url,
        githubPostedBody: body.slice(0, 20_000),
      },
    });
    this.logger.info('github comment posted', { refKey: ref.refKey, workItemId });
    return { url };
  }

  /** Existing live card for this issue; a stale ref to an archived card is
   * released so re-import brings the issue back to the visible board. */
  private findExisting(refKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT r.work_item_id AS id, i.archived AS archived
         FROM work_item_external_refs r JOIN work_items i ON i.id = r.work_item_id
         WHERE r.source = 'github' AND r.ref_key = ?`,
      )
      .get(refKey) as { id: string; archived: number } | undefined;
    if (!row) return null;
    if (row.archived === 1) {
      this.db
        .prepare(`DELETE FROM work_item_external_refs WHERE source = 'github' AND ref_key = ?`)
        .run(refKey);
      return null;
    }
    return row.id;
  }

  private async resolveToken(): Promise<string | null> {
    return this.vault.get() ?? (await this.cachedGhCliToken());
  }

  private async cachedGhCliToken(): Promise<string | null> {
    const at = this.now().getTime();
    if (this.ghCliCache && at - this.ghCliCache.at < 60_000) return this.ghCliCache.token;
    const token = await this.ghCliToken();
    this.ghCliCache = { token, at };
    return token;
  }

  private async request(path: string, token: string | null): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Charter-Desktop',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw failure(
          'GITHUB_TIMEOUT',
          'GitHub took too long to respond. Check your connection and try again.',
        );
      }
      throw failure(
        'GITHUB_NETWORK',
        'Could not reach GitHub. Check your network connection and try again.',
      );
    }
  }

  private async fetchIssue(ref: ParsedIssueUrl, token: string | null): Promise<GithubIssue> {
    const response = await this.request(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}`,
      token,
    );
    if (!response.ok) throw await this.httpFailure(response, token);
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object') {
      throw failure('GITHUB_RESPONSE_INVALID', 'GitHub returned an unreadable issue response.');
    }
    const raw = value as Record<string, unknown>;
    if (raw.pull_request !== undefined) {
      throw failure(
        'GITHUB_URL_IS_PR',
        'That URL points to a pull request. Import works with issues for now.',
      );
    }
    if (
      typeof raw.title !== 'string' ||
      (typeof raw.body !== 'string' && raw.body !== null) ||
      typeof raw.state !== 'string' ||
      typeof raw.html_url !== 'string' ||
      typeof raw.comments !== 'number' ||
      !Number.isSafeInteger(raw.comments) ||
      raw.comments < 0 ||
      typeof raw.created_at !== 'string' ||
      !Array.isArray(raw.labels)
    ) {
      throw failure('GITHUB_RESPONSE_INVALID', 'GitHub returned an unreadable issue response.');
    }
    const user = raw.user;
    const normalizedUser =
      user &&
      typeof user === 'object' &&
      typeof (user as Record<string, unknown>).login === 'string'
        ? { login: String((user as Record<string, unknown>).login).slice(0, 100) }
        : null;
    const labels: GithubIssue['labels'] = raw.labels
      .map((label) => {
        if (typeof label === 'string') return label;
        if (
          label &&
          typeof label === 'object' &&
          typeof (label as Record<string, unknown>).name === 'string'
        ) {
          return { name: String((label as Record<string, unknown>).name) };
        }
        return null;
      })
      .filter((label): label is { name: string } | string => label !== null);
    return {
      number: typeof raw.number === 'number' ? raw.number : ref.number,
      title: raw.title,
      body: raw.body,
      state: raw.state,
      html_url: raw.html_url,
      comments: raw.comments,
      created_at: raw.created_at,
      user: normalizedUser,
      labels,
    };
  }

  private async fetchDiscussionTail(
    ref: ParsedIssueUrl,
    issue: GithubIssue,
    token: string | null,
  ): Promise<GithubComment[]> {
    if (!issue.comments) return [];
    const lastPage = Math.max(1, Math.ceil(issue.comments / COMMENT_PAGE_SIZE));
    const last = await this.fetchCommentPage(ref, lastPage, token);
    if (last === null) return [];
    if (last.length >= DISCUSSION_TAIL || lastPage === 1) return last.slice(-DISCUSSION_TAIL);

    // A partially filled final page does not contain the complete tail. Pull
    // the preceding page too, then keep exactly the newest comments.
    const previous = await this.fetchCommentPage(ref, lastPage - 1, token);
    return [...(previous ?? []), ...last].slice(-DISCUSSION_TAIL);
  }

  private async fetchCommentPage(
    ref: ParsedIssueUrl,
    page: number,
    token: string | null,
  ): Promise<GithubComment[] | null> {
    const response = await this.request(
      `/repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
      token,
    );
    // The issue itself already resolved; a failed comment fetch degrades, not aborts.
    if (!response.ok) {
      this.logger.warn('github comments fetch failed', { status: response.status, page });
      return null;
    }
    const value: unknown = await response.json();
    if (!Array.isArray(value)) return [];
    return value
      .map((entry): GithubComment | null => {
        if (!entry || typeof entry !== 'object') return null;
        const raw = entry as Record<string, unknown>;
        if (
          (typeof raw.body !== 'string' && raw.body !== null) ||
          typeof raw.created_at !== 'string'
        ) {
          return null;
        }
        const user = raw.user;
        return {
          body: raw.body,
          created_at: raw.created_at,
          user:
            user &&
            typeof user === 'object' &&
            typeof (user as Record<string, unknown>).login === 'string'
              ? { login: String((user as Record<string, unknown>).login).slice(0, 100) }
              : null,
        };
      })
      .filter((entry): entry is GithubComment => entry !== null);
  }

  private async matchLocalProject(ref: ParsedIssueUrl): Promise<GithubProjectCandidate | null> {
    const wanted = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;
    for (const project of this.listProjects()) {
      try {
        const remote = await this.remoteUrlFor(project.path);
        if (remote && ownerRepoFromRemoteUrl(remote) === wanted) return project;
      } catch {
        // A project folder without git (or with an unreadable config) simply doesn't match.
      }
    }
    return null;
  }

  private buildBackground(
    ref: ParsedIssueUrl,
    issue: GithubIssue,
    comments: GithubComment[],
    project: GithubProjectCandidate | null,
  ): string {
    const opened = issue.created_at ? issue.created_at.slice(0, 10) : '';
    const lines = [
      `Imported from GitHub — ${ref.owner}/${ref.repo}#${ref.number} · opened by @${issue.user?.login ?? 'unknown'}${opened ? ` on ${opened}` : ''} · state: ${issue.state}`,
    ];
    if (project) {
      lines.push(`Local repository: ${project.path} (project “${project.displayName}”)`);
    }
    if (comments.length) {
      lines.push('', `Recent discussion (last ${comments.length} of ${issue.comments}):`);
      for (const comment of comments) {
        const at = comment.created_at ? comment.created_at.slice(0, 10) : '';
        const body = (comment.body ?? '').trim().slice(0, 1500);
        lines.push('', `@${comment.user?.login ?? 'unknown'}${at ? ` (${at})` : ''}:`, body);
      }
    }
    return lines.join('\n');
  }

  private async httpFailure(response: Response, token: string | null): Promise<ProductFailure> {
    if (response.status === 404) {
      return failure(
        'GITHUB_ISSUE_NOT_FOUND',
        token
          ? 'GitHub says this issue does not exist, or your token cannot see this repository.'
          : 'Issue not found. Private repositories need a GitHub token — add one in Settings → GitHub.',
      );
    }
    if (response.status === 401) {
      return failure(
        'GITHUB_AUTH_FAILED',
        'GitHub rejected the stored credential. Update the token in Settings → GitHub.',
      );
    }
    if (response.status === 403 || response.status === 429) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0' && Number.isFinite(reset)) {
        const minutes = Math.max(1, Math.ceil((reset * 1000 - this.now().getTime()) / 60_000));
        return failure(
          'GITHUB_RATE_LIMITED',
          `GitHub rate limit reached. It resets in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        );
      }
      return failure(
        'GITHUB_FORBIDDEN',
        'GitHub declined the request. The repository may require a token with more access.',
      );
    }
    return failure('GITHUB_HTTP_ERROR', `GitHub returned HTTP ${response.status}.`);
  }
}
