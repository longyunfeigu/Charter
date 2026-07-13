import { z } from 'zod';
import { fail, ok, productError, type Result } from '@pi-ide/foundation';
import { AppInfoSchema, RecentWorkspaceSchema, WorkspaceDtoSchema } from './dto.js';
import { SettingsSchema } from './settings.js';
import { LayoutStateSchema } from './layout.js';
import { DirEntrySchema, DocumentDtoSchema, EolSchema, OpenTabsStateSchema } from './documents.js';
import {
  AgentModeSchema,
  AskUserPromptDtoSchema,
  ChangeSetDtoSchema,
  ModelDescriptorDtoSchema,
  ModelRefSchema,
  PermissionCardDtoSchema,
  PlanEditDtoSchema,
  TaskDtoSchema,
  TimelineEventDtoSchema,
  VerificationCommandSchema,
  VerificationRunDtoSchema,
} from './agent-dto.js';
import { ActivityItemSchema } from './activity.js';

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
  'git.status': ch(
    'git.status',
    1,
    z.object({}).strict(),
    z.object({
      gitAvailable: z.boolean(),
      isRepo: z.boolean(),
      branch: z.string().nullable(),
      upstream: z.string().nullable(),
      ahead: z.number(),
      behind: z.number(),
      detached: z.boolean(),
      head: z.string().nullable(),
      entries: z.array(
        z.object({
          path: z.string(),
          origPath: z.string().nullable(),
          group: z.enum(['staged', 'changes', 'untracked', 'conflict']),
          indexState: z.string(),
          workState: z.string(),
        }),
      ),
    }),
  ),
  'git.diffFile': ch(
    'git.diffFile',
    1,
    z.object({ path: z.string(), staged: z.boolean() }).strict(),
    z.object({ diff: z.string() }),
  ),
  'git.show': ch(
    'git.show',
    1,
    z.object({ path: z.string(), ref: z.string() }).strict(),
    z.object({ content: z.string() }),
  ),
  'git.stage': ch(
    'git.stage',
    1,
    z.object({ paths: z.array(z.string()).min(1).max(500) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'git.unstage': ch(
    'git.unstage',
    1,
    z.object({ paths: z.array(z.string()).min(1).max(500) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'git.discard': ch(
    'git.discard',
    1,
    z
      .object({ paths: z.array(z.string()).min(1).max(500), includeUntracked: z.boolean() })
      .strict(),
    z.object({ ok: z.boolean() }),
  ),
  'git.commit': ch(
    'git.commit',
    1,
    z.object({ message: z.string().min(1).max(5000) }).strict(),
    z.object({ output: z.string() }),
  ),
  'git.branches': ch(
    'git.branches',
    1,
    z.object({}).strict(),
    z.object({ items: z.array(z.object({ name: z.string(), current: z.boolean() })) }),
  ),
  'git.checkout': ch(
    'git.checkout',
    1,
    z.object({ name: z.string().min(1).max(200) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'git.createBranch': ch(
    'git.createBranch',
    1,
    z.object({ name: z.string().min(1).max(200) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'git.init': ch('git.init', 1, z.object({}).strict(), z.object({ ok: z.boolean() })),
  'task.create': ch(
    'task.create',
    1,
    z
      .object({
        title: z.string().min(1).max(300),
        goalMd: z.string().min(1).max(20000),
        acceptance: z.array(z.string().max(1000)).max(20).default([]),
        mode: AgentModeSchema,
        model: ModelRefSchema,
        verification: z.array(VerificationCommandSchema).max(10).default([]),
      })
      .strict(),
    z.object({ task: TaskDtoSchema }),
  ),
  'task.start': ch(
    'task.start',
    1,
    z.object({ taskId: z.string(), prompt: z.string().max(20000).optional() }).strict(),
    z.object({ task: TaskDtoSchema, queued: z.boolean() }),
  ),
  'task.message': ch(
    'task.message',
    1,
    z
      .object({
        taskId: z.string(),
        text: z.string().min(1).max(20000),
        during: z.enum(['steer', 'followUp']).default('steer'),
      })
      .strict(),
    z.object({ delivered: z.enum(['started', 'steered', 'queued']) }),
  ),
  'task.stop': ch(
    'task.stop',
    1,
    z.object({ taskId: z.string() }).strict(),
    z.object({ task: TaskDtoSchema }),
  ),
  'task.list': ch(
    'task.list',
    1,
    z
      .object({
        filter: z.enum(['all', 'active', 'review', 'done', 'failed']).default('all'),
        includeArchived: z.boolean().default(false),
      })
      .strict(),
    z.object({ tasks: z.array(TaskDtoSchema) }),
  ),
  'task.get': ch(
    'task.get',
    1,
    z.object({ taskId: z.string(), eventsAfter: z.number().int().default(0) }).strict(),
    z.object({ task: TaskDtoSchema, timeline: z.array(TimelineEventDtoSchema) }),
  ),
  'task.archive': ch(
    'task.archive',
    1,
    z.object({ taskId: z.string() }).strict(),
    z.object({ task: TaskDtoSchema }),
  ),
  'task.permissionDecision': ch(
    'task.permissionDecision',
    1,
    z
      .object({
        requestId: z.string(),
        kind: z.enum(['allow', 'deny']),
        scope: z.enum(['once', 'task', 'workspace', 'always']),
        expectedParamsHash: z.string(),
        reason: z.string().max(2000).optional(),
        applyToSimilar: z.boolean().default(false),
      })
      .strict(),
    z.object({ resolvedRequestIds: z.array(z.string()) }),
  ),
  'task.pendingPermissions': ch(
    'task.pendingPermissions',
    1,
    z.object({ taskId: z.string() }).strict(),
    z.object({
      permissions: z.array(PermissionCardDtoSchema),
      asks: z.array(AskUserPromptDtoSchema),
    }),
  ),
  'task.answerUser': ch(
    'task.answerUser',
    1,
    z.object({ callId: z.string(), answer: z.string().max(20000) }).strict(),
    z.object({ ok: z.boolean() }),
  ),
  'task.planDecision': ch(
    'task.planDecision',
    1,
    z
      .object({
        taskId: z.string(),
        decision: z.enum(['approve', 'reject']),
        editedPlan: PlanEditDtoSchema.optional(),
        reason: z.string().max(2000).optional(),
        confirmRemovedDone: z.boolean().default(false),
      })
      .strict(),
    z.object({ task: TaskDtoSchema }),
  ),
  'task.changeSet': ch(
    'task.changeSet',
    1,
    z.object({ taskId: z.string() }).strict(),
    z.object({ changeSet: ChangeSetDtoSchema }),
  ),
  'task.reviewDecision': ch(
    'task.reviewDecision',
    1,
    z
      .object({
        taskId: z.string(),
        path: z.string().min(1),
        scope: z.enum(['file', 'hunk']),
        decision: z.enum(['accept', 'reject']),
        hunkKey: z.string().max(100).optional(),
        expectedCurrentHash: z.string().max(128).optional(),
      })
      .strict(),
    z.object({ status: z.enum(['applied', 'stale']), changeSet: ChangeSetDtoSchema }),
  ),
  'task.accept': ch(
    'task.accept',
    1,
    z.object({ taskId: z.string(), confirmUnverified: z.boolean().default(false) }).strict(),
    z.object({ task: TaskDtoSchema }),
  ),
  'task.rollback': ch(
    'task.rollback',
    1,
    z.object({ taskId: z.string(), force: z.boolean().default(false) }).strict(),
    z.object({
      status: z.enum(['ok', 'conflicts']),
      task: TaskDtoSchema,
      restored: z.array(z.string()).optional(),
      conflicts: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
    }),
  ),
  'task.runVerification': ch(
    'task.runVerification',
    1,
    z.object({ taskId: z.string(), label: z.string().max(120).optional() }).strict(),
    z.object({ configured: z.boolean(), runs: z.array(VerificationRunDtoSchema) }),
  ),
  'task.verificationRuns': ch(
    'task.verificationRuns',
    1,
    z.object({ taskId: z.string() }).strict(),
    z.object({ runs: z.array(VerificationRunDtoSchema) }),
  ),
  'task.suggestVerifications': ch(
    'task.suggestVerifications',
    1,
    z.object({}).strict(),
    z.object({ suggestions: z.array(VerificationCommandSchema) }),
  ),
  'task.activity': ch(
    'task.activity',
    1,
    z
      .object({
        taskId: z.string(),
        /** Return only the last N items (dashboard hydration); omit for full replay. */
        tail: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    z.object({ items: z.array(ActivityItemSchema), total: z.number().int() }),
  ),
  'task.changeRecord': ch(
    'task.changeRecord',
    1,
    z.object({ taskId: z.string(), changeId: z.string() }).strict(),
    z.object({
      record: z
        .object({
          id: z.string(),
          taskId: z.string(),
          path: z.string(),
          kind: z.enum(['created', 'modified', 'deleted', 'renamed']),
          beforeHash: z.string().nullable(),
          afterHash: z.string().nullable(),
          patch: z.string().nullable(),
          renameTo: z.string().nullable(),
          author: z.enum(['agent', 'user', 'system']),
          toolCallId: z.string().nullable(),
          createdAt: z.string(),
        })
        .nullable(),
    }),
  ),
  'workspace.relativize': ch(
    'workspace.relativize',
    1,
    z.object({ paths: z.array(z.string().min(1).max(2000)).min(1).max(50) }).strict(),
    z.object({
      inside: z.array(z.object({ abs: z.string(), rel: z.string() })),
      outside: z.array(z.string()),
    }),
  ),
  'fs.readImage': ch(
    'fs.readImage',
    1,
    z.object({ path: z.string().min(1) }).strict(),
    z.object({ dataBase64: z.string(), mime: z.string(), sizeBytes: z.number().int() }),
  ),
  'image.saveAnnotated': ch(
    'image.saveAnnotated',
    1,
    z
      .object({
        sourcePath: z.string().min(1),
        /** PNG bytes; ~24 MB base64 cap keeps the IPC payload bounded. */
        dataBase64: z
          .string()
          .min(1)
          .max(32 * 1024 * 1024),
      })
      .strict(),
    z.object({ path: z.string() }),
  ),
  'models.list': ch(
    'models.list',
    1,
    z.object({}).strict(),
    z.object({ models: z.array(ModelDescriptorDtoSchema), workerAlive: z.boolean() }),
  ),
  'models.fetchRemote': ch(
    'models.fetchRemote',
    1,
    z.object({ providerId: z.string().min(1).max(100) }).strict(),
    z.object({ models: z.array(ModelDescriptorDtoSchema) }),
  ),
  'secrets.set': ch(
    'secrets.set',
    1,
    z
      .object({ providerId: z.string().min(1).max(100), apiKey: z.string().min(1).max(4000) })
      .strict(),
    z.object({ configured: z.boolean() }),
  ),
  'secrets.delete': ch(
    'secrets.delete',
    1,
    z.object({ providerId: z.string() }).strict(),
    z.object({ deleted: z.boolean() }),
  ),
  'secrets.list': ch(
    'secrets.list',
    1,
    z.object({}).strict(),
    z.object({
      items: z.array(
        z.object({ providerId: z.string(), configured: z.boolean(), hint: z.string() }),
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
