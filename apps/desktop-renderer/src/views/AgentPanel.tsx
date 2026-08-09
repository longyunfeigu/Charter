import React, { useEffect, useRef, useState } from 'react';
import type {
  AskUserPromptDto,
  PermissionCardDto,
  TaskPlanDto,
  TimelineEventDto,
} from '@pi-ide/ipc-contracts';
import { toolPaths } from '@pi-ide/ipc-contracts';
import { useTaskStore, activeTask, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { NewTaskDialog } from './NewTaskDialog.js';
import { PathChips } from './PathLinks.js';
import { useDraftStore } from '../store/draftStore.js';
import { useExternalStore } from '../store/externalStore.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';
import { restoreScroll, saveScroll } from './scrollMemory.js';
import { STREAM_MARKDOWN_LIMIT } from './timeline-window.js';
import { Markdown } from './Markdown.js';
import { Ic } from './home-icons.js';
import { ConfirmDangerButton } from './ui.js';
import {
  errorTitle,
  modeLabel,
  stateLabel,
  toolActionLabel,
  toolStateWord,
  toolVerb,
  canResumeExternal,
} from './labels.js';

const RISK_COLORS: Record<string, string> = {
  R0: 'var(--fg-muted)',
  R1: 'var(--info)',
  R2: 'var(--info)',
  R3: 'var(--warning)',
  R4: 'var(--danger)',
};

const RISK_POLICY =
  'R0 read-only · R1 reversible workspace write · R2 local execution · ' +
  'R3 external/hard-to-reverse (always asks, never granted permanently) · R4 forbidden by product policy';

/** Approval card (§13.3, PERM-004): tool, why, exact target, diff/command, scoped decisions. */
export function PermissionCard(props: {
  card: PermissionCardDto;
  resolution: { outcome: string; scope?: string | null } | null;
}): React.JSX.Element {
  // Actions only — subscribing here would re-render every visible card per
  // streaming token.
  const store = useTaskStore.getState();
  const { card, resolution } = props;
  const [reason, setReason] = useState('');
  const riskColor = RISK_COLORS[card.risk.level] ?? 'var(--fg)';
  const actionLabel = toolActionLabel(card.toolName);

  if (resolution) {
    const allowed = resolution.outcome === 'allowed';
    const outcomeLabel =
      resolution.outcome === 'allowed'
        ? 'Allowed'
        : resolution.outcome === 'denied'
          ? 'Denied'
          : resolution.outcome === 'cancelled'
            ? 'Cancelled'
            : 'No longer needed';
    return (
      <Card
        icon={allowed ? 'checkCircle' : resolution.outcome === 'denied' ? 'ban' : 'clock'}
        title={`${outcomeLabel}${resolution.scope ? ` for ${resolution.scope}` : ''} — ${actionLabel}`}
        tone={allowed ? 'success' : 'warning'}
        testid="perm-card-resolved"
        collapsible
      >
        <div className="text-muted">{card.preview.summary}</div>
      </Card>
    );
  }

  const decide = (
    kind: 'allow' | 'deny',
    scope: 'once' | 'task' | 'workspace' | 'always',
  ): void => {
    void store.decidePermission({
      requestId: card.requestId,
      kind,
      scope,
      expectedParamsHash: card.paramsHash,
      ...(kind === 'deny' && reason.trim() ? { reason: reason.trim() } : {}),
    });
  };

  return (
    <Card
      icon="shield"
      title={`Your approval is needed — ${actionLabel}`}
      tone="warning"
      testid="perm-card"
      className="permission-card"
    >
      <div className="permission-card-risk">
        <span
          style={{
            border: `1px solid ${riskColor}`,
            color: riskColor,
            borderRadius: 4,
            padding: '0 6px',
            fontSize: 11,
          }}
          data-testid="perm-risk"
        >
          {card.risk.level}
        </span>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {card.risk.reasons.join('; ')}
        </span>
      </div>
      <div className="permission-card-summary">{card.preview.summary}</div>
      {card.preview.targets && card.preview.targets.length > 0 ? (
        <div className="permission-card-targets">
          <b>Target</b> {card.preview.targets.join(', ')}
        </div>
      ) : null}
      <div className="permission-card-actions" aria-label="Permission decision">
        {card.options.allowScopes.includes('once') ? (
          <button
            className="btn primary"
            data-testid="perm-allow-once"
            onClick={() => decide('allow', 'once')}
          >
            Allow once
          </button>
        ) : null}
        {card.options.allowScopes.includes('task') ? (
          <button
            className="btn"
            data-testid="perm-allow-task"
            onClick={() => decide('allow', 'task')}
          >
            Allow for this task
          </button>
        ) : null}
        {card.options.allowScopes.includes('workspace') ? (
          <button
            className="btn"
            data-testid="perm-allow-workspace"
            onClick={() => decide('allow', 'workspace')}
            title="Allow this kind of action in this workspace from now on"
          >
            Allow in workspace
          </button>
        ) : null}
        <button
          className="btn danger"
          data-testid="perm-deny"
          onClick={() => decide('deny', 'once')}
        >
          Deny
        </button>
        <button
          className="btn danger"
          data-testid="perm-deny-always"
          onClick={() => decide('deny', 'always')}
          title="Always deny this kind of action in this workspace"
        >
          Always deny
        </button>
      </div>
      <input
        data-testid="perm-reason"
        aria-label="Reason for denying this action"
        placeholder="Optional reason shown to the agent when denying…"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        style={{
          width: '100%',
          marginTop: 6,
          background: 'var(--bg-input)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          padding: '4px 6px',
          fontSize: 12,
        }}
      />
      <details className="permission-card-details text-muted">
        <summary>Technical details and risk policy</summary>
        <div className="permission-card-technical">
          <div>Action: {actionLabel}</div>
          {card.preview.command ? (
            <pre className="mono">
              $ {card.preview.command.executable} {card.preview.command.args.join(' ')}
              {'\n'}working directory: {card.preview.command.cwd}
            </pre>
          ) : null}
          {card.preview.diff ? (
            <pre className="mono permission-card-diff">{card.preview.diff}</pre>
          ) : (
            <div>No file diff — this action does not modify files directly.</div>
          )}
          {card.preview.detail ? <div>{card.preview.detail}</div> : null}
          <div>{RISK_POLICY}</div>
        </div>
      </details>
    </Card>
  );
}

const STEP_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  done: '●',
  skipped: '◌',
  blocked: '⊘',
};

