import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import type { Logger } from '@pi-ide/foundation';
import {
  CLI_SESSION_ID_RE,
  MAX_DISCOVERED_FILES,
  MAX_DISCOVERED_SESSIONS,
  MAX_DISCOVERED_SKILLS,
  type DiscoveredCli,
  type DiscoveredSessionDto,
} from '@pi-ide/ipc-contracts';

/**
 * ADR-0038 — session archaeology. Read-only discovery over the CLI agents'
 * own transcript stores:
 *
 * - Claude Code: `~/.claude/projects/<munged cwd>/<session-uuid>.jsonl` —
 *   partitioned by launch directory; every entry additionally records `cwd`,
 *   so attribution never reverse-guesses the lossy munge.
 * - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` —
 *   partitioned by date; the cwd lives in the first `session_meta` line.
 *
 * Charter NEVER writes into either store (the ADR-0017 boundary lesson).
 * Sessions already linked to a Charter task (cli-session-locator) surface as
 * tracked, so nothing is ever listed — or adopted — twice.
 */

/** What one transcript file reduces to. Paths are as recorded (absolute). */
export interface TranscriptSummary {
  sessionId: string | null;
  cwd: string | null;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  filesTouched: string[];
  skills: string[];
  turnCount: number;
}

const CODEX_ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Tool names whose input names a written file (Claude Code transcripts). */
const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TITLE = 120;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Human text of a user turn, or null for tool results / injected wrappers
 * (`<command-name>`, `<system-reminder>`, "Caveat:" preambles…). */
function plainUserText(content: unknown): string | null {
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    for (const part of content) {
      const p = record(part);
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        text = p.text;
        break;
      }
      if (p.type === 'tool_result') return null;
    }
  }
  const trimmed = text?.trim() ?? '';
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('Caveat:')) return null;
  return trimmed;
}

function clampTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine;
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      yield record(JSON.parse(line));
    } catch {
      // Half-written tail lines are expected on live sessions — skip.
    }
  }
}

/** Reduce one Claude Code transcript. Sidechain (subagent) entries are noise
 * for archaeology — only the main conversation counts. */
export function parseClaudeTranscript(text: string): TranscriptSummary {
  const out: TranscriptSummary = {
    sessionId: null,
    cwd: null,
    title: '',
    startedAt: null,
    endedAt: null,
    filesTouched: [],
    skills: [],
    turnCount: 0,
  };
  let firstUser: string | null = null;
  let aiTitle: string | null = null;
  for (const entry of jsonLines(text)) {
    if (entry.isSidechain === true) continue;
    out.sessionId ??= asString(entry.sessionId);
    out.cwd ??= asString(entry.cwd);
    const ts = asString(entry.timestamp);
    if (ts) {
      out.startedAt ??= ts;
      out.endedAt = ts;
    }
    if (entry.type === 'ai-title') {
      aiTitle = asString(entry.aiTitle) ?? aiTitle;
      continue;
    }
    if (entry.type === 'user') {
      const message = record(entry.message);
      const text0 = plainUserText(message.content);
      if (text0) {
        out.turnCount += 1;
        firstUser ??= text0;
      }
      continue;
    }
    if (entry.type === 'assistant') {
      const content = record(entry.message).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const p = record(part);
        if (p.type !== 'tool_use') continue;
        const name = asString(p.name);
        const input = record(p.input);
        if (name && CLAUDE_WRITE_TOOLS.has(name)) {
          const path = asString(input.file_path) ?? asString(input.notebook_path);
          if (path) out.filesTouched.push(path);
        } else if (name === 'Skill') {
          const skill = asString(input.skill);
          if (skill) out.skills.push(skill);
        }
      }
    }
  }
  out.title = clampTitle(aiTitle ?? firstUser ?? '');
  return out;
}

/** Reduce one Codex rollout. cwd and id come from the `session_meta` head
 * line; written files from successful `patch_apply_end` events. */
