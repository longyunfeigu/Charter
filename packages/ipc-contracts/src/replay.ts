import { z } from 'zod';
import {
  ActivityKindSchema,
  ActivityStatusSchema,
  ReplayCaptureGradeSchema,
  ReplaySourceSchema,
  type ActivityItem,
} from './activity.js';

/**
 * Replay V3 (ADR-0017 Amendment 8): one evidence ledger, three depths.
 *
 * This module is the single trust-critical projection from the activity
 * stream to the replay contract: per-fact evidence levels, Story Time,
 * semantic chapters, interval coverage and the deterministic result card.
 * It is pure and shared — the renderer uses it directly today and the
 * main-process ReplayService reuses it for the paginated IPC surface.
 *
 * Honesty invariants (tested):
 * - Evidence level is computed per fact; one structured event never upgrades
 *   an observed neighbour or the session.
 * - No numeric confidence anywhere; coverage is measured capture, not belief.
 * - Relations come only from recorded ids (callId / requestId); temporal
 *   adjacency never creates an edge.
 * - Story Time folds idle and groups repetition but never drops a mandatory
 *   fact (failures, denials, approvals, high risk, material changes,
 *   verification, final result).
 */

// ---------- contract ----------

export const ReplayDepthSchema = z.enum(['recap', 'explore', 'verify']);
export type ReplayDepth = z.infer<typeof ReplayDepthSchema>;

export const ReplayEvidenceLevelSchema = z.enum([
  'verified',
  'recorded',
  'observed',
  'inferred',
  'missing',
]);
export type ReplayEvidenceLevel = z.infer<typeof ReplayEvidenceLevelSchema>;

export const ReplayLaneSchema = z.enum(['intent', 'actions', 'artifacts', 'risk']);
export type ReplayLane = z.infer<typeof ReplayLaneSchema>;

export const ReplayRelationSchema = z.object({
  type: z.enum(['requested-by', 'produced', 'verified-by']),
  factId: z.string(),
});
export type ReplayRelation = z.infer<typeof ReplayRelationSchema>;

export const ReplayPivotSchema = z.object({
  /** Recorded plan prose for the revision, if the agent wrote any; never invented. */
  reason: z.string().nullable(),
  /** Recorded facts that precede this revision: prior plan + failures since it. */
  refFactIds: z.array(z.string()),
});
export type ReplayPivot = z.infer<typeof ReplayPivotSchema>;

export const ReplayFactDtoSchema = z.object({
  /** Stable id: the underlying event id / tool callId. */
  id: z.string(),
  sequence: z.number().int(),
  startedAt: z.string(),
  /** Offsets from session start, in ms, on the real wall clock. */
  actualStartMs: z.number().int(),
  actualEndMs: z.number().int(),
  /** Offsets on the Story Time projection. Grouped facts share one span. */
  storyStartMs: z.number().int(),
  storyEndMs: z.number().int(),
  /** Real idle time folded away immediately before this fact (0 = none). */
  idleBeforeMs: z.number().int(),
  lane: ReplayLaneSchema,
  actor: z.object({
    kind: z.enum(['user', 'agent', 'application', 'system']),
    label: z.string(),
  }),
  /** The observable action line (from the activity projection). */
  action: z.string(),
  detail: z.string().optional(),
  kind: ActivityKindSchema,
  status: ActivityStatusSchema,
  source: ReplaySourceSchema,
  capture: ReplayCaptureGradeSchema,
  /** Per-fact evidence level — never a session-wide grade. */
  level: ReplayEvidenceLevelSchema,
  /** Durable references: the ledger event itself plus recorded change ids. */
  evidenceRefs: z.array(z.string()),
  /** Explicit, id-backed relations only. */
  relations: z.array(ReplayRelationSchema),
  /** Recorded risk (permission cards); 'none' when nothing was recorded. */
  risk: z.enum(['none', 'low', 'medium', 'high']),
  reversibility: z.enum(['reversible', 'compensatable', 'irreversible', 'unknown']),
  /** Never skipped or grouped in Story Time. */
  mandatory: z.boolean(),
  /** Recorded outward action: the fact carries a recorded application
   * identity (MCP/provider-emitted `app`) — never inferred from tool names. */
  outward: z.boolean().optional(),
  /** Plan revision after an earlier plan (V3.1 pivot); id-backed refs only. */
  pivot: ReplayPivotSchema.optional(),
  groupKey: z.string().optional(),
  groupSize: z.number().int().optional(),
  app: z.string().optional(),
  resource: z.string().optional(),
  toolName: z.string().optional(),
  paths: z.array(z.string()),
  changeIds: z.array(z.string()).optional(),
  diffstat: z
    .object({ additions: z.number().int(), deletions: z.number().int() })
    .nullable()
    .optional(),
  durationMs: z.number().int().nullable().optional(),
});
export type ReplayFactDto = z.infer<typeof ReplayFactDtoSchema>;

