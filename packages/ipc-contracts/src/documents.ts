import { z } from 'zod';

export const EolSchema = z.enum(['lf', 'crlf']);
export const ExternalStateSchema = z.enum(['clean', 'externallyModified', 'externallyDeleted']);

export const DocumentDtoSchema = z.object({
  relativePath: z.string(),
  content: z.string(),
  diskRevision: z.number().int(),
  bufferRevision: z.number().int(),
  savedRevision: z.number().int(),
  contentHash: z.string(),
  diskHash: z.string().nullable(),
  dirty: z.boolean(),
  eol: EolSchema,
  encoding: z.enum(['utf8', 'utf8-bom']),
  binary: z.boolean(),
  largeFile: z.boolean(),
  editable: z.boolean(),
  readonly: z.boolean(),
  externalState: ExternalStateSchema,
  sizeBytes: z.number().int(),
});
export type DocumentDto = z.infer<typeof DocumentDtoSchema>;

export const DirEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(['file', 'dir', 'symlink', 'other']),
  size: z.number().nullable(),
  ignored: z.boolean(),
});
export type DirEntryDto = z.infer<typeof DirEntrySchema>;

export const FsChangeSchema = z.object({
  kind: z.enum(['created', 'modified', 'deleted']),
  relativePath: z.string(),
  isDirectory: z.boolean(),
});

export const OpenTabsStateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  groups: z
    .array(
      z.object({
        tabs: z.array(
          z.object({
            path: z.string(),
            pinned: z.boolean().default(false),
            // Additive since beta.6: a tab is either a plain file buffer or a
            // git diff view of that path. Older payloads default to 'file';
            // older builds strip the extra keys and fall back to a file tab.
            kind: z.enum(['file', 'diff']).default('file'),
            /** Diff tabs only: staged (HEAD ↔ index) vs working tree (index ↔ disk). */
            staged: z.boolean().optional(),
          }),
        ),
        active: z.string().nullable(),
      }),
    )
    .max(2),
  activeGroup: z.number().int().min(0).max(1),
  splitDirection: z.enum(['horizontal', 'vertical']).nullable().default(null),
});
export type OpenTabsState = z.infer<typeof OpenTabsStateSchema>;
