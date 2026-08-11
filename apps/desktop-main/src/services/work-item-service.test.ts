import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, ProductFailure } from '@pi-ide/foundation';
import { openDatabase, MIGRATIONS, type SqlDatabase } from '@pi-ide/persistence';
import type { WorkItemCreateInput } from '@pi-ide/ipc-contracts';
import { WorkItemService } from './work-item-service.js';

let root: string;
let db: SqlDatabase;
let now: Date;
let changed: Array<{ id: string | null; reason: string }>;
let alerts: Array<{ itemId: string; reminderId: string }>;
let service: WorkItemService;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'charter-work-items-'));
  db = openDatabase({
    file: join(root, 'state.db'),
    backupDir: join(root, 'backups'),
    migrations: MIGRATIONS,
  }).db;
  now = new Date('2026-08-08T09:00:00.000Z');
  changed = [];
  alerts = [];
  service = new WorkItemService(db, createLogger('test', { write: () => undefined }), {
    now: () => now,
    changed: (id, reason) => changed.push({ id, reason }),
    reminderDue: ({ item, reminder }) => alerts.push({ itemId: item.id, reminderId: reminder.id }),
  });
});

afterEach(() => {
  service.dispose();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function input(overrides: Partial<WorkItemCreateInput> = {}): WorkItemCreateInput {
  return {
    typeId: 'work-type-generic',
    title: 'Prepare launch brief',
    descriptionMd: 'Produce an approved launch brief.',
    backgroundMd: 'The launch is scheduled for next week.',
    sourcePerson: 'Maya Chen',
    sourceChannel: 'Customer call',
    sourceUrl: 'https://example.com/source',
    assignee: 'Edy',
    priority: 'high',
    labels: ['launch'],
    startAt: null,
    dueAt: '2026-08-10T09:00:00.000Z',
    reminderAt: null,
    acceptance: [{ id: 'a1', text: 'PM approves the brief', checked: false }],
    deliverables: [{ id: 'd1', text: 'Launch brief', checked: false }],
    customFields: {},
    ...overrides,
  };
}

function seedSessionAndMission(): void {
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO workspaces
     (id, canonical_path, display_name, last_opened_at, created_at)
     VALUES ('ws-1', '/repo', 'Repo', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO tasks
     (id, workspace_id, title, goal_md, mode, state, model_json, created_at, updated_at)
     VALUES ('session-1', 'ws-1', 'Research competitors', '', 'ask', 'IN_PROGRESS', '{}', ?, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO tasks
     (id, workspace_id, title, goal_md, mode, state, model_json, external_json, created_at, updated_at)
     VALUES ('external-1', 'ws-1', 'Claude positioning pass', '', 'edit', 'IN_PROGRESS', '{}', ?, ?, ?)`,
  ).run(
    JSON.stringify({
      cli: 'claude',
      terminalId: 'terminal-2',
      snapshotRef: null,
      status: 'active',
    }),
    at,
    at,
  );
  db.prepare(
    `INSERT INTO missions
     (id, workspace_id, title, goal_md, acceptance_json, execution_policy_json,
      state, version, created_at, updated_at)
     VALUES ('mission-1', 'ws-1', 'Coordinate launch', '', '[]', '{}', 'RUNNING', 1, ?, ?)`,
  ).run(at, at);
}

describe('WorkItemService', () => {
  it('seeds a role-neutral board and built-in schemas exactly once', () => {
    const first = service.snapshot();
    expect(first.columns.map((column) => column.name)).toEqual([
      'Inbox',
      'In progress',
      'Waiting',
      'Review',
      'Done',
    ]);
    expect(first.types.map((type) => type.name)).toEqual([
      'General',
      'Product',
      'Operations',
      'Research',
      'Content',
      'Data',
      'Engineering',
      'Approval',
    ]);
    expect(first.types.find((type) => type.name === 'Operations')?.fieldDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'external_action', kind: 'checkbox' }),
      ]),
    );

    // Restarting the service must not duplicate deterministic built-ins.
    service.dispose();
    service = new WorkItemService(db, createLogger('test', { write: () => undefined }), {
      now: () => now,
    });
    expect(service.snapshot().columns).toHaveLength(5);
    expect(service.snapshot().types).toHaveLength(8);
  });

  it('persists generic task context, source, owner, checklists and activity', () => {
    const created = service.create(input());
    expect(created).toMatchObject({
      title: 'Prepare launch brief',
      sourcePerson: 'Maya Chen',
      sourceChannel: 'Customer call',
      assignee: 'Edy',
      priority: 'high',
      version: 1,
    });
    expect(created.columnId).toBe('work-col-inbox');
    const detail = service.detail(created.id);
    expect(detail.item.acceptance[0]?.text).toBe('PM approves the brief');
    expect(detail.item.deliverables[0]?.text).toBe('Launch brief');
    expect(detail.events[0]).toMatchObject({ type: 'work_item.created', actor: 'You' });
    expect(changed.at(-1)).toEqual({ id: created.id, reason: 'created' });
  });

  it('enforces required type-specific fields without making all work engineering-shaped', () => {
    expect(() => service.create(input({ typeId: 'work-type-product' }))).toThrow(ProductFailure);
    const product = service.create(
      input({
        typeId: 'work-type-product',
        customFields: {
          user_problem: 'Operators cannot tell which campaign task is blocked.',
          target_users: 'Lifecycle operations',
          success_metric: 'Time-to-unblock under one hour',
        },
      }),
    );
    expect(product.customFields.user_problem).toContain('campaign task');

    const operations = service.create(
      input({
        title: 'Run customer webinar campaign',
        typeId: 'work-type-operations',
        customFields: {
          channel: 'Email + webinar',
          audience: 'Enterprise admins',
          external_action: true,
          approval_owner: 'Growth lead',
        },
      }),
    );
    expect(operations.customFields.external_action).toBe(true);
  });

  it('rejects stale edits and preserves the winning version', () => {
    const created = service.create(input());
    const updated = service.update({
      id: created.id,
      expectedVersion: created.version,
      title: 'Approved launch brief',
    });
    expect(updated.version).toBe(2);
    expect(() =>
      service.update({ id: created.id, expectedVersion: 1, assignee: 'Stale editor' }),
    ).toThrow(ProductFailure);
    expect(service.detail(created.id).item.assignee).toBe('Edy');
  });

  it('moves and orders cards, marks completion, and cancels obsolete reminders', () => {
    const first = service.create(input({ title: 'First', reminderAt: '2026-08-09T09:00:00.000Z' }));
    const second = service.create(input({ title: 'Second' }));
    const movedSecond = service.move({
      id: second.id,
      columnId: 'work-col-active',
      beforeId: null,
      expectedVersion: second.version,
    });
    expect(movedSecond.columnId).toBe('work-col-active');
    const movedFirst = service.move({
      id: first.id,
      columnId: 'work-col-active',
      beforeId: second.id,
      expectedVersion: first.version,
    });
    const active = service
      .snapshot()
      .items.filter((item) => item.columnId === 'work-col-active')
      .sort((a, b) => a.position - b.position);
    expect(active.map((item) => item.title)).toEqual(['First', 'Second']);

    const completed = service.move({
      id: movedFirst.id,
      columnId: 'work-col-done',
      beforeId: null,
      expectedVersion: movedFirst.version,
    });
    expect(completed.completedAt).toBe(now.toISOString());
    expect(service.detail(first.id).reminders[0]?.state).toBe('cancelled');
    const reopened = service.move({
      id: completed.id,
      columnId: 'work-col-active',
      beforeId: null,
      expectedVersion: completed.version,
    });
    expect(reopened.completedAt).toBeNull();
  });

  it('enforces custom WIP limits', () => {
    const stage = service.createColumn({
      name: 'Legal review',
      category: 'review',
      color: '#9333ea',
      wipLimit: 1,
    });
    const first = service.create(input({ title: 'Contract A' }));
    const second = service.create(input({ title: 'Contract B' }));
    service.move({
      id: first.id,
      columnId: stage.id,
      beforeId: null,
      expectedVersion: first.version,
    });
    expect(() =>
      service.move({
        id: second.id,
        columnId: stage.id,
        beforeId: null,
        expectedVersion: second.version,
      }),
    ).toThrow(ProductFailure);
  });

  it('fires missed reminders once, then supports durable snooze and cancellation', () => {
    const item = service.create(input({ reminderAt: '2026-08-08T08:59:00.000Z' }));
    expect(service.processDueReminders()).toBe(1);
    expect(service.processDueReminders()).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.itemId).toBe(item.id);
    const reminder = service.detail(item.id).reminders[0]!;
    expect(reminder.state).toBe('fired');

    service.snoozeReminder(reminder.id, '2026-08-08T10:00:00.000Z');
    now = new Date('2026-08-08T09:59:59.000Z');
    expect(service.processDueReminders()).toBe(0);
    now = new Date('2026-08-08T10:00:00.000Z');
    expect(service.processDueReminders()).toBe(1);
    expect(alerts).toHaveLength(2);
    expect(service.cancelReminder(reminder.id).state).toBe('cancelled');
  });

  it('links multiple Sessions, Missions, people and alternative approaches with live status', () => {
    seedSessionAndMission();
    const item = service.create(input({ title: 'Competitive launch plan' }));
    const session = service.linkExecution({
      workItemId: item.id,
      targetKind: 'session',
      targetId: 'session-1',
      role: 'primary',
      approach: 'Primary research',
      displayLabel: '',
      agentLabel: 'Codex',
      summary: '',
    });
    const mission = service.linkExecution({
      workItemId: item.id,
      targetKind: 'mission',
      targetId: 'mission-1',
      role: 'collaborator',
      approach: 'Parallel launch streams',
      displayLabel: '',
      agentLabel: 'Mission team',
      summary: '',
    });
    service.linkExecution({
      workItemId: item.id,
      targetKind: 'manual',
      targetId: null,
      role: 'reviewer',
      approach: 'Legal review',
      displayLabel: 'Morgan · Legal',
      agentLabel: 'Human',
      summary: '',
    });
    const terminal = service.linkExecution({
      workItemId: item.id,
      targetKind: 'terminal',
      targetId: 'terminal-2',
      role: 'alternative',
      approach: 'Alternative positioning',
      displayLabel: 'Claude positioning pass',
      agentLabel: 'Claude',
      summary: '',
    });

    expect(session.status).toBe('IN_PROGRESS');
    expect(session.displayLabel).toBe('Research competitors');
    expect(mission.status).toBe('RUNNING');
    expect(terminal.status).toBe('IN_PROGRESS');
    expect(service.detail(item.id).executions).toHaveLength(4);

    db.prepare("UPDATE tasks SET state = 'REVIEW_READY' WHERE id = 'session-1'").run();
    db.prepare("UPDATE tasks SET state = 'INTERRUPTED' WHERE id = 'external-1'").run();
    expect(service.snapshot().executions.find((entry) => entry.id === session.id)?.status).toBe(
      'REVIEW_READY',
    );
    expect(service.snapshot().executions.find((entry) => entry.id === terminal.id)?.status).toBe(
      'INTERRUPTED',
    );
    service.unlinkExecution(mission.id);
    expect(service.detail(item.id).executions).toHaveLength(3);
  });

  it('records typed review evidence and supports custom work schemas', () => {
    const type = service.createType({
      name: 'Customer escalation',
      icon: 'alert',
      color: '#c4453d',
      description: 'Customer-impacting investigation and response.',
      fieldDefinitions: [
        {
          key: 'account',
          label: 'Account',
          kind: 'text',
          required: true,
          options: [],
          placeholder: '',
        },
      ],
    });
    const item = service.create(
      input({
        typeId: type.id,
        title: 'Resolve Acme renewal blocker',
        customFields: { account: 'Acme Corp' },
      }),
    );
    const evidence = service.addEvidence({
      workItemId: item.id,
      kind: 'approval',
      label: 'Customer approved remediation plan',
      value: 'https://example.com/approval',
      createdBy: 'Alicia',
    });
    expect(service.detail(item.id).evidence[0]).toMatchObject({
      kind: 'approval',
      createdBy: 'Alicia',
    });
    expect(service.detail(item.id).events[0]?.type).toBe('evidence.added');
    expect(service.removeEvidence(evidence.id)).toBe(true);
    expect(service.detail(item.id).evidence).toHaveLength(0);
  });

  it('archives without deleting the audit trail', () => {
    const item = service.create(input());
    const archived = service.archive(item.id, true, item.version);
    expect(archived.archived).toBe(true);
    expect(service.snapshot().items).toHaveLength(0);
    expect(service.snapshot(true).items).toHaveLength(1);
    expect(service.detail(item.id).events[0]?.type).toBe('work_item.archived');
  });
});