export const ReplayChapterCategorySchema = z.enum([
  'request',
  'approach',
  'discovery',
  'decision',
  'pivot',
  'change',
  'problem',
  'verification',
  'result',
]);
export type ReplayChapterCategory = z.infer<typeof ReplayChapterCategorySchema>;

export const ReplayChapterDtoSchema = z.object({
  id: z.string(),
  category: ReplayChapterCategorySchema,
  label: z.string(),
  factId: z.string(),
  storyStartMs: z.number().int(),
  actualStartMs: z.number().int(),
});
export type ReplayChapterDto = z.infer<typeof ReplayChapterDtoSchema>;

export const ReplayCoverageSegmentSchema = z.object({
  actualStartMs: z.number().int(),
  actualEndMs: z.number().int(),
  storyStartMs: z.number().int(),
  storyEndMs: z.number().int(),
  level: ReplayEvidenceLevelSchema,
});
export type ReplayCoverageSegment = z.infer<typeof ReplayCoverageSegmentSchema>;

export const ReplayCitedLineSchema = z.object({ label: z.string(), factId: z.string() });

export const ReplaySessionDtoSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  /** External sessions may have no recorded goal; the UI must say so. */
  goalRecorded: z.boolean(),
  outcome: z.enum(['completed', 'partial', 'attention', 'stopped', 'running']),
  outcomeLabel: z.string(),
  verification: z.enum(['verified', 'partial', 'unverified']),
  actualDurationMs: z.number().int(),
  storyDurationMs: z.number().int(),
  eventCount: z.number().int(),
  latestSequence: z.number().int(),
  summary: z.object({
    /** Deterministic template — never an uncited model narrative. */
    result: z.string(),
    /** Verbatim excerpt of the agent's recorded final report (Inferred level):
     * quoted, anchored to its fact — never a synthesized narrative. */
    conclusion: z.object({ text: z.string(), factId: z.string() }).nullable(),
    changed: z.array(ReplayCitedLineSchema),
    /** Recorded outward actions (facts with a recorded app identity). */
    outward: z.array(
      z.object({
        label: z.string(),
        factId: z.string(),
        app: z.string().optional(),
        reversibility: z.enum(['reversible', 'compensatable', 'irreversible', 'unknown']),
      }),
    ),
    attention: z.array(ReplayCitedLineSchema),
    citations: z.array(z.string()),
  }),
  /** Recorded inputs fed with the request (user-attached code refs). Memory
   * and rule injections are not ledgered yet — the UI must say "not recorded". */
  inputs: z.object({ files: z.array(z.string()) }),
  chapters: z.array(ReplayChapterDtoSchema),
  coverage: z.array(ReplayCoverageSegmentSchema),
});
export type ReplaySessionDto = z.infer<typeof ReplaySessionDtoSchema>;

/**
 * On-demand evidence detail (task.replayEvidence). Two durable evidence
 * kinds exist today: a ledger event row and a content-addressed file version
 * pair. integrityHash is the recorded SHA-256 of the after-version blob;
 * events carry no independent hash yet and must not pretend to.
 */
export const ReplayEvidenceDetailSchema = z.object({
  id: z.string(),
  type: z.enum(['event', 'file-version']),
  /** Provenance label: the ledger event type, or 'file_changes'. */
  source: z.string(),
  capturedAt: z.string(),
  integrityHash: z.string().nullable(),
  path: z.string().optional(),
  kind: z.string().optional(),
  beforeHash: z.string().nullable().optional(),
  afterHash: z.string().nullable().optional(),
  patch: z.string().nullable().optional(),
  beforeText: z.string().nullable().optional(),
  afterText: z.string().nullable().optional(),
  binary: z.boolean().optional(),
  /** Bounded, pretty-printed payload excerpt for ledger events. */
  payloadExcerpt: z.string().optional(),
});
export type ReplayEvidenceDetail = z.infer<typeof ReplayEvidenceDetailSchema>;

/** Explicit replay entry request — replaces the old boolean open flag. */
export interface ReplayRequest {
  taskId: string;
  depth?: ReplayDepth;
  anchor?:
    | { type: 'result' }
    | { type: 'fact'; id: string }
    | { type: 'change'; id: string }
    /** First material change touching this path (Changes-panel entry). */
    | { type: 'path'; path: string }
    | { type: 'actual-time'; ms: number };
  liveFollow?: boolean;
}

