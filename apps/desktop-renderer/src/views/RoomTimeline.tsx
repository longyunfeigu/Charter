import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AskUserPromptDto,
  PermissionCardDto,
  TaskDto,
  TaskPlanDto,
  TimelineEventDto,
} from '@pi-ide/ipc-contracts';
import { CodeContextRefsSchema, toolPaths } from '@pi-ide/ipc-contracts';
import { useTaskStore } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { peekModeForTool } from './peek.js';
import { restoreScroll, saveScroll } from './scrollMemory.js';
import { Ic } from './home-icons.js';
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
import { roomCopyFor, type RoomCopy } from './roomCopy.js';
import { SentCodeContext } from './CodeContextAttachments.js';
import { SentFileRefs, type SentFileRefPayload } from './FileContextAttachments.js';
import {
  computeWindow,
  growWindow,
  initialWindow,
  STREAM_MARKDOWN_LIMIT,
  TIMELINE_CHUNK,
} from './timeline-window.js';

/**
 * Task Room conversation: user and agent messages stay visually distinct,
 * while plans, tools and run metadata use quieter disclosure layers.
 * Interactive approvals (permissions / open plan / questions) reuse the tested
 * cards from the agent panel so their testids and flows stay identical.
 */

/** Worklog clock (ADR-0018): mm:ss.d since the room's first event. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

/**
 * ADR-0018: contiguous evidence rows collapse into one recessed worklog.
 * Row events group; null-rendering events pass through without breaking a
 * group; everything else (milestones, bubbles, cards) closes it.
 */
function isLogRow(event: TimelineEventDto): boolean {
  if (event.type === 'verification.completed' || event.type === 'worktree.setup') return true;
  if (event.type !== 'tool.call') return false;
  const payload = event.payload as Record<string, unknown>;
  const name = String(payload.name ?? '');
  if (name === 'propose_plan' || name === 'update_plan') return false; // renders null
  // Conflict cards present as cards, not rows — they break the group.
  return !(
    String(payload.state ?? '') === 'FAILED' &&
    String(payload.summary ?? '') === 'CHG_VERSION_CONFLICT'
  );
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
  copy: RoomCopy;
  testid?: string;
  live?: boolean;
}): React.JSX.Element {
  const speaker = props.who === 'you' ? props.copy.you : props.copy.charter;
  return (
    <article
      className={`rt-bubble ${props.who}`}
      aria-label={`${speaker} message`}
      lang={props.copy.locale === 'zh' ? 'zh-CN' : 'en'}
      {...(props.testid ? { 'data-testid': props.testid } : {})}
    >
      <div className="rt-speaker">{speaker}</div>
      <div className="rt-text">
        {props.children}
        {props.live ? <span className="rt-live-caret" aria-hidden /> : null}
      </div>
    </article>
  );
}

interface ConversationRef {
  taskId: string;
  title: string;
  projectName: string;
}

function recordedMessageParts(text: string): {
  message: string;
  acceptance: string[] | null;
  hasPriorTaskContext: boolean;
} {
  // Scenario directives are a mock-runner control channel, not user-facing
  // Session content. Keep them in recorded evidence but never leak them into
  // the collaboration transcript.
  let message = text.trim().replace(/^\[scenario:[^\]]+\]\s*/i, '');
  let acceptance: string[] | null = null;
  const noAcceptance = /\n\n\(No acceptance criteria were provided\.\)\s*$/u;
  if (noAcceptance.test(message)) {
    acceptance = [];
    message = message.replace(noAcceptance, '').trim();
  } else {
    const criteria = /\n\nAcceptance criteria:\n([\s\S]+)$/u.exec(message);
    if (criteria) {
      acceptance = criteria[1]!
        .split('\n')
        .map((line) => line.replace(/^\d+\.\s*/u, '').trim())
        .filter(Boolean);
      message = message.slice(0, criteria.index).trim();
    }
  }

  const followUp =
    /\n\n\(Follow-up to [\s\S]+?that task's changes are already applied in this project\.\)\s*$/u;
  const hasPriorTaskContext = followUp.test(message);
  if (hasPriorTaskContext) message = message.replace(followUp, '').trim();
  return { message, acceptance, hasPriorTaskContext };
}

