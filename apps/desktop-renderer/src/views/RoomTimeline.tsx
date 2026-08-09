import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AskUserPromptDto,
  PermissionCardDto,
  PrDraftDto,
  TaskDto,
  TaskPlanDto,
  TimelineEventDto,
} from '@pi-ide/ipc-contracts';
import {
  ArtifactFeedbackRefsSchema,
  CodeContextRefsSchema,
  toolPaths,
} from '@pi-ide/ipc-contracts';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { peekModeForTool } from './peek.js';
import { AT_BOTTOM, peekScroll, restoreScroll, saveScroll } from './scrollMemory.js';
import { Ic } from './home-icons.js';
import {
  PermissionCard,
  PlanCard,
  QuestionCard,
  ConflictCard,
  useTimelineContext,
  type TimelineContext,
} from './AgentPanel.js';
import { errorTitle, isAnswered, stateLabel, toolVerb } from './labels.js';
import { Markdown } from './Markdown.js';
import { roomCopyFor, type RoomCopy } from './roomCopy.js';
import { SentCodeContext } from './CodeContextAttachments.js';
import { SentFileRefs, type SentFileRefPayload } from './FileContextAttachments.js';
import { SentArtifactFeedback } from './ArtifactFeedbackAttachments.js';
import {
  AUTO_GROW_TOP_PX,
  computeWindow,
  growWindow,
  openingWindow,
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
function PrDraftEntry(props: { taskId: string; draft: PrDraftDto }): React.JSX.Element {
  const app = useAppStore();
  const { draft } = props;
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
      <div className="rt-prdraft-branch mono">{draft.branch} → your default branch</div>
      <div className="rt-prdraft-row">
        <button
          className="btn"
          data-testid="tl-pr-draft-open"
          onClick={() => useTaskStore.getState().openPrDraft(props.taskId, draft)}
        >
          Review draft
        </button>
        <button className="btn" onClick={() => void copy('PR body', draft.body)}>
          Copy body
        </button>
        <button className="btn" onClick={() => void copy('Commands', draft.commands)}>
          Copy commands
        </button>
      </div>
    </div>
  );
}