export interface ReplayTaskContext {
  id: string;
  goalMd: string;
  state: string;
  createdAt: string;
  external?: { cli: string; status: 'active' | 'ended' } | null;
}

export interface ReplayProjection {
  session: ReplaySessionDto;
  facts: ReplayFactDto[];
}

// ---------- tuning constants (exported for tests) ----------

/** Real gaps at least this long are folded into a story gap marker. */
export const IDLE_FOLD_MS = 45_000;
/** Repeated low-impact facts within this real gap can share one story frame. */
export const GROUP_GAP_MS = 30_000;
/** Story Time target ceiling (soft: mandatory floors may exceed it). */
export const STORY_MAX_MS = 90_000;
/** Story length of one folded idle gap marker. */
const GAP_MARKER_MS = 600;
/** Story ms per weight unit before compression. */
const BASE_UNIT_MS = 900;

// ---------- per-fact classification ----------

const RUNNING_STATES = new Set([
  'READY',
  'EXPLORING',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);

function laneFor(item: ActivityItem): ReplayLane {
  switch (item.kind) {
    case 'user':
    case 'message':
    case 'question':
    case 'answer':
    case 'plan':
    case 'plan-decision':
      return 'intent';
    case 'write':
    case 'report':
      return 'artifacts';
    case 'permission':
    case 'verification':
    case 'review':
      return 'risk';
    default:
      return 'actions';
  }
}

function isMaterialChange(item: ActivityItem): boolean {
  return (
    item.kind === 'write' &&
    ((item.changeIds?.length ?? 0) > 0 ||
      (item.diffstat != null && item.diffstat.additions + item.diffstat.deletions > 0))
  );
}

/**
 * Recorded outward action: an agent act carrying a recorded application
 * identity (`app` is MCP/provider-emitted, never inferred from tool names or
 * paths). Reads/searches stay inward even when app-attributed.
 */
function isOutwardAction(item: ActivityItem): boolean {
  return (
    Boolean(item.app) &&
    item.author === 'agent' &&
    item.kind !== 'read' &&
    item.kind !== 'search' &&
    item.kind !== 'state' &&
    item.kind !== 'system'
  );
}

/** Verbatim excerpt for the conclusion line: cut at a sentence boundary. */
function excerptSentence(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(
    cut.lastIndexOf('。'),
    cut.lastIndexOf('.'),
    cut.lastIndexOf('；'),
    cut.lastIndexOf('！'),
    cut.lastIndexOf('？'),
  );
  return stop > max * 0.5 ? cut.slice(0, stop + 1) : `${cut}…`;
}

function isMandatory(item: ActivityItem): boolean {
  return (
    item.status === 'error' ||
    item.status === 'denied' ||
    item.kind === 'permission' ||
    item.kind === 'verification' ||
    item.kind === 'report' ||
    item.riskLevel === 'R3' ||
    item.riskLevel === 'R4' ||
    isMaterialChange(item)
  );
}

/** §5.2 — per-fact evidence level. File changes alone are never Verified. */
function levelFor(item: ActivityItem): ReplayEvidenceLevel {
  if (item.kind === 'verification' && item.status === 'ok') return 'verified';
  if ((item.captureGrade ?? 'full') === 'observed') return 'observed';
  return 'recorded';
}

function riskFor(item: ActivityItem): ReplayFactDto['risk'] {
  switch (item.riskLevel) {
    case 'R0':
      return 'none';
    case 'R1':
      return 'low';
    case 'R2':
      return 'medium';
    case 'R3':
    case 'R4':
      return 'high';
    default:
      return 'none';
  }
}

function reversibilityFor(item: ActivityItem): ReplayFactDto['reversibility'] {
  if (item.kind === 'write') {
    // Blob-backed changes restore byte-exact through the existing rollback path.
    return (item.changeIds?.length ?? 0) > 0 ? 'reversible' : 'unknown';
  }
  if (item.kind === 'command') return 'unknown';
  return 'unknown';
}

function sourceLabel(source: ActivityItem['source']): string {
  if (source === 'claude') return 'Claude CLI';
  if (source === 'codex') return 'Codex CLI';
  if (source === 'external') return 'External CLI';
  return 'Pi Agent';
}

function actorFor(item: ActivityItem): ReplayFactDto['actor'] {
  if (item.author === 'user') return { kind: 'user', label: 'You' };
  if (item.author === 'system') return { kind: 'system', label: 'System' };
  return { kind: 'agent', label: sourceLabel(item.source) };
}

function groupKeyFor(item: ActivityItem, mandatory: boolean): string | null {
  if (mandatory) return null;
  const lowImpact = item.status === 'ok' || item.status === 'info' || item.status === 'running';
  if (!lowImpact) return null;
  const repeatable =
    item.kind === 'read' ||
    item.kind === 'search' ||
    (item.kind === 'command' && item.toolName === 'terminal' && item.status === 'info');
  if (!repeatable) return null;
  const target = item.paths[0] ?? item.resource ?? '';
  return `${item.kind}|${item.app ?? item.toolName ?? ''}|${target}`;
}

// ---------- actual timeline ----------

function actualOffsets(items: readonly ActivityItem[]): { startMs: number; offsets: number[] } {
  if (items.length === 0) return { startMs: 0, offsets: [] };
  const parsed = items.map((item) => Date.parse(item.at));
  const valid = parsed.filter(Number.isFinite);
  const startMs = valid[0] ?? 0;
  const offsets: number[] = [];
  parsed.forEach((atMs, index) => {
    const wallClock = Number.isFinite(atMs) ? Math.max(0, atMs - startMs) : index * 650;
    // Ledger timestamps can share one millisecond; keep real gaps while every
    // fact stays individually seekable.
    offsets.push(index === 0 ? wallClock : Math.max(wallClock, (offsets[index - 1] ?? 0) + 1));
  });
  return { startMs, offsets };
}

// ---------- the projection ----------

export function projectReplay(input: {
  task: ReplayTaskContext;
  items: readonly ActivityItem[];
  nowMs?: number;
}): ReplayProjection {
  const { task, items } = input;
  const { startMs, offsets } = actualOffsets(items);

  const running = task.external
    ? task.external.status === 'active'
    : RUNNING_STATES.has(task.state);

  const lastOffset = offsets.at(-1) ?? 0;
  const lastDuration = Math.max(0, items.at(-1)?.durationMs ?? 0);
  let actualDurationMs = Math.max(1_000, lastOffset + Math.max(lastDuration, 500));
  if (running && typeof input.nowMs === 'number' && startMs > 0) {
    actualDurationMs = Math.max(actualDurationMs, input.nowMs - startMs);
  }

  // -- classify facts and detect groups (consecutive, same key, small gaps) --
  interface Working {
    item: ActivityItem;
    index: number;
    mandatory: boolean;
    groupKey: string | null;
    idleBeforeMs: number;
  }
  const working: Working[] = items.map((item, index) => {
    const mandatory = isMandatory(item);
    const gap = index === 0 ? 0 : (offsets[index] ?? 0) - (offsets[index - 1] ?? 0);
    return {
      item,
      index,
      mandatory,
      groupKey: groupKeyFor(item, mandatory),
      idleBeforeMs: gap >= IDLE_FOLD_MS ? gap : 0,
    };
  });

  // Group runs: consecutive facts sharing a key with small real gaps.
  interface StoryEntity {
    members: Working[];
    weight: number;
    mandatory: boolean;
    grouped: boolean;
  }
  const entities: StoryEntity[] = [];
  let run: Working[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      entities.push({ members: run, weight: 1.6, mandatory: false, grouped: true });
    } else {
      for (const member of run) entities.push(entityFor(member));
    }
    run = [];
  };
  const entityFor = (member: Working): StoryEntity => {
    const { item, mandatory } = member;
    let weight = 1.0;
    if (mandatory) weight = 3.0;
    else if (item.kind === 'write') weight = 2.0;
    else if (laneFor(item) === 'intent') weight = 1.6;
    else if (item.kind === 'state' || item.kind === 'system') weight = 0.6;
    return { members: [member], weight, mandatory, grouped: false };
  };
  for (const member of working) {
    const previous = run.at(-1);
    const sameRun =
      previous != null &&
      member.groupKey !== null &&
      previous.groupKey === member.groupKey &&
      (offsets[member.index] ?? 0) - (offsets[previous.index] ?? 0) <= GROUP_GAP_MS &&
      member.idleBeforeMs === 0;
    if (sameRun) {
      run.push(member);
      continue;
    }
    flushRun();
    if (member.groupKey !== null) run = [member];
    else entities.push(entityFor(member));
  }
  flushRun();

  // -- Story Time allocation --
  const totalWeight = entities.reduce((sum, e) => sum + e.weight, 0);
  const idleCount = working.filter((w) => w.idleBeforeMs > 0).length;
  const gapStoryMs = idleCount * GAP_MARKER_MS;
  const natural = totalWeight * BASE_UNIT_MS + gapStoryMs;
  const unit =
    natural <= STORY_MAX_MS
      ? BASE_UNIT_MS
      : Math.max((STORY_MAX_MS - gapStoryMs) / Math.max(totalWeight, 1), 40);
  const mandatoryCount = entities.filter((e) => e.mandatory).length;
  const mandatoryFloor = Math.max(300, Math.min(1_500, 54_000 / Math.max(1, mandatoryCount)));

  const storySpans = new Map<number, { start: number; end: number }>();
  const groupSizes = new Map<number, number>();
  let storyCursor = 0;
  for (const entity of entities) {
    if (entity.members[0]!.idleBeforeMs > 0) storyCursor += GAP_MARKER_MS;
    let duration = entity.weight * unit;
    if (entity.mandatory) duration = Math.max(duration, mandatoryFloor);
    else if (entity.grouped) duration = Math.max(duration, 120);
    else duration = Math.max(duration, 150);
    const span = { start: Math.round(storyCursor), end: Math.round(storyCursor + duration) };
    for (const member of entity.members) {
      storySpans.set(member.index, span);
      if (entity.grouped) groupSizes.set(member.index, entity.members.length);
    }
    storyCursor += duration;
  }
  const storyDurationMs = Math.round(storyCursor);

  // -- explicit relations from recorded ids only --
  // callId → fact index for tool-lifecycle facts.
  const factIdOf = (index: number) => items[index]!.key;
  const toolByCall = new Map<string, number>();
  const requestedByRequestId = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind !== 'permission' && item.callId) toolByCall.set(item.callId, index);
    if (item.kind === 'permission' && item.status === 'pending' && item.parentKey) {
      requestedByRequestId.set(item.parentKey, index);
    }
  });
  const relationsFor = (item: ActivityItem, index: number): ReplayRelation[] => {
    const relations: ReplayRelation[] = [];
    if (item.kind === 'permission') {
      if (item.status === 'pending' && item.callId) {
        const tool = toolByCall.get(item.callId);
        if (tool !== undefined && tool !== index) {
          relations.push({ type: 'requested-by', factId: factIdOf(tool) });
        }
      } else if (item.status !== 'pending' && item.parentKey) {
        const requested = requestedByRequestId.get(item.parentKey);
        if (requested !== undefined && requested !== index) {
          relations.push({ type: 'requested-by', factId: factIdOf(requested) });
        }
      }
    }
    return relations;
  };

  // -- pivot detection (V3.1): a NEW agent plan proposal after an earlier one
  // is a recorded strategy revision. `status !== 'info'` excludes plan
  // progress ticks; a same-key lifecycle pair (running → terminal) is one
  // proposal, never a revision. Refs are id-backed: the prior plan plus the
  // failures recorded since it. The reason is the plan's own recorded prose.
  const pivotByIndex = new Map<number, ReplayPivot>();
  {
    let lastPlan = -1;
    let failures: number[] = [];
    items.forEach((item, index) => {
      if (item.status === 'error' || item.status === 'denied') failures.push(index);
      const isPlanProposal =
        item.kind === 'plan' && item.author === 'agent' && item.status !== 'info';
      if (!isPlanProposal) return;
      if (lastPlan < 0) {
        lastPlan = index;
        failures = [];
        return;
      }
      if (items[lastPlan]!.key !== item.key) {
        pivotByIndex.set(index, {
          reason: item.detail ?? null,
          refFactIds: [factIdOf(lastPlan), ...failures.slice(-3).map(factIdOf)],
        });
        failures = [];
      }
      lastPlan = index;
    });
  }

  // -- facts --
  const facts: ReplayFactDto[] = working.map(({ item, index, mandatory, groupKey }) => {
    const span = storySpans.get(index) ?? { start: 0, end: 0 };
    const start = offsets[index] ?? 0;
    const nextStart = offsets[index + 1];
    const rawEnd = start + Math.max(0, item.durationMs ?? 0);
    const actualEndMs = Math.round(
      Math.max(start, nextStart !== undefined ? Math.min(rawEnd, nextStart) : rawEnd),
    );
    const groupSize = groupSizes.get(index);
    return {
      id: item.key,
      sequence: item.sequence,
      startedAt: item.at,
      actualStartMs: Math.round(start),
      actualEndMs,
      storyStartMs: span.start,
      storyEndMs: span.end,
      idleBeforeMs: working[index]!.idleBeforeMs,
      lane: laneFor(item),
      actor: actorFor(item),
      action: item.label,
      ...(item.detail ? { detail: item.detail } : {}),
      kind: item.kind,
      status: item.status,
      source: item.source ?? 'pi',
      capture: item.captureGrade ?? 'full',
      level: levelFor(item),
      evidenceRefs: [`event:${item.key}`, ...(item.changeIds ?? []).map((id) => `change:${id}`)],
      relations: relationsFor(item, index),
      risk: riskFor(item),
      reversibility: reversibilityFor(item),
      mandatory,
      ...(isOutwardAction(item) ? { outward: true } : {}),
      ...(pivotByIndex.has(index) ? { pivot: pivotByIndex.get(index)! } : {}),
      ...(groupKey !== null && (groupSize ?? 0) >= 2 ? { groupKey, groupSize } : {}),
      ...(item.app ? { app: item.app } : {}),
      ...(item.resource ? { resource: item.resource } : {}),
      ...(item.toolName ? { toolName: item.toolName } : {}),
      paths: item.paths,
      ...(item.changeIds ? { changeIds: item.changeIds } : {}),
      ...(item.diffstat !== undefined ? { diffstat: item.diffstat } : {}),
      ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
    };
  });

  // -- coverage: interval capture levels; strong events never paint gaps --
  const coverage: ReplayCoverageSegment[] = [];
  const pushCoverage = (segment: ReplayCoverageSegment) => {
    const previous = coverage.at(-1);
    if (previous && previous.level === segment.level) {
      previous.actualEndMs = segment.actualEndMs;
      previous.storyEndMs = segment.storyEndMs;
    } else {
      coverage.push(segment);
    }
  };
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i]!;
    const next = facts[i + 1];
    const level: ReplayEvidenceLevel =
      fact.level === 'verified'
        ? 'verified'
        : fact.capture === 'observed'
          ? 'observed'
          : 'recorded';
    const segmentEnd =
      next === undefined
        ? Math.max(fact.actualStartMs + 1, actualDurationMs)
        : next.idleBeforeMs > 0
          ? Math.min(fact.actualStartMs + 1_000, next.actualStartMs)
          : next.actualStartMs;
    pushCoverage({
      actualStartMs: fact.actualStartMs,
      actualEndMs: segmentEnd,
      storyStartMs: fact.storyStartMs,
      storyEndMs:
        next === undefined ? storyDurationMs : Math.min(fact.storyEndMs, next.storyStartMs),
      level,
    });
    if (next !== undefined && next.idleBeforeMs > 0) {
      pushCoverage({
        actualStartMs: segmentEnd,
        actualEndMs: next.actualStartMs,
        storyStartMs: Math.min(fact.storyEndMs, next.storyStartMs),
        storyEndMs: next.storyStartMs,
        level: 'missing',
      });
    }
  }

  // -- semantic chapters (scored, never sampled by count) --
  const chapters = pickChapters(facts);

  // -- verification state (stale-aware) --
  const materialChange = items.map((item) => isMaterialChange(item));
  const passes = facts.filter((f) => f.kind === 'verification' && f.status === 'ok');
  const fails = facts.filter((f) => f.kind === 'verification' && f.status === 'error');
  const lastPassSeq = passes.at(-1)?.sequence ?? -1;
  const lastChangeSeq = facts.filter((_, index) => materialChange[index]).at(-1)?.sequence ?? -1;
  const verification: ReplaySessionDto['verification'] =
    passes.length > 0 && fails.length === 0 && lastChangeSeq < lastPassSeq
      ? 'verified'
      : passes.length > 0
        ? 'partial'
        : 'unverified';

  // -- outcome --
  const hasErrors = facts.some((f) => f.status === 'error' || f.status === 'denied');
  let outcome: ReplaySessionDto['outcome'];
  let outcomeLabel: string;
  if (running) {
    outcome = 'running';
    outcomeLabel = '进行中';
  } else if (task.external) {
    outcome = hasErrors ? 'attention' : 'completed';
    outcomeLabel = hasErrors ? '已结束 · 有失败事件' : '会话已结束';
  } else if (task.state === 'FAILED') {
    outcome = 'attention';
    outcomeLabel = '运行失败';
  } else if (task.state === 'INTERRUPTED' || task.state === 'CANCELLED') {
    outcome = 'stopped';
    outcomeLabel = task.state === 'CANCELLED' ? '已取消' : '被中断';
  } else if (task.state === 'ROLLED_BACK') {
    outcome = 'stopped';
    outcomeLabel = '已回滚';
  } else if (task.state === 'REVIEW_READY') {
    outcome = 'completed';
    outcomeLabel = 'Agent 完成 · 待审阅';
  } else if (task.state === 'IDLE') {
    // ADR-0032: the settled conversation — turns settled, session continuable.
    outcome = 'completed';
    outcomeLabel = '轮次已结算 · 会话可继续';
  } else if (task.state === 'ACCEPTED' || task.state === 'ARCHIVED') {
    outcome = 'completed';
    outcomeLabel = '已完成并接受';
  } else {
    outcome = 'completed';
    outcomeLabel = '已结束';
  }

  // -- result card (deterministic templates + citations, §5.1) --
  const changedByPath = new Map<string, { additions: number; deletions: number; factId: string }>();
  for (const [index, fact] of facts.entries()) {
    if (!materialChange[index]) continue;
    for (const path of fact.paths) {
      const entry = changedByPath.get(path) ?? { additions: 0, deletions: 0, factId: fact.id };
      entry.additions += fact.diffstat?.additions ?? 0;
      entry.deletions += fact.diffstat?.deletions ?? 0;
      entry.factId = fact.id;
      changedByPath.set(path, entry);
    }
  }
  const changed = [...changedByPath.entries()]
    .sort((a, b) => b[1].additions + b[1].deletions - (a[1].additions + a[1].deletions))
    .slice(0, 3)
    .map(([path, entry]) => ({
      label: `${path} +${entry.additions} −${entry.deletions}`,
      factId: entry.factId,
    }));

  // Recorded outward actions (V3.1): the non-file "what changed" track.
  const outwardFacts = facts.filter((fact) => fact.outward);
  const outward = outwardFacts.slice(0, 6).map((fact) => ({
    label: fact.action,
    factId: fact.id,
    ...(fact.app ? { app: fact.app } : {}),
    reversibility: fact.reversibility,
  }));

  const attention: Array<{ label: string; factId: string }> = [];
  // Irreversible / high-risk outward actions are pinned first: they are the
  // part no snapshot can undo.
  for (const fact of outwardFacts) {
    if (attention.length >= 2) break;
    if (fact.reversibility === 'irreversible' || fact.risk === 'high') {
      attention.push({ label: `对外动作：${fact.action}`, factId: fact.id });
    }
  }
  for (const fact of facts) {
    if (attention.length >= 4) break;
    if (fact.status === 'error' || fact.status === 'denied') {
      attention.push({ label: fact.action, factId: fact.id });
    }
  }
  const reportFact = facts.filter((f) => f.kind === 'report').at(-1);
  if (reportFact?.status === 'warn' && attention.length < 4) {
    attention.push({ label: '结果未经验证（未运行验证命令）', factId: reportFact.id });
  }
  const observedMs = coverage
    .filter((c) => c.level === 'observed' || c.level === 'missing')
    .reduce((sum, c) => sum + (c.actualEndMs - c.actualStartMs), 0);
  if (actualDurationMs > 0 && observedMs / actualDurationMs > 0.5 && attention.length < 4) {
    const firstObserved = facts.find((f) => f.capture === 'observed');
    if (firstObserved) {
      attention.push({
        label: '大部分时段仅有观察级证据，语义无法确认',
        factId: firstObserved.id,
      });
    }
  }

  const totalAdd = [...changedByPath.values()].reduce((sum, e) => sum + e.additions, 0);
  const totalDel = [...changedByPath.values()].reduce((sum, e) => sum + e.deletions, 0);
  const fileCount = changedByPath.size;
  const irreversibleCount = outwardFacts.filter(
    (fact) => fact.reversibility === 'irreversible',
  ).length;
  const outwardPhrase =
    outwardFacts.length > 0
      ? `${outwardFacts.length} 项对外动作${irreversibleCount > 0 ? `（${irreversibleCount} 项不可逆）` : ''}`
      : '';
  let result: string;
  if (outcome === 'running') {
    result = `任务进行中 — 已记录 ${facts.length} 个事件。`;
  } else if (outcome === 'attention') {
    result = `任务需要注意 — 记录到 ${attention.length} 个失败或被拒事件。`;
  } else if (outcome === 'stopped') {
    result = `任务已停止（${outcomeLabel}）— 共记录 ${facts.length} 个事件。`;
  } else if (fileCount > 0) {
    // Dual-track template (V3.1): files and outward actions are both results.
    result = `${outcomeLabel} — ${fileCount} 个文件被修改（+${totalAdd} −${totalDel}）${outwardPhrase ? `，${outwardPhrase}` : ''}。`;
  } else if (outwardFacts.length > 0) {
    result = `${outcomeLabel} — ${outwardPhrase}，未记录文件变更。`;
  } else {
    result = `${outcomeLabel} — 未记录文件变更或对外动作。`;
  }

  // Conclusion line: a verbatim, fact-anchored excerpt of the agent's own
  // recorded final report — quoted (Inferred), never synthesized.
  const conclusion =
    reportFact && reportFact.detail
      ? { text: excerptSentence(reportFact.detail, 220), factId: reportFact.id }
      : null;

  // Recorded inputs: user-attached code refs on the request/answers. Memory
  // and rule injections are not ledgered — the UI must say so, not guess.
  const inputFiles = [
    ...new Set(
      items
        .filter((it) => it.author === 'user' && (it.kind === 'user' || it.kind === 'answer'))
        .flatMap((it) => it.paths),
    ),
  ].slice(0, 24);

  const citations = [
    ...new Set(
      [
        ...changed.map((c) => c.factId),
        ...attention.map((a) => a.factId),
        ...(reportFact ? [reportFact.id] : []),
        ...passes.map((p) => p.id),
      ].filter(Boolean),
    ),
  ];

  const goal = task.goalMd.trim();
  const session: ReplaySessionDto = {
    taskId: task.id,
    goal: goal || '未记录原始目标',
    goalRecorded: goal.length > 0,
    outcome,
    outcomeLabel,
    verification,
    actualDurationMs: Math.round(actualDurationMs),
    storyDurationMs,
    eventCount: facts.length,
    latestSequence: items.reduce((max, item) => Math.max(max, item.sequence), 0),
    summary: { result, conclusion, changed, outward, attention, citations },
    inputs: { files: inputFiles },
    chapters,
    coverage,
  };

  return { session, facts };
}