function TaskContext({
  acceptance,
  conversationRefs,
  hasPriorTaskContext,
  copy,
}: {
  acceptance: string[] | null;
  conversationRefs: ConversationRef[];
  hasPriorTaskContext: boolean;
  copy: RoomCopy;
}): React.JSX.Element | null {
  const hasAcceptance = acceptance !== null && acceptance.length > 0;
  if (!hasAcceptance && conversationRefs.length === 0 && !hasPriorTaskContext) return null;
  return (
    <aside className="rt-context" data-testid="tl-task-context" aria-label={copy.taskContext}>
      <span className="rt-context-label">{copy.taskContext}</span>
      {hasAcceptance ? (
        <details className="rt-context-acceptance">
          <summary>
            {copy.acceptanceChecks} · {acceptance.length}
          </summary>
          <ol>
            {acceptance.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ol>
        </details>
      ) : null}
      {hasPriorTaskContext || conversationRefs.length > 0 ? (
        <span className="rt-context-prior">{copy.previousConversation}</span>
      ) : null}
      {conversationRefs.length > 0 ? (
        <span className="rt-conversation-refs" aria-label={copy.previousConversation}>
          {conversationRefs.map((ref) => (
            <span
              key={ref.taskId}
              className="rt-conversation-ref"
              data-testid={`tl-conversation-ref-${ref.taskId}`}
              title={ref.projectName ? `${ref.title} · ${ref.projectName}` : ref.title}
            >
              @{ref.title}
            </span>
          ))}
        </span>
      ) : null}
    </aside>
  );
}

/** ADR-0022: the PR draft as a durable timeline entry (copy-out only). */
function PrDraftEntry(props: {
  branch: string;
  body: string;
  commands: string;
}): React.JSX.Element {
  const app = useAppStore();
  const copy = async (label: string, text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      app.pushToast('success', `${label} copied.`);
    } catch {
      app.pushToast('error', `Could not copy the ${label.toLowerCase()}.`);
    }
  };
  return (
    <div className="rt-prdraft" data-testid="tl-pr-draft">
      <div className="rt-prdraft-title">PR draft — from the evidence ledger</div>
      <div className="rt-prdraft-branch mono">{props.branch} → your default branch</div>
      <div className="rt-prdraft-row">
        <button className="btn" onClick={() => void copy('PR body', props.body)}>
          Copy body
        </button>
        <button className="btn" onClick={() => void copy('Commands', props.commands)}>
          Copy commands
        </button>
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
function ToolRow({
  event,
  ts,
}: {
  event: TimelineEventDto;
  ts?: string;
}): React.JSX.Element | null {
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
        {ts ? <span className="rt-ts">{ts}</span> : null}
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

/** Historical plans keep their evidence, but no longer dominate the transcript. */
function PlanStatic({ plan, copy }: { plan: TaskPlanDto; copy: RoomCopy }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="rt-plan rt-plan-static" data-testid="plan-card-static">
      <button
        type="button"
        className="rt-plan-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="rt-plan-title">
          {copy.plan} v{plan.version}
        </span>
        <span className="rt-plan-meta">{copy.steps(plan.steps.length)}</span>
        <span className="rt-disclosure" aria-hidden>
          {open ? '−' : '+'}
        </span>
      </button>
      {open ? (
        <div className="rt-plan-content">
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
      ) : null}
    </div>
  );
}

/**
 * ADR-0016 (direction B): the completion report presents as STATE — the review
 * bar above the composer (TaskRoomView) — not as a timeline card. The timeline
 * keeps a quiet Done milestone whose meta carries the headline evidence.
 */
function DoneMilestone({
  payload,
  copy,
}: {
  payload: Record<string, unknown>;
  copy: RoomCopy;
}): React.JSX.Element {
  const changed = payload.changed as
    { files: number; additions: number; deletions: number } | undefined;
  const verification = payload.verification as
    { runs: unknown[]; passed: number; failed: number } | undefined;
  const parts: string[] = [];
  if (changed && changed.files > 0) {
    parts.push(
      copy.locale === 'zh'
        ? `${changed.files} 个文件 +${changed.additions} −${changed.deletions}`
        : `${changed.files} file${changed.files === 1 ? '' : 's'} +${changed.additions} −${changed.deletions}`,
    );
  }
  if (verification && verification.runs.length > 0) {
    parts.push(
      `${copy.checks} ${verification.passed} ${copy.passed}${
        verification.failed > 0 ? `, ${verification.failed} ${copy.failed}` : ''
      }`,
    );
  }
  if (payload.unverified === true) parts.push(copy.locale === 'zh' ? '未验证' : 'unverified');
  return (
    <Milestone
      tone={(verification?.failed ?? 0) > 0 ? 'warn' : 'ok'}
      label={copy.locale === 'zh' ? '完成' : 'Done'}
      meta={parts.join(' · ') || `outcome: ${String(payload.outcome)}`}
      testid="tl-done"
    />
  );
}

function eventNode(
  event: TimelineEventDto,
  context: TimelineContext,
  task: TaskDto,
  runStartMs: number,
  copy: RoomCopy,
): React.JSX.Element | null {
  const payload = event.payload as Record<string, unknown>;
  const clock = fmtClock(Date.parse(event.at) - runStartMs);
  switch (event.type) {
    case 'task.stateChanged': {
      const to = String(payload.to);
      // Terminal "Answered" milestone replaces the review-ready ceremony.
      // For external CLIs the edge is the process exit, not an answer.
      if (to === 'REVIEW_READY' && isAnswered(task)) {
        const endedLabel = copy.locale === 'zh' ? '会话已结束' : 'Session ended';
        const answeredLabel = copy.locale === 'zh' ? '已回答' : 'Answered';
        return (
          <Milestone
            key={event.id}
            tone="ok"
            label={task.external ? endedLabel : answeredLabel}
            meta={copy.locale === 'zh' ? '未改动磁盘文件' : 'nothing changed on disk'}
            testid="tl-answered"
            dataState={to}
          />
        );
      }
      // Routine phases already have a live activity strip, a plan/permission
      // surface, or the review bar. Repeating them as ceremony adds scroll but
      // no new decision-making information.
      if (
        [
          'EXPLORING',
          'PLANNING',
          'AWAITING_PLAN_APPROVAL',
          'IN_PROGRESS',
          'AWAITING_PERMISSION',
          'VERIFYING',
          'REVIEW_READY',
          'ACCEPTED',
          'ROLLED_BACK',
        ].includes(to)
      ) {
        return null;
      }
      const tone = to === 'FAILED' ? 'err' : 'warn';
      return (
        <Milestone
          key={event.id}
          tone={tone}
          label={stateLabel(to)}
          testid="tl-milestone"
          dataState={to}
        />
      );
    }
    case 'user.message': {
      const kind = typeof payload.kind === 'string' ? payload.kind : null;
      // ADR-0022: marquee feedback carries a screenshot thumbnail + selection.
      const preview =
        payload.preview && typeof payload.preview === 'object'
          ? (payload.preview as {
              thumbDataUrl?: unknown;
              pageUrl?: unknown;
              note?: unknown;
              selector?: unknown;
              rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
            })
          : null;
      // The note leads; the coordinate block the agent received stays
      // inspectable but folded — it's for the agent, not for reading twice.
      const previewNote = preview && typeof preview.note === 'string' ? preview.note : null;
      const conversationRefs: ConversationRef[] = Array.isArray(payload.conversationRefs)
        ? payload.conversationRefs.flatMap((value) => {
            if (!value || typeof value !== 'object') return [];
            const ref = value as Record<string, unknown>;
            if (typeof ref.taskId !== 'string' || typeof ref.title !== 'string') return [];
            return [
              {
                taskId: ref.taskId,
                title: ref.title,
                projectName: typeof ref.projectName === 'string' ? ref.projectName : '',
              },
            ];
          })
        : [];
      const recorded = recordedMessageParts(String(payload.text ?? ''));
      const acceptance = Array.isArray(payload.acceptance)
        ? payload.acceptance.filter((item): item is string => typeof item === 'string')
        : recorded.acceptance;
      const parsedCodeRefs = CodeContextRefsSchema.safeParse(payload.codeRefs ?? []);
      const codeRefs = parsedCodeRefs.success ? parsedCodeRefs.data : [];
      // ADR-0024: file / folder / image references that rode this message.
      const fileRefs: SentFileRefPayload[] = Array.isArray(payload.fileRefs)
        ? payload.fileRefs.flatMap((value) => {
            if (!value || typeof value !== 'object') return [];
            const ref = value as Record<string, unknown>;
            const kind =
              ref.kind === 'file' || ref.kind === 'folder' || ref.kind === 'image'
                ? ref.kind
                : null;
            if (!kind || typeof ref.name !== 'string') return [];
            return [
              {
                kind,
                name: ref.name,
                ...(typeof ref.path === 'string' ? { path: ref.path } : {}),
                ...(typeof ref.sizeBytes === 'number' ? { sizeBytes: ref.sizeBytes } : {}),
                ...(typeof ref.thumbDataUrl === 'string' ? { thumbDataUrl: ref.thumbDataUrl } : {}),
              },
            ];
          })
        : [];
      return (
        <React.Fragment key={event.id}>
          <Bubble who="you" copy={copy} testid="tl-user">
            {kind === 'answer' ? <span className="rt-kind">answer · </span> : null}
            {previewNote ? previewNote : recorded.message}
            {preview && typeof preview.thumbDataUrl === 'string' ? (
              <>
                <img
                  className="rt-preview-thumb"
                  data-testid="tl-preview-feedback"
                  src={preview.thumbDataUrl}
                  alt="Preview screenshot with the selected region"
                />
                <span className="rt-preview-meta">
                  preview · {typeof preview.pageUrl === 'string' ? preview.pageUrl : ''}
                  {typeof preview.selector === 'string' ? ` · ${preview.selector}` : ''}
                  {preview.rect &&
                  typeof preview.rect.width === 'number' &&
                  typeof preview.rect.height === 'number'
                    ? ` · ${preview.rect.width}×${preview.rect.height}`
                    : ''}
                </span>
                {previewNote ? (
                  <details className="rt-preview-full">
                    <summary>full message sent to the agent</summary>
                    <pre>{String(payload.text ?? '')}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
            <SentCodeContext refs={codeRefs} />
            <SentFileRefs refs={fileRefs} />
          </Bubble>
          <TaskContext
            acceptance={acceptance}
            conversationRefs={conversationRefs}
            hasPriorTaskContext={recorded.hasPriorTaskContext}
            copy={copy}
          />
        </React.Fragment>
      );
    }
    case 'agent.message':
      return (
        <Bubble key={event.id} who="agent" copy={copy} testid="tl-agent">
          <Markdown text={String(payload.text ?? '')} />
        </Bubble>
      );
    case 'agent.thinking':
      return (
        <ThinkingBlock
          key={event.id}
          text={String(payload.text ?? '')}
          durationMs={typeof payload.durationMs === 'number' ? payload.durationMs : null}
          copy={copy}
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
      return <ToolRow key={`${event.id}-${event.sequence}`} event={event} ts={clock} />;
    }
    case 'agent.toolProposed':
      return null;
    case 'agent.planProposed': {
      if (!context.visiblePlanSeqs.has(event.sequence)) return null;
      const plan = payload.plan as TaskPlanDto;
      const open =
        event.sequence === context.openPlanSeq && context.taskState === 'AWAITING_PLAN_APPROVAL';
      if (open) return <PlanCard key={`plan-${event.id}`} plan={plan} open variant="room" />;
      return <PlanStatic key={`plan-${event.id}`} plan={plan} copy={copy} />;
    }
    case 'user.planDecision': {
      const decision = String(payload.decision);
      const parsedCodeRefs = CodeContextRefsSchema.safeParse(payload.codeRefs ?? []);
      const codeRefs = parsedCodeRefs.success ? parsedCodeRefs.data : [];
      return (
        <React.Fragment key={event.id}>
          <div
            className={`rt-note ${decision === 'approved' ? 'ok' : decision === 'rejected' ? 'err' : 'warn'}`}
            data-testid="tl-plan-decision"
          >
            {decision === 'approved'
              ? copy.locale === 'zh'
                ? `✓ 计划已批准${payload.auto === true ? '（自动模式）' : ''}${payload.edited === true ? '，包含你的修改' : ''}`
                : `✓ Plan approved${payload.auto === true ? ' automatically (auto mode)' : ''}${payload.edited === true ? ' with your edits' : ''}`
              : decision === 'changes_requested'
                ? copy.locale === 'zh'
                  ? `↻ 你要求修改计划${payload.reason ? ` — “${String(payload.reason)}”` : ''}`
                  : `↻ You asked for plan changes${payload.reason ? ` — "${String(payload.reason)}"` : ''}`
                : copy.locale === 'zh'
                  ? '✕ 计划已拒绝，任务已取消'
                  : '✕ Plan rejected — task cancelled'}
          </div>
          {codeRefs.length > 0 ? (
            <div className="rt-plan-code-context">
              <SentCodeContext refs={codeRefs} />
            </div>
          ) : null}
        </React.Fragment>
      );
    }
    case 'user.planEdited':
      return (
        <div key={event.id} className="rt-note" data-testid="tl-plan-edited">
          {copy.locale === 'zh' ? '你修改了计划' : 'You edited the plan'} (v
          {String((payload.plan as TaskPlanDto | undefined)?.version ?? '?')})
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
      const resolution = context.permissionResolutions.get(card.requestId) ?? null;
      return (
        <div key={event.id} className="rt-perm-wrap">
          <PermissionCard card={card} resolution={resolution} />
          {resolution ? (
            <button
              className="rt-verify-replay"
              data-testid={`tl-verify-replay-${card.requestId}`}
              title="Open Verify at this approval — claim, evidence and disposition"
              onClick={() =>
                useTaskStore.getState().openReplay({
                  taskId: card.taskId,
                  depth: 'verify',
                  anchor: { type: 'fact', id: event.id },
                })
              }
            >
              <Ic name="shield" size={11} />
              在回放中核验
            </button>
          ) : null}
        </div>
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
      // Usage is aggregated once in RunDetails instead of interrupting every
      // conversational turn with token and price telemetry.
      return null;
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
    case 'task.prDraft': {
      // ADR-0022: evidence-ledger PR draft — persists here so dismissing the
      // post-accept card loses nothing. Copy-out only; never executed.
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const body = typeof payload.body === 'string' ? payload.body : '';
      const commands = typeof payload.commands === 'string' ? payload.commands : '';
      return <PrDraftEntry key={event.id} branch={branch} body={body} commands={commands} />;
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
      return <DoneMilestone key={event.id} payload={payload} copy={copy} />;
    }
    case 'task.modelChanged': {
      // ADR-0016: honest audit of a reply-time model/effort override.
      const model = payload.model as
        { providerId: string; modelId: string; thinkingLevel?: string } | undefined;
      return (
        <div key={event.id} className="rt-note" data-testid="tl-model-changed">
          Model for the next turn:{' '}
          <span className="mono">
            {model?.providerId}/{model?.modelId}
          </span>
          {model?.thinkingLevel ? ` · effort ${model.thinkingLevel}` : ''}
        </div>
      );
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
          ts={clock}
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
      return <VerRow key={event.id} run={run} passed={passed} ts={clock} />;
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
  ts,
}: {
  run: { label: string; state: string; exitCode: number | null; outputExcerpt: string };
  passed: boolean;
  ts?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rt-tool ${passed ? '' : 'failed'}`}
      data-testid={`tl-verification-${run.state}`}
    >
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show output">
        {ts ? <span className="rt-ts">{ts}</span> : null}
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
  copy: RoomCopy;
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
            ? `${props.copy.thinking}${seconds && seconds > 1 ? ` · ${seconds}s` : '…'}`
            : `${props.copy.thought}${
                seconds && seconds > 0
                  ? props.copy.locale === 'zh'
                    ? ` · ${seconds}s`
                    : ` for ${seconds}s`
                  : ''
              }`}
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
  ts?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const seconds = Math.round(props.durationMs / 1000);
  return (
    <div className={`rt-tool ${props.ok ? '' : 'failed'}`} data-testid="tl-worktree-setup">
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show setup output">
        {props.ts ? <span className="rt-ts">{props.ts}</span> : null}
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

function ActivityGroup({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="rt-worklog" data-testid="tl-worklog" aria-label="Agent activity">
      {children}
    </section>
  );
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds - minutes * 60).padStart(2, '0')}s`;
}

function RunDetails({
  actionCount,
  durationMs,
  inputTokens,
  outputTokens,
  costUsd,
  copy,
}: {
  actionCount: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  copy: RoomCopy;
}): React.JSX.Element | null {
  if (actionCount === 0 && inputTokens + outputTokens === 0 && durationMs < 1000) return null;
  return (
    <details className="rt-run-details" data-testid="tl-run-details">
      <summary>{copy.runDetails}</summary>
      <dl>
        {actionCount > 0 ? (
          <div>
            <dt>{copy.activity}</dt>
            <dd>{copy.actions(actionCount)}</dd>
          </div>
        ) : null}
        {durationMs >= 1000 ? (
          <div>
            <dt>{copy.duration}</dt>
            <dd>{formatDuration(durationMs)}</dd>
          </div>
        ) : null}
        {inputTokens + outputTokens > 0 ? (
          <div>
            <dt>{copy.tokens}</dt>
            <dd>
              {inputTokens.toLocaleString()} {copy.locale === 'zh' ? '输入' : 'in'} ·{' '}
              {outputTokens.toLocaleString()} {copy.locale === 'zh' ? '输出' : 'out'}
            </dd>
          </div>
        ) : null}
        {costUsd > 0 ? (
          <div>
            <dt>{copy.cost}</dt>
            <dd>${costUsd.toFixed(4)}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

export function RoomTimeline({ task }: { task: TaskDto }): React.JSX.Element {
  const store = useTaskStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const context = useTimelineContext(task.state, task.verification.length);
  const copy = roomCopyFor(`${task.title}\n${task.goalMd}`);

  // M11-04: bound the rendered node count. Only the tail is built; older events
  // are revealed in chunks. Reset when the room changes so a huge window from
  // one task never carries into another.
  const [visibleCount, setVisibleCount] = useState(initialWindow);
  useEffect(() => {
    setVisibleCount(initialWindow());
  }, [task.id]);

  // "Load earlier" prepends nodes, which would jump the viewport; capture the
  // pre-grow scroll geometry and restore the reading anchor after layout.
  const growAnchor = useRef<{ height: number; top: number } | null>(null);
  const loadEarlier = (): void => {
    const el = scrollRef.current;
    if (el) growAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisibleCount((n) => growWindow(n, store.timeline.length));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = growAnchor.current;
    if (el && anchor) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      growAnchor.current = null;
    }
  });

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

  // Tool evidence stays available on demand, while repeated usage events are
  // aggregated into one quiet run-details disclosure. Derived per timeline
  // change, not per render: streaming deltas re-render this component many
  // times a second and must not rebuild every event node (the streaming tail
  // itself renders below, outside this memo).
  const { grouped, runDurationMs, inputTokens, outputTokens, costUsd, actionCount, olderCount } =
    useMemo(() => {
      const total = store.timeline.length;
      const runStartMs = total > 0 ? Date.parse(store.timeline[0]!.at) : Date.now();
      const runEndMs = total > 0 ? Date.parse(store.timeline[total - 1]!.at) : runStartMs;
      // Summary stats reflect the WHOLE run (cheap numeric loop), independent of
      // the render window — a folded older event still counts toward totals.
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      let actionCount = 0;
      for (const event of store.timeline) {
        if (isLogRow(event)) actionCount += 1;
        if (event.type !== 'agent.usage') continue;
        const usage = (
          event.payload as {
            usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number | null };
          }
        ).usage;
        inputTokens += usage?.inputTokens ?? 0;
        outputTokens += usage?.outputTokens ?? 0;
        costUsd += usage?.costUsd ?? 0;
      }
      // Only the tail is turned into React nodes — this is the expensive part.
      const { startIndex, olderCount } = computeWindow(total, visibleCount);
      const windowed = startIndex > 0 ? store.timeline.slice(startIndex) : store.timeline;
      const grouped: React.JSX.Element[] = [];
      let logGroup: React.JSX.Element[] = [];
      let logGroupKey = '';
      const flushLog = (): void => {
        if (logGroup.length > 0) {
          grouped.push(<ActivityGroup key={`wl-${logGroupKey}`}>{logGroup}</ActivityGroup>);
          logGroup = [];
        }
      };
      for (const event of windowed) {
        const node = eventNode(event, context, task, runStartMs, copy);
        if (node === null) continue; // silent events never break a worklog
        if (isLogRow(event)) {
          if (logGroup.length === 0) logGroupKey = event.id;
          logGroup.push(node);
        } else {
          flushLog();
          grouped.push(node);
        }
      }
      flushLog();
      return {
        grouped,
        runDurationMs: Math.max(0, runEndMs - runStartMs),
        inputTokens,
        outputTokens,
        costUsd,
        actionCount,
        olderCount,
      };
    }, [store.timeline, context, task, copy, visibleCount]);

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
      <div className="rt-col">
        {store.loadingTimeline ? (
          <div className="rt-note">Loading timeline…</div>
        ) : (
          <>
            {olderCount > 0 ? (
              <button
                type="button"
                className="rt-load-earlier"
                data-testid="timeline-load-earlier"
                onClick={loadEarlier}
              >
                Load {Math.min(olderCount, TIMELINE_CHUNK)} earlier of {olderCount} hidden
              </button>
            ) : null}
            {grouped}
            {store.streamingThinking ? (
              <ThinkingBlock
                live
                text={store.streamingThinking.text}
                durationMs={null}
                startedAt={store.streamingThinking.startedAt}
                copy={copy}
              />
            ) : null}
            {store.streaming ? (
              <Bubble who="agent" copy={copy} testid="tl-streaming" live>
                {store.streaming.text.length > STREAM_MARKDOWN_LIMIT ? (
                  // Freeze guard (§16.5): don't re-parse a huge markdown string
                  // every token — show the plain tail live; the completed
                  // message settles into full markdown.
                  <pre className="rt-stream-raw" data-testid="tl-streaming-raw">
                    {store.streaming.text.slice(-STREAM_MARKDOWN_LIMIT)}
                  </pre>
                ) : (
                  <Markdown text={store.streaming.text} />
                )}
              </Bubble>
            ) : null}
            <RunDetails
              actionCount={actionCount}
              durationMs={runDurationMs}
              inputTokens={inputTokens}
              outputTokens={outputTokens}
              costUsd={costUsd}
              copy={copy}
            />
          </>
        )}
      </div>
    </div>
  );
}
