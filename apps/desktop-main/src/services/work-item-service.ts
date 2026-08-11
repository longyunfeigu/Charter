import {
  WorkBoardColumnDtoSchema,
  WorkBoardSnapshotDtoSchema,
  WorkEvidenceDtoSchema,
  WorkExecutionDtoSchema,
  WorkItemDetailDtoSchema,
  WorkItemDtoSchema,
  WorkItemTypeDtoSchema,
  WorkReminderDtoSchema,
  type WorkBoardColumnDto,
  type WorkBoardSnapshotDto,
  type WorkChecklistItem,
  type WorkCustomFieldValue,
  type WorkEvidenceDto,
  type WorkEvidenceKind,
  type WorkExecutionDto,
  type WorkExecutionRole,
  type WorkExecutionTargetKind,
  type WorkItemCreateInput,
  type WorkItemDetailDto,
  type WorkItemDto,
  type WorkItemFieldDefinition,
  type WorkItemStatusCategory,
  type WorkItemTypeDto,
  type WorkItemUpdateInput,
  type WorkReminderDto,
} from '@pi-ide/ipc-contracts';
import { newId, productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { SqlDatabase } from '@pi-ide/persistence';

interface ReminderAlert {
  item: WorkItemDto;
  reminder: WorkReminderDto;
}

interface WorkItemServiceOptions {
  now?: () => Date;
  changed?: (itemId: string | null, reason: string) => void;
  reminderDue?: (alert: ReminderAlert) => void;
}

const DEFAULT_COLUMNS: Array<{
  id: string;
  name: string;
  category: WorkItemStatusCategory;
  color: string;
}> = [
  { id: 'work-col-inbox', name: 'Inbox', category: 'inbox', color: '#64748b' },
  { id: 'work-col-active', name: 'In progress', category: 'active', color: '#7c5cff' },
  { id: 'work-col-waiting', name: 'Waiting', category: 'waiting', color: '#d97706' },
  { id: 'work-col-review', name: 'Review', category: 'review', color: '#0891b2' },
  { id: 'work-col-done', name: 'Done', category: 'completed', color: '#2f9e63' },
];

const DEFAULT_TYPES: Array<{
  id: string;
  name: string;
  icon: string;
  color: string;
  description: string;
  fields: WorkItemFieldDefinition[];
}> = [
  {
    id: 'work-type-generic',
    name: 'General',
    icon: 'circle',
    color: '#64748b',
    description: 'A flexible task for any kind of work.',
    fields: [],
  },
  {
    id: 'work-type-product',
    name: 'Product',
    icon: 'compass',
    color: '#7c5cff',
    description: 'Discovery, specification, rollout and product decisions.',
    fields: [
      field('user_problem', 'User problem', 'long_text', true),
      field('target_users', 'Target users', 'text'),
      field('success_metric', 'Success metric', 'text'),
      field('release_target', 'Release target', 'date'),
    ],
  },
  {
    id: 'work-type-operations',
    name: 'Operations',
    icon: 'bolt',
    color: '#d97706',
    description: 'Campaigns, launches, partner operations and external actions.',
    fields: [
      field('channel', 'Channel', 'text', true),
      field('audience', 'Audience', 'text'),
      field('runbook', 'Runbook / procedure', 'long_text'),
      field('external_action', 'External action', 'checkbox'),
      field('approval_owner', 'Approval owner', 'text'),
    ],
  },
  {
    id: 'work-type-research',
    name: 'Research',
    icon: 'search',
    color: '#2563eb',
    description: 'Source-backed investigation that supports a decision.',
    fields: [
      field('question', 'Research question', 'long_text', true),
      field('source_standard', 'Source standard', 'text'),
      field('decision', 'Decision this informs', 'long_text'),
    ],
  },
  {
    id: 'work-type-content',
    name: 'Content',
    icon: 'file',
    color: '#db2777',
    description: 'Copy, editorial, social, lifecycle and publishing work.',
    fields: [
      field('format', 'Format', 'text'),
      field('audience', 'Audience', 'text'),
      field('publish_at', 'Publish at', 'date'),
      field('approval_owner', 'Approval owner', 'text'),
    ],
  },
  {
    id: 'work-type-data',
    name: 'Data',
    icon: 'chart',
    color: '#059669',
    description: 'Analysis, reporting, spreadsheets and metric investigations.',
    fields: [
      field('dataset', 'Dataset', 'text', true),
      field('metric_definition', 'Metric definition', 'long_text'),
      field('output_format', 'Output format', 'text'),
    ],
  },
  {
    id: 'work-type-engineering',
    name: 'Engineering',
    icon: 'terminal',
    color: '#475569',
    description: 'Code, infrastructure, investigation and technical delivery.',
    fields: [
      field('repository', 'Repository / project', 'text'),
      field('environment', 'Environment', 'text'),
      field('risk', 'Risk level', 'select', false, ['Low', 'Medium', 'High']),
      field('verification', 'Verification', 'long_text'),
    ],
  },
  {
    id: 'work-type-approval',
    name: 'Approval',
    icon: 'check',
    color: '#9333ea',
    description: 'A decision with explicit options, owner and rationale.',
    fields: [
      field('decision_needed', 'Decision needed', 'long_text', true),
      field('options', 'Options', 'long_text'),
      field('decision_owner', 'Decision owner', 'text', true),
    ],
  },
];

function field(
  key: string,
  label: string,
  kind: WorkItemFieldDefinition['kind'],
  required = false,
  options: string[] = [],
): WorkItemFieldDefinition {
  return { key, label, kind, required, options, placeholder: '' };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asBoolean(value: number): boolean {
  return value === 1;
}

type Row = Record<string, unknown>;

export class WorkItemService {
  private readonly now: () => Date;
  private readonly changed: (itemId: string | null, reason: string) => void;
  private readonly reminderDue: (alert: ReminderAlert) => void;
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly db: SqlDatabase,
    private readonly logger: Logger,
    options: WorkItemServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.changed = options.changed ?? (() => undefined);
    this.reminderDue = options.reminderDue ?? (() => undefined);
    this.seedDefaults();
  }

  start(): void {
    this.scheduleReminderSweep(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    this.reminderTimer = null;
  }

  snapshot(includeArchived = false): WorkBoardSnapshotDto {
    const itemWhere = includeArchived ? '' : 'WHERE archived = 0';
    const items = this.db
      .prepare(`SELECT * FROM work_items ${itemWhere} ORDER BY column_id, position, created_at`)
      .all()
      .map((row) => this.itemFromRow(row as Row));
    const ids = new Set(items.map((item) => item.id));
    const executions = this.db
      .prepare('SELECT * FROM work_item_executions ORDER BY created_at')
      .all()
      .map((row) => this.executionFromRow(row as Row))
      .filter((execution) => ids.has(execution.workItemId))
      .map((execution) => this.withLiveExecutionStatus(execution));
    const reminders = this.db
      .prepare('SELECT * FROM work_item_reminders ORDER BY remind_at, created_at')
      .all()
      .map((row) => this.reminderFromRow(row as Row))
      .filter((reminder) => ids.has(reminder.workItemId));
    return WorkBoardSnapshotDtoSchema.parse({
      columns: this.columns(includeArchived),
      types: this.types(includeArchived),
      items,
      executions,
      reminders,
    });
  }

  detail(id: string): WorkItemDetailDto {
    const item = this.requireItem(id);
    const executions = this.db
      .prepare('SELECT * FROM work_item_executions WHERE work_item_id = ? ORDER BY created_at')
      .all(id)
      .map((row) => this.withLiveExecutionStatus(this.executionFromRow(row as Row)));
    const reminders = this.db
      .prepare('SELECT * FROM work_item_reminders WHERE work_item_id = ? ORDER BY remind_at')
      .all(id)
      .map((row) => this.reminderFromRow(row as Row));
    const evidence = this.db
      .prepare('SELECT * FROM work_item_evidence WHERE work_item_id = ? ORDER BY created_at DESC')
      .all(id)
      .map((row) => this.evidenceFromRow(row as Row));
    const events = this.db
      .prepare(
        'SELECT * FROM work_item_events WHERE work_item_id = ? ORDER BY sequence DESC LIMIT 200',
      )
      .all(id)
      .map((row) => ({
        id: String((row as Row).id),
        workItemId: String((row as Row).work_item_id),
        sequence: Number((row as Row).sequence),
        type: String((row as Row).type),
        actor: String((row as Row).actor),
        payload: parseJson(String((row as Row).payload_json), {}),
        createdAt: String((row as Row).created_at),
      }));
    return WorkItemDetailDtoSchema.parse({ item, executions, reminders, evidence, events });
  }

  create(input: WorkItemCreateInput): WorkItemDto {
    this.requireType(input.typeId);
    const column = input.columnId
      ? this.requireColumn(input.columnId)
      : (this.columns(false).find((candidate) => candidate.category === 'inbox') ??
        this.columns(false)[0]);
    if (!column) throw this.failure('WORK_BOARD_EMPTY', 'The work board has no active column.');
    this.validateCustomFields(input.typeId, input.customFields);
    const at = this.now().toISOString();
    const id = newId('work');
    const position = this.nextPosition(column.id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, type_id, column_id, title, description_md, background_md,
            source_person, source_channel, source_url, assignee, priority,
            labels_json, start_at, due_at, acceptance_json, deliverables_json,
            custom_fields_json, position, archived, version, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`,
        )
        .run(
          id,
          input.typeId,
          column.id,
          input.title.trim(),
          input.descriptionMd,
          input.backgroundMd,
          input.sourcePerson,
          input.sourceChannel,
          input.sourceUrl,
          input.assignee,
          input.priority,
          JSON.stringify(input.labels),
          input.startAt,
          input.dueAt,
          JSON.stringify(input.acceptance),
          JSON.stringify(input.deliverables),
          JSON.stringify(input.customFields),
          position,
          at,
          at,
          column.category === 'completed' ? at : null,
        );
      this.recordEvent(id, 'work_item.created', 'You', {
        columnId: column.id,
        typeId: input.typeId,
      });
      if (input.reminderAt) this.insertReminder(id, input.reminderAt, '', at);
    });
    this.emit(id, 'created');
    this.scheduleReminderSweep();
    return this.requireItem(id);
  }

  update(input: WorkItemUpdateInput): WorkItemDto {
    const current = this.requireItem(input.id);
    if (current.version !== input.expectedVersion) throw this.conflict(current);
    const nextTypeId = input.typeId ?? current.typeId;
    this.requireType(nextTypeId);
    const nextCustomFields = input.customFields ?? current.customFields;
    this.validateCustomFields(nextTypeId, nextCustomFields);
    const at = this.now().toISOString();
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const columns: Record<string, string> = {
      typeId: 'type_id',
      title: 'title',
      descriptionMd: 'description_md',
      backgroundMd: 'background_md',
      sourcePerson: 'source_person',
      sourceChannel: 'source_channel',
      sourceUrl: 'source_url',
      assignee: 'assignee',
      priority: 'priority',
      startAt: 'start_at',
      dueAt: 'due_at',
    };
    for (const [key, column] of Object.entries(columns)) {
      const value = input[key as keyof WorkItemUpdateInput];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    const jsonColumns: Array<[keyof WorkItemUpdateInput, string]> = [
      ['labels', 'labels_json'],
      ['acceptance', 'acceptance_json'],
      ['deliverables', 'deliverables_json'],
      ['customFields', 'custom_fields_json'],
    ];
    for (const [key, column] of jsonColumns) {
      const value = input[key];
      if (value === undefined) continue;
      assignments.push(`${column} = ?`);
      values.push(JSON.stringify(value));
    }
    if (assignments.length === 0) return current;
    assignments.push('updated_at = ?', 'version = version + 1');
    values.push(at, input.id, input.expectedVersion);
    const result = this.db.transaction(() => {
      const run = this.db
        .prepare(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ? AND version = ?`)
        .run(...values);
      if (Number(run.changes) !== 1) throw this.conflict(this.requireItem(input.id));
      this.recordEvent(input.id, 'work_item.updated', 'You', {
        fields: [...Object.keys(columns), ...jsonColumns.map(([key]) => key)].filter(
          (key) => input[key as keyof WorkItemUpdateInput] !== undefined,
        ),
      });
      return this.requireItem(input.id);
    });
    this.emit(input.id, 'updated');
    return result;
  }

  move(input: {
    id: string;
    columnId: string;
    beforeId: string | null;
    expectedVersion: number;
  }): WorkItemDto {
    const current = this.requireItem(input.id);
    if (current.version !== input.expectedVersion) throw this.conflict(current);
    const column = this.requireColumn(input.columnId);
    this.enforceWipLimit(column, current.columnId);
    const at = this.now().toISOString();
    const completedAt = column.category === 'completed' ? (current.completedAt ?? at) : null;
    this.db.transaction(() => {
      const ids = (
        this.db
          .prepare(
            'SELECT id FROM work_items WHERE column_id = ? AND archived = 0 AND id <> ? ORDER BY position, created_at',
          )
          .all(column.id, input.id) as Array<{ id: string }>
      ).map((row) => row.id);
      const beforeIndex = input.beforeId ? ids.indexOf(input.beforeId) : -1;
      ids.splice(beforeIndex >= 0 ? beforeIndex : ids.length, 0, input.id);
      ids.forEach((id, index) => {
        if (id === input.id) {
          const run = this.db
            .prepare(
              `UPDATE work_items SET column_id = ?, position = ?, completed_at = ?,
               updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
            )
            .run(column.id, (index + 1) * 1024, completedAt, at, id, input.expectedVersion);
          if (Number(run.changes) !== 1) throw this.conflict(this.requireItem(id));
        } else {
          this.db
            .prepare('UPDATE work_items SET position = ? WHERE id = ?')
            .run((index + 1) * 1024, id);
        }
      });
      this.recordEvent(input.id, 'work_item.moved', 'You', {
        fromColumnId: current.columnId,
        toColumnId: column.id,
      });
      if (column.category === 'completed') {
        this.db
          .prepare(
            `UPDATE work_item_reminders SET state = 'cancelled', updated_at = ?
             WHERE work_item_id = ? AND state IN ('scheduled', 'snoozed')`,
          )
          .run(at, input.id);
      }
    });
    this.emit(input.id, 'moved');
    this.scheduleReminderSweep();
    return this.requireItem(input.id);
  }

  archive(id: string, archived: boolean, expectedVersion: number): WorkItemDto {
    const current = this.requireItem(id);
    if (current.version !== expectedVersion) throw this.conflict(current);
    const at = this.now().toISOString();
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          'UPDATE work_items SET archived = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?',
        )
        .run(archived ? 1 : 0, at, id, expectedVersion);
      if (Number(result.changes) !== 1) throw this.conflict(this.requireItem(id));
      if (archived) {
        this.db
          .prepare(
            `UPDATE work_item_reminders SET state = 'cancelled', updated_at = ?
             WHERE work_item_id = ? AND state IN ('scheduled', 'snoozed')`,
          )
          .run(at, id);
      }
      this.recordEvent(id, archived ? 'work_item.archived' : 'work_item.restored', 'You', {});
    });
    this.emit(id, archived ? 'archived' : 'restored');
    this.scheduleReminderSweep();
    return this.requireItem(id);
  }

  createReminder(workItemId: string, remindAt: string, message: string): WorkReminderDto {
    this.requireItem(workItemId);
    const reminder = this.db.transaction(() => {
      const at = this.now().toISOString();
      const created = this.insertReminder(workItemId, remindAt, message, at);
      this.recordEvent(workItemId, 'reminder.scheduled', 'You', { remindAt });
      return created;
    });
    this.emit(workItemId, 'reminder-scheduled');
    this.scheduleReminderSweep();
    return reminder;
  }

  snoozeReminder(id: string, remindAt: string): WorkReminderDto {
    const current = this.requireReminder(id);
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE work_item_reminders SET remind_at = ?, state = 'snoozed', fired_at = NULL,
           updated_at = ? WHERE id = ?`,
        )
        .run(remindAt, at, id);
      this.recordEvent(current.workItemId, 'reminder.snoozed', 'You', { remindAt });
    });
    this.emit(current.workItemId, 'reminder-snoozed');
    this.scheduleReminderSweep();
    return this.requireReminder(id);
  }

  /** Due-and-unhandled reminders — drives the Dock badge. A reminder leaves
   * this count only when the user snoozes or dismisses it, so the badge nags
   * exactly as long as something is actually waiting. */
  firedReminderCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS value FROM work_item_reminders WHERE state = 'fired'")
      .get() as { value: number };
    return row.value;
  }

  cancelReminder(id: string): WorkReminderDto {
    const current = this.requireReminder(id);
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE work_item_reminders SET state = 'cancelled', updated_at = ? WHERE id = ?")
        .run(at, id);
      this.recordEvent(current.workItemId, 'reminder.cancelled', 'You', {});
    });
    this.emit(current.workItemId, 'reminder-cancelled');
    this.scheduleReminderSweep();
    return this.requireReminder(id);
  }

  linkExecution(input: {
    workItemId: string;
    targetKind: WorkExecutionTargetKind;
    targetId: string | null;
    role: WorkExecutionRole;
    approach: string;
    displayLabel: string;
    agentLabel: string;
    summary: string;
  }): WorkExecutionDto {
    this.requireItem(input.workItemId);
    if (input.targetKind !== 'manual' && !input.targetId) {
      throw this.failure('WORK_EXECUTION_TARGET_REQUIRED', 'Choose an execution to link.');
    }
    const existing = input.targetId
      ? (this.db
          .prepare(
            'SELECT id FROM work_item_executions WHERE work_item_id = ? AND target_kind = ? AND target_id = ?',
          )
          .get(input.workItemId, input.targetKind, input.targetId) as { id: string } | undefined)
      : undefined;
    const at = this.now().toISOString();
    const id = existing?.id ?? newId('workexec');
    this.db.transaction(() => {
      if (existing) {
        this.db
          .prepare(
            `UPDATE work_item_executions SET role = ?, approach = ?, display_label = ?,
             agent_label = ?, summary = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            input.role,
            input.approach,
            input.displayLabel,
            input.agentLabel,
            input.summary,
            at,
            id,
          );
      } else {
        this.db
          .prepare(
            `INSERT INTO work_item_executions
             (id, work_item_id, target_kind, target_id, role, approach, display_label,
              agent_label, status, summary, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?, ?)`,
          )
          .run(
            id,
            input.workItemId,
            input.targetKind,
            input.targetId,
            input.role,
            input.approach,
            input.displayLabel,
            input.agentLabel,
            input.summary,
            at,
            at,
          );
      }
      this.recordEvent(
        input.workItemId,
        existing ? 'execution.updated' : 'execution.linked',
        'You',
        {
          executionId: id,
          targetKind: input.targetKind,
          targetId: input.targetId,
          role: input.role,
        },
      );
    });
    this.emit(input.workItemId, existing ? 'execution-updated' : 'execution-linked');
    return this.withLiveExecutionStatus(this.requireExecution(id));
  }

  unlinkExecution(id: string): boolean {
    const execution = this.requireExecution(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM work_item_executions WHERE id = ?').run(id);
      this.recordEvent(execution.workItemId, 'execution.unlinked', 'You', {
        targetKind: execution.targetKind,
        targetId: execution.targetId,
      });
    });
    this.emit(execution.workItemId, 'execution-unlinked');
    return true;
  }

  addEvidence(input: {
    workItemId: string;
    kind: WorkEvidenceKind;
    label: string;
    value: string;
    createdBy: string;
  }): WorkEvidenceDto {
    this.requireItem(input.workItemId);
    const id = newId('workevidence');
    const at = this.now().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_item_evidence
           (id, work_item_id, kind, label, value, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workItemId,
          input.kind,
          input.label.trim(),
          input.value,
          input.createdBy,
          at,
        );
      this.recordEvent(input.workItemId, 'evidence.added', input.createdBy, {
        evidenceId: id,
        kind: input.kind,
        label: input.label,
      });
    });
    this.emit(input.workItemId, 'evidence-added');
    const row = this.db.prepare('SELECT * FROM work_item_evidence WHERE id = ?').get(id) as Row;
    return this.evidenceFromRow(row);
  }

  removeEvidence(id: string): boolean {
    const row = this.db.prepare('SELECT * FROM work_item_evidence WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) return false;
    const evidence = this.evidenceFromRow(row);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM work_item_evidence WHERE id = ?').run(id);
      this.recordEvent(evidence.workItemId, 'evidence.removed', 'You', {
        evidenceId: id,
        label: evidence.label,
      });
    });
    this.emit(evidence.workItemId, 'evidence-removed');
    return true;
  }

  createType(input: {
    name: string;
    icon: string;
    color: string;
    description: string;
    fieldDefinitions: WorkItemFieldDefinition[];
  }): WorkItemTypeDto {
    const id = newId('worktype');
    const at = this.now().toISOString();
    const position =
      Number(
        (
          this.db
            .prepare('SELECT COALESCE(MAX(position), 0) AS value FROM work_item_types')
            .get() as {
            value: number;
          }
        ).value,
      ) + 1;
    this.db
      .prepare(
        `INSERT INTO work_item_types
         (id, name, icon, color, description, field_definitions_json, built_in, archived,
          position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.icon,
        input.color,
        input.description,
        JSON.stringify(input.fieldDefinitions),
        position,
        at,
        at,
      );
    this.emit(null, 'type-created');
    return this.requireType(id);
  }

  createColumn(input: {
    name: string;
    category: WorkItemStatusCategory;
    color: string;
    wipLimit: number | null;
  }): WorkBoardColumnDto {
    const id = newId('workcol');
    const at = this.now().toISOString();
    const position =
      Number(
        (
          this.db
            .prepare('SELECT COALESCE(MAX(position), 0) AS value FROM work_board_columns')
            .get() as {
            value: number;
          }
        ).value,
      ) + 1;
    this.db
      .prepare(
        `INSERT INTO work_board_columns
         (id, name, category, color, position, wip_limit, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.name.trim(), input.category, input.color, position, input.wipLimit, at, at);
    this.emit(null, 'column-created');
    return this.requireColumn(id);
  }

  /** Public for deterministic unit coverage; production uses the scheduler. */
  processDueReminders(): number {
    const now = this.now().toISOString();
    const rows = this.db
      .prepare(
        `SELECT r.* FROM work_item_reminders r
         JOIN work_items i ON i.id = r.work_item_id
         JOIN work_board_columns c ON c.id = i.column_id
         WHERE r.state IN ('scheduled', 'snoozed') AND r.remind_at <= ?
           AND i.archived = 0 AND c.category NOT IN ('completed', 'cancelled')
         ORDER BY r.remind_at, r.created_at LIMIT 100`,
      )
      .all(now) as Row[];
    for (const row of rows) {
      const reminder = this.reminderFromRow(row);
      this.db.transaction(() => {
        this.db
          .prepare(
            `UPDATE work_item_reminders SET state = 'fired', fired_at = ?, updated_at = ?
             WHERE id = ? AND state IN ('scheduled', 'snoozed')`,
          )
          .run(now, now, reminder.id);
        this.recordEvent(reminder.workItemId, 'reminder.fired', 'System', {
          reminderId: reminder.id,
          remindAt: reminder.remindAt,
        });
      });
      const fired = this.requireReminder(reminder.id);
      const item = this.requireItem(reminder.workItemId);
      this.reminderDue({ item, reminder: fired });
      this.changed(item.id, 'reminder-fired');
    }
    this.scheduleReminderSweep();
    return rows.length;
  }

  private columns(includeArchived: boolean): WorkBoardColumnDto[] {
    return this.db
      .prepare(
        `SELECT * FROM work_board_columns ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY position`,
      )
      .all()
      .map((row) => this.columnFromRow(row as Row));
  }

  private types(includeArchived: boolean): WorkItemTypeDto[] {
    return this.db
      .prepare(
        `SELECT * FROM work_item_types ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY position`,
      )
      .all()
      .map((row) => this.typeFromRow(row as Row));
  }

  private itemFromRow(row: Row): WorkItemDto {
    return WorkItemDtoSchema.parse({
      id: String(row.id),
      typeId: String(row.type_id),
      columnId: String(row.column_id),
      title: String(row.title),
      descriptionMd: String(row.description_md ?? ''),
      backgroundMd: String(row.background_md ?? ''),
      sourcePerson: String(row.source_person ?? ''),
      sourceChannel: String(row.source_channel ?? ''),
      sourceUrl: String(row.source_url ?? ''),
      assignee: String(row.assignee ?? ''),
      priority: String(row.priority),
      labels: parseJson(String(row.labels_json), []),
      startAt: row.start_at === null ? null : String(row.start_at),
      dueAt: row.due_at === null ? null : String(row.due_at),
      acceptance: parseJson<WorkChecklistItem[]>(String(row.acceptance_json), []),
      deliverables: parseJson<WorkChecklistItem[]>(String(row.deliverables_json), []),
      customFields: parseJson<Record<string, WorkCustomFieldValue>>(
        String(row.custom_fields_json),
        {},
      ),
      position: Number(row.position),
      archived: asBoolean(Number(row.archived)),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      completedAt: row.completed_at === null ? null : String(row.completed_at),
    });
  }

  private columnFromRow(row: Row): WorkBoardColumnDto {
    return WorkBoardColumnDtoSchema.parse({
      id: String(row.id),
      name: String(row.name),
      category: String(row.category),
      color: String(row.color),
      position: Number(row.position),
      wipLimit: row.wip_limit === null ? null : Number(row.wip_limit),
      archived: asBoolean(Number(row.archived)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    });
  }

  private typeFromRow(row: Row): WorkItemTypeDto {
    return WorkItemTypeDtoSchema.parse({
      id: String(row.id),
      name: String(row.name),
      icon: String(row.icon),
      color: String(row.color),
      description: String(row.description),
      fieldDefinitions: parseJson(String(row.field_definitions_json), []),
      builtIn: asBoolean(Number(row.built_in)),
      archived: asBoolean(Number(row.archived)),
      position: Number(row.position),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    });
  }

  private executionFromRow(row: Row): WorkExecutionDto {
    return WorkExecutionDtoSchema.parse({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      targetKind: String(row.target_kind),
      targetId: row.target_id === null ? null : String(row.target_id),
      role: String(row.role),
      approach: String(row.approach ?? ''),
      displayLabel: String(row.display_label ?? ''),
      agentLabel: String(row.agent_label ?? ''),
      status: String(row.status ?? 'linked'),
      summary: String(row.summary ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    });
  }

  private withLiveExecutionStatus(execution: WorkExecutionDto): WorkExecutionDto {
    if (!execution.targetId) return execution;
    if (execution.targetKind === 'session') {
      const row = this.db
        .prepare('SELECT title, state, archived FROM tasks WHERE id = ?')
        .get(execution.targetId) as { title: string; state: string; archived: number } | undefined;
      return row
        ? {
            ...execution,
            displayLabel: execution.displayLabel || row.title,
            status: row.archived === 1 ? 'archived' : row.state,
          }
        : { ...execution, status: 'missing' };
    }
    if (execution.targetKind === 'mission') {
      const row = this.db
        .prepare('SELECT title, state, deleted_at FROM missions WHERE id = ?')
        .get(execution.targetId) as
        { title: string; state: string; deleted_at: string | null } | undefined;
      return row
        ? {
            ...execution,
            displayLabel: execution.displayLabel || row.title,
            status: row.deleted_at ? 'trashed' : row.state,
          }
        : { ...execution, status: 'missing' };
    }
    if (execution.targetKind === 'terminal') {
      const row = this.db
        .prepare(
          `SELECT title, state, archived FROM tasks
           WHERE external_json IS NOT NULL
             AND json_extract(external_json, '$.terminalId') = ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(execution.targetId) as { title: string; state: string; archived: number } | undefined;
      return row
        ? {
            ...execution,
            displayLabel: execution.displayLabel || row.title,
            status: row.archived === 1 ? 'archived' : row.state,
          }
        : { ...execution, status: 'missing' };
    }
    return execution;
  }

  private reminderFromRow(row: Row): WorkReminderDto {
    return WorkReminderDtoSchema.parse({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      remindAt: String(row.remind_at),
      state: String(row.state),
      message: String(row.message ?? ''),
      firedAt: row.fired_at === null ? null : String(row.fired_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    });
  }

  private evidenceFromRow(row: Row): WorkEvidenceDto {
    return WorkEvidenceDtoSchema.parse({
      id: String(row.id),
      workItemId: String(row.work_item_id),
      kind: String(row.kind),
      label: String(row.label),
      value: String(row.value),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
    });
  }

  private requireItem(id: string): WorkItemDto {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw this.failure('WORK_ITEM_NOT_FOUND', 'That work item no longer exists.');
    return this.itemFromRow(row);
  }

  private requireColumn(id: string): WorkBoardColumnDto {
    const row = this.db.prepare('SELECT * FROM work_board_columns WHERE id = ?').get(id) as
      Row | undefined;
    if (!row || Number(row.archived) === 1) {
      throw this.failure('WORK_COLUMN_NOT_FOUND', 'That board column is unavailable.');
    }
    return this.columnFromRow(row);
  }

  private requireType(id: string): WorkItemTypeDto {
    const row = this.db.prepare('SELECT * FROM work_item_types WHERE id = ?').get(id) as
      Row | undefined;
    if (!row || Number(row.archived) === 1) {
      throw this.failure('WORK_TYPE_NOT_FOUND', 'That work type is unavailable.');
    }
    return this.typeFromRow(row);
  }

  private requireReminder(id: string): WorkReminderDto {
    const row = this.db.prepare('SELECT * FROM work_item_reminders WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) throw this.failure('WORK_REMINDER_NOT_FOUND', 'That reminder no longer exists.');
    return this.reminderFromRow(row);
  }

  private requireExecution(id: string): WorkExecutionDto {
    const row = this.db.prepare('SELECT * FROM work_item_executions WHERE id = ?').get(id) as
      Row | undefined;
    if (!row)
      throw this.failure('WORK_EXECUTION_NOT_FOUND', 'That execution link no longer exists.');
    return this.executionFromRow(row);
  }

  private insertReminder(
    workItemId: string,
    remindAt: string,
    message: string,
    at: string,
  ): WorkReminderDto {
    const id = newId('workreminder');
    this.db
      .prepare(
        `INSERT INTO work_item_reminders
         (id, work_item_id, remind_at, state, message, fired_at, created_at, updated_at)
         VALUES (?, ?, ?, 'scheduled', ?, NULL, ?, ?)`,
      )
      .run(id, workItemId, remindAt, message, at, at);
    return this.requireReminder(id);
  }

  private nextPosition(columnId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) AS value FROM work_items WHERE column_id = ?')
      .get(columnId) as { value: number };
    return Number(row.value) + 1024;
  }

  private recordEvent(
    workItemId: string,
    type: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    const sequence = Number(
      (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM work_item_events WHERE work_item_id = ?',
          )
          .get(workItemId) as { value: number }
      ).value,
    );
    this.db
      .prepare(
        `INSERT INTO work_item_events
         (id, work_item_id, sequence, type, actor, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('workevent'),
        workItemId,
        sequence,
        type,
        actor,
        JSON.stringify(payload),
        this.now().toISOString(),
      );
  }

  private validateCustomFields(typeId: string, values: Record<string, WorkCustomFieldValue>): void {
    const type = this.requireType(typeId);
    for (const definition of type.fieldDefinitions) {
      const value = values[definition.key];
      if (
        definition.required &&
        (value === undefined ||
          value === null ||
          value === '' ||
          (Array.isArray(value) && value.length === 0))
      ) {
        throw this.failure(
          'WORK_FIELD_REQUIRED',
          `Complete the required field “${definition.label}”.`,
        );
      }
      if (
        definition.kind === 'select' &&
        typeof value === 'string' &&
        definition.options.length > 0
      ) {
        if (!definition.options.includes(value)) {
          throw this.failure(
            'WORK_FIELD_INVALID',
            `Choose a valid value for “${definition.label}”.`,
          );
        }
      }
    }
  }

  private enforceWipLimit(column: WorkBoardColumnDto, sourceColumnId: string): void {
    if (!column.wipLimit || column.id === sourceColumnId) return;
    const count = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS value FROM work_items WHERE column_id = ? AND archived = 0')
          .get(column.id) as { value: number }
      ).value,
    );
    if (count >= column.wipLimit) {
      throw this.failure(
        'WORK_WIP_LIMIT',
        `${column.name} is at its work-in-progress limit (${column.wipLimit}).`,
      );
    }
  }

  private seedDefaults(): void {
    const at = this.now().toISOString();
    this.db.transaction(() => {
      DEFAULT_COLUMNS.forEach((column, index) => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO work_board_columns
             (id, name, category, color, position, wip_limit, archived, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
          )
          .run(column.id, column.name, column.category, column.color, index + 1, at, at);
      });
      DEFAULT_TYPES.forEach((type, index) => {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO work_item_types
             (id, name, icon, color, description, field_definitions_json, built_in,
              archived, position, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
          )
          .run(
            type.id,
            type.name,
            type.icon,
            type.color,
            type.description,
            JSON.stringify(type.fields),
            index + 1,
            at,
            at,
          );
      });
    });
  }

  private scheduleReminderSweep(delayOverride?: number): void {
    if (this.disposed) return;
    if (this.reminderTimer) clearTimeout(this.reminderTimer);
    let delay = delayOverride;
    if (delay === undefined) {
      const next = this.db
        .prepare(
          `SELECT remind_at FROM work_item_reminders
           WHERE state IN ('scheduled', 'snoozed') ORDER BY remind_at LIMIT 1`,
        )
        .get() as { remind_at: string } | undefined;
      if (!next) {
        this.reminderTimer = null;
        return;
      }
      delay = Math.max(0, Math.min(60_000, Date.parse(next.remind_at) - this.now().getTime()));
    }
    this.reminderTimer = setTimeout(() => {
      this.reminderTimer = null;
      try {
        this.processDueReminders();
      } catch (error) {
        this.logger.warn('work reminder sweep failed', { error: String(error) });
        this.scheduleReminderSweep(30_000);
      }
    }, delay);
    this.reminderTimer.unref?.();
  }

  private emit(itemId: string | null, reason: string): void {
    this.changed(itemId, reason);
  }

  private failure(code: string, userMessage: string): ProductFailure {
    return new ProductFailure(productError(code, { userMessage }));
  }

  private conflict(item: WorkItemDto): ProductFailure {
    return new ProductFailure(
      productError('WORK_ITEM_CONFLICT', {
        userMessage: 'This work item changed in another window. It has been refreshed.',
        severity: 'warning',
        context: { itemId: item.id, version: item.version },
      }),
    );
  }
}