/** Open a timeline evidence path: peek by default (ADR-0014); ⌘/alt opens the
 * peek's Edit mode — the real shared document model, still inside the Session
 * (ADR-0054). Worktree/foreign-project files stay on the read-through modes
 * because the workspace document model cannot own their buffers. */
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
  const focused = useWorkspaceStore.getState().workspace?.path;
  if (explicit && !task?.worktree && task?.projectPath === focused) {
    app.openPeek(taskId, path, 'edit');
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
  rolledBackLater,
}: {
  payload: Record<string, unknown>;
  copy: RoomCopy;
  rolledBackLater: boolean;
}): React.JSX.Element {
  const executionFailed = payload.outcome === 'failed';
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
  if (rolledBackLater) {
    parts.push(copy.locale === 'zh' ? '回滚前的历史结果' : 'historical result before rollback');
  }
  if (payload.unverified === true) parts.push(copy.locale === 'zh' ? '未验证' : 'unverified');
  if (executionFailed) {
    const execution = payload.execution as { failedWriteCalls?: number } | undefined;
    const failedWrites = execution?.failedWriteCalls ?? 0;
    const failedWriteLabelCount = failedWrites > 0 ? failedWrites : 1;
    parts.unshift(
      copy.locale === 'zh'
        ? `${failedWriteLabelCount} 个文件操作失败`
        : `${failedWriteLabelCount} file action${failedWriteLabelCount === 1 ? '' : 's'} failed`,
    );
  }
  return (
    <Milestone
      tone={
        executionFailed ? 'err' : rolledBackLater || (verification?.failed ?? 0) > 0 ? 'warn' : 'ok'
      }
      label={
        rolledBackLater
          ? copy.locale === 'zh'
            ? '已回滚（此前完成）'
            : 'Rolled back (previously done)'
          : executionFailed
            ? copy.locale === 'zh'
              ? '最新请求失败'
              : 'Latest request failed'
            : copy.locale === 'zh'
              ? '完成'
              : 'Done'
      }
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
      // Answered state remains available in the room header/rail, but repeating
      // it after every conversational turn adds noise between messages.
      if ((to === 'REVIEW_READY' || to === 'IDLE') && isAnswered(task)) {
        return null;
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
          'AWAITING_USER',
          'AWAITING_PERMISSION',
          'VERIFYING',
          'REVIEW_READY',
          // ADR-0032: settlement is expressed by its own ledger events
          // (task.accepted / turn.rolledBack) — the IDLE edge is not noise-worthy.
          'IDLE',
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
      const parsedArtifactRefs = ArtifactFeedbackRefsSchema.safeParse(payload.artifactRefs ?? []);
      const artifactRefs = parsedArtifactRefs.success ? parsedArtifactRefs.data : [];
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
            <SentArtifactFeedback refs={artifactRefs} />
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
      return <PermissionCard key={event.id} card={card} resolution={resolution} />;
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
      // Usage remains in the durable timeline data, but telemetry does not
      // interrupt the conversation surface.
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
      // ADR-0022: evidence-ledger PR draft — the durable, non-blocking next
      // step after accept. Opening the larger card is always explicit.
      const branch = typeof payload.branch === 'string' ? payload.branch : '';
      const title = typeof payload.title === 'string' ? payload.title : '';
      const body = typeof payload.body === 'string' ? payload.body : '';
      const commands = typeof payload.commands === 'string' ? payload.commands : '';
      const bodyPath = typeof payload.bodyPath === 'string' ? payload.bodyPath : '';
      const receiptSha256 =
        typeof payload.receiptSha256 === 'string' ? payload.receiptSha256 : null;
      return (
        <PrDraftEntry
          key={event.id}
          taskId={task.id}
          draft={{ branch, title, body, commands, bodyPath, receiptSha256 }}
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
      return (
        <DoneMilestone
          key={event.id}
          payload={payload}
          copy={copy}
          rolledBackLater={
            context.latestRollbackSeq !== null && context.latestRollbackSeq > event.sequence
          }
        />
      );
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
    case 'memory.distilled': {
      // ADR-0028: a correction from this task became a project rule (receipt).
      const text = typeof payload.text === 'string' ? payload.text : '';
      return (
        <div key={event.id} className="rt-note" data-testid="tl-memory-distilled">
          Distilled into a project rule: “{text}” — future tasks carry it automatically.
        </div>
      );
    }
    case 'run.failed': {
      const error = payload.error as { userMessage?: string; code?: string } | undefined;
      return (
        <div key={event.id} className="rt-plan rt-failedcard" data-testid="tl-failed">
          <div className="rt-plan-head">
            <b>{errorTitle(error?.code)}</b>
          </div>
          <div className="rt-report-row">{error?.userMessage}</div>
          {error?.code ? (
            <details className="rt-run-technical">
              <summary>Technical details</summary>
              Error code: <span className="mono">{error.code}</span>
            </details>
          ) : null}
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
      return (
        <VerRow
          key={event.id}
          run={run}
          passed={passed}
          ts={clock}
          rolledBackLater={
            context.latestRollbackSeq !== null && context.latestRollbackSeq > event.sequence
          }
        />
      );
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
  rolledBackLater,
}: {
  run: { label: string; state: string; exitCode: number | null; outputExcerpt: string };
  passed: boolean;
  ts?: string;
  rolledBackLater: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`rt-tool ${passed ? '' : 'failed'}`}
      data-testid={`tl-verification-${run.state}`}
      data-historical={rolledBackLater ? 'true' : 'false'}
    >
      <button className="rt-tool-line" onClick={() => setOpen(!open)} title="Show output">
        {ts ? <span className="rt-ts">{ts}</span> : null}
        <span className="rt-tool-ic" aria-hidden>
          <Ic name="play" size={12} />
        </span>
        <span className="rt-tool-verb">Verification</span>
        <span className="rt-tool-target mono">{run.label}</span>
        <span className="rt-tool-sp" />
        {rolledBackLater ? (
          <span className="rt-tool-state warn">historical · stale after rollback</span>
        ) : passed ? (
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

/**
 * One memoized row per timeline event. Old events keep their object identity
 * across appends (the store replaces the array, not its members), so a tool
 * transition re-renders exactly the replaced row instead of the whole window.
 * `task` intentionally narrows to the three scalars eventNode reads.
 */
const EventRow = React.memo(
  function EventRow(props: {
    event: TimelineEventDto;
    context: TimelineContext;
    task: TaskDto;
    runStartMs: number;
    copy: RoomCopy;
  }): React.JSX.Element | null {
    return eventNode(props.event, props.context, props.task, props.runStartMs, props.copy);
  },
  (prev, next) =>
    prev.event === next.event &&
    prev.context === next.context &&
    prev.runStartMs === next.runStartMs &&
    prev.copy === next.copy &&
    prev.task.id === next.task.id &&
    prev.task.state === next.task.state &&
    prev.task.changedFiles === next.task.changedFiles,
);

const NO_EVENTS: TimelineEventDto[] = [];

export function RoomTimeline({ task }: { task: TaskDto }): React.JSX.Element {
  // Narrow subscriptions: the timeline must not re-render for catalog, model
  // or review-state churn — only for its own data and the live tail.
  // ADR-0055: data comes from the per-task cache (this room may be a hidden
  // kept-alive instance), and every active-only field is gated through the
  // selector so a hidden room re-renders for NOTHING the active session does —
  // no tokens, no loading flips, no other task's events.
  const isActive = useTaskStore((s) => s.activeTaskId === task.id);
  const timeline = useTaskStore((s) => s.timelines[task.id] ?? NO_EVENTS);
  const loadingTimeline = useTaskStore((s) =>
    s.activeTaskId === task.id ? s.loadingTimeline : false,
  );
  const streaming = useTaskStore((s) => (s.activeTaskId === task.id ? s.streaming : null));
  const streamingThinking = useTaskStore((s) =>
    s.activeTaskId === task.id ? s.streamingThinking : null,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const showingDecision = useRef(false);
  const scrollRaf = useRef(0);
  const followRaf = useRef(0);
  const growPending = useRef(false);
  const olderCountRef = useRef(0);
  // Auto-grow direction gate: -Infinity means "no observation yet", so the
  // first scroll event after mount/restore (often a programmatic bottom-pin
  // that lands near the clipped top on short overflows) can never register as
  // the user scrolling upward (adversarially confirmed misfire).
  const lastScrollTop = useRef(-Infinity);
  const context = useTimelineContext(task.state, task.verification.length, timeline);
  const copy = roomCopyFor(`${task.title}\n${task.goalMd}`);

  // M11-04: bound the rendered node count. Only the tail is built; older events
  // are revealed in chunks. Reset when the room changes so a huge window from
  // one task never carries into another. ADR-0055: the opening window is small
  // (progressive first paint) unless a mid-transcript reading position needs
  // the full window to restore into.
  const [visibleCount, setVisibleCount] = useState(() =>
    openingWindow(peekScroll(task.id), AT_BOTTOM),
  );
  useEffect(() => {
    setVisibleCount(openingWindow(peekScroll(task.id), AT_BOTTOM));
  }, [task.id]);

  // Unmount cancels an in-flight measurement frame. The final wheel of an
  // inertial scroll can be dropped by design: by cleanup time the node is
  // detached and measures 0/0/0 — saving that would overwrite the real
  // position with a false "pinned to bottom". One frame of drift is the
  // accepted cost (saveScroll itself also refuses detached elements).
  useEffect(
    () => () => {
      if (followRaf.current) cancelAnimationFrame(followRaf.current);
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = 0;
      followRaf.current = 0;
      lastScrollTop.current = -Infinity;
    },
    [task.id],
  );

  // "Load earlier" prepends nodes, which would jump the viewport; capture the
  // pre-grow scroll geometry and restore the reading anchor after layout.
  const growAnchor = useRef<{ height: number; top: number } | null>(null);
  const loadEarlier = (): void => {
    const el = scrollRef.current;
    if (el) growAnchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setVisibleCount((n) => growWindow(n, timeline.length));
  };
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = growAnchor.current;
    if (el && anchor) {
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      growAnchor.current = null;
      growPending.current = false;
    }
  });

  // PIVOT-036: restore the per-task reading position once the timeline loads —
  // the same memory the Editor agent panel uses, so ⌘E round-trips keep it.
  // Also re-runs when a kept-alive room is revealed again (isActive edge):
  // display:none preserves the DOM but the scroll offset is re-asserted from
  // memory so the reading position survives engines that reset it.
  useEffect(() => {
    if (!isActive || loadingTimeline) return;
    const el = scrollRef.current;
    if (el) pinnedToBottom.current = restoreScroll(task.id, el);
    showingDecision.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, loadingTimeline, task.id]);

  // Pending decisions take precedence over the generic live tail. Otherwise
  // the run-details footer can push the risk label behind the Session header.
  // Decision cards only appear with task-state or timeline changes — streaming
  // growth never introduces one, so this no longer runs per token.
  useEffect(() => {
    if (!isActive) return; // hidden rooms have no boxes to measure
    const el = scrollRef.current;
    if (!el) return;
    const decision = el.querySelector<HTMLElement>(
      '[data-testid="perm-card"], [data-testid="plan-card"], [data-testid="q-card"]',
    );
    if (decision) {
      if (!showingDecision.current) {
        const viewport = el.getBoundingClientRect();
        const card = decision.getBoundingClientRect();
        const inset = 14;
        const available = viewport.height - inset * 2;
        if (card.height > available || card.top < viewport.top + inset) {
          el.scrollTop += card.top - viewport.top - inset;
        } else if (card.bottom > viewport.bottom - inset) {
          el.scrollTop += card.bottom - viewport.bottom + inset;
        }
      }
      showingDecision.current = true;
      return;
    }
    if (showingDecision.current) {
      showingDecision.current = false;
      pinnedToBottom.current = true;
    }
    if (pinnedToBottom.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, task.state, timeline]);

  // Live tail follow: coalesce the per-token scrollTop writes to one per frame.
  useEffect(() => {
    if (!pinnedToBottom.current || showingDecision.current) return;
    if (followRaf.current) return;
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = 0;
      const el = scrollRef.current;
      if (el && pinnedToBottom.current && !showingDecision.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [streaming?.text.length, streamingThinking?.text.length]);

  // Tool evidence stays available inline. Derived per timeline change, not per
  // render: streaming deltas re-render this component many times a second and
  // must not rebuild every event node (the streaming tail itself renders below,
  // outside this memo). Rows are additionally memoized — an append touches the
  // group wrappers, not the settled rows' subtrees.
  const { grouped, olderCount } = useMemo(() => {
    const total = timeline.length;
    const runStartMs = total > 0 ? Date.parse(timeline[0]!.at) : 0;
    // Only the tail is turned into React nodes — this is the expensive part.
    const { startIndex, olderCount } = computeWindow(total, visibleCount);
    const windowed = startIndex > 0 ? timeline.slice(startIndex) : timeline;
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
      // eventNode decides visibility; render rows through the memo boundary.
      const probe = eventNode(event, context, task, runStartMs, copy);
      if (probe === null) continue; // silent events never break a worklog
      const node = (
        <EventRow
          key={`${event.id}-${event.sequence}`}
          event={event}
          context={context}
          task={task}
          runStartMs={runStartMs}
          copy={copy}
        />
      );
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
      olderCount,
    };
  }, [timeline, context, task, copy, visibleCount]);
  olderCountRef.current = olderCount;

  return (
    <div
      ref={scrollRef}
      className="rt-scroll"
      data-testid="timeline"
      data-live={RUNNING_TASK_STATES.has(task.state) ? 'true' : 'false'}
      onScroll={() => {
        // One rAF per frame: read scrollHeight/scrollTop/clientHeight once,
        // derive the pin verdict and the saved position from the same reads.
        if (scrollRaf.current) return;
        scrollRaf.current = requestAnimationFrame(() => {
          scrollRaf.current = 0;
          const el = scrollRef.current;
          if (!el) return;
          const previousTop = lastScrollTop.current;
          lastScrollTop.current = el.scrollTop;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          pinnedToBottom.current = pinned;
          saveScroll(task.id, el, pinned);
          // Progressive history: nearing the clipped top streams the next
          // chunk in automatically (the button remains as the explicit path).
          // Only an actual upward movement counts — programmatic bottom-pin
          // and restore writes land here too and must never grow the window.
          if (
            el.scrollTop < AUTO_GROW_TOP_PX &&
            el.scrollTop < previousTop &&
            olderCountRef.current > 0 &&
            !growPending.current
          ) {
            growPending.current = true;
            loadEarlier();
          }
        });
      }}
    >
      <div className="rt-col">
        {loadingTimeline ? (
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
            {streamingThinking ? (
              <ThinkingBlock
                live
                text={streamingThinking.text}
                durationMs={null}
                startedAt={streamingThinking.startedAt}
                copy={copy}
              />
            ) : null}
            {streaming ? (
              <Bubble who="agent" copy={copy} testid="tl-streaming" live>
                {streaming.text.length > STREAM_MARKDOWN_LIMIT ? (
                  // Freeze guard (§16.5): don't re-parse a huge markdown string
                  // every token — show the plain tail live; the completed
                  // message settles into full markdown.
                  <pre className="rt-stream-raw" data-testid="tl-streaming-raw">
                    {streaming.text.slice(-STREAM_MARKDOWN_LIMIT)}
                  </pre>
                ) : (
                  <Markdown text={streaming.text} live />
                )}
              </Bubble>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