// ---------- chapters ----------

function chapterCategory(fact: ReplayFactDto): ReplayChapterCategory {
  if (fact.status === 'error' || fact.status === 'denied') return 'problem';
  if (fact.pivot) return 'pivot';
  switch (fact.kind) {
    case 'user':
      return 'request';
    case 'plan':
      return 'approach';
    case 'plan-decision':
    case 'permission':
    case 'review':
      return 'decision';
    case 'write':
      return 'change';
    case 'verification':
      return 'verification';
    case 'report':
      return 'result';
    case 'search':
    case 'read':
      return 'discovery';
    default:
      return 'discovery';
  }
}

function pickChapters(facts: ReplayFactDto[]): ReplayChapterDto[] {
  let firstUserSeen = false;
  const repeats = new Map<string, number>();
  const scored = facts.map((fact) => {
    const category = chapterCategory(fact);
    let score: number;
    switch (category) {
      case 'problem':
        score = 95;
        break;
      case 'request':
        score = firstUserSeen ? 55 : 92;
        if (fact.kind === 'user') firstUserSeen = true;
        break;
      case 'result':
        score = 90;
        break;
      case 'pivot':
        // A recorded strategy revision is the turning point of the story.
        score = 91;
        break;
      case 'decision':
        score = fact.kind === 'permission' ? (fact.risk === 'high' ? 92 : 88) : 80;
        if (fact.status === 'pending') score = 60;
        break;
      case 'verification':
        score = 85;
        break;
      case 'change': {
        const delta = (fact.diffstat?.additions ?? 0) + (fact.diffstat?.deletions ?? 0);
        score = 72 + Math.min(14, delta / 8);
        break;
      }
      case 'approach':
        score = 70;
        break;
      default:
        score =
          fact.kind === 'search' ? 40 : fact.kind === 'command' && fact.status === 'ok' ? 30 : 20;
    }
    // Repetition decays: the 30th read of the same file is not a chapter.
    const repeatKey = `${category}|${fact.paths[0] ?? fact.action}`;
    const seen = repeats.get(repeatKey) ?? 0;
    repeats.set(repeatKey, seen + 1);
    score -= Math.min(30, seen * 20);
    return { fact, category, score };
  });

  return scored
    .sort((a, b) => b.score - a.score || a.fact.sequence - b.fact.sequence)
    .slice(0, 8)
    .sort((a, b) => a.fact.sequence - b.fact.sequence)
    .map(({ fact, category }) => ({
      id: `ch-${fact.id}`,
      category,
      label: fact.action,
      factId: fact.id,
      storyStartMs: fact.storyStartMs,
      actualStartMs: fact.actualStartMs,
    }));
}

// ---------- playhead helpers (shared by the controller and tests) ----------

/** Latest fact whose story (or actual) start is at or before the playhead. */
export function factIndexAtTime(
  facts: readonly ReplayFactDto[],
  playheadMs: number,
  mode: 'story' | 'actual',
): number {
  if (facts.length === 0) return 0;
  const startOf = (fact: ReplayFactDto) =>
    mode === 'story' ? fact.storyStartMs : fact.actualStartMs;
  let lo = 0;
  let hi = facts.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (startOf(facts[mid]!) <= playheadMs) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, Math.min(facts.length - 1, hi));
}