/** Plan card (§13.2, AG-007/008): view, edit (text/order/remove), approve or reject.
 * variant 'room' renders the timeline-v2 presentation with identical testids/logic. */
export function PlanCard(props: {
  plan: TaskPlanDto;
  open: boolean;
  variant?: 'panel' | 'room';
}): React.JSX.Element {
  // Actions only — no store fields are read, so don't subscribe.
  const store = useTaskStore.getState();
  const { plan, open } = props;
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(plan.summary);
  const [steps, setSteps] = useState(
    plan.steps.map((s) => ({ id: s.id as string | undefined, title: s.title, status: s.status })),
  );

  if (!open) {
    return (
      <Card
        key="plan-static"
        icon="map"
        title={`Plan v${plan.version} — ${plan.summary.slice(0, 80)}`}
        testid="plan-card-static"
        collapsible
      >
        <ol style={{ margin: '4px 0 4px 18px', padding: 0 }}>
          {plan.steps.map((s) => (
            <li key={s.id} style={{ fontSize: 12 }}>
              <span aria-hidden>{STEP_ICON[s.status] ?? '○'}</span> {s.title}
              <span className="text-muted"> ({s.status})</span>
            </li>
          ))}
        </ol>
      </Card>
    );
  }

  const approve = (): void => {
    const removedDone = plan.steps.filter(
      (orig) => orig.status === 'done' && !steps.some((s) => s.id === orig.id),
    );
    if (removedDone.length > 0) {
      const ok = window.confirm(
        `This edit removes ${removedDone.length} completed step(s). Remove them anyway?`,
      );
      if (!ok) return;
    }
    const edited =
      summary !== plan.summary ||
      steps.length !== plan.steps.length ||
      steps.some((s, i) => plan.steps[i]?.id !== s.id || plan.steps[i]?.title !== s.title);
    void store.decidePlan({
      decision: 'approve',
      ...(edited
        ? {
            editedPlan: {
              summary,
              steps: steps.map((s) => ({ ...(s.id ? { id: s.id } : {}), title: s.title })),
            },
            confirmRemovedDone: removedDone.length > 0,
          }
        : {}),
    });
  };

  const move = (index: number, delta: number): void => {
    const next = [...steps];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setSteps(next);
  };

  const room = props.variant === 'room';
  const body = (
    <>
      {editing ? (
        <input
          data-testid="plan-summary-input"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          style={{
            width: '100%',
            marginBottom: 6,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 12,
          }}
        />
      ) : (
        <div style={{ marginBottom: 6 }} className={room ? 'rt-plan-sum' : ''}>
          {summary}
        </div>
      )}
      <ol
        className={room && !editing ? 'rt-plan-steps' : ''}
        style={room && !editing ? {} : { margin: '0 0 6px 18px', padding: 0 }}
      >
        {steps.map((step, i) => (
          <li
            key={step.id ?? `new-${i}`}
            className={room && !editing ? `st-${step.status}` : ''}
            style={room && !editing ? {} : { fontSize: 12, marginBottom: 3 }}
          >
            {editing ? (
              <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  data-testid={`plan-step-input-${i}`}
                  value={step.title}
                  onChange={(e) =>
                    setSteps(steps.map((s, j) => (j === i ? { ...s, title: e.target.value } : s)))
                  }
                  style={{
                    flex: 1,
                    background: 'var(--bg-input)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    padding: '2px 6px',
                    fontSize: 12,
                  }}
                />
                <button className="btn" aria-label="Move step up" onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="btn" aria-label="Move step down" onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  className="btn danger"
                  aria-label="Remove step"
                  data-testid={`plan-step-remove-${i}`}
                  onClick={() => {
                    if (
                      step.status === 'done' &&
                      !window.confirm('This step is already done. Remove it anyway?')
                    ) {
                      return;
                    }
                    setSteps(steps.filter((_, j) => j !== i));
                  }}
                >
                  ✕
                </button>
              </span>
            ) : room ? (
              <>
                <span className="rt-step-n">{step.status === 'done' ? '✓' : i + 1}</span>
                <span className="rt-step-t">{step.title}</span>
              </>
            ) : (
              <>
                <span aria-hidden>{STEP_ICON[step.status] ?? '○'}</span> {step.title}
              </>
            )}
          </li>
        ))}
      </ol>
      {editing ? (
        <button
          className="btn"
          data-testid="plan-step-add"
          onClick={() =>
            setSteps([...steps, { id: undefined, title: 'New step', status: 'pending' }])
          }
        >
          ＋ Add step
        </button>
      ) : null}
      <div
        style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}
      >
        <button className="btn primary" data-testid="plan-approve" onClick={approve}>
          Approve plan
        </button>
        <button className="btn" data-testid="plan-edit-toggle" onClick={() => setEditing(!editing)}>
          {editing ? 'Preview' : 'Edit plan'}
        </button>
        <span style={{ flex: 1 }} />
        <button
          className="btn quiet-danger"
          data-testid="plan-reject"
          title="Rejecting the plan cancels this task"
          onClick={() => {
            if (window.confirm('Reject the plan? The task will be cancelled.')) {
              void store.decidePlan({ decision: 'reject' });
            }
          }}
        >
          Cancel task…
        </button>
      </div>
    </>
  );

  if (room) {
    return (
      <div className="rt-plan rt-plan-open" data-testid="plan-card">
        <div className="rt-plan-head">
          <b>Plan</b>
          <span className="rt-plan-v">v{plan.version}</span>
          <span className="rt-plan-meta">waiting for your approval</span>
        </div>
        {body}
        <div className="rt-plan-hint">
          Prefer different steps? Reply below — the agent will revise the plan.
        </div>
      </div>
    );
  }
  return (
    <Card
      key="plan-interactive"
      icon="map"
      title={`Plan proposed (v${plan.version}) — approval needed`}
      tone="warning"
      testid="plan-card"
    >
      {body}
    </Card>
  );
}

