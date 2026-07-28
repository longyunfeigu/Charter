import { createHash } from 'node:crypto';
import type { Logger } from '@pi-ide/foundation';
import type {
  ReplayEvidenceDetail,
  ReplayFactDto,
  ReplayProjection,
  ReplaySessionDto,
} from '@pi-ide/ipc-contracts';
import { projectReplay } from '@pi-ide/ipc-contracts';
import type { SqlDatabase } from '@pi-ide/persistence';
import type { TaskService } from './task-service.js';

/** Replay V3 (ADR-0017 am.8) hard cap far above the 10k gate. */
const EVENT_CAP = 25_000;
/** Bounded payload excerpt for ledger-event evidence previews. */
const PAYLOAD_EXCERPT_MAX = 4_000;

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Self-contained receipt page: no external assets, no integrity overclaim. */
function receiptHtml(
  manifest: {
    task: { id: string; title: string; goal: string; state: string; createdAt: string };
    session: ReplaySessionDto;
    events: Array<{
      id: string;
      sequence: number;
      type: string;
      at: string;
      payloadSha256: string;
    }>;
    changes: Array<{
      id: string;
      path: string;
      kind: string;
      beforeSha256: string | null;
      afterSha256: string | null;
    }>;
    appVersion: string;
    exportedAt: string;
  },
  manifestSha256: string,
): string {
  const { task, session } = manifest;
  const eventRows = manifest.events
    .map(
      (event) =>
        `<tr><td>${event.sequence}</td><td>${esc(event.type)}</td><td>${esc(event.at)}</td><td class="mono">${event.payloadSha256.slice(0, 16)}…</td></tr>`,
    )
    .join('\n');
  const changeRows = manifest.changes
    .map(
      (change) =>
        `<tr><td>${esc(change.path)}</td><td>${esc(change.kind)}</td><td class="mono">${change.beforeSha256?.slice(0, 16) ?? '∅'}</td><td class="mono">${change.afterSha256?.slice(0, 16) ?? '∅'}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Replay evidence receipt — ${esc(task.title)}</title>
<style>
body { font: 13px/1.55 system-ui, sans-serif; color: #26221c; margin: 40px auto; max-width: 920px; padding: 0 20px; }
h1 { font-size: 20px; } h2 { font-size: 14px; margin-top: 28px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
td, th { border: 1px solid #d8d2c8; padding: 4px 8px; text-align: left; }
.mono { font-family: ui-monospace, monospace; font-size: 11px; }
.note { background: #f6f1e7; border: 1px solid #d8d2c8; border-radius: 8px; padding: 10px 14px; }
</style>
</head>
<body>
<h1>Replay evidence receipt</h1>
<p class="note"><strong>Integrity note:</strong> This export is an ordered ledger snapshot with a
SHA-256 hash for every row. It is <strong>not cryptographically signed</strong> and makes no claim
of tamper resistance. Manifest SHA-256:
<span class="mono">${manifestSha256}</span></p>
<h2>Task</h2>
<table>
<tr><th>Task</th><td>${esc(task.title)} <span class="mono">(${esc(task.id)})</span></td></tr>
<tr><th>Goal</th><td>${esc(task.goal || 'Original goal not recorded')}</td></tr>
<tr><th>State</th><td>${esc(task.state)}</td></tr>
<tr><th>Result</th><td>${esc(session.summary.result)}</td></tr>
<tr><th>Verification</th><td>${esc(session.verification)}</td></tr>
<tr><th>Exported</th><td>${esc(manifest.exportedAt)} · app ${esc(manifest.appVersion)}</td></tr>
</table>
<h2>File changes (${manifest.changes.length})</h2>
<table><tr><th>Path</th><th>Kind</th><th>Before sha256</th><th>After sha256</th></tr>
${changeRows || '<tr><td colspan="4">No recorded file changes.</td></tr>'}
</table>
<h2>Ledger events (${manifest.events.length})</h2>
<table><tr><th>#</th><th>Type</th><th>At</th><th>Payload sha256</th></tr>
${eventRows}
</table>
</body>
</html>`;
}

const RUNNING_STATES = new Set([
  'READY',
  'EXPLORING',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_USER',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);

interface CachedProjection {
  latestSequence: number;
  projection: ReplayProjection;
}

/**
 * Main-process replay projection service. It is a read-only view over the
 * `task_events` ledger + `file_changes`/blobs — never a second replay store.
 * The trust-critical derivation lives in the shared pure engine
 * (`@pi-ide/ipc-contracts` projectReplay); this service adds caching,
 * pagination and the belongs-to-task evidence boundary.
 */
export class ReplayService {
  private readonly cache = new Map<string, CachedProjection>();

  constructor(
    private readonly db: SqlDatabase,
    private readonly tasks: TaskService,
    private readonly logger: Logger,
    private readonly appVersion = 'dev',
  ) {}

  private latestSequence(taskId: string): number {
    const row = this.db
      .prepare('SELECT MAX(sequence) AS latest FROM task_events WHERE task_id = ?')
      .get(taskId) as { latest: number | null } | undefined;
    return row?.latest ?? 0;
  }

  private projection(taskId: string): { projection: ReplayProjection; latestSequence: number } {
    const task = this.tasks.getTask(taskId); // throws TASK_NOT_FOUND for unknown ids
    const latestSequence = this.latestSequence(taskId);
    const running = task.external
      ? task.external.status === 'active'
      : RUNNING_STATES.has(task.state);
    const cached = this.cache.get(taskId);
    // Running sessions recompute every read: their actual duration and
    // provisional summary move with the clock, not only with new events.
    if (cached && cached.latestSequence === latestSequence && !running) {
      return { projection: cached.projection, latestSequence };
    }
    const { items } = this.tasks.activity(taskId, undefined, EVENT_CAP);
    const projection = projectReplay({
      task: {
        id: task.id,
        goalMd: task.goalMd,
        state: task.state,
        createdAt: task.createdAt,
        external: task.external ? { cli: task.external.cli, status: task.external.status } : null,
      },
      items,
      nowMs: Date.now(),
    });
    this.cache.set(taskId, { latestSequence, projection });
    // The cache is a small working set, not a history store.
    if (this.cache.size > 6) {
      const oldest = this.cache.keys().next().value;
      if (oldest && oldest !== taskId) this.cache.delete(oldest);
    }
    return { projection, latestSequence };
  }

  session(taskId: string): {
    session: ReplaySessionDto;
    latestSequence: number;
    eventCount: number;
  } {
    const { projection, latestSequence } = this.projection(taskId);
    return {
      session: projection.session,
      latestSequence,
      eventCount: projection.facts.length,
    };
  }

  events(
    taskId: string,
    options: { afterSequence?: number; limit?: number } = {},
  ): {
    facts: ReplayFactDto[];
    nextAfterSequence: number | null;
    total: number;
    latestSequence: number;
  } {
    const afterSequence = options.afterSequence ?? 0;
    const limit = Math.max(1, Math.min(500, options.limit ?? 200));
    const { projection, latestSequence } = this.projection(taskId);
    const all = projection.facts;
    // Facts are sequence-ordered; binary-search the cursor.
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid]!.sequence <= afterSequence) lo = mid + 1;
      else hi = mid;
    }
    const facts = all.slice(lo, lo + limit);
    const last = facts.at(-1);
    const done = lo + limit >= all.length;
    return {
      facts,
      nextAfterSequence: done || !last ? null : last.sequence,
      total: all.length,
      latestSequence,
    };
  }

  /**
   * Evidence-bounded "ask this replay" (Pass 3, §7). The answer is derived
   * only from recorded facts; every citation is validated against this task's
   * projection and the call fails closed — no valid citations, no answer.
   * When the ledger cannot answer "why", the boundary says so explicitly.
   * The text is an Inferred narrative and is never written back as evidence.
   */
  ask(
    taskId: string,
    factId: string,
    question: string,
  ): { text: string; citations: string[]; boundary: string | null } {
    const { projection } = this.projection(taskId);
    const fact = projection.facts.find((f) => f.id === factId);
    if (!fact) {
      return {
        text: 'The record cannot confirm this moment: the fact is not in this task ledger.',
        citations: [],
        boundary: 'No evidence is available to cite.',
      };
    }
    // Candidate citations, validated against this task's ledger (fail closed).
    const validFactIds = new Set(projection.facts.map((f) => f.id));
    const citations = [
      `fact:${fact.id}`,
      ...fact.evidenceRefs,
      ...fact.relations
        .filter((relation) => validFactIds.has(relation.factId))
        .map((relation) => `fact:${relation.factId}`),
    ];
    if (citations.length === 0) {
      return {
        text: 'The record cannot answer this question.',
        citations: [],
        boundary: 'This moment has no verifiable evidence references.',
      };
    }

    const when = new Date(fact.startedAt).toLocaleString();
    const lines: string[] = [];
    if (fact.capture === 'observed') {
      lines.push(
        `The record only confirms that at ${when}, the terminal or file-system observation for ${fact.actor.label} included "${fact.action}" (status: ${fact.status}).`,
      );
    } else {
      lines.push(
        `The ledger confirms that at ${when}, ${fact.actor.label} ${fact.action} (status: ${fact.status}; ${fact.evidenceRefs.length} direct evidence reference${fact.evidenceRefs.length === 1 ? '' : 's'}).`,
      );
    }
    for (const relation of fact.relations) {
      const target = projection.facts.find((f) => f.id === relation.factId);
      if (target) lines.push(`Recorded relationship (${relation.type}): "${target.action}".`);
    }
    if (fact.kind === 'verification') {
      lines.push(
        fact.status === 'ok'
          ? 'This verification passed; its command, exit code, and output are recorded.'
          : 'This verification failed; its failure output is preserved as evidence.',
      );
    }
    const boundary =
      fact.capture === 'observed'
        ? 'The record cannot confirm internal app meaning or why this step occurred.'
        : "The record only confirms what happened; it cannot confirm the agent's internal reasons or hidden reasoning.";
    this.logger.info('replay.ask', { taskId, factId, question: question.slice(0, 80) });
    return { text: lines.join(' '), citations, boundary };
  }

  /**
   * Evidence receipt export (Pass 3, §8): task metadata, per-event payload
   * hashes, change/blob hashes, verification dispositions and a manifest
   * SHA-256. Honest limits: the ledger is ordered but NOT signed or
   * hash-chained — the receipt never claims tamper-proofing.
   */
  receipt(taskId: string): {
    json: string;
    html: string;
    manifestSha256: string;
    suggestedName: string;
  } {
    const task = this.tasks.getTask(taskId);
    const { projection } = this.projection(taskId);
    const rows = this.db
      .prepare(
        'SELECT id, sequence, type, payload_json, created_at FROM task_events WHERE task_id = ? ORDER BY sequence LIMIT ?',
      )
      .all(taskId, EVENT_CAP) as Array<{
      id: string;
      sequence: number;
      type: string;
      payload_json: string;
      created_at: string;
    }>;
    const events = rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      type: row.type,
      at: row.created_at,
      payloadSha256: createHash('sha256').update(row.payload_json).digest('hex'),
    }));
    const changes = this.db
      .prepare(
        'SELECT id, relative_path, kind, before_hash, after_hash, created_at FROM file_changes WHERE task_id = ? ORDER BY created_at, id',
      )
      .all(taskId) as Array<{
      id: string;
      relative_path: string;
      kind: string;
      before_hash: string | null;
      after_hash: string | null;
      created_at: string;
    }>;
    const manifest = {
      format: 'charter-replay-receipt/1',
      integrity:
        'Ordered ledger export with per-row SHA-256 hashes. NOT cryptographically signed; no tamper-proof claim.',
      task: {
        id: task.id,
        title: task.title,
        goal: task.goalMd,
        state: task.state,
        createdAt: task.createdAt,
        project: task.projectName,
      },
      session: projection.session,
      events,
      changes: changes.map((change) => ({
        id: change.id,
        path: change.relative_path,
        kind: change.kind,
        beforeSha256: change.before_hash,
        afterSha256: change.after_hash,
        at: change.created_at,
      })),
      appVersion: this.appVersion,
      exportedAt: new Date().toISOString(),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestSha256 = createHash('sha256').update(manifestJson).digest('hex');
    const json = JSON.stringify({ manifestSha256, manifest }, null, 2);
    const html = receiptHtml(manifest, manifestSha256);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      json,
      html,
      manifestSha256,
      suggestedName: `replay-receipt-${task.id}-${stamp}`,
    };
  }

  /**
   * Resolve one evidence ref on demand. Refs are `event:<ledger id>` or
   * `change:<file_changes id>`; both are validated to belong to the task —
   * an id from another task resolves to null, never to foreign evidence.
   */
  async evidence(taskId: string, evidenceId: string): Promise<ReplayEvidenceDetail | null> {
    this.tasks.getTask(taskId);
    if (evidenceId.startsWith('change:')) {
      const changeId = evidenceId.slice('change:'.length);
      const record = this.tasks.changeRecord(taskId, changeId);
      if (!record) return null;
      let content: { beforeText: string | null; afterText: string | null; binary: boolean } | null =
        null;
      try {
        content = await this.tasks.changeEvidence(taskId, changeId);
      } catch (error) {
        // Blob store unavailable (workspace closed): hashes stay authoritative.
        this.logger.warn('replay.evidence.blobUnavailable', {
          taskId,
          changeId,
          error: `${error}`,
        });
      }
      return {
        id: evidenceId,
        type: 'file-version',
        source: 'file_changes',
        capturedAt: record.createdAt,
        integrityHash: record.afterHash,
        path: record.path,
        kind: record.kind,
        beforeHash: record.beforeHash,
        afterHash: record.afterHash,
        patch: record.patch,
        beforeText: content?.beforeText ?? null,
        afterText: content?.afterText ?? null,
        binary: content?.binary ?? false,
      };
    }
    if (evidenceId.startsWith('event:')) {
      const eventId = evidenceId.slice('event:'.length);
      const row = this.db
        .prepare(
          'SELECT id, type, payload_json, created_at FROM task_events WHERE id = ? AND task_id = ?',
        )
        .get(eventId, taskId) as
        { id: string; type: string; payload_json: string; created_at: string } | undefined;
      if (!row) return null;
      let excerpt = row.payload_json;
      try {
        excerpt = JSON.stringify(JSON.parse(row.payload_json), null, 2);
      } catch {
        // keep the raw stored text
      }
      if (excerpt.length > PAYLOAD_EXCERPT_MAX) {
        excerpt = `${excerpt.slice(0, PAYLOAD_EXCERPT_MAX)}\n… (truncated)`;
      }
      return {
        id: evidenceId,
        type: 'event',
        source: row.type,
        capturedAt: row.created_at,
        integrityHash: null,
        payloadExcerpt: excerpt,
      };
    }
    return null;
  }
}
