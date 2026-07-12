import { z } from 'zod';
import { fail, ok, productError, type Result } from '@pi-ide/foundation';
import { AppInfoSchema, RecentWorkspaceSchema, WorkspaceDtoSchema } from './dto.js';
import { SettingsSchema } from './settings.js';
import { LayoutStateSchema } from './layout.js';
import { DirEntrySchema, DocumentDtoSchema, EolSchema, OpenTabsStateSchema } from './documents.js';

const SettingsStateSchema = z.object({
  effective: SettingsSchema,
  issues: z.array(z.string()),
  overrideKeys: z.array(z.string()),
});

export interface ChannelDef<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  name: string;
  schemaVersion: number;
  request: Req;
  response: Res;
}

function ch<Req extends z.ZodType, Res extends z.ZodType>(
  name: string,
  schemaVersion: number,
  request: Req,
  response: Res,
): ChannelDef<Req, Res> {
  return { name, schemaVersion, request, response };
}

/**
 * Fixed channel registry. The preload bridge is generated from this object;
 * a channel that is not listed here does not exist for the renderer.
 * Registry grows with milestones; every entry carries its own schemaVersion.
 */
export const CHANNELS = {
  'app.getInfo': ch('app.getInfo', 1, z.object({}).strict(), AppInfoSchema),
  'app.openExternal': ch(
    'app.openExternal',
    1,
    z.object({ url: z.string().url() }).strict(),
    z.object({ opened: z.boolean() }),
  ),
  'workspace.open': ch(
    'workspace.open',
    1,
    z.object({ path: z.string().min(1) }).strict(),
    z.object({ workspace: WorkspaceDtoSchema }),
  ),
  'workspace.pickAndOpen': ch(
    'workspace.pickAndOpen',
    1,
    z.object({}).strict(),
    z.object({ workspace: WorkspaceDtoSchema.nullable() }),
  ),
  'workspace.recent': ch(
    'workspace.recent',
    1,
    z.object({}).strict(),
    z.object({ items: z.array(RecentWorkspaceSchema) }),
  ),
  'settings.get': ch('settings.get', 1, z.object({}).strict(), SettingsStateSchema),
  'settings.update': ch(
    'settings.update',
    1,
    z
      .object({
        scope: z.enum(['global', 'workspace']),
        patch: z.record(z.string(), z.unknown()),
      })
      .strict(),
    SettingsStateSchema,
  ),
  'settings.reset': ch(
    'settings.reset',
    1,
    z.object({ scope: z.enum(['global', 'workspace']) }).strict(),
    SettingsStateSchema,
  ),
  'layout.get': ch(
    'layout.get',
    1,
    z.object({}).strict(),
    z.object({ layout: LayoutStateSchema.nullable() }),
  ),
  'layout.save': ch(
    'layout.save',
    1,
    z.object({ layout: LayoutStateSchema }).strict(),
    z.object({ saved: z.boolean() }),
  ),
  'diagnostics.get': ch(
    'diagnostics.get',
    1,
    z.object({}).strict(),
    z.object({
      dbOk: z.boolean(),
      dbDetail: z.string(),
      logsDir: z.string(),
      components: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['ok', 'degraded', 'down', 'idle']),
          detail: z.string(),
        }),
      ),
      recentErrors: z.array(
        z.object({ code: z.string(), component: z.string(), severity: z.string(), at: z.string() }),
      ),
    }),
  ),
  'diagnostics.openLogsFolder': ch(
    'diagnostics.openLogsFolder',
    1,
    z.object({}).strict(),
    z.object({ opened: z.boolean() }),
  ),
  'app.reportClientError': ch(
    'app.reportClientError',
    1,
    z
      .object({
        code: z.string().max(64),
        message: z.string().max(2000),
        stack: z.string().max(8000).optional(),
      })
      .strict(),
    z.object({ logged: z.boolean() }),
  ),
  'app.setQuitBlockers': ch(
    'app.setQuitBlockers',
    1,
    z.object({ blockers: z.array(z.string().max(200)).max(20) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'workspace.close': ch(
    'workspace.close',
    1,
    z.object({}).strict(),
    z.object({ closed: z.boolean() }),
  ),
  'workspace.current': ch(
    'workspace.current',
    1,
    z.object({}).strict(),
    z.object({ workspace: WorkspaceDtoSchema.nullable() }),
  ),
  'workspace.setTrust': ch(
    'workspace.setTrust',
    1,
    z.object({ trusted: z.boolean() }).strict(),
    z.object({ workspace: WorkspaceDtoSchema }),
  ),
  'fs.listDir': ch(
    'fs.listDir',
    1,
    z.object({ dir: z.string(), showIgnored: z.boolean().default(false) }).strict(),
    z.object({ entries: z.array(DirEntrySchema) }),
  ),
  'fs.create': ch(
    'fs.create',
    1,
    z
      .object({
        parentDir: z.string(),
        name: z.string().min(1).max(255),
        kind: z.enum(['file', 'dir']),
      })
      .strict(),
    z.object({ path: z.string() }),
  ),
  'fs.rename': ch(
    'fs.rename',
    1,
    z.object({ path: z.string(), newName: z.string().min(1).max(255) }).strict(),
    z.object({ newPath: z.string() }),
  ),
  'fs.trash': ch(
    'fs.trash',
    1,
    z.object({ path: z.string() }).strict(),
    z.object({ trashed: z.boolean() }),
  ),
  'doc.open': ch(
    'doc.open',
    1,
    z.object({ path: z.string() }).strict(),
    z.object({ doc: DocumentDtoSchema }),
  ),
  'doc.update': ch(
    'doc.update',
    1,
    z.object({ path: z.string(), content: z.string() }).strict(),
    z.object({ dirty: z.boolean(), bufferRevision: z.number().int() }),
  ),
  'doc.save': ch(
    'doc.save',
    1,
    z
      .object({ path: z.string(), content: z.string().optional(), force: z.boolean().optional() })
      .strict(),
    z.object({ doc: DocumentDtoSchema }),
  ),
  'doc.close': ch(
    'doc.close',
    1,
    z.object({ path: z.string() }).strict(),
    z.object({ closed: z.boolean() }),
  ),
  'doc.resolveExternal': ch(
    'doc.resolveExternal',
    1,
    z.object({ path: z.string(), choice: z.enum(['reload', 'keep']) }).strict(),
    z.object({ doc: DocumentDtoSchema }),
  ),
  'doc.setEol': ch(
    'doc.setEol',
    1,
    z.object({ path: z.string(), eol: EolSchema }).strict(),
    z.object({ doc: DocumentDtoSchema }),
  ),
  'doc.readDisk': ch(
    'doc.readDisk',
    1,
    z.object({ path: z.string() }).strict(),
    z.object({ content: z.string(), exists: z.boolean() }),
  ),
  'tabs.get': ch(
    'tabs.get',
    1,
    z.object({}).strict(),
    z.object({ tabs: OpenTabsStateSchema.nullable() }),
  ),
  'tabs.save': ch(
    'tabs.save',
    1,
    z.object({ tabs: OpenTabsStateSchema }).strict(),
    z.object({ saved: z.boolean() }),
  ),
  'search.files': ch(
    'search.files',
    1,
    z.object({ query: z.string().max(500) }).strict(),
    z.object({
      items: z.array(z.object({ path: z.string(), positions: z.array(z.number()) })),
      total: z.number(),
    }),
  ),
  'search.allFiles': ch(
    'search.allFiles',
    1,
    z.object({}).strict(),
    z.object({ files: z.array(z.string()), truncated: z.boolean() }),
  ),
  'search.textStart': ch(
    'search.textStart',
    1,
    z
      .object({
        query: z.string().min(1).max(2000),
        isRegex: z.boolean(),
        caseSensitive: z.boolean(),
        wholeWord: z.boolean(),
        includeGlob: z.string().max(500).optional(),
        excludeGlob: z.string().max(500).optional(),
        maxResults: z.number().int().min(1).max(20000).default(2000),
      })
      .strict(),
    z.object({ searchId: z.string() }),
  ),
  'search.cancel': ch(
    'search.cancel',
    1,
    z.object({ searchId: z.string() }).strict(),
    z.object({ cancelled: z.boolean() }),
  ),
  'search.replace': ch(
    'search.replace',
    1,
    z
      .object({
        files: z.array(
          z.object({
            path: z.string(),
            expectedHash: z.string(),
            edits: z.array(
              z.object({ start: z.number().int(), end: z.number().int(), text: z.string() }),
            ),
          }),
        ),
      })
      .strict(),
    z.object({
      outcomes: z.array(
        z.object({
          path: z.string(),
          status: z.enum(['applied', 'stale', 'error']),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
  'terminal.create': ch(
    'terminal.create',
    1,
    z.object({ cwd: z.string().optional() }).strict(),
    z.object({
      id: z.string(),
      title: z.string(),
      shell: z.string(),
      pid: z.number(),
    }),
  ),
  'terminal.write': ch(
    'terminal.write',
    1,
    z.object({ id: z.string(), data: z.string().max(1024 * 128) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'terminal.resize': ch(
    'terminal.resize',
    1,
    z.object({ id: z.string(), cols: z.number().int(), rows: z.number().int() }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'terminal.kill': ch(
    'terminal.kill',
    1,
    z.object({ id: z.string(), force: z.boolean().default(false) }).strict(),
    z.object({ closed: z.boolean(), needsConfirm: z.boolean() }),
  ),
  'terminal.list': ch(
    'terminal.list',
    1,
    z.object({}).strict(),
    z.object({
      items: z.array(
        z.object({ id: z.string(), title: z.string(), shell: z.string(), pid: z.number() }),
      ),
    }),
  ),
  'lsp.status': ch(
    'lsp.status',
    1,
    z.object({}).strict(),
    z.object({
      python: z.object({
        available: z.boolean(),
        serverPath: z.string().nullable(),
        running: z.boolean(),
        hint: z.string(),
      }),
    }),
  ),
  'lsp.pythonRequest': ch(
    'lsp.pythonRequest',
    1,
    z
      .object({
        method: z.enum(['completion', 'hover', 'definition', 'symbols']),
        path: z.string(),
        line: z.number().int().min(0),
        character: z.number().int().min(0),
      })
      .strict(),
    z.object({ result: z.unknown() }),
  ),
} as const;

export type ChannelName = keyof typeof CHANNELS;
export type ChannelRequest<N extends ChannelName> = z.infer<(typeof CHANNELS)[N]['request']>;
export type ChannelResponse<N extends ChannelName> = z.infer<(typeof CHANNELS)[N]['response']>;

export function isKnownChannel(name: string): name is ChannelName {
  return Object.prototype.hasOwnProperty.call(CHANNELS, name);
}

export function getChannel(name: ChannelName): ChannelDef {
  if (!isKnownChannel(name)) {
    throw new Error(`Unknown IPC channel: ${String(name)}`);
  }
  return CHANNELS[name];
}

export function validateChannelRequest(name: ChannelName, payload: unknown): Result<unknown> {
  const def = getChannel(name);
  const parsed = def.request.safeParse(payload);
  if (!parsed.success) {
    return fail(
      productError('IPC_SCHEMA_VIOLATION', {
        userMessage: 'The application sent an invalid internal request.',
        technicalMessage: parsed.error.message.slice(0, 2000),
        context: { channel: name },
      }),
    );
  }
  return ok(parsed.data);
}
