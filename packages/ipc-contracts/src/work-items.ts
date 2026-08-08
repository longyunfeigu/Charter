import { z } from 'zod';

export const WorkItemStatusCategorySchema = z.enum([
  'inbox',
  'planned',
  'active',
  'waiting',
  'review',
  'completed',
  'cancelled',
]);
export type WorkItemStatusCategory = z.infer<typeof WorkItemStatusCategorySchema>;

export const WorkItemPrioritySchema = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
export type WorkItemPriority = z.infer<typeof WorkItemPrioritySchema>;

export const WorkItemFieldKindSchema = z.enum([
  'text',
  'long_text',
  'number',
  'date',
  'url',
  'select',
  'multi_select',
  'checkbox',
]);

export const WorkItemFieldDefinitionSchema = z
  .object({
    key: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    kind: WorkItemFieldKindSchema,
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(120)).max(40).default([]),
    placeholder: z.string().max(300).default(''),
  })
  .strict();
export type WorkItemFieldDefinition = z.infer<typeof WorkItemFieldDefinitionSchema>;

export const WorkItemTypeDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    icon: z.string(),
    color: z.string(),
    description: z.string(),
    fieldDefinitions: z.array(WorkItemFieldDefinitionSchema),
    builtIn: z.boolean(),
    archived: z.boolean(),
    position: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkItemTypeDto = z.infer<typeof WorkItemTypeDtoSchema>;

export const WorkBoardColumnDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: WorkItemStatusCategorySchema,
    color: z.string(),
    position: z.number().int(),
    wipLimit: z.number().int().positive().nullable(),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkBoardColumnDto = z.infer<typeof WorkBoardColumnDtoSchema>;

export const WorkChecklistItemSchema = z
  .object({
    id: z.string().min(1).max(120),
    text: z.string().min(1).max(1000),
    checked: z.boolean(),
  })
  .strict();
export type WorkChecklistItem = z.infer<typeof WorkChecklistItemSchema>;

export const WorkCustomFieldValueSchema = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(1000)).max(100),
  z.null(),
]);
export type WorkCustomFieldValue = z.infer<typeof WorkCustomFieldValueSchema>;
export const WorkCustomFieldsSchema = z.record(z.string(), WorkCustomFieldValueSchema);