export function parseCodexRollout(text: string): TranscriptSummary {
  const out: TranscriptSummary = {
    sessionId: null,
    cwd: null,
    title: '',
    startedAt: null,
    endedAt: null,
    filesTouched: [],
    skills: [],
    turnCount: 0,
  };
  let firstUser: string | null = null;
  for (const entry of jsonLines(text)) {
    const ts = asString(entry.timestamp);
    if (ts) {
      out.startedAt ??= ts;
      out.endedAt = ts;
    }
    const payload = record(entry.payload);
    if (entry.type === 'session_meta') {
      out.sessionId ??= asString(payload.id);
      out.cwd ??= asString(payload.cwd);
      out.startedAt = asString(payload.timestamp) ?? out.startedAt;
      continue;
    }
    if (entry.type !== 'event_msg') continue;
    if (payload.type === 'user_message') {
      const text0 = plainUserText(payload.message);
      if (text0) {
        out.turnCount += 1;
        firstUser ??= text0;
      }
    } else if (payload.type === 'patch_apply_end' && payload.success !== false) {
      for (const path of Object.keys(record(payload.changes))) out.filesTouched.push(path);
    }
  }
  out.title = clampTitle(firstUser ?? '');
  return out;
}

/** Longest project whose directory contains `path` ('' = none). Projects must
 * be passed longest-first so nested checkouts resolve to the inner project. */
function containingProject(path: string, projectsLongestFirst: string[]): string | null {
  for (const project of projectsLongestFirst) {
    if (path === project || path.startsWith(project + sep)) return project;
  }
  return null;
}

/**
 * ADR-0038 attribution: what the session DID beats where it started. A cwd
 * inside a project wins outright; otherwise the project owning the most
 * touched files wins (the "claude launched from ~ but edited bullpen" case);
 * otherwise the session stays unattributed and honest.
 */
