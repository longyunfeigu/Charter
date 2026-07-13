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
import { Ic } from './home-icons.js';
import { ConfirmDangerButton } from './ui.js';
import { modeLabel, stateLabel, stateTone, TONE_COLOR, toolStateWord, toolVerb } from './labels.js';

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
  const store = useTaskStore();
  const { card, resolution } = props;
  const [reason, setReason] = useState('');
  const riskColor = RISK_COLORS[card.risk.level] ?? 'var(--fg)';

  if (resolution) {
    const allowed = resolution.outcome === 'allowed';
    return (
      <Card
        icon={allowed ? 'checkCircle' : resolution.outcome === 'denied' ? 'ban' : 'clock'}
        title={`Permission ${resolution.outcome}${resolution.scope ? ` (${resolution.scope})` : ''} — ${card.toolName}`}
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
      title={`Permission needed — ${card.toolName}`}
      tone="warning"
      testid="perm-card"
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
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
      <div style={{ marginBottom: 4 }}>{card.preview.summary}</div>
      {card.preview.command ? (
        <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: '4px 0' }}>
          $ {card.preview.command.executable} {card.preview.command.args.join(' ')}
          {'\n'}cwd: {card.preview.command.cwd}
        </pre>
      ) : null}
      {card.preview.targets && card.preview.targets.length > 0 ? (
        <div className="text-muted" style={{ fontSize: 11 }}>
          targets: {card.preview.targets.join(', ')}
        </div>
      ) : null}
      {card.preview.diff ? (
        <pre
          className="mono"
          style={{ fontSize: 11, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {card.preview.diff}
        </pre>
      ) : (
        <div className="text-muted" style={{ fontSize: 11 }}>
          No diff — this action does not modify files directly.
        </div>
      )}
      {card.preview.detail ? (
        <div className="text-muted" style={{ fontSize: 11 }}>
          {card.preview.detail}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
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
      <details style={{ marginTop: 6, fontSize: 11 }} className="text-muted">
        <summary style={{ cursor: 'pointer' }}>View risk policy</summary>
        <div style={{ paddingTop: 4 }}>{RISK_POLICY}</div>
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

/** Plan card (§13.2, AG-007/008): view, edit (text/order/remove), approve or reject. */
export function PlanCard(props: { plan: TaskPlanDto; open: boolean }): React.JSX.Element {
  const store = useTaskStore();
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

  return (
    <Card
      key="plan-interactive"
      icon="map"
      title={`Plan proposed (v${plan.version}) — approval needed`}
      tone="warning"
      testid="plan-card"
    >
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
        <div style={{ marginBottom: 6 }}>{summary}</div>
      )}
      <ol style={{ margin: '0 0 6px 18px', padding: 0 }}>
        {steps.map((step, i) => (
          <li key={step.id ?? `new-${i}`} style={{ fontSize: 12, marginBottom: 3 }}>
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
  const store = useTaskStore();
  const [text, setText] = useState('');
  const { prompt, answered } = props;
  if (answered) {
    return (
      <Card icon="help" title="Question (answered)" testid="q-card-answered" collapsible>
        <div className="text-muted">{prompt.question}</div>
      </Card>
    );
  }
  return (
    <Card icon="help" title="The agent has a question" tone="warning" testid="q-card">
      <div style={{ marginBottom: 6, whiteSpace: 'pre-wrap' }}>{prompt.question}</div>
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

/** Human state chip (PIVOT-023). Tests assert the machine state via data-state. */
export function StateBadge({ state }: { state: string }): React.JSX.Element {
  const color = TONE_COLOR[stateTone(state)];
  return (
    <span
      data-testid="task-state"
      data-state={state}
      title={stateLabel(state)}
      style={{
        border: `1px solid ${color}`,
        color,
        borderRadius: 999,
        padding: '1px 9px',
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {stateLabel(state)}
    </span>
  );
}

export function Card(props: {
  /** Ic icon name (PIVOT-023: no emoji in chrome/cards). */
  icon: string;
  title: string;
  tone?: 'default' | 'danger' | 'warning' | 'success';
  testid?: string;
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
  taskState: string;
}

function TimelineCard({
  event,
  context,
}: {
  event: TimelineEventDto;
  context: TimelineContext;
}): React.JSX.Element | null {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'agent.planProposed': {
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
      return (
        <PermissionCard
          card={card}
          resolution={context.permissionResolutions.get(card.requestId) ?? null}
        />
      );
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
          <div style={{ whiteSpace: 'pre-wrap' }}>{String(payload.text ?? '')}</div>
        </Card>
      );
    case 'tool.call': {
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
          title={`${toolVerb(String(payload.name))}${stateWord ? ` — ${stateWord}` : ''}`}
          tone={denied ? 'warning' : !terminal || ok ? 'default' : 'danger'}
          testid={`tl-tool-${String(payload.name)}`}
          dataState={state}
          collapsible
        >
          <div className="text-muted">{String(payload.summary ?? '')}</div>
          <PathChips
            paths={toolPaths(String(payload.name), payload.input)}
            testidPrefix="tl-path"
          />
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
        <Card
          icon="xCircle"
          title={`Run failed (${error?.code ?? 'unknown'})`}
          tone="danger"
          testid="tl-failed"
        >
          {error?.userMessage}
        </Card>
      );
    }
    case 'run.aborted':
      return (
        <Card icon="square" title="Stopped" tone="warning" testid="tl-aborted">
          The run was stopped ({String(payload.reason)}). Nothing was rolled back automatically.
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
      return (
        <Card
          icon="clipboard"
          title="Final report"
          tone={unverified || (verification?.failed ?? 0) > 0 ? 'warning' : 'success'}
          testid="tl-report"
        >
          <div>Outcome: {String(payload.outcome)}</div>
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
          {verification && verification.runs.length > 0 ? (
            <div data-testid="report-verification">
              Verification: {verification.passed} passed, {verification.failed} failed
              <ul style={{ margin: '2px 0 2px 16px', padding: 0, fontSize: 11.5 }}>
                {verification.runs.map((r, i) => (
                  <li key={i} className={r.state === 'passed' ? '' : 'text-warning'}>
                    {r.label} — {r.state}
                    {r.stale ? ' (stale)' : ''}
                    {r.superseded ? ' (superseded)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {unverified ? (
            <div className="text-warning" data-testid="report-unverified">
              Unverified — no verification commands were run.
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
              <div style={{ whiteSpace: 'pre-wrap', paddingTop: 4 }}>{agentSummary}</div>
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
              <span style={{ flex: 1 }} />
              <ConfirmDangerButton
                label="Roll back all…"
                confirmLabel="Confirm — roll back all"
                testid="report-rollback"
                quiet
                title="Restore every touched file to its pre-task state"
                onConfirm={() => void useTaskStore.getState().rollbackTask()}
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
}

/** Cross-event context shared by every timeline consumer (panel + Task Room). */
export function useTimelineContext(taskState: string): TimelineContext {
  const timeline = useTaskStore((s) => s.timeline);
  return React.useMemo(() => {
    const permissionResolutions = new Map<string, { outcome: string; scope?: string | null }>();
    const answeredCallIds = new Set<string>();
    let openPlanSeq: number | null = null;
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
      if (event.type === 'agent.planProposed') openPlanSeq = event.sequence;
      if (event.type === 'user.planDecision') openPlanSeq = null;
    }
    return { permissionResolutions, answeredCallIds, openPlanSeq, taskState };
  }, [timeline, taskState]);
}

/** The scrollable event list (auto-scrolls on growth). Used by panel + room. */
export function TimelineList({ taskState }: { taskState: string }): React.JSX.Element {
  const store = useTaskStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineContext = useTimelineContext(taskState);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [store.timeline.length, store.streaming?.text.length]);

  return (
    <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', minHeight: 0 }} data-testid="timeline">
      {store.loadingTimeline ? (
        <div className="text-muted" style={{ padding: 12 }}>
          Loading timeline…
        </div>
      ) : (
        <>
          {store.timeline.map((event) => (
            <TimelineCard
              key={`${event.id}-${event.sequence}`}
              event={event}
              context={timelineContext}
            />
          ))}
          {store.streaming ? (
            <Card icon="bot" title="Agent (streaming…)" testid="tl-streaming">
              <div style={{ whiteSpace: 'pre-wrap' }}>{store.streaming.text}</div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Reply composer (steer / queue / new run). Used by panel + room. */
export function TaskComposer({ running }: { running: boolean }): React.JSX.Element {
  const store = useTaskStore();
  const [input, setInput] = useState('');
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
  const store = useTaskStore();
  const workspace = useWorkspaceStore((s) => s.workspace);
  const task = activeTask(store);

  useEffect(() => {
    store.init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      data-testid="agent-panel-main"
    >
      <div
        style={{
          padding: '8px 10px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        {task ? (
          <>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={task.title}
            >
              {task.title}
            </span>
            <StateBadge state={task.state} />
            {task.state === 'REVIEW_READY' ? (
              <button
                className="btn primary"
                data-testid="review-open"
                onClick={() => void store.openReview()}
              >
                Review
              </button>
            ) : null}
            {task.state === 'INTERRUPTED' || task.state === 'FAILED' ? (
              // M10 recovery: pick up where it stopped, inspect, or restore.
              <>
                <button
                  className="btn primary"
                  data-testid="task-resume"
                  title="Start a new run for this task"
                  onClick={() => void store.resumeTask()}
                >
                  Resume
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
                  onConfirm={() => void store.rollbackTask()}
                />
              </>
            ) : null}
            <button
              className="btn"
              data-testid="replay-open"
              title="Replay what the agent did, step by step"
              onClick={() => store.openReplay()}
            >
              Replay
            </button>
            {running ? (
              <button
                className="btn danger"
                data-testid="agent-stop"
                onClick={() => void store.stop()}
              >
                Stop
              </button>
            ) : null}
          </>
        ) : (
          <span style={{ flex: 1 }} className="text-muted">
            No task selected
          </span>
        )}
        <button
          className="btn primary"
          data-testid="new-task-btn"
          onClick={() => store.setNewTaskOpen(true)}
        >
          + Task
        </button>
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

      {store.newTaskOpen ? <NewTaskDialog /> : null}
    </div>
  );
}
