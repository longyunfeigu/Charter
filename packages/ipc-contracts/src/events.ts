import { z } from 'zod';
import { DocumentDtoSchema, FsChangeSchema } from './documents.js';
import { WorkspaceDtoSchema } from './dto.js';

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
