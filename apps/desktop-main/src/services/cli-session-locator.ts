import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * ADR-0017 amendment — locating the CLI's own conversation id so resume can
 * target the exact session (`claude --resume <id>` / `codex resume <id>`)
 * instead of "whatever was most recent in this directory".
 *
 * Ground truth (verified against real installs):
 * - Claude Code: `~/.claude/projects/<munged cwd>/<session-uuid>.jsonl`, where
 *   the munge replaces every non-alphanumeric character with `-`
 *   (`/private/var/.../pi_ide` → `-private-var----pi-ide`).
 * - Codex CLI: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`
 *   (`CODEX_HOME` defaults to `~/.codex`).
 *
 * Discovery is time-window based: the newest transcript whose mtime falls
 * inside the session's lifetime is the session. It runs at session end (the
 * transcript's last write is the session's own end), so a later session in the
 * same directory can never be picked. Codex candidates are additionally
 * matched against the rollout's `session_meta.cwd`, so parallel sessions in
 * other projects cannot be confused. Everything is best-effort: any fs error
 * resolves to null; callers must not guess a Codex conversation with `--last`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIMI_SESSION_RE = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_ROLLOUT_RE =
  /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Session ids are written into a PTY — only exact provider-owned safe shapes are embedded. */
export function isSafeCliSessionId(id: string): boolean {
  return UUID_RE.test(id) || KIMI_SESSION_RE.test(id);
}

/** Claude Code's transcript folder name for a working directory. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Lead slack: the transcript may be created moments before we saw the agent. */
const START_SLACK_MS = 60_000;
/** Tail slack: final writes can land after the exit edge debounce. */
const END_SLACK_MS = 120_000;
/** Backfill safety: never walk more day directories than this. */
const MAX_CODEX_DAYS = 16;
/** Codex session_meta is currently ~40 KiB; stay bounded if the format grows. */
const CODEX_META_READ_BYTES = 256 * 1024;

export interface DiscoverInput {
  cli: string;
  /** Adapter-selected implementation. Defaults to `cli` for compatibility
   * with older callers and fixtures. */
  connector?: string;
  /** The directory the CLI ran in (external.cwd), not the accounting root. */
  cwd: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Test seam. */
  home?: string;
  /** Adapter-resolved provider data directory. When present it takes
   * precedence over provider-specific environment/default-home discovery. */
  dataHome?: string;
  /** Test/backfill seam: Codex homes themselves, each containing `sessions/`. */
  codexHomes?: string[];
  /** Test seam for the Main process's inherited Codex home. */
  configuredCodexHome?: string | null;
  /** Test seam for Kimi Code's data home. */
  kimiHome?: string | null;
}

interface Candidate {
  sessionId: string;
  mtimeMs: number;
}

async function newestInWindow(
  candidates: Candidate[],
  input: DiscoverInput,
): Promise<string | null> {
  const from = input.startedAtMs - START_SLACK_MS;
  const to = input.endedAtMs + END_SLACK_MS;
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (candidate.mtimeMs < from || candidate.mtimeMs > to) continue;
    if (!best || candidate.mtimeMs > best.mtimeMs) best = candidate;
  }
  return best?.sessionId ?? null;
}

async function discoverClaude(input: DiscoverInput): Promise<string | null> {
  const dir = join(
    input.dataHome ?? join(input.home ?? homedir(), '.claude'),
    'projects',
    claudeProjectDirName(input.cwd),
  );
  const candidates: Candidate[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (!isSafeCliSessionId(sessionId)) continue;
    try {
      const info = await stat(join(dir, name));
      candidates.push({ sessionId, mtimeMs: info.mtimeMs });
    } catch {
      // raced deletion — skip
    }
  }
  return newestInWindow(candidates, input);
}

/** Local-date day keys covering [start, end] with one day of slack each side. */
function codexDayKeys(startedAtMs: number, endedAtMs: number): string[] {
  const keys: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  for (let t = startedAtMs - day; t <= endedAtMs + day && keys.length < MAX_CODEX_DAYS; t += day) {
    const d = new Date(t);
    const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

async function discoverCodex(input: DiscoverInput): Promise<string | null> {
  const from = input.startedAtMs - START_SLACK_MS;
  const to = input.endedAtMs + END_SLACK_MS;
  const candidates: Array<Candidate & { startedAtMs: number }> = [];
  for (const home of codexHomeCandidates(input, false)) {
    const root = join(home, 'sessions');
    for (const key of codexDayKeys(input.startedAtMs, input.endedAtMs)) {
      const dir = join(root, key);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // day directory does not exist
      }
      for (const name of names) {
        const match = CODEX_ROLLOUT_RE.exec(name);
        if (!match) continue;
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < from || info.mtimeMs > to) continue;
          const meta = await readCodexSessionMeta(path);
          const filenameId = match[1]!.toLowerCase();
          if (
            !meta ||
            meta.sessionId !== filenameId ||
            resolve(meta.cwd) !== resolve(input.cwd) ||
            meta.startedAtMs < from ||
            meta.startedAtMs > to
          ) {
            continue;
          }
          candidates.push({
            sessionId: filenameId,
            mtimeMs: info.mtimeMs,
            startedAtMs: meta.startedAtMs,
          });
        } catch {
          // malformed, unreadable, or raced deletion — skip
        }
      }
    }
  }

  // Agent detection follows process launch, so the rollout created closest to
  // the observed session start is the strongest identity signal. mtime breaks
  // ties for older fixtures and filesystems with coarse timestamp precision.
  candidates.sort(
    (a, b) =>
      Math.abs(a.startedAtMs - input.startedAtMs) - Math.abs(b.startedAtMs - input.startedAtMs) ||
      b.mtimeMs - a.mtimeMs,
  );
  return candidates[0]?.sessionId ?? null;
}

const KIMI_INDEX_READ_BYTES = 4 * 1024 * 1024;

function kimiHome(input: DiscoverInput): string {
  if (input.dataHome) return resolve(input.dataHome);
  if (input.kimiHome) return resolve(input.kimiHome);
  if (!input.home && process.env.KIMI_CODE_HOME && isAbsolute(process.env.KIMI_CODE_HOME)) {
    return resolve(process.env.KIMI_CODE_HOME);
  }
  return resolve(input.home ?? homedir(), '.kimi-code');
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path);
  const length = Math.min(info.size, maxBytes);
  if (length <= 0) return '';
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(buffer, 0, length, Math.max(0, info.size - length));
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (info.size > length) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
    return text;
  } finally {
    await file.close();
  }
}

/** Kimi records an exact session directory and working directory in a bounded JSONL index. */
async function discoverKimi(input: DiscoverInput): Promise<string | null> {
  const home = kimiHome(input);
  const sessionsRoot = resolve(home, 'sessions');
  const text = await readTail(join(home, 'session_index.jsonl'), KIMI_INDEX_READ_BYTES);
  const candidates: Candidate[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        sessionId?: unknown;
        sessionDir?: unknown;
        workDir?: unknown;
      };
      if (
        typeof entry.sessionId !== 'string' ||
        !KIMI_SESSION_RE.test(entry.sessionId) ||
        typeof entry.sessionDir !== 'string' ||
        typeof entry.workDir !== 'string' ||
        resolve(entry.workDir) !== resolve(input.cwd)
      ) {
        continue;
      }
      const sessionDir = resolve(entry.sessionDir);
      const relativeSessionDir = relative(sessionsRoot, sessionDir);
      if (
        !relativeSessionDir ||
        relativeSessionDir.startsWith('..') ||
        isAbsolute(relativeSessionDir) ||
        basename(sessionDir) !== entry.sessionId
      ) {
        continue;
      }
      const statePath = join(sessionDir, 'state.json');
      const info = await stat(statePath);
      const stateText = await readTail(statePath, 256 * 1024);
      const state = JSON.parse(stateText) as { workDir?: unknown; updatedAt?: unknown };
      if (typeof state.workDir !== 'string' || resolve(state.workDir) !== resolve(input.cwd)) {
        continue;
      }
      const updatedAt =
        typeof state.updatedAt === 'string' ? Date.parse(state.updatedAt) : Number.NaN;
      candidates.push({
        sessionId: entry.sessionId,
        mtimeMs: Number.isFinite(updatedAt) ? Math.max(info.mtimeMs, updatedAt) : info.mtimeMs,
      });
    } catch {
      // Malformed, unreadable, or raced session entry — skip.
    }
  }
  return newestInWindow(candidates, input);
}

/**
 * The host Codex Desktop process uses `.codex-app`, but Charter strips that
 * ambient CODEX_HOME from user PTYs. Scanning it during discovery can attach
 * the host conversation to a terminal session that started at the same time.
 */
function codexHomeCandidates(input: DiscoverInput, includePrivateHostHome: boolean): string[] {
  if (input.dataHome) return [resolve(input.dataHome)];
  if (input.codexHomes) return [...new Set(input.codexHomes.map((value) => resolve(value)))];
  const homes = [join(input.home ?? homedir(), '.codex')];
  const configuredHome =
    input.configuredCodexHome !== undefined
      ? input.configuredCodexHome
      : !input.home
        ? process.env.CODEX_HOME
        : null;
  if (
    configuredHome &&
    isAbsolute(configuredHome) &&
    (includePrivateHostHome || basename(resolve(configuredHome)) !== '.codex-app')
  ) {
    homes.push(configuredHome);
  }
  return [...new Set(homes.map((value) => resolve(value)))];
}

async function readCodexSessionMeta(
  path: string,
): Promise<{ sessionId: string; cwd: string; startedAtMs: number } | null> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CODEX_META_READ_BYTES);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const newline = text.indexOf('\n');
    if (newline < 0 && bytesRead === buffer.length) return null;
    const entry = JSON.parse(newline >= 0 ? text.slice(0, newline) : text) as {
      type?: unknown;
      timestamp?: unknown;
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown };
    };
    if (entry.type !== 'session_meta') return null;
    const sessionId = typeof entry.payload?.id === 'string' ? entry.payload.id.toLowerCase() : '';
    const cwd = typeof entry.payload?.cwd === 'string' ? entry.payload.cwd : '';
    const timestamp = entry.payload?.timestamp ?? entry.timestamp;
    const startedAtMs = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    if (!isSafeCliSessionId(sessionId) || !cwd || !Number.isFinite(startedAtMs)) return null;
    return { sessionId, cwd, startedAtMs };
  } finally {
    await file.close();
  }
}

export interface CodexSessionLocation {
  sessionId: string;
  codexHome: string;
}

/**
 * Resolve an already-recorded Codex id back to the home that owns its rollout.
 * Unlike new-session discovery, this includes the private host home so sessions
 * recorded by older Charter builds remain resumable after environment hygiene.
 */
export async function locateCodexSession(
  input: DiscoverInput & { sessionId: string },
): Promise<CodexSessionLocation | null> {
  if (!isSafeCliSessionId(input.sessionId)) return null;
  const wanted = input.sessionId.toLowerCase();
  try {
    for (const home of codexHomeCandidates(input, true)) {
      const root = join(home, 'sessions');
      for (const key of codexDayKeys(input.startedAtMs, input.endedAtMs)) {
        const dir = join(root, key);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          const match = CODEX_ROLLOUT_RE.exec(name);
          if (match?.[1]?.toLowerCase() !== wanted) continue;
          const meta = await readCodexSessionMeta(join(dir, name));
          if (
            meta?.sessionId === wanted &&
            resolve(meta.cwd) === resolve(input.cwd) &&
            meta.startedAtMs >= input.startedAtMs - START_SLACK_MS &&
            meta.startedAtMs <= input.endedAtMs + END_SLACK_MS
          ) {
            return { sessionId: wanted, codexHome: home };
          }
        }
      }
    }
  } catch {
    // Resume falls back to its existing command when the local index is unreadable.
  }
  return null;
}

/**
 * The CLI-native conversation id for a session bounded by [startedAt, endedAt]
 * in `cwd`, or null when it cannot be established (unknown CLI, no transcript,
 * fs errors). Never throws.
 */
export async function discoverCliSessionId(input: DiscoverInput): Promise<string | null> {
  try {
    const connector = SESSION_ID_CONNECTORS[input.connector ?? input.cli];
    return connector ? await connector(input) : null;
  } catch {
    return null;
  }
}

/** Connector implementations are host code because they parse bounded native
 * storage formats. The Adapter selects one by id; adding an Agent with no
 * identity support needs no provider branch and simply declares none. */
const SESSION_ID_CONNECTORS: Readonly<
  Record<string, (input: DiscoverInput) => Promise<string | null>>
> = {
  claude: discoverClaude,
  codex: discoverCodex,
  kimi: discoverKimi,
};
