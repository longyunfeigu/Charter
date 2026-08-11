import React, { useEffect, useMemo, useState } from 'react';
import type {
  ChangeSetDto,
  TaskDto,
  VerificationRunDto,
  WorkExecutionDto,
  WorkItemDetailDto,
  WorkItemDto,
} from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { agentDisplayName, useAgentCatalogStore } from '../store/agentCatalogStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useWorkItemStore } from '../store/workItemStore.js';
import {
  executionPhase,
  externalRef,
  isExternalItem,
  itemStatus,
  parseGithubComments,
  statusLabel,
  useForYouStore,
} from '../store/forYouStore.js';
import { buildHandoffPrompt } from './WorkItemDetail.js';
import { Markdown } from './Markdown.js';
import { Ic, ProviderMark } from './home-icons.js';
import { buildIssueWorkspaceDirective, type IssueWorkspaceMode } from './issueLaunchContext.js';
import { useTerminalStore } from './TerminalPanel.js';
import '../styles/for-you.css';

/**
 * For-you main surface — the detail side of the external-work-inbox mock,
 * replicated 1:1 over real data (ADR-0056/0057):
 * - Incoming: issue context, carried-context inventory, discussion, and a
 *   launch card that resolves Project/repository/branch before work starts,
 *   with a Final-check modal that really creates the Session/Mission.
 * - Attention: the decision banner for a session (or reminder) waiting on you.
 * - Review: change/checks/executions/evidence metrics, files, verification,
 *   evidence — and the approval-gated Ship result card whose "Post update"
 *   really publishes one comment to the source issue after an exact preview.
 */

function formatDay(iso: string): string {
  return iso ? iso.slice(0, 10) : '';
}

function initials(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

function primarySession(executions: WorkExecutionDto[]): WorkExecutionDto | null {
  const sessions = executions.filter(
    (execution) => execution.targetKind === 'session' && execution.targetId,
  );
  const current = sessions.find((execution) =>
    ['running', 'waiting', 'review'].includes(executionPhase([execution])),
  );
  return (
    current ?? sessions.find((execution) => execution.role === 'primary') ?? sessions[0] ?? null
  );
}

function openExecution(execution: WorkExecutionDto): void {
  if (!execution.targetId) return;
  if (execution.targetKind === 'session') {
    // Route immediately. Waiting for task.get made a healthy row feel inert,
    // especially for native Agent Sessions whose transcript hydration may be
    // slower than the navigation itself.
    void useTaskStore.getState().openTask(execution.targetId);
    useAppStore.getState().openTaskRoom(execution.targetId);
  } else if (execution.targetKind === 'mission') {
    useAppStore.getState().openMission(execution.targetId);
  } else if (execution.targetKind === 'terminal') {
    useTerminalStore.getState().init();
    useAppStore.getState().openTerminalSession(execution.targetId);
  }
}

/* ---------------------------------------------------------------- header */

function DetailHeader(props: {
  item: WorkItemDto;
  secondary?: React.ReactNode;
  onDelete?(): void;
}): React.JSX.Element {
  const { item } = props;
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const external = isExternalItem(item);
  const status = itemStatus(item, snapshot, snapshot.executions);
  const author = String(item.customFields.githubAuthor ?? '') || item.sourcePerson;
  const created = String(item.customFields.githubCreatedAt ?? '');
  return (
    <header className="fy-detail-head">
      <div className="fy-kicker">
        <span className={`fy-source-mark small ${external ? 'github' : 'charter'}`}>
          {external ? 'GH' : 'C'}
        </span>
        <span>{external ? 'GitHub' : 'Charter'}</span>
        <span className="fy-kicker-sep">›</span>
        <span className="mono" data-i18n-ignore>
          {externalRef(item) ?? item.title.slice(0, 60)}
        </span>
      </div>
      <div className="fy-detail-title-row">
        <div className="fy-detail-title-wrap">
          <h2 data-testid="fy-detail-title">{item.title}</h2>
          <div className="fy-detail-meta">
            <span className={`fy-status ${status}`}>
              <i /> {statusLabel(status)}
            </span>
            {author ? <span data-i18n-ignore>@{author}</span> : null}
            {created ? <span data-i18n-ignore>{formatDay(created)}</span> : null}
            {item.customFields.repository ? (
              <span className="mono" data-i18n-ignore>
                {String(item.customFields.repository)}
              </span>
            ) : null}
          </div>
        </div>
        <div className="fy-head-actions">
          {props.secondary}
          {external ? (
            <>
              <button
                className="fy-small-button danger"
                data-testid="fy-delete-issue"
                onClick={props.onDelete}
              >
                <Ic name="trash" size={12} /> Delete
              </button>
              <button
                className="fy-small-button"
                data-testid="fy-open-source"
                onClick={() => void rpcResult('app.openExternal', { url: item.sourceUrl })}
              >
                <Ic name="external" size={12} /> Open in GitHub
              </button>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function DeleteIssueDialog(props: {
  detail: WorkItemDetailDto;
  busy: boolean;
  onClose(): void;
  onConfirm(): void;
}): React.JSX.Element {
  const linked = props.detail.executions.length;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !props.busy) props.onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.busy, props.onClose]);
  return (
    <div
      className="modal-backdrop fy-modal-backdrop"
      data-testid="fy-delete-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onClose();
      }}
    >
      <section
        className="fy-modal fy-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fy-delete-title"
      >
        <header className="fy-modal-head">
          <div>
            <span className="fy-modal-kicker danger">REMOVE FROM WORK</span>
            <h2 id="fy-delete-title">Delete imported issue?</h2>
            <p data-i18n-ignore>{externalRef(props.detail.item) ?? props.detail.item.title}</p>
          </div>
          <button
            className="fy-icon-button"
            aria-label="Close"
            disabled={props.busy}
            onClick={props.onClose}
          >
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="fy-modal-body fy-delete-body">
          <span className="fy-delete-mark">
            <Ic name="trash" size={18} />
          </span>
          <span>
            <strong>The imported card and its local audit trail will leave Work.</strong>
            <p>GitHub is not changed. Re-importing the same URL creates a fresh visible card.</p>
          </span>
          {linked > 0 ? (
            <div className="fy-delete-warning" data-testid="fy-delete-linked-warning">
              <Ic name="alert" size={14} />
              <span>
                <strong>
                  {linked} linked {linked === 1 ? 'execution' : 'executions'} will remain available.
                </strong>
                Delete only removes the imported Work card; it does not stop Sessions or Missions.
              </span>
            </div>
          ) : null}
        </div>
        <footer className="fy-modal-foot">
          <button className="fy-small-button" disabled={props.busy} onClick={props.onClose}>
            Cancel
          </button>
          <button
            className="fy-small-button danger solid"
            data-testid="fy-delete-confirm"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? 'Deleting…' : 'Delete imported issue'}
          </button>
        </footer>
      </section>
    </div>
  );
}

/* ------------------------------------------------------ incoming: left side */

