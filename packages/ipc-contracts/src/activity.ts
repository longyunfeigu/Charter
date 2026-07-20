import { z } from 'zod';
import type { TimelineEventDto } from './agent-dto.js';

/**
 * Activity stream (ADR-0006): one product-level item per thing the agent (or
 * the user, or the system) DID. Pure projection of the immutable task event
 * log — used identically by the live dashboard and by session replay, so the
 * two can never disagree. The agent is not assumed to be a coding agent:
 * messages, questions, commands, searches and permissions are first-class
 * actions; file edits are just one kind among them.
 */

export const ActivityKindSchema = z.enum([
  'message',
  'question',
  'answer',
  'plan',
  'plan-decision',
  'read',
  'search',
  'command',
  'write',
  'permission',
  'verification',
  'review',
  'state',
  'report',
  'system',
  'user',
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivityStatusSchema = z.enum([
  'running',
  'pending',
  'ok',
  'error',
  'denied',
  'warn',
  'info',
]);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const ReplaySourceSchema = z.enum(['pi', 'claude', 'codex', 'external']);
export type ReplaySource = z.infer<typeof ReplaySourceSchema>;

export const ReplayCaptureGradeSchema = z.enum(['full', 'structured', 'observed']);
export type ReplayCaptureGrade = z.infer<typeof ReplayCaptureGradeSchema>;

export const ReplayEvidenceKindSchema = z.enum([
  'message',
  'plan',
  'tool',
  'result',
  'file',
  'permission',
  'verification',
  'terminal',
  'application',
]);
export type ReplayEvidenceKind = z.infer<typeof ReplayEvidenceKindSchema>;

export const ActivityItemSchema = z.object({
  /** Stable identity: the event id, or the callId for tool lifecycles (so a
   * running item is replaced by its terminal item, never duplicated). */
  key: z.string(),
  taskId: z.string(),
  sequence: z.number().int(),
  at: z.string(),
  kind: ActivityKindSchema,
  label: z.string(),
  detail: z.string().optional(),
  status: ActivityStatusSchema,
  paths: z.array(z.string()),
  toolName: z.string().optional(),
  callId: z.string().optional(),
  author: z.enum(['agent', 'user', 'system']),
  /** Provenance is explicit so every replay projection can degrade honestly. */
  source: ReplaySourceSchema.optional(),
  captureGrade: ReplayCaptureGradeSchema.optional(),
  evidenceKinds: z.array(ReplayEvidenceKindSchema).optional(),
  /** Optional identity for cross-application projection; never inferred from pixels. */
  app: z.string().optional(),
  resource: z.string().optional(),
  parentKey: z.string().optional(),
  /** Recorded risk level (permission cards); never a product heuristic. */
  riskLevel: z.enum(['R0', 'R1', 'R2', 'R3', 'R4']).optional(),
  /** Filled by main-side enrichment (tool_calls / file_changes). */
  durationMs: z.number().int().nullable().optional(),
  diffstat: z
    .object({ additions: z.number().int(), deletions: z.number().int() })
    .nullable()
    .optional(),
  changeIds: z.array(z.string()).optional(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

// ---------- helpers ----------

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function trunc(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function cleanPath(path: string): string {
  return path.startsWith('./') ? path.slice(2) : path;
}

const WRITE_TOOLS = new Set(['apply_patch', 'create_file', 'delete_file', 'rename_file']);
/** Tool lifecycles that are already represented by richer dedicated events. */
const SILENT_TOOLS = new Set(['ask_user', 'propose_plan', 'update_plan']);

export function toolPaths(name: string, input: unknown): string[] {
  const data = rec(input);
  if (name === 'rename_file') {
    return [str(data.from), str(data.to)].filter(Boolean).map(cleanPath);
  }
  const single = str(data.path) || (name === 'list_directory' ? str(data.dir) : '');
  return single ? [cleanPath(single)] : [];
}

function toolKind(name: string): ActivityKind {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (name === 'run_command') return 'command';
  if (name === 'run_verification') return 'verification';
  if (name === 'search_text') return 'search';
  return 'read';
}

function commandLine(input: unknown): string {
  const data = rec(input);
  const args = Array.isArray(data.args) ? data.args.map((a) => str(a)) : [];
  return [str(data.executable), ...args].filter(Boolean).join(' ');
}

function toolLabel(name: string, input: unknown, running: boolean, ok: boolean | null): string {
  const data = rec(input);
  const paths = toolPaths(name, input);
  const target = paths[0] ?? '';
  switch (name) {
    case 'read_file':
      return running ? `Reading ${target}…` : `Read ${target}`;
    case 'list_directory':
      return running ? `Listing ${target || '.'}…` : `Listed ${target || '.'}`;
    case 'search_text':
      return running
        ? `Searching for "${trunc(str(data.query), 40)}"…`
        : `Searched for "${trunc(str(data.query), 40)}"`;
    case 'git_status':
      return running ? 'Checking git status…' : 'Checked git status';
    case 'git_diff':
      return running ? 'Reading git diff…' : 'Viewed git diff';
    case 'apply_patch':
      return running
        ? `Editing ${target}…`
        : ok === false
          ? `Edit failed: ${target}`
          : `Edited ${target}`;
    case 'create_file':
      return running
        ? `Creating ${target}…`
        : ok === false
          ? `Create failed: ${target}`
          : `Created ${target}`;
    case 'delete_file':
      return running
        ? `Deleting ${target}…`
        : ok === false
          ? `Delete failed: ${target}`
          : `Deleted ${target}`;
    case 'rename_file': {
      const [from, to] = [paths[0] ?? '', paths[1] ?? ''];
      return running ? `Renaming ${from} → ${to}…` : `Renamed ${from} → ${to}`;
    }
    case 'run_command': {
      const line = trunc(commandLine(input), 72);
      return running
        ? `Running ${line}…`
        : ok === false
          ? `Command failed: ${line}`
          : `Ran ${line}`;
    }
    case 'run_verification': {
      const label = str(data.label);
      return running
        ? `Verifying${label ? `: ${label}` : '…'}`
        : `Ran verification${label ? `: ${label}` : ''}`;
    }
    default:
      return running ? `Using ${name}…` : `Used ${name}`;
  }
}

const STATE_LABELS: Record<string, { label: string; status: ActivityStatus }> = {
  READY: { label: 'Ready to start', status: 'info' },
  EXPLORING: { label: 'Exploring the workspace', status: 'info' },
  PLANNING: { label: 'Planning', status: 'info' },
  AWAITING_PLAN_APPROVAL: { label: 'Waiting for your plan approval', status: 'pending' },
  IN_PROGRESS: { label: 'Working', status: 'info' },
  AWAITING_PERMISSION: { label: 'Waiting for your permission', status: 'pending' },
  VERIFYING: { label: 'Verifying', status: 'info' },
  REVIEW_READY: { label: 'Ready for your review', status: 'ok' },
  ACCEPTED: { label: 'Accepted', status: 'ok' },
  ROLLED_BACK: { label: 'Rolled back', status: 'warn' },
  INTERRUPTED: { label: 'Interrupted', status: 'warn' },
  FAILED: { label: 'Failed', status: 'error' },
  CANCELLED: { label: 'Cancelled', status: 'warn' },
  ARCHIVED: { label: 'Archived', status: 'info' },
};

// ---------- the projection ----------

/**
 * Project one task event to an activity item; returns null for events that
 * carry no user-meaningful action (usage ticks, unknown types). Never throws
 * on malformed payloads — a defensive fallback item is better than a dead feed.
 */
export function projectActivityEvent(event: TimelineEventDto): ActivityItem | null {
  const p = rec(event.payload);
  const base = {
    key: event.id,
    taskId: event.taskId,
    sequence: event.sequence,
    at: event.at,
    paths: [] as string[],
    author: 'agent' as const,
    source: 'pi' as const,
    captureGrade: 'full' as const,
  };

  switch (event.type) {
    case 'external.sessionStarted':
    case 'external.sessionResuming': {
      const source = str(p.cli);
      return {
        ...base,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: 'observed',
        evidenceKinds: ['terminal'] as const,
        kind: 'state',
        label:
          event.type === 'external.sessionResuming'
            ? `${source || 'External'} session resumed`
            : `${source || 'External'} session detected`,
        detail: 'Entry snapshot captured; terminal and file observations are being recorded.',
        status: 'info',
        author: 'system',
      };
    }
    case 'external.sessionEnded': {
      const source = str(p.cli);
      return {
        ...base,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: str(p.captureGrade) === 'structured' ? 'structured' : 'observed',
        evidenceKinds: ['terminal', 'file'] as const,
        kind: 'state',
        label: `External session ended · ${typeof p.changedFiles === 'number' ? p.changedFiles : 0} file${p.changedFiles === 1 ? '' : 's'} changed`,
        status: 'ok',
        author: 'system',
      };
    }
    case 'external.terminal': {
      const source = str(p.cli);
      return {
        ...base,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: str(p.captureGrade) === 'structured' ? 'structured' : 'observed',
        evidenceKinds: ['terminal'] as const,
        kind: 'command',
        label: `${source || 'External'} terminal output`,
        ...(str(p.text) ? { detail: str(p.text) } : {}),
        status: 'info',
        toolName: 'terminal',
      };
    }
    case 'external.fileChanged': {
      const source = str(p.cli);
      const path = cleanPath(str(p.path));
      const changeId = str(p.changeId);
      const additions = typeof p.additions === 'number' ? p.additions : 0;
      const deletions = typeof p.deletions === 'number' ? p.deletions : 0;
      return {
        ...base,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: str(p.captureGrade) === 'structured' ? 'structured' : 'observed',
        evidenceKinds: ['file'] as const,
        kind: 'write',
        label: `${source || 'External'} ${str(p.kind, 'modified')} ${path}`,
        status: 'ok',
        paths: path ? [path] : [],
        ...(changeId ? { changeIds: [changeId] } : {}),
        diffstat: { additions, deletions },
      };
    }
    case 'external.contextInjected': {
      const source = str(p.cli);
      const path = cleanPath(str(p.path));
      const range =
        typeof p.startLine === 'number' && typeof p.endLine === 'number'
          ? p.startLine === p.endLine
            ? ` L${p.startLine}`
            : ` L${p.startLine}–${p.endLine}`
          : '';
      return {
        ...base,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: str(p.captureGrade) === 'structured' ? 'structured' : 'observed',
        evidenceKinds: ['terminal'] as const,
        kind: 'user',
        label: `Context placed in ${source || 'the CLI'}'s input line · ${str(p.kind) === 'selection' ? 'selection' : 'file'} ${path}${range}`,
        status: 'info',
        paths: path ? [path] : [],
        author: 'user',
      };
    }
    case 'external.observation': {
      const source = str(p.cli);
      const kindValue = str(p.kind, 'system');
      const kind = ActivityKindSchema.safeParse(kindValue).success
        ? (kindValue as ActivityKind)
        : 'system';
      const statusValue = str(p.status, 'info');
      const status = ActivityStatusSchema.safeParse(statusValue).success
        ? (statusValue as ActivityStatus)
        : 'info';
      const evidenceKinds = Array.isArray(p.evidenceKinds)
        ? p.evidenceKinds
            .map((value) => ReplayEvidenceKindSchema.safeParse(value))
            .filter((value) => value.success)
            .map((value) => value.data)
        : [];
      const paths = Array.isArray(p.paths)
        ? p.paths.map((value) => cleanPath(str(value))).filter(Boolean)
        : [];
      return {
        ...base,
        key: str(p.key) || base.key,
        source: source === 'claude' || source === 'codex' ? source : 'external',
        captureGrade: str(p.captureGrade) === 'structured' ? 'structured' : 'observed',
        evidenceKinds,
        kind,
        label: trunc(str(p.label, 'External observation'), 180),
        ...(str(p.detail) ? { detail: trunc(str(p.detail), 4000) } : {}),
        status,
        paths,
        ...(str(p.callId) ? { callId: str(p.callId) } : {}),
        ...(str(p.toolName) ? { toolName: str(p.toolName) } : {}),
        ...(str(p.app) ? { app: str(p.app) } : {}),
        ...(str(p.resource) ? { resource: str(p.resource) } : {}),
        ...(str(p.parentKey) ? { parentKey: str(p.parentKey) } : {}),
      };
    }
    case 'user.message': {
      const isAnswer = str(p.kind) === 'answer';
      // Attached code refs are recorded inputs (Replay V3.1 input ledger);
      // they never pulse the tree — the glow only reacts to write/review paths.
      const refPaths = Array.isArray(p.codeRefs)
        ? p.codeRefs.map((ref) => cleanPath(str(rec(ref).path))).filter(Boolean)
        : [];
      return {
        ...base,
        author: 'user',
        kind: isAnswer ? 'answer' : 'user',
        label: isAnswer
          ? `Answered: “${trunc(str(p.text), 80)}”`
          : `You: “${trunc(str(p.text), 80)}”`,
        ...(str(p.text) ? { detail: trunc(str(p.text), 2000) } : {}),
        status: 'info',
        paths: [...new Set(refPaths)],
      };
    }
    case 'agent.message':
      return {
        ...base,
        kind: 'message',
        label: trunc(str(p.text), 140),
        // Full recorded prose (bounded) so replay can show the actual reply,
        // not only the one-line action label.
        ...(str(p.text) ? { detail: trunc(str(p.text), 2000) } : {}),
        status: 'ok',
      };
    case 'agent.thinking':
      // ADR-0011: reasoning is presentation-only — it never becomes the
      // action line or activity noise (the timeline renders it directly).
      return null;
    case 'worktree.setup': {
      const ok = p.ok === true;
      return {
        ...base,
        kind: 'command',
        label: ok
          ? `Worktree setup finished: ${trunc(str(p.command), 60)}`
          : `Worktree setup failed: ${trunc(str(p.command), 60)}`,
        status: ok ? 'ok' : 'error',
        author: 'system',
      };
    }
    case 'agent.question': {
      const prompt = rec(p.prompt);
      return {
        ...base,
        kind: 'question',
        callId: str(prompt.callId) || undefined,
        label: `Asked: “${trunc(str(prompt.question), 100)}”`,
        status: 'pending',
      };
    }
    case 'agent.toolProposed': {
      const call = rec(p.call);
      const name = str(call.toolName);
      if (SILENT_TOOLS.has(name)) return null;
      return {
        ...base,
        key: str(call.callId) || base.key,
        callId: str(call.callId) || undefined,
        kind: toolKind(name),
        toolName: name,
        label: toolLabel(name, call.input, true, null),
        status: 'running',
        paths: toolPaths(name, call.input),
      };
    }
    case 'tool.call': {
      const name = str(p.name);
      if (SILENT_TOOLS.has(name)) return null;
      const state = str(p.state);
      const running = !['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'TIMED_OUT'].includes(state);
      const ok = typeof p.ok === 'boolean' ? p.ok : null;
      const status: ActivityStatus = running
        ? 'running'
        : state === 'DENIED'
          ? 'denied'
          : state === 'CANCELLED' || state === 'TIMED_OUT'
            ? 'warn'
            : ok === false
              ? 'error'
              : 'ok';
      const summary = str(p.summary);
      return {
        ...base,
        key: str(p.callId) || base.key,
        callId: str(p.callId) || undefined,
        kind: toolKind(name),
        toolName: name,
        label: toolLabel(name, p.input, running, ok),
        ...(summary && !running ? { detail: trunc(summary, 200) } : {}),
        status,
        paths: toolPaths(name, p.input),
      };
    }
    case 'agent.planProposed': {
      const plan = rec(p.plan);
      const steps = Array.isArray(plan.steps) ? plan.steps.length : 0;
      return {
        ...base,
        kind: 'plan',
        label: `Proposed a plan (${steps} step${steps === 1 ? '' : 's'})`,
        ...(str(plan.summary) ? { detail: trunc(str(plan.summary), 200) } : {}),
        status: 'pending',
      };
    }
    case 'agent.planUpdated':
      return { ...base, kind: 'plan', label: 'Updated plan progress', status: 'info' };
    case 'user.planEdited':
      return {
        ...base,
        author: 'user',
        kind: 'plan',
        label: 'You edited the plan',
        status: 'info',
      };
    case 'user.planDecision': {
      const approved = str(p.decision) === 'approved';
      const auto = p.auto === true;
      return {
        ...base,
        author: auto ? 'system' : 'user',
        kind: 'plan-decision',
        label: approved
          ? auto
            ? 'Plan auto-approved (Auto mode)'
            : p.edited === true
              ? 'Plan approved with your edits'
              : 'Plan approved'
          : 'Plan rejected',
        status: approved ? 'ok' : 'denied',
      };
    }
    case 'permission.requested': {
      const card = rec(p.card);
      const preview = rec(card.preview);
      const risk = rec(card.risk);
      const riskLevel = str(risk.level);
      const targets = Array.isArray(preview.targets) ? preview.targets.map((t) => str(t)) : [];
      return {
        ...base,
        kind: 'permission',
        label: `Waiting for approval: ${trunc(str(preview.summary), 100)}`,
        status: 'pending',
        paths: targets.filter(Boolean).map(cleanPath),
        // Real recorded ids only: the tool call this request gates, and the
        // request id its decision will carry (never inferred from adjacency).
        ...(str(card.callId) ? { callId: str(card.callId) } : {}),
        ...(str(card.requestId) ? { parentKey: str(card.requestId) } : {}),
        ...(/^R[0-4]$/.test(riskLevel)
          ? { riskLevel: riskLevel as ActivityItem['riskLevel'] }
          : {}),
      };
    }
    case 'permission.decided': {
      const outcome = str(p.outcome);
      const riskLevel = str(p.risk);
      return {
        ...base,
        author: str(p.actor) === 'user' ? 'user' : 'system',
        kind: 'permission',
        label: `${
          outcome === 'allowed' ? 'Approved' : outcome === 'denied' ? 'Denied' : trunc(outcome, 20)
        }: ${trunc(str(p.summary), 100)}`,
        status: outcome === 'allowed' ? 'ok' : outcome === 'denied' ? 'denied' : 'info',
        ...(str(p.requestId) ? { parentKey: str(p.requestId) } : {}),
        ...(/^R[0-4]$/.test(riskLevel)
          ? { riskLevel: riskLevel as ActivityItem['riskLevel'] }
          : {}),
      };
    }
    case 'verification.started':
      return {
        ...base,
        author: str(p.initiator) === 'user' ? 'user' : 'agent',
        kind: 'verification',
        label: `Verification started: ${trunc(str(p.label), 80)}`,
        status: 'running',
      };
    case 'verification.completed': {
      const run = rec(p.run);
      const state = str(run.state);
      const exit = typeof run.exitCode === 'number' ? ` (exit ${run.exitCode})` : '';
      return {
        ...base,
        kind: 'verification',
        label: `Verification ${state}: ${trunc(str(run.label), 80)}${exit}`,
        ...(str(run.outputExcerpt) ? { detail: trunc(str(run.outputExcerpt), 200) } : {}),
        status:
          state === 'passed' ? 'ok' : state === 'failed' || state === 'timeout' ? 'error' : 'warn',
      };
    }
    case 'review.decision': {
      const accept = str(p.decision) === 'accept';
      const path = cleanPath(str(p.path));
      return {
        ...base,
        author: 'user',
        kind: 'review',
        label: `You ${accept ? 'accepted' : 'rejected'} ${
          str(p.scope) === 'hunk' ? `a change block in ${path}` : `changes to ${path}`
        }`,
        status: accept ? 'ok' : 'warn',
        paths: path ? [path] : [],
      };
    }
    case 'task.created':
      return {
        ...base,
        author: 'user',
        kind: 'state',
        label: `Task created (${str(p.mode, 'edit')} mode)`,
        status: 'info',
      };
    case 'task.queued':
      return {
        ...base,
        kind: 'state',
        label: 'Queued: waiting for a free agent slot',
        status: 'pending',
      };
    case 'task.stateChanged': {
      const to = str(p.to);
      const known = STATE_LABELS[to];
      if (!known) return null;
      return { ...base, kind: 'state', label: known.label, status: known.status, author: 'system' };
    }
    case 'task.accepted':
      return {
        ...base,
        author: 'user',
        kind: 'state',
        label: 'You accepted the changes',
        status: 'ok',
      };
    case 'task.rolledBack':
      return {
        ...base,
        author: 'user',
        kind: 'state',
        label: 'Rolled back to the pre-task state',
        status: 'warn',
      };
    case 'task.mergedBack': {
      const files = Array.isArray(p.files) ? p.files.map((f) => str(f)).filter(Boolean) : [];
      // kind 'write' so the merged files pulse/glow in the main project tree.
      return {
        ...base,
        kind: 'write',
        label: `Merged ${files.length} file${files.length === 1 ? '' : 's'} into the project`,
        status: 'ok',
        author: 'system',
        paths: files.map(cleanPath),
      };
    }
    case 'merge.blocked':
      return {
        ...base,
        kind: 'state',
        label: 'Merge blocked: the project changed during the task',
        status: 'warn',
        author: 'system',
      };
    case 'rollback.blocked':
      return {
        ...base,
        kind: 'state',
        label: 'Rollback blocked: files changed outside this task',
        status: 'warn',
        author: 'system',
      };
    case 'run.completed':
      return {
        ...base,
        kind: 'state',
        label: 'Agent run finished',
        status: 'ok',
        author: 'system',
      };
    case 'run.failed': {
      const error = rec(p.error);
      return {
        ...base,
        kind: 'state',
        label: 'Agent run failed',
        ...(str(error.userMessage) ? { detail: trunc(str(error.userMessage), 200) } : {}),
        status: 'error',
        author: 'system',
      };
    }
    case 'run.aborted':
      return {
        ...base,
        kind: 'state',
        label: `Run stopped (${str(p.reason, 'stopped')})`,
        status: 'warn',
        author: 'system',
      };
    case 'report.final': {
      const changed = rec(p.changed);
      const files = typeof changed.files === 'number' ? changed.files : 0;
      return {
        ...base,
        kind: 'report',
        label: `Final report — ${files} file${files === 1 ? '' : 's'} changed`,
        // The agent's own closing summary: recorded prose, never a verification.
        ...(str(p.agentSummary) ? { detail: trunc(str(p.agentSummary), 400) } : {}),
        status: p.unverified === true ? 'warn' : 'ok',
        author: 'system',
      };
    }
    case 'system.contextCompacted':
      return {
        ...base,
        kind: 'system',
        label: 'Context compacted',
        status: 'info',
        author: 'system',
      };
    case 'system.diagnostic':
      return {
        ...base,
        kind: 'system',
        label: `Runtime diagnostic: ${trunc(str(p.code, 'unknown'), 60)}`,
        status: 'warn',
        author: 'system',
      };
    case 'system.abortRequested':
      return { ...base, author: 'user', kind: 'system', label: 'Stop requested', status: 'info' };
    case 'system.workerCrashed':
      return {
        ...base,
        kind: 'system',
        label: 'The agent process exited unexpectedly',
        status: 'error',
        author: 'system',
      };
    case 'system.interruptedByRestart':
      return {
        ...base,
        kind: 'system',
        label: 'Interrupted by an application restart',
        status: 'warn',
        author: 'system',
      };
    default:
      return null; // agent.usage and future/unknown types: no activity noise
  }
}

/** Batch projection preserving order; drops null items. */
export function projectActivity(events: TimelineEventDto[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const event of events) {
    const item = projectActivityEvent(event);
    if (item) items.push(item);
  }
  return items;
}
