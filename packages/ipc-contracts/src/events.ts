import { z } from 'zod';
import { DocumentDtoSchema, FsChangeSchema } from './documents.js';
import { WorkspaceDtoSchema } from './dto.js';
import { TaskStateSchema, TimelineEventDtoSchema } from './agent-dto.js';

export interface EventChannelDef<S extends z.ZodType = z.ZodType> {
  name: string;
  schemaVersion: number;
  payload: S;
}

function ev<S extends z.ZodType>(
  name: string,
  schemaVersion: number,
  payload: S,
): EventChannelDef<S> {
  return { name, schemaVersion, payload };
}

/** Fixed main→renderer event channel registry. Grows with milestones. */
export const EVENT_CHANNELS = {
  'app.menuAction': ev('app.menuAction', 1, z.object({ action: z.string() })),
  'app.themeChanged': ev(
    'app.themeChanged',
    1,
    z.object({ theme: z.enum(['light', 'dark', 'system']), effective: z.enum(['light', 'dark']) }),
  ),
  'settings.changed': ev(
    'settings.changed',
    1,
    z.object({ issues: z.array(z.string()), overrideKeys: z.array(z.string()) }),
  ),
  /** External skill roots are watcher-driven; renderers refresh the catalog. */
  'skills.changed': ev(
    'skills.changed',
    1,
    z.object({ reason: z.string(), revision: z.number().int().nonnegative() }),
  ),
  'workspace.changed': ev(
    'workspace.changed',
    1,
    z.object({ workspace: WorkspaceDtoSchema.nullable() }),
  ),
  'fs.batch': ev('fs.batch', 1, z.object({ changes: z.array(FsChangeSchema).max(2000) })),
  'doc.changedExternally': ev('doc.changedExternally', 1, z.object({ doc: DocumentDtoSchema })),
  'search.results': ev(
    'search.results',
    1,
    z.object({
      searchId: z.string(),
      groups: z.array(
        z.object({
          path: z.string(),
          contentHash: z.string(),
          matches: z.array(
            z.object({
              line: z.number(),
              column: z.number(),
              matchText: z.string(),
              previewText: z.string(),
              absoluteStart: z.number(),
              absoluteEnd: z.number(),
            }),
          ),
        }),
      ),
      done: z.boolean(),
      truncated: z.boolean(),
      cancelled: z.boolean(),
    }),
  ),
  'terminal.data': ev('terminal.data', 1, z.object({ id: z.string(), data: z.string() })),
  'terminal.exit': ev('terminal.exit', 1, z.object({ id: z.string(), exitCode: z.number() })),
  /** ADR-0017: a terminal entered (agent = CLI name) or left (agent = null) an
   * external agent session. taskId is present once accounting attached. */
  'terminal.agentState': ev(
    'terminal.agentState',
    1,
    z.object({
      id: z.string(),
      agent: z.string().nullable(),
      taskId: z.string().nullable(),
    }),
  ),
  /** ADR-0021: a command-finish notification was clicked — scroll the terminal
   * to the block start and flash it (the landing point is the block, not the app). */
  'terminal.revealBlock': ev(
    'terminal.revealBlock',
    1,
    z.object({ id: z.string(), blockId: z.string() }),
  ),
  /** ADR-0021: a structured external session crossed a turn boundary (Codex
   * turn.completed / Claude result). Observed-grade sessions never fire this. */
  'external.turn': ev(
    'external.turn',
    1,
    z.object({
      terminalId: z.string(),
      taskId: z.string(),
      label: z.string(),
      status: z.enum(['ok', 'error']),
    }),
  ),
  /** ADR-0017: live accounting for an external CLI session (watcher-driven). */
  'external.sessionChanged': ev(
    'external.sessionChanged',
    1,
    z.object({
      taskId: z.string(),
      terminalId: z.string(),
      cli: z.string(),
      status: z.enum(['active', 'ended']),
      captureGrade: z.enum(['structured', 'observed']),
      /** Short id of the entry snapshot (git tree), null for non-git projects. */
      snapshotRef: z.string().nullable(),
      files: z.array(
        z.object({
          path: z.string(),
          status: z.enum(['created', 'modified', 'deleted', 'renamed']),
          additions: z.number(),
          deletions: z.number(),
        }),
      ),
    }),
  ),
  'git.changed': ev('git.changed', 1, z.object({ reason: z.string() })),
  'task.event': ev(
    'task.event',
    1,
    z.object({ taskId: z.string(), event: TimelineEventDtoSchema }),
  ),
  'task.stream': ev(
    'task.stream',
    1,
    z.object({
      taskId: z.string(),
      runId: z.string(),
      messageId: z.string(),
      delta: z.string(),
    }),
  ),
  'task.streamThinking': ev(
    'task.streamThinking',
    1,
    z.object({
      taskId: z.string(),
      runId: z.string(),
      messageId: z.string(),
      delta: z.string(),
    }),
  ),
  'task.stateChanged': ev(
    'task.stateChanged',
    1,
    z.object({ taskId: z.string(), state: TaskStateSchema }),
  ),
  'agent.workerStatus': ev(
    'agent.workerStatus',
    1,
    z.object({ alive: z.boolean(), restarts: z.number(), degraded: z.boolean() }),
  ),
  /** A system notification was clicked — bring this task into view (PIVOT-014). */
  'app.focusTask': ev('app.focusTask', 1, z.object({ taskId: z.string() })),
  'lsp.pythonDiagnostics': ev(
    'lsp.pythonDiagnostics',
    1,
    z.object({
      path: z.string(),
      diagnostics: z.array(
        z.object({
          message: z.string(),
          severity: z.number(),
          startLine: z.number(),
          startCharacter: z.number(),
          endLine: z.number(),
          endCharacter: z.number(),
          source: z.string().optional(),
        }),
      ),
    }),
  ),
} as const;

export type EventChannelName = keyof typeof EVENT_CHANNELS;
export type EventPayload<N extends EventChannelName> = z.infer<
  (typeof EVENT_CHANNELS)[N]['payload']
>;

export function isKnownEventChannel(name: string): name is EventChannelName {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, name);
}