function IssueContextCard(props: { item: WorkItemDto }): React.JSX.Element {
  const { item } = props;
  return (
    <section className="fy-card">
      <div className="fy-card-head">
        <h3>Issue context</h3>
        <span>Imported without flattening the source</span>
      </div>
      <div className="fy-card-body fy-prose" data-testid="fy-issue-context">
        {item.descriptionMd ? (
          <Markdown text={item.descriptionMd} />
        ) : (
          <p className="fy-muted">This issue has no description.</p>
        )}
        {item.labels.length ? (
          <div className="fy-labels">
            {item.labels.map((label, index) => (
              <span
                key={label}
                className={`fy-label ${index === 0 ? 'accent' : ''}`}
                data-i18n-ignore
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function CarriedContextCard(props: { item: WorkItemDto }): React.JSX.Element {
  const item = props.item;
  const comments = parseGithubComments(item);
  const rows: Array<{ icon: string; name: string; note: string; state: string }> = [
    {
      icon: 'file',
      name: 'Issue body and metadata',
      note: 'Title, labels, author, and source link',
      state: 'Included',
    },
    {
      icon: 'sessions',
      name: `${comments.length} source comments`,
      note: 'Discussion tail preserved in order',
      state: 'Included',
    },
    {
      icon: 'check',
      name: 'Acceptance criteria',
      note: `${item.acceptance.length} testable outcomes from the issue`,
      state: 'Editable',
    },
    {
      icon: 'branch',
      name: 'Repository context',
      note: 'Project rules and recent changes at start',
      state: 'At start',
    },
  ];
  return (
    <section className="fy-card">
      <div className="fy-card-head">
        <h3>Context Charter will carry in</h3>
        <span>{rows.length} objects</span>
      </div>
      <div className="fy-card-body fy-context-list">
        {rows.map((row) => (
          <div className="fy-context-row" key={row.name}>
            <span className="fy-context-icon">
              <Ic name={row.icon} size={13} />
            </span>
            <span>
              <span className="fy-context-name">{row.name}</span>
              <span className="fy-context-note">{row.note}</span>
            </span>
            <span className="fy-context-state">{row.state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DiscussionCard(props: { item: WorkItemDto }): React.JSX.Element | null {
  const comments = parseGithubComments(props.item);
  if (comments.length === 0) return null;
  return (
    <section className="fy-card" data-testid="fy-discussion">
      <div className="fy-card-head">
        <h3>Recent discussion</h3>
        <span>{comments.length} comments</span>
      </div>
      <div className="fy-card-body">
        {comments.map((comment, index) => (
          <div className="fy-comment" key={`${comment.login}-${index}`}>
            <span className="fy-avatar" data-i18n-ignore>
              {initials(comment.login)}
            </span>
            <span>
              <span className="fy-comment-head" data-i18n-ignore>
                {comment.login}
                <span>{formatDay(comment.at)}</span>
              </span>
              <span className="fy-comment-body" data-i18n-ignore>
                {comment.body}
              </span>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------- incoming: launch side */

interface ProjectChoice {
  path: string;
  displayName: string;
}

function useRecentProjects(): ProjectChoice[] {
  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  useEffect(() => {
    void rpcResult('workspace.recent', {}).then((result) => {
      if (result.ok) {
        setProjects(
          result.data.items.map((entry) => ({ path: entry.path, displayName: entry.displayName })),
        );
      }
    });
  }, []);
  return projects;
}

interface ProjectGitContext {
  branch: string | null;
  branches: Array<{ name: string; current: boolean }>;
  dirty: number | null;
  isRepo: boolean;
  loading: boolean;
}

function useProjectGit(path: string): ProjectGitContext {
  const [state, setState] = useState<ProjectGitContext>({
    branch: null,
    branches: [],
    dirty: null,
    isRepo: false,
    loading: false,
  });
  useEffect(() => {
    setState({ branch: null, branches: [], dirty: null, isRepo: false, loading: Boolean(path) });
    if (!path) return;
    let cancelled = false;
    void rpcResult('project.inspect', { path }).then((result) => {
      if (cancelled) return;
      if (!result.ok || !result.data.git.isRepo) {
        setState({ branch: null, branches: [], dirty: null, isRepo: false, loading: false });
        return;
      }
      setState({
        branch: result.data.git.branch,
        branches: result.data.git.branches,
        dirty: result.data.git.entries.length,
        isRepo: true,
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return state;
}

async function saveMapping(item: WorkItemDto, project: ProjectChoice): Promise<void> {
  await useWorkItemStore.getState().update({
    id: item.id,
    expectedVersion: item.version,
    customFields: {
      ...item.customFields,
      githubLocalPath: project.path,
      githubLocalProject: project.displayName,
      githubMappingSource: 'manual',
    },
  });
  await useForYouStore.getState().refreshDetail();
}

/** The mock's "Final check" modal — really creates the Session/Mission. */
function StartModal(props: { item: WorkItemDto; onClose(): void }): React.JSX.Element {
  const { item } = props;
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const models = useTaskStore((state) => state.models);
  const catalogAgents = useAgentCatalogStore((state) => state.agents);
  const agentCatalogLoading = useAgentCatalogStore((state) => state.loading);
  const settings = useAppStore((state) => state.settings);
  const projects = useRecentProjects();
  const mappedPath = String(item.customFields.githubLocalPath ?? '');
  const [projectPath, setProjectPath] = useState(mappedPath);
  const projectGit = useProjectGit(projectPath);
  const [baseBranch, setBaseBranch] = useState('');
  const [workspaceMode, setWorkspaceMode] = useState<IssueWorkspaceMode>('checkout');
  const [shape, setShape] = useState<'mission' | 'session'>('mission');
  const [acceptance, setAcceptance] = useState(
    item.acceptance.map((entry) => `• ${entry.text}`).join('\n'),
  );
  const [starting, setStarting] = useState(false);
  const [catalogReady, setCatalogReady] = useState(models.length > 0);
  const [entryAgent, setEntryAgent] = useState('pi');
  const [modelKey, setModelKey] = useState('');
  const externalAgents = useMemo(
    () => catalogAgents.filter((agent) => agent.installed && agent.capabilities.terminal),
    [catalogAgents],
  );

  // The inbox can be the first surface of a launch — make sure the model
  // catalog is loaded before deciding between direct start and composer.
  useEffect(() => {
    useTaskStore.getState().init();
    useAgentCatalogStore.getState().init();
    void useTaskStore
      .getState()
      .refreshModels()
      .finally(() => setCatalogReady(true));
  }, []);

  const configuredModels = useMemo(() => models.filter((model) => model.configured), [models]);
  useEffect(() => {
    if (configuredModels.some((model) => `${model.providerId}::${model.modelId}` === modelKey)) {
      return;
    }
    const preferred =
      configuredModels.find(
        (model) =>
          model.providerId === settings?.models.defaultProviderId &&
          model.modelId === settings?.models.defaultModelId,
      ) ?? configuredModels[0];
    setModelKey(preferred ? `${preferred.providerId}::${preferred.modelId}` : '');
  }, [configuredModels, modelKey, settings]);

  useEffect(() => {
    if (entryAgent === 'pi') return;
    if (externalAgents.some((agent) => agent.id === entryAgent)) return;
    setEntryAgent('pi');
  }, [entryAgent, externalAgents]);
  const selectedExternalAgent = externalAgents.find((agent) => agent.id === entryAgent) ?? null;

  useEffect(() => {
    if (!projectGit.isRepo) {
      setBaseBranch('');
      setWorkspaceMode('checkout');
      return;
    }
    if (projectGit.branches.some((candidate) => candidate.name === baseBranch)) return;
    const preferredBranch =
      projectGit.branches.find((candidate) => candidate.current)?.name ??
      projectGit.branch ??
      projectGit.branches[0]?.name ??
      '';
    setBaseBranch(preferredBranch);
  }, [baseBranch, projectGit.branch, projectGit.branches, projectGit.isRepo]);

  const start = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    const type = snapshot.types.find((candidate) => candidate.id === item.typeId) ?? null;
    const configured = useTaskStore.getState().models.filter((model) => model.configured);
    const preferred =
      configured.find((model) => `${model.providerId}::${model.modelId}` === modelKey) ??
      configured.find(
        (model) =>
          model.providerId === settings?.models.defaultProviderId &&
          model.modelId === settings?.models.defaultModelId,
      ) ??
      configured[0];
    const acceptanceLines = acceptance
      .split('\n')
      .map((line) => line.replace(/^•\s*/, '').trim())
      .filter(Boolean);
    const pipeline =
      shape === 'mission'
        ? '\nRun this as a Mission: direct worker terminals for implementation, verification, and an independent review before you finish (terminal.create / terminal.send / terminal.wait).'
        : '';
    const issuePrompt = buildHandoffPrompt(item, type);
    const workspaceDirective = buildIssueWorkspaceDirective({
      projectPath,
      baseBranch: baseBranch || null,
      currentBranch: projectGit.branch,
      mode: workspaceMode,
    });
    const launchInstructions = `\n\n${workspaceDirective}${pipeline}`;
    const preparedPrompt = issuePrompt + launchInstructions;

    if (entryAgent !== 'pi') {
      // Keep the branch/worktree contract even when an unusually large issue
      // body has to be clipped for a native terminal Agent.
      const truncationNote = `${launchInstructions}\n\n[Issue context truncated to fit the native Agent launch limit.]`;
      const externalPrompt =
        preparedPrompt.length <= 20_000
          ? preparedPrompt
          : issuePrompt.slice(0, Math.max(0, 20_000 - truncationNote.length)) + truncationNote;
      useTerminalStore.getState().init();
      const terminalId = await useTerminalStore.getState().create({
        launch: entryAgent,
        context: { kind: 'recent', projectPath },
        title: item.title,
        reveal: false,
        initialPrompt: externalPrompt,
      });
      if (!terminalId) {
        setStarting(false);
        return;
      }
      await useTaskStore.getState().refreshTasks();
      const externalTask = useTaskStore
        .getState()
        .tasks.find((task) => task.external?.terminalId === terminalId);
      await useWorkItemStore.getState().linkExecution({
        workItemId: item.id,
        targetKind: externalTask ? 'session' : 'terminal',
        targetId: externalTask?.id ?? terminalId,
        role: 'primary',
        approach: shape === 'mission' ? 'Mission lead' : 'Agent Session',
        displayLabel: item.title,
        agentLabel: agentDisplayName(entryAgent),
        summary: '',
      });
      setStarting(false);
      await useForYouStore.getState().refreshDetail();
      useAppStore
        .getState()
        .pushToast(
          'success',
          `Started ${shape === 'mission' ? 'Mission' : 'Session'} with ${agentDisplayName(entryAgent)}.`,
        );
      props.onClose();
      return;
    }

    if (!preferred) {
      // No configured model → the composer (which owns provider setup) is the
      // only honest path; hand the prepared context over instead of failing.
      useAppStore.getState().queueWorkHandoff({
        workItemId: item.id,
        title: item.title,
        prompt: preparedPrompt,
        acceptance: acceptanceLines,
        ...(projectPath ? { projectPath } : {}),
      });
      useAppStore.getState().openSessionHome();
      useAppStore.getState().focusComposer();
      props.onClose();
      return;
    }
    // Deliberately not createAndStart: the mock stays on the inbox with the
    // running card — no navigation into the Session Room.
    const thinkingLevel = settings?.models.defaultThinkingLevel ?? 'medium';
    const create = await rpcResult('task.create', {
      title: item.title,
      goalMd: preparedPrompt,
      acceptance: acceptanceLines,
      mode: settings?.agent.defaultMode ?? 'edit',
      model: { providerId: preferred.providerId, modelId: preferred.modelId, thinkingLevel },
      verification: [],
      ...(projectPath ? { projectPath } : {}),
      // This imported-issue mode is Agent-owned: the instruction above may
      // request a worktree, but Charter itself never creates one.
      isolation: 'none',
      conversationRefTaskIds: [],
    });
    if (!create.ok) {
      setStarting(false);
      useAppStore.getState().pushToast('error', create.error.userMessage);
      return;
    }
    const started = await rpcResult('task.start', {
      taskId: create.data.task.id,
      codeRefs: [],
      fileRefs: [],
      artifactRefs: [],
    });
    if (!started.ok) {
      setStarting(false);
      useAppStore.getState().pushToast('error', started.error.userMessage);
      return;
    }
    await useTaskStore.getState().refreshTasks();
    await useWorkItemStore.getState().linkExecution({
      workItemId: item.id,
      targetKind: 'session',
      targetId: create.data.task.id,
      role: 'primary',
      approach: shape === 'mission' ? 'Mission (implement · verify · review)' : 'Single Session',
      displayLabel: create.data.task.title,
      agentLabel: `Charter Agent · ${preferred.displayName}`,
      summary: '',
    });
    setStarting(false);
    await useForYouStore.getState().refreshDetail();
    useAppStore
      .getState()
      .pushToast('success', `Started work from ${externalRef(item) ?? item.title}.`);
    props.onClose();
  };

  return (
    <div
      className="modal-backdrop fy-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !starting) props.onClose();
      }}
    >
      <section
        className="fy-modal fy-start-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Final check"
        data-testid="fy-start-modal"
      >
        <header className="fy-start-head">
          <div className="fy-start-heading">
            <span className="fy-start-source">
              <span className="fy-source-mark small github">GH</span>
              <span>GitHub issue</span>
              <i>·</i>
              <span className="mono" data-i18n-ignore>
                {externalRef(item) ?? 'Local work'}
              </span>
            </span>
            <h2>Start a new execution</h2>
            <p data-i18n-ignore>{item.title}</p>
          </div>
          <button
            className="fy-icon-button"
            aria-label="Close"
            disabled={starting}
            onClick={props.onClose}
          >
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="fy-start-body">
          <div className="fy-start-main">
            <section className="fy-start-section">
              <div className="fy-start-section-head">
                <span className="fy-start-step">1</span>
                <span>
                  <strong>Choose how to run</strong>
                  <small>
                    Use a Mission for coordinated work, or one Session for a focused task.
                  </small>
                </span>
              </div>
              <div className="fy-choice-grid">
                <label
                  className={`fy-choice ${shape === 'mission' ? 'checked' : ''}`}
                  data-testid="fy-shape-mission-option"
                >
                  <input
                    type="radio"
                    name="fy-shape"
                    value="mission"
                    checked={shape === 'mission'}
                    onChange={() => setShape('mission')}
                  />
                  <span className="fy-choice-icon">
                    <Ic name="compass" size={16} />
                  </span>
                  <span>
                    <strong>Mission</strong>
                    <em>Recommended</em>
                    <p>Coordinate implementation, verification, and independent review.</p>
                  </span>
                  <span className="fy-choice-check">
                    <Ic name="check" size={11} />
                  </span>
                </label>
                <label
                  className={`fy-choice ${shape === 'session' ? 'checked' : ''}`}
                  data-testid="fy-shape-session-option"
                >
                  <input
                    type="radio"
                    name="fy-shape"
                    value="session"
                    data-testid="fy-shape-session"
                    checked={shape === 'session'}
                    onChange={() => setShape('session')}
                  />
                  <span className="fy-choice-icon">
                    <Ic name="sessions" size={16} />
                  </span>
                  <span>
                    <strong>Single Session</strong>
                    <p>Run one selected Agent on a small, focused change.</p>
                  </span>
                  <span className="fy-choice-check">
                    <Ic name="check" size={11} />
                  </span>
                </label>
              </div>
            </section>

            <section className="fy-start-section">
              <div className="fy-start-section-head">
                <span className="fy-start-step">2</span>
                <span>
                  <strong data-testid="fy-agent-field-label">
                    {shape === 'mission' ? 'Choose the Mission lead' : 'Choose the Session Agent'}
                  </strong>
                  <small>The selected Agent receives the complete issue context.</small>
                </span>
              </div>
              <div className="fy-agent-grid" data-testid="fy-entry-agent">
                <button
                  type="button"
                  className={`fy-agent-option ${entryAgent === 'pi' ? 'selected' : ''}`}
                  data-testid="fy-agent-pi"
                  data-agent-id="pi"
                  aria-pressed={entryAgent === 'pi'}
                  onClick={() => setEntryAgent('pi')}
                >
                  <span className="fy-agent-mark charter">
                    <ProviderMark provider="pi" size={17} />
                  </span>
                  <span>
                    <strong>Charter Agent</strong>
                    <small>Model-backed</small>
                  </span>
                  <Ic name="check" size={11} className="fy-agent-selected-mark" />
                </button>
                {externalAgents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    className={`fy-agent-option ${entryAgent === agent.id ? 'selected' : ''}`}
                    data-testid={`fy-agent-${agent.id}`}
                    data-agent-id={agent.id}
                    aria-pressed={entryAgent === agent.id}
                    onClick={() => setEntryAgent(agent.id)}
                  >
                    <span
                      className="fy-agent-mark"
                      style={{ '--agent-accent': agent.accent } as React.CSSProperties}
                    >
                      <ProviderMark provider={agent.id} size={17} />
                    </span>
                    <span>
                      <strong data-i18n-ignore>{agent.displayName}</strong>
                      <small>Native CLI</small>
                    </span>
                    <Ic name="check" size={11} className="fy-agent-selected-mark" />
                  </button>
                ))}
              </div>

              {entryAgent === 'pi' ? (
                <label className="fy-start-config">
                  <span className="fy-start-config-mark">
                    <ProviderMark provider="pi" size={17} />
                  </span>
                  <span className="fy-start-config-copy">
                    <strong>Charter model</strong>
                    <small>{shape === 'mission' ? 'Leads the Mission' : 'Runs this Session'}</small>
                  </span>
                  <select
                    aria-label="Model"
                    data-testid="fy-entry-model"
                    value={modelKey}
                    onChange={(event) => setModelKey(event.target.value)}
                  >
                    {configuredModels.map((model) => (
                      <option
                        key={`${model.providerId}::${model.modelId}`}
                        value={`${model.providerId}::${model.modelId}`}
                      >
                        {model.providerName} · {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="fy-start-config" data-testid="fy-entry-agent-note">
                  <span
                    className="fy-start-config-mark"
                    style={
                      {
                        '--agent-accent': selectedExternalAgent?.accent ?? 'var(--accent)',
                      } as React.CSSProperties
                    }
                  >
                    <ProviderMark provider={entryAgent} size={17} />
                  </span>
                  <span className="fy-start-config-copy">
                    <strong data-i18n-ignore>{agentDisplayName(entryAgent)}</strong>
                    <small>
                      {shape === 'mission'
                        ? 'Native terminal · can direct Mission workers'
                        : 'Native terminal · runs this Session directly'}
                    </small>
                  </span>
                  <span className="fy-runtime-ready">
                    <i /> Ready
                  </span>
                </div>
              )}
            </section>
          </div>

          <aside className="fy-start-context">
            <div className="fy-start-context-head">
              <span>
                <strong>Launch context</strong>
                <small>Review where the Agent will work.</small>
              </span>
              <span className="fy-runtime-ready">
                <i /> Local
              </span>
            </div>
            <label className="fy-start-project">
              <span>Project</span>
              <select
                data-testid="fy-start-project"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
              >
                {!mappedPath ? <option value="">Choose a Project…</option> : null}
                {projects.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="fy-start-facts">
              <label className="fy-start-branch">
                <Ic name="branch" size={13} />
                <span>
                  <small>Base branch</small>
                  <select
                    className="mono"
                    data-testid="fy-start-branch"
                    data-i18n-ignore
                    disabled={projectGit.loading || !projectGit.isRepo}
                    value={baseBranch}
                    onChange={(event) => setBaseBranch(event.target.value)}
                  >
                    {projectGit.loading ? <option value="">Loading branches…</option> : null}
                    {!projectGit.loading && projectGit.branches.length === 0 ? (
                      <option value="">No local branches</option>
                    ) : null}
                    {projectGit.branches.map((candidate) => (
                      <option key={candidate.name} value={candidate.name}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <span>
                <Ic name="folder" size={13} />
                <span>
                  <small>Repository</small>
                  <strong className="mono" data-i18n-ignore title={projectPath}>
                    {projectPath || 'Choose a Project'}
                  </strong>
                </span>
              </span>
            </div>
            <fieldset className="fy-workspace-mode">
              <legend>
                <span>Workspace strategy</span>
                <small>
                  {projectGit.branch
                    ? `${projectGit.branch} checked out${projectGit.dirty ? ` · ${projectGit.dirty} local changes` : ''}`
                    : 'Choose how the Agent should enter the repository'}
                </small>
              </legend>
              <div className="fy-workspace-options">
                <label className={workspaceMode === 'checkout' ? 'selected' : ''}>
                  <input
                    type="radio"
                    name="fy-workspace-mode"
                    value="checkout"
                    checked={workspaceMode === 'checkout'}
                    onChange={() => setWorkspaceMode('checkout')}
                  />
                  <span>
                    <strong>Existing checkout</strong>
                    <small>Agent verifies or safely switches to the selected branch.</small>
                  </span>
                  <Ic name="check" size={10} />
                </label>
                <label
                  className={`${workspaceMode === 'agent-worktree' ? 'selected' : ''} ${!projectGit.isRepo || !baseBranch ? 'disabled' : ''}`}
                  data-testid="fy-workspace-agent-worktree"
                >
                  <input
                    type="radio"
                    name="fy-workspace-mode"
                    value="agent-worktree"
                    checked={workspaceMode === 'agent-worktree'}
                    disabled={!projectGit.isRepo || !baseBranch}
                    onChange={() => setWorkspaceMode('agent-worktree')}
                  />
                  <span>
                    <strong>Agent-created worktree</strong>
                    <small>Prompt the Agent to create and enter an isolated worktree.</small>
                  </span>
                  <Ic name="check" size={10} />
                </label>
              </div>
              {workspaceMode === 'agent-worktree' ? (
                <p className="fy-worktree-note" data-testid="fy-worktree-note">
                  <Ic name="info" size={11} /> Charter only adds the instruction. The Agent creates
                  and manages the worktree.
                </p>
              ) : null}
            </fieldset>
            <label className="fy-start-acceptance">
              <span>
                <strong>Acceptance criteria</strong>
                <small>
                  {acceptance.split('\n').filter((line) => line.trim()).length} outcomes
                </small>
              </span>
              <textarea
                data-testid="fy-start-acceptance"
                rows={6}
                value={acceptance}
                onChange={(event) => setAcceptance(event.target.value)}
                placeholder="Add testable outcomes…"
              />
            </label>
          </aside>
        </div>
        <footer className="fy-modal-foot fy-start-foot">
          <span className="fy-foot-caption">
            <Ic name="shield" size={12} /> Local execution only · GitHub stays read-only
          </span>
          <div className="fy-modal-foot-right">
            <button className="fy-small-button" disabled={starting} onClick={props.onClose}>
              Cancel
            </button>
            <button
              className="fy-small-button primary"
              data-testid="fy-start-confirm"
              disabled={
                starting ||
                !projectPath ||
                projectGit.loading ||
                (projectGit.isRepo && !baseBranch) ||
                (entryAgent === 'pi'
                  ? !catalogReady || !modelKey
                  : agentCatalogLoading || !externalAgents.some((agent) => agent.id === entryAgent))
              }
              onClick={() => void start()}
            >
              {entryAgent === 'pi' && !catalogReady
                ? 'Loading agents…'
                : starting
                  ? 'Starting…'
                  : shape === 'mission'
                    ? 'Start Mission'
                    : 'Start Session'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function RunningCard(props: {
  item: WorkItemDto;
  executions: WorkExecutionDto[];
}): React.JSX.Element {
  const [startOpen, setStartOpen] = useState(false);
  const linked = props.executions;
  const phase = executionPhase(linked);
  const canStartAnother = phase === 'stopped' || phase === 'completed';
  const active = linked.filter((execution) => executionPhase([execution]) === 'running').length;
  const waiting = linked.filter((execution) =>
    ['waiting', 'review'].includes(executionPhase([execution])),
  ).length;
  const first = primarySession(linked) ?? linked[0] ?? null;
  const presentation = {
    linked: {
      title: 'Work is linked',
      copy: 'Charter attached this issue to durable execution records.',
      badge: 'Linked',
      tone: 'ready',
      icon: 'sessions',
    },
    running: {
      title: 'Work is running',
      copy: 'The entry Agent is actively working with the issue context and repository mapping.',
      badge: 'Live',
      tone: 'running',
      icon: 'play',
    },
    waiting: {
      title: 'Work needs attention',
      copy: 'A linked Session or Mission is waiting for a decision before it can continue.',
      badge: 'Waiting',
      tone: 'blocked',
      icon: 'alert',
    },
    review: {
      title: 'Work is ready for review',
      copy: 'Execution has finished its current pass and is waiting for review.',
      badge: 'Review',
      tone: 'review',
      icon: 'eye',
    },
    completed: {
      title: 'Work is complete',
      copy: 'Every linked execution has completed.',
      badge: 'Done',
      tone: 'done',
      icon: 'check',
    },
    stopped: {
      title: 'Work has stopped',
      copy: 'No linked execution is running. Open it to inspect, resume, or start another attempt.',
      badge: 'Stopped',
      tone: 'stopped',
      icon: 'circleStop',
    },
  }[phase];
  return (
    <>
      <section className="fy-card fy-running" data-phase={phase} data-testid="fy-running">
        <div className="fy-running-top">
          <span className="fy-running-pulse">
            <Ic name={presentation.icon} size={14} />
          </span>
          <span>
            <span className="fy-running-title">{presentation.title}</span>
            <span className="fy-running-copy">{presentation.copy}</span>
          </span>
        </div>
        <div className="fy-running-stats">
          <span className="fy-running-stat">
            <b>{linked.length}</b>
            <span>Linked</span>
          </span>
          <span className="fy-running-stat">
            <b>{active}</b>
            <span>Active</span>
          </span>
          <span className="fy-running-stat">
            <b>{waiting}</b>
            <span>Waiting</span>
          </span>
        </div>
        <div className="fy-running-actions">
          {canStartAnother ? (
            <button
              className="fy-small-button primary fy-restart-button"
              data-testid="fy-start-another"
              onClick={() => setStartOpen(true)}
            >
              <Ic name="bot" size={12} /> Start new Mission / Session
            </button>
          ) : null}
          <button
            className={`fy-small-button ${canStartAnother ? '' : 'primary'}`}
            data-testid="fy-open-execution"
            disabled={!first}
            onClick={() => first && void openExecution(first)}
          >
            <Ic name="sessions" size={12} /> Open
          </button>
          <button
            className="fy-small-button"
            onClick={() => {
              if (first?.targetId) void navigator.clipboard.writeText(first.targetId);
            }}
          >
            <Ic name="clipboard" size={12} /> Copy ID
          </button>
        </div>
      </section>
      <section className="fy-card fy-soft">
        <div className="fy-card-head">
          <h3>Execution plan</h3>
          <span className={`fy-status ${presentation.tone}`} data-testid="fy-execution-phase">
            <i /> {presentation.badge}
          </span>
        </div>
        <div className="fy-card-body fy-context-list">
          {linked.map((execution) => (
            <button
              type="button"
              key={execution.id}
              className="fy-context-row fy-linked-row"
              data-testid="fy-execution-row"
              aria-label={`Open ${execution.displayLabel || execution.approach || 'linked execution'}`}
              onClick={() => openExecution(execution)}
            >
              <span className="fy-context-icon">
                <Ic name={execution.targetKind === 'mission' ? 'compass' : 'sessions'} size={13} />
              </span>
              <span>
                <span className="fy-context-name" data-i18n-ignore>
                  {execution.displayLabel || execution.approach || 'Linked execution'}
                </span>
                <span className="fy-context-note" data-i18n-ignore>
                  {execution.agentLabel || execution.targetKind} · {execution.role}
                </span>
              </span>
              <span className="fy-context-target">
                <span className="fy-context-state" data-i18n-ignore>
                  {execution.status.toLowerCase().replaceAll('_', ' ')}
                </span>
                <Ic name="arrowRight" size={12} />
              </span>
            </button>
          ))}
        </div>
      </section>
      {startOpen ? <StartModal item={props.item} onClose={() => setStartOpen(false)} /> : null}
    </>
  );
}

function LaunchCard(props: { item: WorkItemDto }): React.JSX.Element {
  const { item } = props;
  const projects = useRecentProjects();
  const mappedPath = String(item.customFields.githubLocalPath ?? '');
  const mappedProject = String(item.customFields.githubLocalProject ?? '');
  const mapMatchedByRemote =
    Boolean(mappedPath) && item.customFields.githubMappingSource !== 'manual';
  const { branch, dirty } = useProjectGit(mappedPath);
  const [startOpen, setStartOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const toggleAcceptance = async (id: string): Promise<void> => {
    const next = item.acceptance.map((entry) =>
      entry.id === id ? { ...entry, checked: !entry.checked } : entry,
    );
    await useWorkItemStore
      .getState()
      .update({ id: item.id, expectedVersion: item.version, acceptance: next });
    await useForYouStore.getState().refreshDetail();
  };

  if (!mappedPath && isExternalItem(item)) {
    return (
      <section className="fy-card fy-launch" data-testid="fy-launch-unmapped">
        <div className="fy-launch-intro danger">
          <span className="fy-mapping-mark danger">
            <Ic name="alert" size={14} />
          </span>
          <span>
            <strong>No local repository mapping</strong>
            <p>Charter knows the source issue, but not where this work should run.</p>
          </span>
        </div>
        <div className="fy-launch-body">
          <label className="fy-field">
            <span>Local Project</span>
            <select
              data-testid="fy-project-picker"
              disabled={saving}
              value=""
              onChange={(event) => {
                const project = projects.find((entry) => entry.path === event.target.value);
                if (!project) return;
                setSaving(true);
                void saveMapping(item, project).finally(() => setSaving(false));
              }}
            >
              <option value="" disabled>
                Choose a Project…
              </option>
              {projects.map((project) => (
                <option key={project.path} value={project.path}>
                  {project.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="fy-card fy-launch" data-testid="fy-launch">
        <div className="fy-launch-intro">
          <span className="fy-mapping-mark">
            <Ic name="branch" size={14} />
          </span>
          <span>
            <strong>
              {mappedProject ? `Ready to start in ${mappedProject}` : 'Ready to start'}
            </strong>
            <p>
              {isExternalItem(item)
                ? 'GitHub source mapped to a local Project and repository. Verify once, then Charter remembers it.'
                : 'Local work item ready for an Agent Session.'}
            </p>
          </span>
        </div>
        <div className="fy-launch-body">
          {mappedPath ? (
            <div className="fy-field">
              <div className="fy-field-label">
                <span>Project & repository</span>
                <em>{mapMatchedByRemote ? 'Matched by git remote' : 'Chosen manually'}</em>
              </div>
              <div className="fy-repo-line">
                <span className="fy-repo-icon">
                  <Ic name="branch" size={12} />
                </span>
                <span className="fy-repo-main">
                  <span className="mono" data-i18n-ignore>
                    {String(item.customFields.repository ?? mappedProject)}
                  </span>
                  <span className="mono fy-repo-path" data-i18n-ignore>
                    {mappedPath}
                  </span>
                </span>
                <span className="fy-confidence">✓</span>
              </div>
            </div>
          ) : null}
          {branch ? (
            <div className="fy-field">
              <div className="fy-field-label">
                <span>Base branch</span>
                <span>{dirty === 0 ? 'clean' : dirty ? `${dirty} local changes` : ''}</span>
              </div>
              <div className="fy-repo-line">
                <span className="fy-repo-icon">
                  <Ic name="branch" size={12} />
                </span>
                <span className="fy-repo-main">
                  <span className="mono" data-i18n-ignore>
                    {branch}
                  </span>
                  <span className="fy-repo-path">A worktree can be created at start</span>
                </span>
              </div>
            </div>
          ) : null}
          <div className="fy-field">
            <div className="fy-field-label">
              <span>Suggested collaboration</span>
              <span>Mission shape</span>
            </div>
            <div className="fy-pipeline">
              <div className="fy-pipeline-step">
                <b>Implement</b>Charter Agent
              </div>
              <div className="fy-pipeline-step">
                <b>Verify</b>Worker terminal
              </div>
              <div className="fy-pipeline-step">
                <b>Review</b>Independent
              </div>
            </div>
          </div>
          {item.acceptance.length ? (
            <div className="fy-field">
              <div className="fy-field-label">
                <span>Acceptance</span>
                <span>{item.acceptance.length} criteria</span>
              </div>
              <div className="fy-check-list">
                {item.acceptance.map((entry) => (
                  <label className="fy-check-row" key={entry.id}>
                    <input
                      type="checkbox"
                      checked={entry.checked}
                      onChange={() => void toggleAcceptance(entry.id)}
                    />
                    <span data-i18n-ignore>{entry.text}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="fy-launch-foot">
          <button
            className="fy-start-button"
            data-testid="fy-start"
            onClick={() => setStartOpen(true)}
          >
            <Ic name="bot" size={14} /> Review and start Mission
          </button>
          <p className="fy-foot-note">
            Nothing is posted back to GitHub until you approve an update.
          </p>
        </div>
      </section>
      {mappedPath ? (
        <section className="fy-card fy-soft">
          <div className="fy-card-head">
            <h3>Mapping rule</h3>
            <button
              className="fy-inline-link"
              data-testid="fy-edit-mapping"
              onClick={() => {
                void useWorkItemStore
                  .getState()
                  .update({
                    id: item.id,
                    expectedVersion: item.version,
                    customFields: {
                      ...item.customFields,
                      githubLocalPath: '',
                      githubLocalProject: '',
                    },
                  })
                  .then(() => useForYouStore.getState().refreshDetail());
              }}
            >
              Edit
            </button>
          </div>
          <div className="fy-card-body fy-mapping-rule">
            <code className="mono" data-i18n-ignore>
              GitHub · {String(item.customFields.repository ?? '')}
            </code>
            <span data-i18n-ignore>
              → Project <strong>{mappedProject}</strong> · <strong>{mappedPath}</strong>
            </span>
          </div>
        </section>
      ) : null}
      {startOpen ? <StartModal item={item} onClose={() => setStartOpen(false)} /> : null}
    </>
  );
}

/* --------------------------------------------------------------- review */

function useReviewFacts(executions: WorkExecutionDto[]): {
  changeSet: ChangeSetDto | null;
  runs: VerificationRunDto[];
} {
  const session = primarySession(executions);
  const [changeSet, setChangeSet] = useState<ChangeSetDto | null>(null);
  const [runs, setRuns] = useState<VerificationRunDto[]>([]);
  useEffect(() => {
    setChangeSet(null);
    setRuns([]);
    const taskId = session?.targetId;
    if (!taskId) return;
    let cancelled = false;
    void rpcResult('task.changeSet', { taskId }).then((result) => {
      if (!cancelled && result.ok) setChangeSet(result.data.changeSet);
    });
    void rpcResult('task.verificationRuns', { taskId }).then((result) => {
      if (!cancelled && result.ok) setRuns(result.data.runs);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.targetId]);
  return { changeSet, runs };
}

function composeUpdate(
  item: WorkItemDto,
  changeSet: ChangeSetDto | null,
  runs: VerificationRunDto[],
  evidence: WorkItemDetailDto['evidence'],
  includeVerification: boolean,
  includeEvidence: boolean,
): string {
  const passed = runs.filter((run) => run.state === 'passed').length;
  const lines = [`**Update from Charter — ${item.title}**`, ''];
  if (changeSet && changeSet.files.length) {
    lines.push(
      `- Change: ${changeSet.files.length} file${changeSet.files.length === 1 ? '' : 's'} (+${changeSet.totalAdditions} −${changeSet.totalDeletions})`,
    );
  }
  if (includeVerification && runs.length) {
    lines.push(`- Verification: ${passed}/${runs.length} checks passed`);
  }
  const done = item.acceptance.filter((entry) => entry.checked);
  if (done.length) {
    lines.push(`- Acceptance: ${done.length}/${item.acceptance.length} criteria met`);
    for (const entry of done) lines.push(`  - [x] ${entry.text}`);
  }
  if (includeEvidence) {
    const links = evidence.filter(
      (entry) => entry.kind === 'link' && /^https?:\/\//.test(entry.value),
    );
    if (links.length) {
      lines.push('- Evidence:');
      for (const link of links) lines.push(`  - ${link.label}: ${link.value}`);
    }
  }
  lines.push('', '_Posted from Charter after human review._');
  return lines.join('\n');
}

function PostModal(props: { item: WorkItemDto; body: string; onClose(): void }): React.JSX.Element {
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (): Promise<void> => {
    if (posting) return;
    setPosting(true);
    setError(null);
    const result = await rpcResult('github.issue.postComment', {
      workItemId: props.item.id,
      body: props.body,
    });
    setPosting(false);
    if (!result.ok) {
      setError(result.error.userMessage);
      return;
    }
    await useForYouStore.getState().refreshDetail();
    useAppStore.getState().pushToast('success', `Update posted to ${externalRef(props.item)}.`);
    props.onClose();
  };
  return (
    <div
      className="modal-backdrop fy-modal-backdrop"
      onClick={(event) => event.target === event.currentTarget && props.onClose()}
    >
      <section
        className="fy-modal wide"
        role="dialog"
        aria-modal="true"
        aria-label="External write preview"
        data-testid="fy-post-modal"
      >
        <header className="fy-modal-head">
          <div>
            <span className="fy-modal-kicker">EXTERNAL WRITE PREVIEW</span>
            <h2>Post update to GitHub</h2>
            <p data-i18n-ignore>
              This is the exact payload Charter will publish to {externalRef(props.item)}.
            </p>
          </div>
          <button className="fy-icon-button" aria-label="Close" onClick={props.onClose}>
            <Ic name="x" size={14} />
          </button>
        </header>
        <div className="fy-modal-body">
          <div className="fy-preview-note fy-prose" data-testid="fy-post-preview">
            <Markdown text={props.body} />
          </div>
          <div className="fy-quote">
            After publishing, Charter records this exact payload and the resulting link in the
            item's audit trail.
          </div>
          {error ? (
            <div className="fy-import-error" role="alert" data-testid="fy-post-error">
              <Ic name="alert" size={13} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
        <footer className="fy-modal-foot">
          <span className="fy-foot-caption">One comment will be created. No PR.</span>
          <div className="fy-modal-foot-right">
            <button className="fy-small-button" onClick={props.onClose}>
              Cancel
            </button>
            <button
              className="fy-small-button primary"
              data-testid="fy-post-confirm"
              disabled={posting}
              onClick={() => void post()}
            >
              {posting ? 'Posting…' : 'Post update'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function ShipCard(props: {
  detail: WorkItemDetailDto;
  changeSet: ChangeSetDto | null;
  runs: VerificationRunDto[];
}): React.JSX.Element | null {
  const item = props.detail.item;
  const [includeVerification, setIncludeVerification] = useState(true);
  const [includeEvidence, setIncludeEvidence] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (!isExternalItem(item)) return null;
  const postedUrl = String(item.customFields.githubPostedUrl ?? '');
  const body = composeUpdate(
    item,
    props.changeSet,
    props.runs,
    props.detail.evidence,
    includeVerification,
    includeEvidence,
  );
  return (
    <section className="fy-card" data-testid="fy-ship">
      <div className="fy-card-head">
        <h3>Ship result</h3>
        <span>External write requires approval</span>
      </div>
      <div className="fy-card-body">
        <div className="fy-repo-line">
          <span className="fy-source-mark small github">GH</span>
          <span className="fy-repo-main">
            <span className="mono" data-i18n-ignore>
              {externalRef(item)}
            </span>
            <span className="fy-repo-path">Comment with the update summary</span>
          </span>
        </div>
        {postedUrl ? (
          <>
            <div className="fy-posted-box" data-testid="fy-posted">
              <strong>Update posted</strong>
              <p data-i18n-ignore>
                Published to GitHub {String(item.customFields.githubPostedAt ?? '').slice(0, 10)}.
                The exact payload is in the audit trail.
              </p>
            </div>
            <button
              className="fy-small-button fy-block"
              onClick={() => void rpcResult('app.openExternal', { url: postedUrl })}
            >
              <Ic name="external" size={12} /> View published update
            </button>
          </>
        ) : (
          <>
            <div className="fy-preview-note fy-summary-preview" data-i18n-ignore>
              <Markdown text={body} />
            </div>
            <div className="fy-check-list fy-publish-checks">
              <label className="fy-check-row">
                <input
                  type="checkbox"
                  checked={includeVerification}
                  onChange={(event) => setIncludeVerification(event.target.checked)}
                />
                <span>Include verification summary</span>
              </label>
              <label className="fy-check-row">
                <input
                  type="checkbox"
                  checked={includeEvidence}
                  onChange={(event) => setIncludeEvidence(event.target.checked)}
                />
                <span>Attach evidence links</span>
              </label>
            </div>
            <button
              className="fy-start-button"
              data-testid="fy-post-preview-open"
              onClick={() => setPreviewOpen(true)}
            >
              <Ic name="external" size={13} /> Preview GitHub update…
            </button>
          </>
        )}
      </div>
      {previewOpen ? (
        <PostModal item={item} body={body} onClose={() => setPreviewOpen(false)} />
      ) : null}
    </section>
  );
}

function ReviewDetail(props: { detail: WorkItemDetailDto }): React.JSX.Element {
  const detail = props.detail;
  const item = detail.item;
  const { changeSet, runs } = useReviewFacts(detail.executions);
  const passed = runs.filter((run) => run.state === 'passed').length;
  const session = primarySession(detail.executions);
  const notes = detail.evidence.filter((entry) => entry.kind !== 'link');
  return (
    <div className="fy-grid">
      <div className="fy-column">
        <div className="fy-metric-grid">
          <div className="fy-metric">
            <div className="fy-metric-label">Change</div>
            <div className="fy-metric-value" data-i18n-ignore>
              {changeSet ? `${changeSet.files.length} files` : '—'}
            </div>
            <div className="fy-metric-note mono" data-i18n-ignore>
              {changeSet ? `+${changeSet.totalAdditions} −${changeSet.totalDeletions}` : ''}
            </div>
          </div>
          <div className={`fy-metric ${runs.length && passed === runs.length ? 'good' : ''}`}>
            <div className="fy-metric-label">Checks</div>
            <div className="fy-metric-value" data-i18n-ignore>
              {runs.length ? `${passed} / ${runs.length}` : '—'}
            </div>
            <div className="fy-metric-note">{runs.length ? 'verification runs' : 'none yet'}</div>
          </div>
          <div className="fy-metric">
            <div className="fy-metric-label">Executions</div>
            <div className="fy-metric-value" data-i18n-ignore>
              {detail.executions.length}
            </div>
            <div className="fy-metric-note">linked</div>
          </div>
          <div className="fy-metric">
            <div className="fy-metric-label">Evidence</div>
            <div className="fy-metric-value" data-i18n-ignore>
              {detail.evidence.length}
            </div>
            <div className="fy-metric-note">artifacts retained</div>
          </div>
        </div>
        <section className="fy-card">
          <div className="fy-card-head">
            <h3>Outcome</h3>
            {session ? (
              <button
                className="fy-inline-link"
                onClick={() => session && void openExecution(session)}
              >
                Open Session
              </button>
            ) : null}
          </div>
          <div className="fy-card-body fy-prose">
            {notes.length ? (
              notes.map((entry) => (
                <p key={entry.id} data-i18n-ignore>
                  <strong>{entry.label}</strong>
                  {entry.value ? ` — ${entry.value}` : ''}
                </p>
              ))
            ) : (
              <p className="fy-muted">
                No outcome recorded yet — the Session report and review live in the Room.
              </p>
            )}
          </div>
        </section>
        {changeSet && changeSet.files.length ? (
          <section className="fy-card" data-testid="fy-files-changed">
            <div className="fy-card-head">
              <h3>Files changed</h3>
              <span data-i18n-ignore>{changeSet.files.length}</span>
            </div>
            <div className="fy-card-body fy-context-list">
              {changeSet.files.slice(0, 8).map((file) => (
                <div className="fy-file-row" key={file.path}>
                  <span className="fy-file-name mono" data-i18n-ignore>
                    <Ic name="file" size={12} /> {file.path}
                  </span>
                  <span className="fy-diff-stat mono" data-i18n-ignore>
                    <i className="fy-plus">+{file.additions}</i>{' '}
                    <i className="fy-minus">−{file.deletions}</i>
                  </span>
                </div>
              ))}
              {changeSet.files.length > 8 ? (
                <div className="fy-context-note" data-i18n-ignore>
                  +{changeSet.files.length - 8} more
                </div>
              ) : null}
            </div>
          </section>
        ) : null}
        {runs.length ? (
          <section className="fy-card" data-testid="fy-verification">
            <div className="fy-card-head">
              <h3>Verification</h3>
              <span>Run from the Session worktree</span>
            </div>
            <div className="fy-card-body fy-context-list">
              {runs.slice(0, 6).map((run) => (
                <div className="fy-context-row" key={run.id}>
                  <span className={`fy-verify-icon ${run.state}`}>
                    <Ic name={run.state === 'passed' ? 'check' : 'alert'} size={12} />
                  </span>
                  <span>
                    <span className="fy-context-name" data-i18n-ignore>
                      {run.label}
                    </span>
                    <span className="fy-context-note mono" data-i18n-ignore>
                      {run.outputExcerpt.slice(0, 80)}
                    </span>
                  </span>
                  <span className="fy-context-state" data-i18n-ignore>
                    {run.state}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {detail.evidence.length ? (
          <section className="fy-card" data-testid="fy-evidence">
            <div className="fy-card-head">
              <h3>Evidence</h3>
              <span data-i18n-ignore>{detail.evidence.length} artifacts · locally retained</span>
            </div>
            <div className="fy-card-body fy-context-list">
              {detail.evidence.map((entry) => (
                <div className="fy-context-row" key={entry.id}>
                  <span className="fy-context-icon">
                    <Ic name={entry.kind === 'link' ? 'external' : 'file'} size={12} />
                  </span>
                  <span>
                    <span className="fy-context-name" data-i18n-ignore>
                      {entry.label}
                    </span>
                    <span className="fy-context-note" data-i18n-ignore>
                      {entry.value.slice(0, 90)}
                    </span>
                  </span>
                  <span className="fy-context-state" data-i18n-ignore>
                    {entry.kind}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <aside className="fy-column">
        <ShipCard detail={detail} changeSet={changeSet} runs={runs} />
        <section className="fy-card fy-soft">
          <div className="fy-card-head">
            <h3>Audit</h3>
            <span data-i18n-ignore>{item.id.slice(0, 13)}</span>
          </div>
          <div className="fy-card-body fy-context-list">
            <div className="fy-context-row">
              <span className="fy-context-icon">
                <Ic name="clock" size={12} />
              </span>
              <span>
                <span className="fy-context-name">Updated</span>
                <span className="fy-context-note" data-i18n-ignore>
                  {formatDay(item.updatedAt)}
                </span>
              </span>
              <span className="fy-context-state" data-i18n-ignore>
                v{item.version}
              </span>
            </div>
            <div className="fy-context-row">
              <span className="fy-context-icon">
                <Ic name="shield" size={12} />
              </span>
              <span>
                <span className="fy-context-name">
                  {item.customFields.githubPostedUrl ? 'Update posted' : 'No external writes yet'}
                </span>
                <span className="fy-context-note">
                  {item.customFields.githubPostedUrl
                    ? 'Payload retained in evidence'
                    : 'Awaiting your approval'}
                </span>
              </span>
              <span className="fy-context-state">
                {item.customFields.githubPostedUrl ? 'Posted' : 'Safe'}
              </span>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------- attention */

function AttentionDetail(props: { task: TaskDto }): React.JSX.Element {
  const { task } = props;
  return (
    <>
      <header className="fy-detail-head">
        <div className="fy-kicker">
          <span className="fy-source-mark small charter">C</span>
          <span>Charter</span>
          <span className="fy-kicker-sep">›</span>
          <span className="mono" data-i18n-ignore>
            {task.projectName || 'Session'}
          </span>
        </div>
        <div className="fy-detail-title-row">
          <div className="fy-detail-title-wrap">
            <h2 data-testid="fy-detail-title">{task.title}</h2>
            <div className="fy-detail-meta">
              <span className="fy-status blocked">
                <i /> Needs input
              </span>
              <span data-i18n-ignore>{task.external?.cli ?? 'Charter Agent'}</span>
              <span className="mono" data-i18n-ignore>
                {task.state.toLowerCase().replaceAll('_', ' ')}
              </span>
            </div>
          </div>
        </div>
      </header>
      <div className="fy-detail-body">
        <div className="fy-grid">
          <div className="fy-column">
            <div className="fy-attention-banner" data-testid="fy-attention-banner">
              <span className="fy-mapping-mark warn">
                <Ic name="alert" size={14} />
              </span>
              <span>
                <strong>Charter is waiting for a decision</strong>
                <p>
                  {task.state === 'REVIEW_READY'
                    ? 'The work is complete and waiting for your review in the Session Room.'
                    : 'The Session paused on a question, plan, or permission that only you can answer.'}
                </p>
              </span>
            </div>
          </div>
          <aside className="fy-column">
            <section className="fy-card fy-launch">
              <div className="fy-launch-intro">
                <span className="fy-mapping-mark">
                  <Ic name="sessions" size={14} />
                </span>
                <span>
                  <strong>Answer in the Room</strong>
                  <p>The question, plan, or review lives in the Session with full context.</p>
                </span>
              </div>
              <div className="fy-launch-foot">
                <button
                  className="fy-start-button"
                  data-testid="fy-open-session"
                  onClick={() => {
                    void useTaskStore.getState().openTask(task.id);
                    useAppStore.getState().openTaskRoom(task.id);
                  }}
                >
                  <Ic name="sessions" size={13} /> Open Session
                </button>
                <button
                  className="fy-small-button fy-block fy-dismiss"
                  data-testid="fy-dismiss-attention"
                  onClick={() => {
                    useTaskStore.getState().dismissAttention(task.id);
                    void useForYouStore.getState().selectItem(null);
                  }}
                >
                  Dismiss from Attention
                </button>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ view */

export function ForYouView(): React.JSX.Element {
  const selection = useForYouStore((state) => state.selection);
  const detail = useForYouStore((state) => state.detail);
  const tasks = useTaskStore((state) => state.tasks);
  const snapshot = useWorkItemStore((state) => state.snapshot);
  const initWorkItems = useWorkItemStore((state) => state.init);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => initWorkItems(), [initWorkItems]);
  useEffect(() => {
    const refreshSelectedExecution = (): void => {
      const state = useForYouStore.getState();
      if (state.selection?.kind === 'item') void state.refreshDetail();
    };
    const disposers = [
      onEvent('workItem.changed', ({ itemId }) => {
        const state = useForYouStore.getState();
        if (itemId && state.selection?.kind === 'item' && state.selection.id === itemId) {
          void state.refreshDetail();
        }
      }),
      onEvent('task.stateChanged', refreshSelectedExecution),
      onEvent('task.deleted', refreshSelectedExecution),
      onEvent('mission.changed', refreshSelectedExecution),
      onEvent('terminal.exit', refreshSelectedExecution),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, []);

  useEffect(() => {
    setDeleteOpen(false);
    setDeleting(false);
  }, [selection?.kind, selection?.id]);

  const selectedTask =
    selection?.kind === 'task' ? (tasks.find((task) => task.id === selection.id) ?? null) : null;
  const category =
    detail && selection?.kind === 'item'
      ? (snapshot.columns.find((column) => column.id === detail.item.columnId)?.category ?? 'inbox')
      : null;

  return (
    <main className="fy-surface" data-testid="foryou-view">
      {selectedTask ? (
        <AttentionDetail task={selectedTask} />
      ) : detail && selection?.kind === 'item' ? (
        <>
          <DetailHeader
            item={detail.item}
            onDelete={() => setDeleteOpen(true)}
            secondary={
              category === 'review' && primarySession(detail.executions) ? (
                <button
                  className="fy-small-button"
                  onClick={() => {
                    const session = primarySession(detail.executions);
                    if (session) void openExecution(session);
                  }}
                >
                  <Ic name="sessions" size={12} /> Session
                </button>
              ) : null
            }
          />
          <div className="fy-detail-body">
            {category === 'review' ? (
              <ReviewDetail detail={detail} />
            ) : (
              <div className="fy-grid">
                <div className="fy-column">
                  <IssueContextCard item={detail.item} />
                  {isExternalItem(detail.item) ? <CarriedContextCard item={detail.item} /> : null}
                  <DiscussionCard item={detail.item} />
                </div>
                <aside className="fy-column">
                  {detail.executions.length ? (
                    <RunningCard item={detail.item} executions={detail.executions} />
                  ) : (
                    <LaunchCard item={detail.item} />
                  )}
                </aside>
              </div>
            )}
          </div>
          {deleteOpen ? (
            <DeleteIssueDialog
              detail={detail}
              busy={deleting}
              onClose={() => !deleting && setDeleteOpen(false)}
              onConfirm={() => {
                if (deleting) return;
                setDeleting(true);
                void useWorkItemStore
                  .getState()
                  .archive(detail.item.id, true, detail.item.version)
                  .then(async (deleted) => {
                    if (!deleted) {
                      setDeleting(false);
                      return;
                    }
                    await useForYouStore.getState().selectItem(null);
                    setDeleteOpen(false);
                    setDeleting(false);
                    useAppStore
                      .getState()
                      .pushToast('success', 'Imported issue deleted from Work.');
                  });
              }}
            />
          ) : null}
        </>
      ) : (
        <div className="fy-empty">
          <div>
            <Ic name="inbox" size={22} />
            <strong>Select a work item</strong>
            <p>Choose an item from the queue to inspect it, or import a GitHub issue.</p>
          </div>
        </div>
      )}
    </main>
  );
}