/** Agent patch hit a version conflict (M8-06, E2E-014): user edits are protected. */
export function ConflictCard(props: { payload: Record<string, unknown> }): React.JSX.Element {
  const editor = useEditorStore();
  const input = (props.payload.input ?? {}) as { path?: string };
  const path = typeof input.path === 'string' ? input.path : null;
  return (
    <Card
      icon="alert"
      title={`Version conflict — ${path ?? 'file'}`}
      tone="danger"
      testid="tl-conflict"
    >
      <div style={{ fontSize: 12 }}>
        The file changed after the agent read it (your edit or an external change). The stale patch
        was rejected and <b>nothing was overwritten</b>. The agent can re-read the file and try
        again; you can compare the versions in the editor.
      </div>
      {path ? (
        <button
          className="btn"
          style={{ marginTop: 6 }}
          data-testid="conflict-open-file"
          onClick={() => void editor.openFile(path)}
        >
          Open {path}
        </button>
      ) : null}
    </Card>
  );
}

/** ask_user question card — the run is paused until the user answers. */
export function QuestionCard(props: {
  prompt: AskUserPromptDto;
  answered: boolean;
}): React.JSX.Element {
  // Actions only — no store fields are read, so don't subscribe.
  const store = useTaskStore.getState();
  const [text, setText] = useState('');
  const { prompt, answered } = props;
  if (answered) {
    return (
      <Card icon="help" title="Question (answered)" testid="q-card-answered" collapsible>
        <Markdown className="text-muted" text={prompt.question} />
      </Card>
    );
  }
  return (
    <Card icon="help" title="The agent has a question" tone="warning" testid="q-card">
      <div style={{ marginBottom: 6 }}>
        <Markdown text={prompt.question} />
      </div>
      {prompt.options.length > 0 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
          {prompt.options.map((option, i) => (
            <button
              key={option}
              className="btn"
              data-testid={`q-option-${i}`}
              onClick={() => void store.answerUser(prompt.callId, option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      {prompt.allowFreeForm ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            data-testid="q-input"
            placeholder="Type an answer…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && text.trim()) {
                void store.answerUser(prompt.callId, text.trim());
              }
            }}
            style={{
              flex: 1,
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '4px 6px',
              fontSize: 12,
            }}
          />
          <button
            className="btn primary"
            data-testid="q-submit"
            disabled={!text.trim()}
            onClick={() => void store.answerUser(prompt.callId, text.trim())}
          >
            Answer
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/** Non-visual state probe used by Electron tests to await state-machine edges.
 * Session state is communicated contextually by the rail and action dock, not
 * repeated as a badge in the room title bar. */
export function TaskStateProbe({ state }: { state: string }): React.JSX.Element {
  return <span data-testid="task-state" data-state={state} hidden aria-hidden="true" />;
}

export function Card(props: {
  /** Ic icon name (PIVOT-023: no emoji in chrome/cards). */
  icon: string;
  title: string;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  testid?: string;
  className?: string;
  /** Machine-readable state for tests — the visible copy stays humane. */
  dataState?: string;
  children?: React.ReactNode;
  collapsible?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(!props.collapsible);
  // A card can switch from collapsible to fixed across re-renders (React keeps
  // the state for same-type siblings); a fixed card must always be expanded.
  useEffect(() => {
    if (!props.collapsible && !open) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.collapsible]);
  const border =
    props.tone === 'danger'
      ? 'var(--danger)'
      : props.tone === 'warning'
        ? 'var(--warning)'
        : props.tone === 'success'
          ? 'var(--success)'
          : 'var(--border)';
  return (
    <div
      className={props.className}
      data-testid={props.testid}
      {...(props.dataState ? { 'data-state': props.dataState } : {})}
      style={{
        border: `1px solid ${border}`,
        borderRadius: 8,
        margin: '6px 10px',
        background: 'var(--bg-card)',
        fontSize: 12.5,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => props.collapsible && setOpen(!open)}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          width: '100%',
          padding: '6px 10px',
          background: 'transparent',
          border: 'none',
          color: 'var(--fg)',
          cursor: props.collapsible ? 'pointer' : 'default',
          textAlign: 'left',
        }}
      >
        <span aria-hidden style={{ color: 'var(--fg-muted)', display: 'flex' }}>
          <Ic name={props.icon} size={14} />
        </span>
        <span style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.title}
        </span>
        {props.collapsible ? <span className="text-muted">{open ? '▾' : '▸'}</span> : null}
      </button>
      {open && props.children ? (
        <div style={{ padding: '0 10px 8px 10px', overflowWrap: 'anywhere' }}>{props.children}</div>
      ) : null}
    </div>
  );
}

export interface TimelineContext {
  permissionResolutions: Map<string, { outcome: string; scope?: string | null }>;
  answeredCallIds: Set<string>;
  /** Sequence of the latest plan proposal that has no decision after it. */
  openPlanSeq: number | null;
  /** Latest proposal from each approval cycle; superseded drafts stay in the audit log only. */
  visiblePlanSeqs: Set<number>;
  verificationCommands: number;
  verificationRuns: Array<{
    label: string;
    state: string;
    stale?: boolean;
    superseded?: boolean;
  }>;
  latestRollbackSeq: number | null;
  taskState: string;
}

// Memoized: event objects are referentially stable in the store and `context`
// is memoized per timeline change, so cards skip re-rendering during
// streaming deltas and when unrelated events arrive.
const TimelineCard = React.memo(function TimelineCard({
  event,
  context,
}: {
  event: TimelineEventDto;
  context: TimelineContext;
}): React.JSX.Element | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'agent.planProposed': {
      if (!context.visiblePlanSeqs.has(event.sequence)) return null;
      const plan = payload.plan as TaskPlanDto;
      const open =
        event.sequence === context.openPlanSeq && context.taskState === 'AWAITING_PLAN_APPROVAL';
      return <PlanCard key={`plan-${event.id}`} plan={plan} open={open} />;
    }
    case 'agent.planUpdated': {
      const delta = (payload.delta ?? []) as Array<{ id: string; from: string; to: string }>;
      return (
        <div
          className="text-muted tl-note"
          style={{ padding: '0 14px', fontSize: 11 }}
          data-testid="tl-plan-updated"
        >
          Plan updated: {delta.map((d) => `${d.id} → ${d.to}`).join(', ') || 'no changes'}
        </div>
      );
    }
    case 'user.planEdited':
      return (
        <div
          className="text-muted tl-note"
          style={{ padding: '0 14px', fontSize: 11 }}
          data-testid="tl-plan-edited"
        >
          You edited the plan (v
          {String((payload.plan as TaskPlanDto | undefined)?.version ?? '?')})
        </div>
      );
    case 'user.planDecision': {
      const approved = payload.decision === 'approved';
      return (
        <div
          style={{
            padding: '0 14px',
            fontSize: 11,
            color: approved ? 'var(--success)' : 'var(--danger)',
          }}
          data-testid="tl-plan-decision"
        >
          {approved
            ? `✓ Plan approved${payload.auto === true ? ' automatically (auto mode)' : ''}${payload.edited === true ? ' with edits' : ''}`
            : '✕ Plan rejected — task cancelled'}
        </div>
      );
    }
    case 'review.decision':
      return (
        <div
          className="text-muted tl-note"
          style={{ padding: '0 14px', fontSize: 11 }}
          data-testid="tl-review-decision"
        >
          Review: {String(payload.decision)} {String(payload.scope)}{' '}
          <span className="mono">{String(payload.path)}</span>
        </div>
      );
    case 'task.accepted':
      return (
        <Card icon="checkCircle" title="Changes accepted" tone="success" testid="tl-accepted">
          The task's changes were accepted into the workspace. Committing to git is a separate,
          manual action.
        </Card>
      );
    case 'permission.requested': {
      const card = payload.card as PermissionCardDto;
      const resolution = context.permissionResolutions.get(card.requestId) ?? null;
      return <PermissionCard card={card} resolution={resolution} />;
    }
    case 'permission.decided':
      return null; // shown as the resolved state of its request card
    case 'agent.question': {
      const prompt = payload.prompt as AskUserPromptDto;
      return <QuestionCard prompt={prompt} answered={context.answeredCallIds.has(prompt.callId)} />;
    }
    case 'user.message':
      return (
        <Card icon="user" title="You" testid="tl-user">
          <div style={{ whiteSpace: 'pre-wrap' }}>{String(payload.text ?? '')}</div>
        </Card>
      );
    case 'agent.message':
      return (
        <Card icon="bot" title="Agent" testid="tl-agent">
          <Markdown text={String(payload.text ?? '')} />
        </Card>
      );
    case 'agent.thinking': {
      const seconds =
        typeof payload.durationMs === 'number' ? Math.round(payload.durationMs / 1000) : 0;
      return (
        <Card
          icon="bot"
          title={`✦ Thought${seconds > 0 ? ` for ${seconds}s` : ''}`}
          testid="tl-thinking"
          collapsible
        >
          <div className="text-muted" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5 }}>
            {String(payload.text ?? '')}
          </div>
        </Card>
      );
    }
    case 'tool.call': {
      const toolName = String(payload.name);
      // The plan card and its decision/progress notes are the presentation;
      // repeating the underlying plan-channel call adds no user information.
      if (toolName === 'propose_plan' || toolName === 'update_plan') return null;
      const ok = payload.ok === true;
      const state = String(payload.state ?? '');
      const denied = state === 'DENIED';
      // Live lifecycle states (ADR-0006) render as one neutral in-progress card
      // that the terminal event replaces in place (taskStore dedupes by callId).
      const terminal = ['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED', 'TIMED_OUT'].includes(state);
      // Version conflicts get a dedicated card: user content is protected (M8-06).
      if (state === 'FAILED' && String(payload.summary ?? '') === 'CHG_VERSION_CONFLICT') {
        return <ConflictCard payload={payload} />;
      }
      const stateWord = denied ? 'denied' : toolStateWord(state);
      return (
        <Card
          icon={denied ? 'ban' : !terminal ? 'clock' : ok ? 'wrench' : 'alert'}
          title={`${toolVerb(toolName)}${stateWord ? ` — ${stateWord}` : ''}`}
          tone={denied ? 'warning' : !terminal || ok ? 'default' : 'danger'}
          testid={`tl-tool-${toolName}`}
          dataState={state}
          collapsible
        >
          <div className="text-muted">{String(payload.summary ?? '')}</div>
          <PathChips paths={toolPaths(toolName, payload.input)} testidPrefix="tl-path" />
          <pre
            className="mono"
            style={{ fontSize: 11, overflow: 'auto', maxHeight: 160, whiteSpace: 'pre-wrap' }}
          >
            {JSON.stringify(payload.input ?? {}, null, 1)?.slice(0, 1500)}
          </pre>
        </Card>
      );
    }
    case 'agent.toolProposed':
      return null; // live-only hint; the terminal tool.call card follows
    case 'agent.usage': {
      const usage = payload.usage as
        { inputTokens?: number; outputTokens?: number; costUsd?: number | null } | undefined;
      return (
        <div
          className="text-muted tl-note"
          style={{ padding: '0 14px', fontSize: 11 }}
          data-testid="tl-usage"
        >
          {usage?.inputTokens ?? '?'} in · {usage?.outputTokens ?? '?'} out tokens
          {usage?.costUsd != null ? ` · $${usage.costUsd.toFixed(4)}` : ''}
        </div>
      );
    }
    case 'task.stateChanged': {
      // Milestone row (PIVOT-023): plain language, machine state on data-state.
      const to = String(payload.to);
      return (
        <div
          className="text-muted tl-milestone"
          data-state={to}
          style={{ padding: '2px 14px', fontSize: 11, fontWeight: 600 }}
        >
          {stateLabel(to)}
        </div>
      );
    }
    case 'run.failed': {
      const error = payload.error as { userMessage?: string; code?: string } | undefined;
      return (
        <Card icon="xCircle" title={errorTitle(error?.code)} tone="danger" testid="tl-failed">
          {error?.userMessage}
          {error?.code ? (
            <details className="text-muted" style={{ marginTop: 6, fontSize: 11 }}>
              <summary>Technical details</summary>
              Error code: <span className="mono">{error.code}</span>
            </details>
          ) : null}
        </Card>
      );
    }
    case 'run.aborted':
      return (
        <Card icon="square" title="Stopped" tone="warning" testid="tl-aborted">
          The run was stopped ({String(payload.reason)}). Nothing was rolled back automatically.
        </Card>
      );
    case 'worktree.setup':
      return (
        <Card
          icon="wrench"
          title={`Worktree setup — ${payload.ok === true ? 'ok' : 'failed'}`}
          tone={payload.ok === true ? 'default' : 'danger'}
          testid="tl-worktree-setup"
          collapsible
        >
          <div className="mono" style={{ fontSize: 11 }}>
            {String(payload.command ?? '')}
          </div>
          <pre className="mono" style={{ fontSize: 10.5, maxHeight: 120, overflow: 'auto' }}>
            {String(payload.outputTail ?? '')}
          </pre>
        </Card>
      );
    case 'verification.started':
      return (
        <div className="text-muted tl-note" style={{ padding: '0 14px', fontSize: 11 }}>
          Verification started: {String(payload.label)}
        </div>
      );
    case 'verification.completed': {
      const run = payload.run as {
        label: string;
        state: string;
        exitCode: number | null;
        outputExcerpt: string;
      };
      const passed = run.state === 'passed';
      return (
        <Card
          icon={passed ? 'checkCircle' : 'xCircle'}
          title={`Verification "${run.label}" — ${run.state}${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`}
          tone={passed ? 'success' : 'danger'}
          testid={`tl-verification-${run.state}`}
          collapsible
        >
          <pre
            className="mono"
            style={{ fontSize: 11, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap' }}
          >
            {run.outputExcerpt || '(no output)'}
          </pre>
        </Card>
      );
    }
    case 'rollback.blocked': {
      const conflicts = (payload.conflicts ?? []) as Array<{ path: string; reason: string }>;
      return (
        <Card
          icon="ban"
          title="Rollback blocked by conflicts"
          tone="warning"
          testid="tl-rollback-blocked"
        >
          {conflicts.map((c) => (
            <div key={c.path} style={{ fontSize: 12 }}>
              <span className="mono">{c.path}</span> — {c.reason}
            </div>
          ))}
        </Card>
      );
    }
    case 'task.rolledBack':
      return (
        <Card icon="undo" title="Rolled back" tone="warning" testid="tl-rolledback">
          {String((payload.restored as string[] | undefined)?.length ?? 0)} file(s) restored to
          their pre-task state.
        </Card>
      );
    case 'report.final': {
      const rolledBackLater =
        context.latestRollbackSeq !== null && context.latestRollbackSeq > event.sequence;
      const executionFailed = payload.outcome === 'failed';
      const unverified = payload.unverified === true;
      const changed = payload.changed as
        { files: number; additions: number; deletions: number } | undefined;
      const verification = payload.verification as
        | {
            runs: Array<{ label: string; state: string; stale?: boolean; superseded?: boolean }>;
            passed: number;
            failed: number;
            note: string | null;
          }
        | undefined;
      const agentSummary = typeof payload.agentSummary === 'string' ? payload.agentSummary : null;
      const risks = (payload.unresolvedRisks ?? []) as string[];
      const effectiveRuns =
        context.verificationRuns.length > 0
          ? context.verificationRuns.map((run) => ({
              ...run,
              ...(rolledBackLater ? { stale: true } : {}),
            }))
          : (verification?.runs ?? []);
      const staleVerificationCount = effectiveRuns.filter((run) => run.stale).length;
      const effectiveVerification =
        effectiveRuns.length > 0
          ? {
              runs: effectiveRuns,
              passed: effectiveRuns.filter(
                (run) => run.state === 'passed' && !run.stale && !run.superseded,
              ).length,
              failed: effectiveRuns.filter(
                (run) =>
                  !run.stale &&
                  !run.superseded &&
                  ['failed', 'timeout', 'cancelled'].includes(run.state),
              ).length,
              stale: staleVerificationCount,
              note: verification?.note ?? null,
            }
          : undefined;
      const effectivelyUnverified = unverified && context.verificationRuns.length === 0;
      return (
        <Card
          icon={executionFailed ? 'alert' : 'clipboard'}
          title={
            rolledBackLater
              ? 'Final report — before rollback'
              : executionFailed
                ? 'Final report — latest request failed'
                : 'Final report'
          }
          tone={
            rolledBackLater ||
            executionFailed ||
            effectivelyUnverified ||
            (effectiveVerification?.failed ?? 0) > 0 ||
            staleVerificationCount > 0
              ? 'warning'
              : 'success'
          }
          testid="tl-report"
        >
          {rolledBackLater ? (
            <div className="text-warning" data-testid="report-before-rollback">
              Historical evidence only — the workspace was rolled back after this report.
            </div>
          ) : null}
          {executionFailed && !rolledBackLater ? (
            <div className="text-warning" data-testid="report-execution-failed">
              A recorded file action failed. Existing changes remain available for review, but the
              latest requested fix is not proven complete.
            </div>
          ) : null}
          <div>Outcome: {executionFailed ? 'Needs attention' : 'Completed'}</div>
          {changed ? (
            <div data-testid="report-changed">
              Changed: {changed.files} file{changed.files === 1 ? '' : 's'},{' '}
              <span style={{ color: 'var(--success)' }}>+{changed.additions}</span> /{' '}
              <span style={{ color: 'var(--danger)' }}>-{changed.deletions}</span>
              <PathChips
                paths={(Array.isArray((payload.changed as { list?: unknown })?.list)
                  ? ((payload.changed as { list: Array<{ path?: unknown }> }).list ?? [])
                  : []
                )
                  .map((f) => String(f.path ?? ''))
                  .filter(Boolean)}
                testidPrefix="report-path"
              />
            </div>
          ) : null}
          {effectiveVerification && effectiveVerification.runs.length > 0 ? (
            <div data-testid="report-verification">
              Verification: {effectiveVerification.passed} current passed,{' '}
              {effectiveVerification.failed} failed
              {staleVerificationCount > 0 ? `, ${staleVerificationCount} stale` : ''}
              <ul style={{ margin: '2px 0 2px 16px', padding: 0, fontSize: 11.5 }}>
                {effectiveVerification.runs.map((r, i) => (
                  <li
                    key={i}
                    className={
                      r.state === 'passed' && !r.stale && !r.superseded ? '' : 'text-warning'
                    }
                  >
                    {r.label} — {r.state}
                    {r.stale ? ' (stale)' : ''}
                    {r.superseded ? ' (superseded)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {effectivelyUnverified ? (
            <div className="text-warning" data-testid="report-unverified">
              {context.verificationCommands > 0
                ? `${context.verificationCommands} configured check${context.verificationCommands === 1 ? '' : 's'} ${context.verificationCommands === 1 ? 'has' : 'have'} not run.`
                : 'Unverified — no verification commands were run.'}
            </div>
          ) : null}
          {risks.length > 0 ? (
            <div className="text-warning" style={{ fontSize: 11.5 }}>
              Unresolved risks: {risks.join('; ')}
            </div>
          ) : null}
          {agentSummary ? (
            <details style={{ marginTop: 4, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer' }} className="text-muted">
                Agent's own summary (unverified narrative)
              </summary>
              <div style={{ paddingTop: 4 }}>
                <Markdown text={agentSummary} />
              </div>
            </details>
          ) : null}
          <div className="text-muted" style={{ fontSize: 10.5, marginTop: 4 }}>
            Evidence above comes from the change/verification/permission records, not from the
            agent. Check the Problems panel for live diagnostics before accepting.
          </div>
          {context.taskState === 'REVIEW_READY' ? (
            <div
              style={{
                display: 'flex',
                gap: 6,
                marginTop: 6,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <button
                className="btn primary"
                data-testid="report-review-open"
                onClick={() => void useTaskStore.getState().openReview()}
              >
                Review changes
              </button>
              {context.verificationCommands > 0 ? (
                <button
                  className="btn"
                  data-testid="report-run-verification"
                  onClick={() => void useTaskStore.getState().runVerification()}
                >
                  {context.verificationRuns.length > 0 ? 'Re-run checks' : 'Run checks'}
                </button>
              ) : null}
              <span style={{ flex: 1 }} />
              <ConfirmDangerButton
                label="Roll back all…"
                confirmLabel="Confirm — roll back all"
                testid="report-rollback"
                quiet
                title="Restore every touched file to its pre-task state"
                onConfirm={() =>
                  void useTaskStore.getState().rollbackTask({ confirmDestructive: true })
                }
              />
            </div>
          ) : null}
        </Card>
      );
    }
    case 'system.workerCrashed':
      return (
        <Card icon="zap" title="Agent worker crashed" tone="danger" testid="tl-crash">
          {String(payload.note ?? '')}
        </Card>
      );
    case 'system.interruptedByRestart':
      return (
        <Card icon="refresh" title="Interrupted by restart" tone="warning" testid="tl-restart">
          {String(payload.note ?? '')}
        </Card>
      );
    case 'system.diagnostic':
      return (
        <div className="text-muted tl-note" style={{ padding: '0 14px', fontSize: 11 }}>
          {String(payload.detail ?? payload.code)}
        </div>
      );
    case 'task.modelChanged': {
      // ADR-0016: honest audit of a reply-time model/effort override.
      const changedModel = payload.model as
        { providerId: string; modelId: string; thinkingLevel?: string } | undefined;
      return (
        <div
          className="text-muted tl-note"
          style={{ padding: '0 14px', fontSize: 11 }}
          data-testid="tl-model-changed"
        >
          Model for the next turn: {changedModel?.providerId}/{changedModel?.modelId}
          {changedModel?.thinkingLevel ? ` · effort ${changedModel.thinkingLevel}` : ''}
        </div>
      );
    }
    case 'task.created':
    case 'task.queued':
    case 'run.completed':
    case 'system.abortRequested':
      return null;
    default:
      return (
        <div className="text-muted" style={{ padding: '0 14px', fontSize: 11 }}>
          {event.type}
        </div>
      );
  }
});

/** Stable empty-timeline sentinel for the pinned-selector path below. */
const NO_TIMELINE: TimelineEventDto[] = [];

/**
 * Reference stability for the timeline context: most appends (messages, tool
 * rows) change none of the derived decisions, so consumers keyed on the
 * context reference (memoized rows) must not re-render for them. Equality is
 * O(decisions), which is tiny next to re-rendering a 400-row window.
 */
function timelineContextEquals(a: TimelineContext, b: TimelineContext): boolean {
  if (
    a.taskState !== b.taskState ||
    a.verificationCommands !== b.verificationCommands ||
    a.openPlanSeq !== b.openPlanSeq ||
    a.latestRollbackSeq !== b.latestRollbackSeq ||
    a.permissionResolutions.size !== b.permissionResolutions.size ||
    a.answeredCallIds.size !== b.answeredCallIds.size ||
    a.visiblePlanSeqs.size !== b.visiblePlanSeqs.size ||
    a.verificationRuns.length !== b.verificationRuns.length
  ) {
    return false;
  }
  for (const [key, value] of a.permissionResolutions) {
    const other = b.permissionResolutions.get(key);
    if (!other || other.outcome !== value.outcome || other.scope !== value.scope) return false;
  }
  for (const id of a.answeredCallIds) if (!b.answeredCallIds.has(id)) return false;
  for (const seq of a.visiblePlanSeqs) if (!b.visiblePlanSeqs.has(seq)) return false;
  for (let i = 0; i < a.verificationRuns.length; i++) {
    const left = a.verificationRuns[i]!;
    const right = b.verificationRuns[i]!;
    if (
      left.label !== right.label ||
      left.state !== right.state ||
      left.stale !== right.stale ||
      left.superseded !== right.superseded
    ) {
      return false;
    }
  }
  return true;
}

/** Cross-event context shared by every timeline consumer (panel + Task Room). */
export function useTimelineContext(
  taskState: string,
  verificationCommands = 0,
  /**
   * ADR-0055: a kept-alive room passes its own per-task timeline; the
   * subscription below then pins to a constant so the hidden room never
   * re-renders for the ACTIVE task's timeline churn. Callers on active-only
   * surfaces (editor agent panel) omit it and keep the singleton.
   */
  ownTimeline?: TimelineEventDto[],
): TimelineContext {
  const activeTimeline = useTaskStore((s) =>
    ownTimeline === undefined ? s.timeline : NO_TIMELINE,
  );
  const timeline = ownTimeline ?? activeTimeline;
  const stable = useRef<TimelineContext | null>(null);
  const computed = React.useMemo(() => {
    const permissionResolutions = new Map<string, { outcome: string; scope?: string | null }>();
    const answeredCallIds = new Set<string>();
    const visiblePlanSeqs = new Set<number>();
    const verificationByLabel = new Map<
      string,
      { label: string; state: string; stale?: boolean; superseded?: boolean }
    >();
    let openPlanSeq: number | null = null;
    let pendingPlanSeq: number | null = null;
    let latestRollbackSeq: number | null = null;
    for (const event of timeline) {
      const payload = event.payload as Record<string, unknown>;
      if (event.type === 'permission.decided' && typeof payload.requestId === 'string') {
        permissionResolutions.set(payload.requestId, {
          outcome: String(payload.outcome ?? ''),
          scope: (payload.scope as string | null) ?? null,
        });
      }
      if (event.type === 'user.message' && typeof payload.callId === 'string') {
        answeredCallIds.add(payload.callId);
      }
      if (event.type === 'agent.planProposed') {
        openPlanSeq = event.sequence;
        pendingPlanSeq = event.sequence;
      }
      if (event.type === 'user.planDecision') {
        if (pendingPlanSeq !== null) visiblePlanSeqs.add(pendingPlanSeq);
        pendingPlanSeq = null;
        openPlanSeq = null;
      }
      if (event.type === 'verification.completed') {
        const run = payload.run as
          { label?: unknown; state?: unknown; stale?: unknown; superseded?: unknown } | undefined;
        if (run && typeof run.label === 'string') {
          verificationByLabel.set(run.label, {
            label: run.label,
            state: String(run.state ?? ''),
            stale: run.stale === true,
            superseded: run.superseded === true,
          });
        }
      }
      if (event.type === 'task.rolledBack' || event.type === 'turn.rolledBack') {
        latestRollbackSeq = event.sequence;
      }
    }
    if (pendingPlanSeq !== null) visiblePlanSeqs.add(pendingPlanSeq);
    return {
      permissionResolutions,
      answeredCallIds,
      openPlanSeq,
      visiblePlanSeqs,
      verificationCommands,
      verificationRuns: [...verificationByLabel.values()],
      latestRollbackSeq,
      taskState,
    };
  }, [timeline, taskState, verificationCommands]);
  if (stable.current === null || !timelineContextEquals(stable.current, computed)) {
    stable.current = computed;
  }
  return stable.current;
}

/** The scrollable event list (auto-scrolls on growth). Used by panel + room. */
export function TimelineList({ taskState }: { taskState: string }): React.JSX.Element {
  // Narrow subscriptions: this list re-renders for its own data and the live
  // tail — never for catalog/model/review churn elsewhere in the store.
  const timeline = useTaskStore((s) => s.timeline);
  const loadingTimeline = useTaskStore((s) => s.loadingTimeline);
  const streaming = useTaskStore((s) => s.streaming);
  const streamingThinking = useTaskStore((s) => s.streamingThinking);
  const taskId = useTaskStore((s) => s.activeTaskId);
  const verificationCommands = useTaskStore((s) => activeTask(s)?.verification.length ?? 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const scrollRaf = useRef(0);
  const followRaf = useRef(0);
  const timelineContext = useTimelineContext(taskState, verificationCommands);

  // Unmount cancels an in-flight measurement frame; the final inertial-scroll
  // wheel may be dropped by design — a detached node measures 0/0/0 and a
  // save would corrupt the position with a false AT_BOTTOM (parity with
  // RoomTimeline; saveScroll also refuses detached elements).
  useEffect(
    () => () => {
      if (followRaf.current) cancelAnimationFrame(followRaf.current);
      if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = 0;
      followRaf.current = 0;
    },
    [taskId],
  );

  // PIVOT-036: the reading position is shared with the Task Room timeline —
  // ⌘E round-trips land where you left off.
  useEffect(() => {
    if (loadingTimeline || !taskId) return;
    const el = scrollRef.current;
    if (el) pinnedToBottom.current = restoreScroll(taskId, el);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingTimeline, taskId]);

  // Live tail follow: one scrollTop write per frame, not per token.
  useEffect(() => {
    if (!pinnedToBottom.current || followRaf.current) return;
    followRaf.current = requestAnimationFrame(() => {
      followRaf.current = 0;
      const el = scrollRef.current;
      if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
    });
  }, [timeline.length, streaming?.text.length]);

  // Cards are derived per timeline change; streaming deltas re-render the
  // list shell (for the live tail below) but must not rebuild every card.
  const cards = React.useMemo(
    () =>
      timeline.map((event) => (
        <TimelineCard
          key={`${event.id}-${event.sequence}`}
          event={event}
          context={timelineContext}
        />
      )),
    [timeline, timelineContext],
  );

  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
      data-testid="timeline"
      onScroll={() => {
        // One rAF per frame: a single set of layout reads feeds both the pin
        // verdict and the saved reading position.
        if (scrollRaf.current) return;
        scrollRaf.current = requestAnimationFrame(() => {
          scrollRaf.current = 0;
          const el = scrollRef.current;
          if (!el) return;
          const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          pinnedToBottom.current = pinned;
          if (taskId) saveScroll(taskId, el, pinned);
        });
      }}
    >
      {loadingTimeline ? (
        <div className="text-muted" style={{ padding: 12 }}>
          Loading timeline…
        </div>
      ) : (
        <>
          {cards}
          {streamingThinking ? (
            <Card icon="bot" title="✦ Thinking…" testid="tl-thinking-live">
              <div className="text-muted" style={{ whiteSpace: 'pre-wrap', fontSize: 11.5 }}>
                {streamingThinking.text}
              </div>
            </Card>
          ) : null}
          {streaming ? (
            <Card icon="bot" title="Agent (streaming…)" testid="tl-streaming">
              {streaming.text.length > STREAM_MARKDOWN_LIMIT ? (
                // Freeze guard (§16.5) — parity with the Task Room timeline:
                // never re-parse a huge markdown string per token.
                <pre className="rt-stream-raw" data-testid="tl-streaming-raw">
                  {streaming.text.slice(-STREAM_MARKDOWN_LIMIT)}
                </pre>
              ) : (
                <Markdown text={streaming.text} live />
              )}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Reply composer (steer / queue / new run). Used by panel + room. */
export function TaskComposer({ running }: { running: boolean }): React.JSX.Element {
  // Only the active task id is read; send() is called through getState so
  // typing and streaming don't re-render each other.
  const store = useTaskStore.getState();
  const taskId = useTaskStore((s) => s.activeTaskId) ?? '';
  const input = useDraftStore((s) => (taskId ? (s.drafts[taskId] ?? '') : ''));
  const setInput = (text: string): void => {
    if (taskId) useDraftStore.getState().setDraft(taskId, text);
  };
  const [sendMode, setSendMode] = useState<'steer' | 'followUp'>('steer');
  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {running ? (
        <div style={{ display: 'flex', gap: 8, fontSize: 11 }} className="text-muted">
          <label>
            <input
              type="radio"
              checked={sendMode === 'steer'}
              onChange={() => setSendMode('steer')}
            />{' '}
            steer now
          </label>
          <label>
            <input
              type="radio"
              checked={sendMode === 'followUp'}
              onChange={() => setSendMode('followUp')}
            />{' '}
            queue for next turn
          </label>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6 }}>
        <textarea
          data-testid="agent-input"
          placeholder={
            running ? 'Send guidance to the running agent…' : 'Send a message (starts a new run)…'
          }
          value={input}
          rows={2}
          style={{
            flex: 1,
            background: 'var(--bg-input)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '6px 8px',
            resize: 'none',
            fontFamily: 'inherit',
          }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (input.trim()) {
                void store.send(input.trim(), sendMode);
                setInput('');
              }
            }
          }}
        />
        <button
          className="btn primary"
          data-testid="agent-send"
          disabled={input.trim().length === 0}
          onClick={() => {
            void store.send(input.trim(), sendMode);
            setInput('');
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

export function AgentPanel(): React.JSX.Element {
  // Header + shell: it needs the active task and the dialog flag; per-token
  // streaming state belongs to TimelineList below.
  const store = useTaskStore.getState();
  const task = useTaskStore(activeTask);
  const newTaskOpen = useTaskStore((s) => s.newTaskOpen);
  const workspace = useWorkspaceStore((s) => s.workspace);
  const resumingExternalTaskId = useExternalStore((s) => s.resumingTaskId);

  useEffect(() => {
    useTaskStore.getState().init();
  }, []);

  if (!workspace) {
    return (
      <div className="empty-state">
        <div className="es-title">Agent</div>
        <div>Open a workspace to create your first task.</div>
      </div>
    );
  }

  const running = task ? RUNNING_TASK_STATES.has(task.state) : false;
  const externalCanResume = Boolean(
    task &&
    canResumeExternal(task) &&
    ['REVIEW_READY', 'INTERRUPTED', 'FAILED'].includes(task.state),
  );
  const externalResuming = task?.id === resumingExternalTaskId;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="agent-panel-main"
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {task ? (
          <>
            <span
              style={{
                minWidth: 0,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={task.title}
              data-testid="agent-task-title"
            >
              {task.title}
            </span>
            <TaskStateProbe state={task.state} />
            <div
              style={{
                gridColumn: '1 / -1',
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                alignItems: 'center',
              }}
            >
              {task.state === 'REVIEW_READY' ? (
                <>
                  {externalCanResume ? (
                    <button
                      className="btn primary"
                      data-testid="task-resume"
                      disabled={externalResuming}
                      title={`Continue the previous ${task.external!.cli} conversation in its terminal`}
                      onClick={() => void store.resumeTask(task.id)}
                    >
                      {externalResuming
                        ? 'Resuming…'
                        : `Resume ${agentDisplayName(task.external!.cli)}`}
                    </button>
                  ) : null}
                  <button
                    className={`btn ${externalCanResume ? '' : 'primary'}`}
                    data-testid="review-open"
                    onClick={() => void store.openReview()}
                  >
                    Review
                  </button>
                </>
              ) : null}
              {task.state === 'INTERRUPTED' || task.state === 'FAILED' ? (
                // M10 recovery: pick up where it stopped, inspect, or restore.
                <>
                  <button
                    className="btn primary"
                    data-testid="task-resume"
                    disabled={externalResuming}
                    title={
                      externalCanResume
                        ? `Continue the previous ${task.external!.cli} conversation in its terminal`
                        : 'Start a new run for this task'
                    }
                    onClick={() => void store.resumeTask(task.id)}
                  >
                    {externalResuming
                      ? 'Resuming…'
                      : externalCanResume
                        ? `Resume ${agentDisplayName(task.external!.cli)}`
                        : 'Resume'}
                  </button>
                  <button
                    className="btn"
                    data-testid="review-open"
                    title="Inspect what changed before deciding"
                    onClick={() => void store.openReview()}
                  >
                    Review
                  </button>
                  <ConfirmDangerButton
                    label="Roll back…"
                    confirmLabel="Confirm — roll back"
                    testid="task-rollback"
                    quiet
                    title="Restore every touched file to its pre-task state"
                    onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
                  />
                </>
              ) : null}
              {task.external ? (
                <button
                  className="btn"
                  data-testid="replay-open"
                  title="Replay the exact terminal output from this Session"
                  onClick={() => store.openReplay()}
                >
                  Terminal Replay
                </button>
              ) : null}
              {running ? (
                <button
                  className="btn danger"
                  data-testid="agent-stop"
                  onClick={() => void store.stop()}
                >
                  Stop
                </button>
              ) : null}
              <button
                className="btn primary"
                style={{ marginLeft: 'auto' }}
                data-testid="new-task-btn"
                onClick={() => store.setNewTaskOpen(true)}
              >
                + Task
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="text-muted">No task selected</span>
            <button
              className="btn primary"
              data-testid="new-task-btn"
              onClick={() => store.setNewTaskOpen(true)}
            >
              + Task
            </button>
          </>
        )}
      </div>

      {task ? (
        <div
          className="text-muted"
          style={{ padding: '4px 10px', fontSize: 11, borderBottom: '1px solid var(--border)' }}
        >
          {modeLabel(task.mode)} · {task.model.providerId}/{task.model.modelId}
        </div>
      ) : null}

      {!task ? (
        <div className="empty-state" data-testid="timeline">
          <div>Create a task to start working with the agent.</div>
        </div>
      ) : (
        <TimelineList taskState={task.state} />
      )}

      {task ? <TaskComposer running={running} /> : null}

      {newTaskOpen ? <NewTaskDialog /> : null}
    </div>
  );
}
