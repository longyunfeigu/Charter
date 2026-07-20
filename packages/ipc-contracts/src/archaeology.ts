import { z } from 'zod';

/**
 * ADR-0038 — session archaeology. Charter discovers the CLI agents' own
 * transcript stores (`~/.claude/projects/<munged cwd>/*.jsonl`,
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) read-only, lists every
 * conversation that ever ran on this machine, and can adopt one back into a
 * product terminal as a regular external Session.
 */

export const DISCOVERED_CLIS = ['claude', 'codex'] as const;
export const DiscoveredCliSchema = z.enum(DISCOVERED_CLIS);
export type DiscoveredCli = z.infer<typeof DiscoveredCliSchema>;

/** Session ids are eventually written into a PTY — exact UUIDs only. */
export const CLI_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MAX_DISCOVERED_SESSIONS = 500;
export const MAX_DISCOVERED_FILES = 200;
export const MAX_DISCOVERED_SKILLS = 20;

export const DiscoveredSessionDtoSchema = z.object({
  cli: DiscoveredCliSchema,
  sessionId: z.string().regex(CLI_SESSION_ID_RE),
  /** Directory the CLI ran in (from the transcript itself, never guessed). */
  cwd: z.string(),
  /** Charter project this session belongs to; null = no known project matched. */
  projectPath: z.string().nullable(),
  /** How the project attribution was decided (ADR-0038: files beat cwd). */
  attribution: z.enum(['cwd', 'files', 'none']),
  /** The user's first message (or the CLI's own title when it kept one). */
  title: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Paths the session actually wrote, cwd-relative when inside the cwd. */
  filesTouched: z.array(z.string()).max(MAX_DISCOVERED_FILES),
  skills: z.array(z.string()).max(MAX_DISCOVERED_SKILLS),
  /** Real user turns — a 0-turn transcript is noise and never listed. */
  turnCount: z.number().int().positive(),
  /** Already recorded by Charter (cli-session-locator linked it to a task):
   * shown as "Tracked", opens the existing Session, never adopted twice. */
  trackedTaskId: z.string().nullable(),
});
export type DiscoveredSessionDto = z.infer<typeof DiscoveredSessionDtoSchema>;
