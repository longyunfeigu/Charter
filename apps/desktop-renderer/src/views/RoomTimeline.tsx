import React, { useEffect, useRef, useState } from 'react';
import type {
  AskUserPromptDto,
  PermissionCardDto,
  TaskDto,
  TaskPlanDto,
  TimelineEventDto,
} from '@pi-ide/ipc-contracts';
import { toolPaths } from '@pi-ide/ipc-contracts';
import { useTaskStore } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { peekModeForTool } from './peek.js';
import { restoreScroll, saveScroll } from './scrollMemory.js';
import { Ic } from './home-icons.js';
import { ConfirmDangerButton } from './ui.js';
import {
  PermissionCard,
  PlanCard,
  QuestionCard,
  ConflictCard,
  useTimelineContext,
  type TimelineContext,
} from './AgentPanel.js';
import { isAnswered, stateLabel, toolVerb } from './labels.js';
import { Markdown } from './Markdown.js';

/**
 * Task Room timeline (PIVOT-032): the mockup language — ✓ milestones with
 * elapsed time, quiet bubbles, single-line tool rows that expand on demand.
 * Interactive approvals (permissions / open plan / questions) reuse the tested
 * cards from the agent panel so their testids and flows stay identical.
 */

function fmtDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 2500) return null;
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60 < 10 ? '0' : ''}${s - m * 60}s`;
}

/** +a −d from a unified patch (honest: derived from the change itself). */
function patchStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  return { additions, deletions };
}

const TOOL_ICON: Record<string, string> = {
  read_file: 'file',
  list_directory: 'folder',
  search_text: 'search',
  git_status: 'branch',
  git_diff: 'branch',
  apply_patch: 'pencil',
  create_file: 'pencil',
  delete_file: 'trash',
  rename_file: 'pencil',
  run_command: 'play',
  run_verification: 'checkCircle',
  ask_user: 'help',
  propose_plan: 'map',
  update_plan: 'map',
};

function Milestone(props: {
  tone?: 'ok' | 'run' | 'warn' | 'err';
  icon?: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  testid?: string;
  dataState?: string;
}): React.JSX.Element {
  const tone = props.tone ?? 'ok';
  return (
    <div
      className={`rt-milestone ${tone}`}
      {...(props.testid ? { 'data-testid': props.testid } : {})}
      {...(props.dataState ? { 'data-state': props.dataState } : {})}
    >
      <span className="rt-ms-ic" aria-hidden>
        {props.icon ??
          (tone === 'ok' ? '✓' : tone === 'err' ? '✕' : <span className="rt-ms-dot" />)}
      </span>
      <b>{props.label}</b>
      {props.meta ? <span className="rt-ms-meta">{props.meta}</span> : null}
      <span className="rt-ms-line" />
    </div>
  );
}

function Bubble(props: {
  who: 'you' | 'agent';
  children: React.ReactNode;
  testid?: string;
  live?: boolean;
}): React.JSX.Element {
  // Mockup A (ADR-0014): the side carries the speaker — you on the right as a
  // quiet chip-bubble, the agent on the left as plain prose. No role labels.
  return (
    <div
      className={`rt-bubble ${props.who}`}
      {...(props.testid ? { 'data-testid': props.testid } : {})}
    >
      <div className="rt-text">
        {props.children}
        {props.live ? <span className="rt-live-caret" aria-hidden /> : null}
      </div>
    </div>
  );
}

/** Open a timeline evidence path: peek by default (ADR-0014), Editor on ⌘/alt. */
function openTimelinePath(
  path: string,
  toolName: string,
  e?: { metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean },
): void {
  const app = useAppStore.getState();
  const taskId = app.taskRoomTaskId;
  if (!taskId) return;
  const task = useTaskStore.getState().tasks.find((t) => t.id === taskId);
  const explicit = e?.metaKey === true || e?.altKey === true || e?.ctrlKey === true;
  if (explicit && !task?.worktree) {
    app.setSurface('workspace');
    void useEditorStore.getState().openFile(path);
    return;
  }
  app.openPeek(taskId, path, peekModeForTool(toolName));
}

/** Single-line tool row; clicking expands the evidence. */
function ToolRow({ event }: { event: TimelineEventDto }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const payload = event.payload as Record<string, unknown>;
  const name = String(payload.name ?? '');
  const state = String(payload.state ?? '');
  const ok = payload.ok === true;
  const terminal = ['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'TIMED_OUT'].includes(state);
  const input = (payload.input ?? {}) as Record<string, unknown>;
  const paths = toolPaths(name, payload.input);
  const target =
    name === 'run_command'
      ? `${String(input.executable ?? '')} ${(Array.isArray(input.args) ? (input.args as string[]) : []).join(' ')}`.trim()
      : (paths[0] ?? '');

  let stat: { additions: number; deletions: number } | null = null;
  if (name === 'apply_patch' && typeof input.patch === 'string') stat = patchStat(input.patch);
  if (name === 'create_file' && typeof input.content === 'string') {
    stat = { additions: input.content.split('\n').length, deletions: 0 };
  }

  const live = !terminal;
  const denied = state === 'DENIED';
  const failed = terminal && !ok && !denied;
  const writing =
    live && ['apply_patch', 'create_file', 'delete_file', 'rename_file'].includes(name);

  return (
    <div
      className={`rt-tool ${live ? 'live' : ''} ${denied ? 'denied' : ''} ${failed ? 'failed' : ''}`}
      data-testid={`tl-tool-${name}`}
      data-state={state}
    >
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show details">
        <span className="rt-tool-ic" aria-hidden>
          <Ic name={TOOL_ICON[name] ?? 'wrench'} size={12} />
        </span>
        <span className="rt-tool-verb">{live ? liveVerb(name) : roomVerb(name)}</span>
        {target && paths.length > 0 ? (
          // PIVOT-015r: evidence paths open the in-room peek; ⌘/alt-click keeps
          // the explicit Editor jump (never for worktree tasks — not honest).
          <span
            className="rt-tool-target mono link"
            role="link"
            tabIndex={0}
            title={`Peek at ${target}`}
            data-testid={`tl-path-${target}`}
            onClick={(e) => {
              e.stopPropagation();
              openTimelinePath(target, name, e);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                openTimelinePath(target, name);
              }
            }}
          >
            {target}
          </span>
        ) : target ? (
          <span className="rt-tool-target mono">{target}</span>
        ) : null}
        <span className="rt-tool-sp" />
        {stat && !denied ? (
          <span className="rt-tool-stat mono">
            <i className="plus">+{stat.additions}</i> <i className="minus">−{stat.deletions}</i>
          </span>
        ) : null}
        {live ? (
          <span className="rt-tool-livechip">
            <i />
            {writing ? 'writing' : 'running'}
          </span>
        ) : denied ? (
          <span className="rt-tool-state warn">denied</span>
        ) : ok ? (
          <span className="rt-tool-state ok">✓</span>
        ) : (
          <span className="rt-tool-state err">
            {state === 'TIMED_OUT' ? 'timed out' : 'failed'}
          </span>
        )}
      </button>
      {open ? (
        <div className="rt-tool-detail">
          {payload.summary ? (
            <div className="rt-tool-summary">{String(payload.summary)}</div>
          ) : null}
          <pre className="mono">{JSON.stringify(payload.input ?? {}, null, 1)?.slice(0, 1500)}</pre>
        </div>
      ) : null}
    </div>
  );
}

/** Mockup A: one compact verb, the target chip carries the rest. */
const ROOM_VERBS: Record<string, string> = {
  read_file: 'Read',
  list_directory: 'Listed',
  search_text: 'Searched',
  apply_patch: 'Write',
  create_file: 'Write',
  delete_file: 'Delete',
  rename_file: 'Rename',
  run_command: 'Run',
  run_verification: 'Verify',
  git_status: 'Git',
  git_diff: 'Git',
};

function roomVerb(name: string): string {
  return ROOM_VERBS[name] ?? toolVerb(name);
}

function liveVerb(name: string): string {
  switch (name) {
    case 'apply_patch':
    case 'create_file':
      return 'Writing';
    case 'delete_file':
      return 'Deleting';
    case 'rename_file':
      return 'Renaming';
    case 'run_command':
      return 'Running';
    case 'run_verification':
      return 'Verifying';
    case 'read_file':
      return 'Reading';
    case 'search_text':
      return 'Searching';
    default:
      return toolVerb(name);
  }
}

/** Historical (closed) plan — the mockup's numbered-chip presentation. */
function PlanStatic({ plan }: { plan: TaskPlanDto }): React.JSX.Element {
  return (
    <div className="rt-plan" data-testid="plan-card-static">
      <div className="rt-plan-head">
        <b>Plan</b>
        <span className="rt-plan-v">v{plan.version}</span>
        <span className="rt-plan-meta">
          {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="rt-plan-sum">
        <Markdown text={plan.summary} />
      </div>
      <ol className="rt-plan-steps">
        {plan.steps.map((s, i) => (
          <li key={s.id} className={`st-${s.status}`}>
            <span className="rt-step-n">{s.status === 'done' ? '✓' : i + 1}</span>
            <span className="rt-step-t">{s.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Compact final report (hidden entirely for zero-change "Answered" tasks). */
function ReportCard({
  payload,
  context,
}: {
  payload: Record<string, unknown>;
  context: TimelineContext;
}): React.JSX.Element {
  const store = useTaskStore();
  const unverified = payload.unverified === true;
  const changed = payload.changed as
    { files: number; additions: number; deletions: number } | undefined;
  const verification = payload.verification as
    | {
        runs: Array<{ label: string; state: string; stale?: boolean }>;
        passed: number;
        failed: number;
      }
    | undefined;
  const agentSummary = typeof payload.agentSummary === 'string' ? payload.agentSummary : null;
  const risks = (payload.unresolvedRisks ?? []) as string[];
  return (
    <div className="rt-report" data-testid="tl-report">
      <div className="rt-plan-head">
        <b>Final report</b>
        <span className="rt-plan-meta">outcome: {String(payload.outcome)}</span>
      </div>
      {changed ? (
        <div className="rt-report-row" data-testid="report-changed">
          Changed {changed.files} file{changed.files === 1 ? '' : 's'}{' '}
          <span className="mono">
            <i className="plus">+{changed.additions}</i>{' '}
            <i className="minus">−{changed.deletions}</i>
          </span>
        </div>
      ) : null}
      {verification && verification.runs.length > 0 ? (
        <div className="rt-report-row" data-testid="report-verification">
          Verification: {verification.passed} passed, {verification.failed} failed
          {verification.runs.some((r) => r.stale) ? ' (some stale)' : ''}
        </div>
      ) : null}
      {unverified ? (
        <div className="rt-report-row warn" data-testid="report-unverified">
          Unverified — no verification commands were run.
        </div>
      ) : null}
      {risks.length > 0 ? (
        <div className="rt-report-row warn">Risks: {risks.join('; ')}</div>
      ) : null}
      {agentSummary ? (
        <details className="rt-report-sum">
          <summary>Agent's own summary (unverified narrative)</summary>
          <Markdown text={agentSummary} />
        </details>
      ) : null}
      <div className="rt-report-note">
        Evidence comes from the recorded change/verification/permission records, not from the agent.
      </div>
      {context.taskState === 'REVIEW_READY' ? (
        <div className="rt-report-actions">
          <button
            className="btn primary"
            data-testid="report-review-open"
            onClick={() => void store.openReview()}
          >
            Review changes
          </button>
          <span style={{ flex: 1 }} />
          <ConfirmDangerButton
            label="Roll back all…"
            confirmLabel="Confirm — roll back all"
            testid="report-rollback"
            quiet
            title="Restore every touched file to its pre-task state"
            onConfirm={() => void store.rollbackTask()}
          />
        </div>
      ) : null}
    </div>
  );
}

function eventNode(
  event: TimelineEventDto,
  context: TimelineContext,
  task: TaskDto,
  msMeta: Map<string, string | null>,
): React.JSX.Element | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'task.stateChanged': {
      const to = String(payload.to);
      const isCurrent = to === task.state;
      const past = !isCurrent;
      const tone = past
        ? 'ok'
        : ['FAILED'].includes(to)
          ? 'err'
          : ['AWAITING_PLAN_APPROVAL', 'AWAITING_PERMISSION', 'INTERRUPTED'].includes(to)
            ? 'warn'
            : ['REVIEW_READY', 'ACCEPTED'].includes(to)
              ? 'ok'
              : 'run';
      // Terminal "Answered" milestone replaces the review-ready ceremony.
      if (to === 'REVIEW_READY' && isAnswered(task)) {
        return (
          <Milestone
            key={event.id}
            tone="ok"
            label="Answered"
            meta="nothing changed on disk"
            testid="tl-answered"
            dataState={to}
          />
        );
      }
      return (
        <Milestone
          key={event.id}
          tone={tone as 'ok' | 'run' | 'warn' | 'err'}
          label={pastLabel(to, past)}
          meta={msMeta.get(event.id) ?? undefined}
          testid="tl-milestone"
          dataState={to}
        />
      );
    }
    case 'user.message': {
      const kind = typeof payload.kind === 'string' ? payload.kind : null;
      return (
        <Bubble key={event.id} who="you" testid="tl-user">
          {kind === 'answer' ? <span className="rt-kind">answer · </span> : null}
          {String(payload.text ?? '')}
        </Bubble>
      );
    }
    case 'agent.message':
      return (
        <Bubble key={event.id} who="agent" testid="tl-agent">
          <Markdown text={String(payload.text ?? '')} />
        </Bubble>
      );
    case 'agent.thinking':
      return (
        <ThinkingBlock
          key={event.id}
          text={String(payload.text ?? '')}
          durationMs={typeof payload.durationMs === 'number' ? payload.durationMs : null}
        />
      );
    case 'tool.call': {
      const toolName = String(payload.name ?? '');
      // Plan-channel plumbing never renders as tool rows — the plan card and
      // the decision/progress notes ARE its presentation (PIVOT-032).
      if (toolName === 'propose_plan' || toolName === 'update_plan') return null;
      if (
        String(payload.state ?? '') === 'FAILED' &&
        String(payload.summary ?? '') === 'CHG_VERSION_CONFLICT'
      ) {
        return <ConflictCard key={event.id} payload={payload} />;
      }
      return <ToolRow key={`${event.id}-${event.sequence}`} event={event} />;
    }
    case 'agent.toolProposed':
      return null;
    case 'agent.planProposed': {
      const plan = payload.plan as TaskPlanDto;
      const open =
        event.sequence === context.openPlanSeq && context.taskState === 'AWAITING_PLAN_APPROVAL';
      if (open) return <PlanCard key={`plan-${event.id}`} plan={plan} open variant="room" />;
      return <PlanStatic key={`plan-${event.id}`} plan={plan} />;
    }
    case 'user.planDecision': {
      const decision = String(payload.decision);
      return (
        <div
          key={event.id}
          className={`rt-note ${decision === 'approved' ? 'ok' : decision === 'rejected' ? 'err' : 'warn'}`}
          data-testid="tl-plan-decision"
        >
          {decision === 'approved'
            ? `✓ Plan approved${payload.auto === true ? ' automatically (auto mode)' : ''}${payload.edited === true ? ' with your edits' : ''}`
            : decision === 'changes_requested'
              ? `↻ You asked for plan changes${payload.reason ? ` — "${String(payload.reason)}"` : ''}`
              : '✕ Plan rejected — task cancelled'}
        </div>
      );
    }
    case 'user.planEdited':
      return (
        <div key={event.id} className="rt-note" data-testid="tl-plan-edited">
          You edited the plan (v{String((payload.plan as TaskPlanDto | undefined)?.version ?? '?')})
        </div>
      );
    case 'agent.planUpdated': {
      const delta = (payload.delta ?? []) as Array<{ id: string; to: string }>;
      return (
        <div key={event.id} className="rt-note" data-testid="tl-plan-updated">
          Plan progress: {delta.map((d) => `${d.id} → ${d.to}`).join(', ') || 'no changes'}
        </div>
      );
    }
    case 'permission.requested': {
      const card = payload.card as PermissionCardDto;
      return (
        <PermissionCard
          key={event.id}
          card={card}
          resolution={context.permissionResolutions.get(card.requestId) ?? null}
        />
      );
    }
    case 'permission.decided':
      return null;
    case 'agent.question': {
      const prompt = payload.prompt as AskUserPromptDto;
      return (
        <QuestionCard
          key={event.id}
          prompt={prompt}
          answered={context.answeredCallIds.has(prompt.callId)}
        />
      );
    }
    case 'agent.usage': {
      const usage = payload.usage as
        { inputTokens?: number; outputTokens?: number; costUsd?: number | null } | undefined;
      return (
        <div key={event.id} className="rt-usage mono" data-testid="tl-usage">
          {usage?.inputTokens ?? '?'} in · {usage?.outputTokens ?? '?'} out
          {/* Synthesized gateway models have no price table — hide a misleading $0. */}
          {usage?.costUsd != null && usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(4)}` : ''}
        </div>
      );
    }
    case 'review.decision':
      return (
        <div key={event.id} className="rt-note" data-testid="tl-review-decision">
          Review: {String(payload.decision)} {String(payload.scope)}{' '}
          <span className="mono">{String(payload.path)}</span>
        </div>
      );
    case 'task.accepted': {
      const auto = String(payload.actor ?? 'user') === 'system:full-auto';
      return (
        <Milestone
          key={event.id}
          tone="ok"
          label={auto ? 'Completed & applied automatically' : 'Changes accepted'}
          meta={auto ? 'Full auto — you can still roll back' : 'accepting is not a git commit'}
          testid="tl-accepted"
        />
      );
    }
    case 'task.mergedBack': {
      const files = (payload.files ?? []) as string[];
      return (
        <Milestone
          key={event.id}
          tone="ok"
          label="Merged into the project"
          meta={`${files.length} file${files.length === 1 ? '' : 's'} from ${String(payload.branch ?? 'worktree')}`}
          testid="tl-merged-back"
        />
      );
    }
    case 'merge.blocked': {
      const conflicts = (payload.conflicts ?? []) as Array<{ path: string; reason: string }>;
      return (
        <div key={event.id} className="rt-plan rt-conflicts" data-testid="tl-merge-blocked">
          <div className="rt-plan-head">
            <b>Merge blocked by conflicts</b>
          </div>
          {conflicts.map((c) => (
            <div key={c.path} className="rt-report-row warn">
              <span className="mono">{c.path}</span> — {c.reason}
            </div>
          ))}
        </div>
      );
    }
    case 'report.final': {
      if (isAnswered(task)) return null; // the Answered milestone covers it
      return <ReportCard key={event.id} payload={payload} context={context} />;
    }
    case 'run.failed': {
      const error = payload.error as { userMessage?: string; code?: string } | undefined;
      return (
        <div key={event.id} className="rt-plan rt-failedcard" data-testid="tl-failed">
          <div className="rt-plan-head">
            <b>Run failed</b>
            <span className="rt-plan-meta">{error?.code ?? 'unknown'}</span>
          </div>
          <div className="rt-report-row">{error?.userMessage}</div>
        </div>
      );
    }
    case 'run.aborted':
      return (
        <Milestone
          key={event.id}
          tone="warn"
          icon="■"
          label="Stopped"
          meta={`${String(payload.reason)} — nothing was rolled back automatically`}
          testid="tl-aborted"
        />
      );
    case 'worktree.setup': {
      const ok = payload.ok === true;
      return (
        <SetupRow
          key={event.id}
          command={String(payload.command ?? '')}
          ok={ok}
          exitCode={typeof payload.exitCode === 'number' ? payload.exitCode : null}
          durationMs={typeof payload.durationMs === 'number' ? payload.durationMs : 0}
          output={String(payload.outputTail ?? '')}
        />
      );
    }
    case 'verification.started':
      return null; // the completed row carries the evidence
    case 'verification.completed': {
      const run = payload.run as {
        label: string;
        state: string;
        exitCode: number | null;
        outputExcerpt: string;
      };
      const passed = run.state === 'passed';
      return <VerRow key={event.id} run={run} passed={passed} />;
    }
    case 'rollback.blocked': {
      const conflicts = (payload.conflicts ?? []) as Array<{ path: string; reason: string }>;
      return (
        <div key={event.id} className="rt-plan rt-conflicts" data-testid="tl-rollback-blocked">
          <div className="rt-plan-head">
            <b>Rollback blocked by conflicts</b>
          </div>
          {conflicts.map((c) => (
            <div key={c.path} className="rt-report-row warn">
              <span className="mono">{c.path}</span> — {c.reason}
            </div>
          ))}
        </div>
      );
    }
    case 'task.rolledBack':
      return (
        <Milestone
          key={event.id}
          tone="warn"
          icon="↺"
          label="Rolled back"
          meta={
            payload.discardedWorktree === true
              ? 'worktree discarded — the project was never touched'
              : `${String((payload.restored as string[] | undefined)?.length ?? 0)} file(s) restored`
          }
          testid="tl-rolledback"
        />
      );
    case 'system.workerCrashed':
      return (
        <Milestone
          key={event.id}
          tone="err"
          label="Agent worker crashed"
          meta={String(payload.note ?? '')}
          testid="tl-crash"
        />
      );
    case 'system.interruptedByRestart':
      return (
        <Milestone
          key={event.id}
          tone="warn"
          label="Interrupted by restart"
          meta={String(payload.note ?? '')}
          testid="tl-restart"
        />
      );
    case 'system.diagnostic':
      return (
        <div key={event.id} className="rt-note">
          {String(payload.detail ?? payload.code)}
        </div>
      );
    case 'task.created':
    case 'task.queued':
    case 'run.completed':
    case 'system.abortRequested':
      return null;
    default:
      return (
        <div key={event.id} className="rt-note">
          {event.type}
        </div>
      );
  }
}