export const WorkItemDtoSchema = z
  .object({
    id: z.string(),
    typeId: z.string(),
    columnId: z.string(),
    title: z.string(),
    descriptionMd: z.string(),
    backgroundMd: z.string(),
    sourcePerson: z.string(),
    sourceChannel: z.string(),
    sourceUrl: z.string(),
    assignee: z.string(),
    priority: WorkItemPrioritySchema,
    labels: z.array(z.string()),
    startAt: z.string().nullable(),
    dueAt: z.string().nullable(),
    acceptance: z.array(WorkChecklistItemSchema),
    deliverables: z.array(WorkChecklistItemSchema),
    customFields: WorkCustomFieldsSchema,
    position: z.number(),
    archived: z.boolean(),
    version: z.number().int().positive(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
  })
  .strict();
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;

export const WorkExecutionTargetKindSchema = z.enum(['session', 'mission', 'terminal', 'manual']);
export type WorkExecutionTargetKind = z.infer<typeof WorkExecutionTargetKindSchema>;
export const WorkExecutionRoleSchema = z.enum([
  'primary',
  'collaborator',
  'reviewer',
  'alternative',
]);
export type WorkExecutionRole = z.infer<typeof WorkExecutionRoleSchema>;
export const WorkExecutionDtoSchema = z
  .object({
    id: z.string(),
    workItemId: z.string(),
    targetKind: WorkExecutionTargetKindSchema,
    targetId: z.string().nullable(),
    role: WorkExecutionRoleSchema,
    approach: z.string(),
    displayLabel: z.string(),
    agentLabel: z.string(),
    status: z.string(),
    summary: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkExecutionDto = z.infer<typeof WorkExecutionDtoSchema>;

export const WorkReminderStateSchema = z.enum(['scheduled', 'fired', 'snoozed', 'cancelled']);
export const WorkReminderDtoSchema = z
  .object({
    id: z.string(),
    workItemId: z.string(),
    remindAt: z.string(),
    state: WorkReminderStateSchema,
    message: z.string(),
    firedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type WorkReminderDto = z.infer<typeof WorkReminderDtoSchema>;

export const WorkEvidenceKindSchema = z.enum([
  'note',
  'link',
  'file',
  'metric',
  'approval',
  'session',
  'mission',
]);
export type WorkEvidenceKind = z.infer<typeof WorkEvidenceKindSchema>;
export const WorkEvidenceDtoSchema = z
  .object({
    id: z.string(),
    workItemId: z.string(),
    kind: WorkEvidenceKindSchema,
    label: z.string(),
    value: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type WorkEvidenceDto = z.infer<typeof WorkEvidenceDtoSchema>;

export const WorkItemEventDtoSchema = z
  .object({
    id: z.string(),
    workItemId: z.string(),
    sequence: z.number().int().positive(),
    type: z.string(),
    actor: z.string(),
    payload: z.record(z.string(), z.unknown()),
    createdAt: z.string(),
  })
  .strict();
export type WorkItemEventDto = z.infer<typeof WorkItemEventDtoSchema>;

export const WorkBoardSnapshotDtoSchema = z
  .object({
    columns: z.array(WorkBoardColumnDtoSchema),
    types: z.array(WorkItemTypeDtoSchema),
    items: z.array(WorkItemDtoSchema),
    executions: z.array(WorkExecutionDtoSchema),
    reminders: z.array(WorkReminderDtoSchema),
  })
  .strict();
export type WorkBoardSnapshotDto = z.infer<typeof WorkBoardSnapshotDtoSchema>;

export const WorkItemDetailDtoSchema = z
  .object({
    item: WorkItemDtoSchema,
    executions: z.array(WorkExecutionDtoSchema),
    reminders: z.array(WorkReminderDtoSchema),
    evidence: z.array(WorkEvidenceDtoSchema),
    events: z.array(WorkItemEventDtoSchema),
  })
  .strict();
export type WorkItemDetailDto = z.infer<typeof WorkItemDetailDtoSchema>;

const WorkItemMutableInputShape = {
  typeId: z.string().min(1).max(120),
  title: z.string().trim().min(1).max(500),
  descriptionMd: z.string().max(50_000),
  backgroundMd: z.string().max(100_000),
  sourcePerson: z.string().max(500),
  sourceChannel: z.string().max(500),
  sourceUrl: z.string().max(4000),
  assignee: z.string().max(500),
  priority: WorkItemPrioritySchema,
  labels: z.array(z.string().min(1).max(100)).max(30),
  startAt: z.string().datetime().nullable(),
  dueAt: z.string().datetime().nullable(),
  acceptance: z.array(WorkChecklistItemSchema).max(100),
  deliverables: z.array(WorkChecklistItemSchema).max(100),
  customFields: WorkCustomFieldsSchema,
} as const;

export const WorkItemCreateInputSchema = z
  .object({
    typeId: WorkItemMutableInputShape.typeId,
    columnId: z.string().min(1).max(120).optional(),
    title: WorkItemMutableInputShape.title,
    descriptionMd: WorkItemMutableInputShape.descriptionMd.default(''),
    backgroundMd: WorkItemMutableInputShape.backgroundMd.default(''),
    sourcePerson: WorkItemMutableInputShape.sourcePerson.default(''),
    sourceChannel: WorkItemMutableInputShape.sourceChannel.default(''),
    sourceUrl: WorkItemMutableInputShape.sourceUrl.default(''),
    assignee: WorkItemMutableInputShape.assignee.default(''),
    priority: WorkItemMutableInputShape.priority.default('none'),
    labels: WorkItemMutableInputShape.labels.default([]),
    startAt: WorkItemMutableInputShape.startAt.default(null),
    dueAt: WorkItemMutableInputShape.dueAt.default(null),
    reminderAt: z.string().datetime().nullable().default(null),
    acceptance: WorkItemMutableInputShape.acceptance.default([]),
    deliverables: WorkItemMutableInputShape.deliverables.default([]),
    customFields: WorkItemMutableInputShape.customFields.default({}),
  })
  .strict();
export type WorkItemCreateInput = z.infer<typeof WorkItemCreateInputSchema>;

export const WorkItemUpdateInputSchema = z
  .object(WorkItemMutableInputShape)
  .partial()
  .extend({
    id: z.string().min(1),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type WorkItemUpdateInput = z.infer<typeof WorkItemUpdateInputSchema>;