export function attributeProject(
  cwd: string,
  filesTouched: string[],
  projects: string[],
): { projectPath: string | null; attribution: 'cwd' | 'files' | 'none' } {
  const longestFirst = [...projects].sort((a, b) => b.length - a.length);
  const byCwd = containingProject(cwd, longestFirst);
  if (byCwd) return { projectPath: byCwd, attribution: 'cwd' };
  const votes = new Map<string, number>();
  for (const file of filesTouched) {
    const project = containingProject(file, longestFirst);
    if (project) votes.set(project, (votes.get(project) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestVotes = 0;
  for (const [project, count] of votes) {
    if (count > bestVotes) {
      best = project;
      bestVotes = count;
    }
  }
  return best
    ? { projectPath: best, attribution: 'files' }
    : { projectPath: null, attribution: 'none' };
}

/** cwd-relative display form for paths inside the session's cwd. */
function relativizeFiles(files: string[], cwd: string): string[] {
  const unique = [...new Set(files)];
  return unique
    .map((file) => (file.startsWith(cwd + sep) ? file.slice(cwd.length + 1) : file))
    .slice(0, MAX_DISCOVERED_FILES);
}

export interface ArchaeologyOptions {
  logger: Logger;
  /** Test seam / E2E fake home. */
  homeDir?: string;
  /** Off in E2E unless a fake home is supplied (ADR-0015/0019 pattern). */
  enabled?: boolean;
  /** Host-owned dedupe: external conversation id → owning Charter task. */
  knownSessions: () => Map<string, string>;
  /** Known Charter project canonical paths (attribution targets). */
  projects: () => string[];
  /** Codex is date-partitioned — bound the walk (Claude needs no window). */
  windowDays?: number;
  /** Never parse pathological transcripts into memory. */
  maxBytes?: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  summary: TranscriptSummary | null;
}

interface Candidate {
  cli: DiscoveredCli;
  path: string;
  /** Claude: the transcript file name IS the session uuid. */
  fileSessionId: string;
}

export class SessionArchaeologyService {
  private readonly cache = new Map<string, CacheEntry>();
  private known: DiscoveredSessionDto[] = [];
  private scanning: Promise<DiscoveredSessionDto[]> | null = null;

  constructor(private readonly options: ArchaeologyOptions) {}

  private get home(): string {
    return this.options.homeDir ?? homedir();
  }

  get enabled(): boolean {
    return this.options.enabled ?? true;
  }

  /** Full discovery pass (concurrent calls coalesce). Read-only by design:
   * readdir/stat/readFile — any fs error degrades to "not discovered". */
  async scan(): Promise<DiscoveredSessionDto[]> {
    if (!this.enabled) return [];
    this.scanning ??= this.scanOnce().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  /** The discovered session behind an adopt/terminal-context request. Scans
   * first if this process has never looked (fresh launch → direct adopt). */
  async lookup(cli: DiscoveredCli, sessionId: string): Promise<DiscoveredSessionDto | null> {
    if (this.known.length === 0) await this.scan();
    return (
      this.known.find((item) => item.cli === cli && item.sessionId === sessionId.toLowerCase()) ??
      null
    );
  }

  private async scanOnce(): Promise<DiscoveredSessionDto[]> {
    const startedMs = Date.now();
    const candidates = [...(await this.claudeCandidates()), ...(await this.codexCandidates())];
    const sessions: DiscoveredSessionDto[] = [];
    const knownSessions = this.options.knownSessions();
    const projects = this.options.projects();
    for (const candidate of candidates) {
      const summary = await this.summarize(candidate);
      if (!summary || summary.turnCount === 0) continue;
      const sessionId = (summary.sessionId ?? candidate.fileSessionId).toLowerCase();
      if (!CLI_SESSION_ID_RE.test(sessionId)) continue;
      const cwd = summary.cwd;
      if (!cwd) continue;
      const { projectPath, attribution } = attributeProject(cwd, summary.filesTouched, projects);
      sessions.push({
        cli: candidate.cli,
        sessionId,
        cwd,
        projectPath,
        attribution,
        title: summary.title || `${candidate.cli} session`,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        filesTouched: relativizeFiles(summary.filesTouched, cwd),
        skills: [...new Set(summary.skills)].slice(0, MAX_DISCOVERED_SKILLS),
        turnCount: summary.turnCount,
        trackedTaskId: knownSessions.get(sessionId) ?? null,
      });
    }
    sessions.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
    this.known = sessions;
    this.options.logger.info('archaeology scan finished', {
      candidates: candidates.length,
      sessions: sessions.length,
      ms: Date.now() - startedMs,
    });
    return sessions;
  }

  private async claudeCandidates(): Promise<Candidate[]> {
    const root = join(this.home, '.claude', 'projects');
    const out: Candidate[] = [];
    for (const dir of await this.listDirs(root)) {
      for (const name of await this.listNames(join(root, dir))) {
        if (!name.endsWith('.jsonl')) continue;
        const fileSessionId = name.slice(0, -'.jsonl'.length);
        if (!CLI_SESSION_ID_RE.test(fileSessionId)) continue;
        out.push({ cli: 'claude', path: join(root, dir, name), fileSessionId });
      }
    }
    return out;
  }

  private async codexCandidates(): Promise<Candidate[]> {
    const root = join(this.home, '.codex', 'sessions');
    const out: Candidate[] = [];
    const windowDays = this.options.windowDays ?? 30;
    const oldest = new Date(Date.now() - windowDays * 86_400_000);
    const floor = `${oldest.getFullYear()}-${String(oldest.getMonth() + 1).padStart(2, '0')}-${String(oldest.getDate()).padStart(2, '0')}`;
    for (const year of await this.listDirs(root)) {
      if (!/^\d{4}$/.test(year)) continue;
      for (const month of await this.listDirs(join(root, year))) {
        if (!/^\d{2}$/.test(month)) continue;
        for (const day of await this.listDirs(join(root, year, month))) {
          if (!/^\d{2}$/.test(day)) continue;
          if (`${year}-${month}-${day}` < floor) continue;
          for (const name of await this.listNames(join(root, year, month, day))) {
            const match = CODEX_ROLLOUT_RE.exec(name);
            if (!match) continue;
            out.push({
              cli: 'codex',
              path: join(root, year, month, day, name),
              fileSessionId: match[1]!,
            });
          }
        }
      }
    }
    return out;
  }

  /** Parse-once cache keyed by (path, mtime, size) — a rescan re-reads only
   * transcripts that actually changed since the last pass. */
  private async summarize(candidate: Candidate): Promise<TranscriptSummary | null> {
    try {
      const info = await stat(candidate.path);
      const cached = this.cache.get(candidate.path);
      if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        return cached.summary;
      }
      let summary: TranscriptSummary | null = null;
      if (info.size <= (this.options.maxBytes ?? 50 * 1024 * 1024)) {
        const text = await readFile(candidate.path, 'utf8');
        summary =
          candidate.cli === 'claude' ? parseClaudeTranscript(text) : parseCodexRollout(text);
      } else {
        this.options.logger.warn('archaeology transcript skipped (too large)', {
          path: candidate.path,
          size: info.size,
        });
      }
      this.cache.set(candidate.path, { mtimeMs: info.mtimeMs, size: info.size, summary });
      return summary;
    } catch {
      return null;
    }
  }

  private async listDirs(path: string): Promise<string[]> {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  private async listNames(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  }
}

export { MAX_DISCOVERED_SESSIONS };