function VerRow({
  run,
  passed,
}: {
  run: { label: string; state: string; exitCode: number | null; outputExcerpt: string };
  passed: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rt-tool ${passed ? '' : 'failed'}`}
      data-testid={`tl-verification-${run.state}`}
    >
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show output">
        <span className="rt-tool-ic" aria-hidden>
          <Ic name="play" size={12} />
        </span>
        <span className="rt-tool-verb">Verification</span>
        <span className="rt-tool-target mono">{run.label}</span>
        <span className="rt-tool-sp" />
        {passed ? (
          <span className="rt-tool-state ok">✓ passed</span>
        ) : (
          <span className="rt-tool-state err">
            {run.state}
            {run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}
          </span>
        )}
      </button>
      {open ? (
        <div className="rt-tool-detail">
          <pre className="mono">{run.outputExcerpt || '(no output)'}</pre>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Model reasoning (ADR-0011): collapsed by default, never part of the
 * evidence system. Live variant streams softly and folds when done.
 */
function ThinkingBlock(props: {
  text: string;
  durationMs: number | null;
  live?: boolean;
  startedAt?: number;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!props.live) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [props.live]);
  const seconds = props.live
    ? Math.max(0, Math.round((Date.now() - (props.startedAt ?? Date.now())) / 1000))
    : props.durationMs !== null
      ? Math.round(props.durationMs / 1000)
      : null;
  return (
    <div
      className={`rt-think ${props.live ? 'live' : ''} ${open ? 'open' : ''}`}
      data-testid={props.live ? 'tl-thinking-live' : 'tl-thinking'}
    >
      <button
        className="rt-think-head"
        onClick={() => setOpen(!open)}
        title={props.live ? 'The model is reasoning' : 'Show the model\u2019s reasoning'}
      >
        <span className="rt-think-star" aria-hidden>
          ✦
        </span>
        <span className={`rt-think-label ${props.live ? 'shimmer' : ''}`}>
          {props.live
            ? `Thinking${seconds && seconds > 1 ? ` · ${seconds}s` : '…'}`
            : `Thought${seconds && seconds > 0 ? ` for ${seconds}s` : ''}`}
        </span>
        {!props.live && !open ? (
          <span className="rt-think-preview">
            — {props.text.replace(/\s+/g, ' ').trim().slice(0, 110)}
          </span>
        ) : null}
        <span className="rt-think-chev" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open || props.live ? (
        <div className="rt-think-body" data-testid="tl-thinking-body">
          {props.text}
          {props.live ? <span className="rt-live-caret" aria-hidden /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Worktree setup evidence row (deps install etc. before the agent started). */
function SetupRow(props: {
  command: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const seconds = Math.round(props.durationMs / 1000);
  return (
    <div className={`rt-tool ${props.ok ? '' : 'failed'}`} data-testid="tl-worktree-setup">
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show setup output">
        <span className="rt-tool-ic" aria-hidden>
          <Ic name="wrench" size={12} />
        </span>
        <span className="rt-tool-verb">Worktree setup</span>
        <span className="rt-tool-target mono">{props.command}</span>
        <span className="rt-tool-sp" />
        {props.ok ? (
          <span className="rt-tool-state ok">✓ {seconds > 1 ? `${seconds}s` : ''}</span>
        ) : (
          <span className="rt-tool-state err">
            failed{props.exitCode !== null ? ` (exit ${props.exitCode})` : ''}
          </span>
        )}
      </button>
      {open ? (
        <div className="rt-tool-detail">
          <pre className="mono">{props.output || '(no output)'}</pre>
        </div>
      ) : null}
    </div>
  );
}

function pastLabel(state: string, past: boolean): string {
  if (!past) return stateLabel(state);
  // Completed phases read as achievements, mirroring the mockup.
  switch (state) {
    case 'EXPLORING':
      return 'Explored the codebase';
    case 'PLANNING':
      return 'Wrote a plan';
    case 'AWAITING_PLAN_APPROVAL':
      return 'Plan reviewed';
    case 'VERIFYING':
      return 'Ran verification';
    case 'IN_PROGRESS':
      return 'Worked';
    case 'AWAITING_PERMISSION':
      return 'Permission decided';
    default:
      return stateLabel(state);
  }
}

export function RoomTimeline({ task }: { task: TaskDto }): React.JSX.Element {
  const store = useTaskStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const context = useTimelineContext(task.state);

  // PIVOT-036: restore the per-task reading position once the timeline loads —
  // the same memory the Editor agent panel uses, so ⌘E round-trips keep it.
  useEffect(() => {
    if (store.loadingTimeline) return;
    const el = scrollRef.current;
    if (el) pinnedToBottom.current = restoreScroll(task.id, el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.loadingTimeline, task.id]);

  // Follow live output only while the user is pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [store.timeline.length, store.streaming?.text.length, store.streamingThinking?.text.length]);

  // Elapsed time per milestone = distance to the next state change.
  const msMeta = new Map<string, string | null>();
  const stateEvents = store.timeline.filter((e) => e.type === 'task.stateChanged');
  for (let i = 0; i < stateEvents.length; i++) {
    const cur = stateEvents[i]!;
    const next = stateEvents[i + 1];
    msMeta.set(cur.id, next ? fmtDuration(Date.parse(next.at) - Date.parse(cur.at)) : null);
  }

  return (
    <div
      ref={scrollRef}
      className="rt-scroll"
      data-testid="timeline"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        saveScroll(task.id, el);
      }}
    >
      {store.loadingTimeline ? (
        <div className="rt-note">Loading timeline…</div>
      ) : (
        <>
          {store.timeline.map((event) => eventNode(event, context, task, msMeta))}
          {store.streamingThinking ? (
            <ThinkingBlock
              live
              text={store.streamingThinking.text}
              durationMs={null}
              startedAt={store.streamingThinking.startedAt}
            />
          ) : null}
          {store.streaming ? (
            <Bubble who="agent" testid="tl-streaming" live>
              <Markdown text={store.streaming.text} />
            </Bubble>
          ) : null}
        </>
      )}
    </div>
  );
}
