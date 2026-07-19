import type { AgentMode } from '@pi-ide/agent-contract';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto, VerificationCommand } from '@pi-ide/ipc-contracts';
import { onEvent, pathForDroppedFile, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTaskStore, titleFromIntent, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore } from '../store/activityStore.js';
import { Ic, ProviderMark } from './home-icons.js';
import { MODE_META, type ThinkingLevelId, presentedMeta } from './labels.js';
import { ModelEffortControl } from './ui.js';
import { readDragRef } from './dragRefs.js';
import { useSkillSlash } from './SkillSlashPicker.js';
import { useTerminalStore } from './TerminalPanel.js';

const MAX_CONVERSATION_REFS = 3;

interface SelectedConversationRef {
  taskId: string;
  title: string;
  projectName: string;
}

type ReferencePickerItem = { kind: 'conversation'; task: TaskDto } | { kind: 'file'; path: string };
type ComposerAgent = 'pi' | 'claude' | 'codex';

function parseCustomCommand(raw: string): VerificationCommand | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return null;
  return {
    label: raw.trim(),
    executable: parts[0],
    args: parts.slice(1),
    cwd: '',
    timeoutMs: 300000,
  };
}

/**
 * Launcher (PIVOT-011..015, PIVOT-028): the content page of the persistent
 * shell — serif hero, composer (dispatch target = selected project), Advanced
 * charter. Global session state and attention live in the persistent rail.
 */
export function HomeView(): React.JSX.Element {
  const app = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const taskStore = useTaskStore();

  const [intent, setIntent] = useState('');
  const [agent, setAgent] = useState<ComposerAgent>('pi');
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  // Settings → Agent → default mode seeds the composer (it loads before mount).
  const [mode, setMode] = useState<AgentMode>(
    () => useAppStore.getState().settings?.agent.defaultMode ?? 'edit',
  );
  const [modelKey, setModelKey] = useState('');
  // Reasoning effort for this task; seeded from Settings → Models.
  const [thinking, setThinking] = useState<ThinkingLevelId>(
    () => useAppStore.getState().settings?.models.defaultThinkingLevel ?? 'medium',
  );
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  const [conversationRefs, setConversationRefs] = useState<SelectedConversationRef[]>([]);
  // Advanced charter (PIVOT-012)
  const [advanced, setAdvanced] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [boundaries, setBoundaries] = useState('');
  const [criteria, setCriteria] = useState('');
  const [suggestions, setSuggestions] = useState<VerificationCommand[]>([]);
  const [selectedVerif, setSelectedVerif] = useState<Set<string>>(new Set());
  const [customVerif, setCustomVerif] = useState<VerificationCommand[]>([]);
  const [customDraft, setCustomDraft] = useState('');
  // ADR-0009: worktree isolation for same-project parallel tasks.
  const [worktree, setWorktree] = useState(false);
  const [worktreeTouched, setWorktreeTouched] = useState(false);
  // ADR-0009 am.2: optional setup command for the fresh worktree (deps etc.).
  const [wtSetup, setWtSetup] = useState('');
  const [wtSetupTouched, setWtSetupTouched] = useState(false);
  // Codex-style @ picker: project files + existing task conversations.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerFiles, setPickerFiles] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const workspace = workspaceStore.workspace;

  // "/" in the empty composer → enabled-skills picker (ADR-0015).
  const slash = useSkillSlash({
    value: intent,
    setValue: setIntent,
    testid: 'home',
    focus: () => inputRef.current?.focus(),
  });

  useEffect(() => {
    taskStore.init();
    useActivityStore.getState().init();
    void taskStore.refreshModels();
    void taskStore.refreshTasks();
    void rpcResult('workspace.recent', {}).then((res) => {
      if (res.ok) setRecent(res.data.items);
    });
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sidebar "New task" (and friends) ask the composer to take focus.
  const composerFocusSeq = useAppStore((s) => s.composerFocusSeq);
  useEffect(() => {
    if (composerFocusSeq > 0) inputRef.current?.focus();
  }, [composerFocusSeq]);

  // Selected project = dispatch target: show its branch in the chip.
  useEffect(() => {
    setBranch(null);
    if (!workspace) return;
    void rpcResult('git.status', {}).then((res) => {
      if (res.ok && res.data.isRepo) setBranch(res.data.branch);
    });
    void rpcResult('workspace.recent', {}).then((res) => {
      if (res.ok) setRecent(res.data.items);
    });
  }, [workspace]);

  // Verification suggestions for the Advanced charter.
  useEffect(() => {
    if (!advanced || !workspace) return;
    void rpcResult('task.suggestVerifications', {}).then((res) => {
      if (res.ok) setSuggestions(res.data.suggestions);
    });
  }, [advanced, workspace]);

  // Worktree setup suggestion (lockfile detection) seeds the field per project.
  useEffect(() => {
    setWtSetupTouched(false);
    setWtSetup('');
    if (!workspace?.isGitRepo) return;
    void rpcResult('task.suggestWorktreeSetup', {}).then((res) => {
      if (res.ok && res.data.command) {
        setWtSetup((current) => (current ? current : res.data.command!));
      }
    });
  }, [workspace]);

  // ADR-0009: same-project parallelism defaults the worktree toggle ON.
  const projectBusy = useMemo(
    () =>
      taskStore.tasks.some(
        (t) =>
          t.projectPath === workspace?.path &&
          (RUNNING_TASK_STATES.has(t.state) ||
            t.state === 'AWAITING_PLAN_APPROVAL' ||
            t.state === 'READY'),
      ),
    [taskStore.tasks, workspace],
  );
  useEffect(() => {
    if (!worktreeTouched) setWorktree(projectBusy && Boolean(workspace?.isGitRepo));
  }, [projectBusy, workspace, worktreeTouched]);

  const configuredModels = useMemo(
    () => taskStore.models.filter((m) => m.configured),
    [taskStore.models],
  );
  useEffect(() => {
    if (!modelKey && configuredModels.length > 0) {
      const preferred =
        configuredModels.find(
          (m) =>
            m.providerId === app.settings?.models.defaultProviderId &&
            m.modelId === app.settings?.models.defaultModelId,
        ) ?? configuredModels[0]!;
      setModelKey(`${preferred.providerId}::${preferred.modelId}`);
    }
  }, [configuredModels, modelKey, app.settings]);

  // Effort × model linkage lives inside ModelEffortControl now (it clamps the
  // effort to the selected model's supported levels).

  // Refs queued elsewhere (e.g. "attach annotated image", PIVOT-020).
  const pendingRefs = useAppStore((s) => s.pendingRefs);
  useEffect(() => {
    if (pendingRefs.length === 0) return;
    addRefs(app.consumePendingRefs());
    inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRefs.length]);

  // Dropdowns close on any outside interaction (they overlay the composer).
  useEffect(() => {
    if (!projectMenuOpen && !pickerOpen && !agentMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        !target.closest('.hm-menu') &&
        !target.closest('.hm-agent-picker-wrap') &&
        !target.closest('[data-testid="home-project"]') &&
        !target.closest('[data-testid="home-attach"]')
      ) {
        setProjectMenuOpen(false);
        setPickerOpen(false);
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [projectMenuOpen, pickerOpen, agentMenuOpen]);

  const addRefs = useCallback(
    (rels: string[]) => {
      setRefs((prev) => [...new Set([...prev, ...rels])].slice(0, 20));
    },
    [setRefs],
  );

  const submit = async (): Promise<void> => {
    if (!intent.trim() || submitting) return;
    if (!workspace) {
      app.pushToast('warning', 'Choose a project first.');
      setProjectMenuOpen(true);
      return;
    }
    let goal = intent.trim();
    if (advanced && boundaries.trim()) goal += `\n\nConstraints:\n${boundaries.trim()}`;
    if (refs.length > 0) goal += `\n\nContext files:\n${refs.map((r) => `- @${r}`).join('\n')}`;
    const acceptance = advanced
      ? criteria
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
    const verification = advanced
      ? [...suggestions.filter((s) => selectedVerif.has(s.label)), ...customVerif]
      : [];

    // Claude and Codex are execution backends inside the same Composer. Their
    // native PTY is still preserved, but it is no longer a separate creation
    // doorway in the global rail.
    if (agent !== 'pi') {
      setSubmitting(true);
      useTerminalStore.getState().init();
      // The first message rides the create call: the host delivers it once the
      // CLI's TUI is actually ready and presses Enter itself; a blind timed
      // write from here raced the TUI startup and left the text unsent.
      const id = await useTerminalStore.getState().create({
        launch: agent,
        context: { kind: 'focused' },
        title: titleFromIntent(intent),
        reveal: false,
        initialPrompt: goal,
      });
      if (id) {
        app.openTerminalSession(id);
        setIntent('');
        setRefs([]);
        setConversationRefs([]);
      }
      setSubmitting(false);
      return;
    }

    const [providerId, modelId] = modelKey.split('::');
    if (!providerId || !modelId) {
      app.pushToast('warning', 'No model available — add a provider key in Settings.');
      return;
    }

    setSubmitting(true);
    const ok = await taskStore.createAndStart({
      title: (advanced && titleDraft.trim()) || titleFromIntent(intent),
      goalMd: goal,
      acceptance,
      mode,
      model: { providerId, modelId, thinkingLevel: thinking },
      verification,
      // ADR-0009: explicit dispatch target + optional worktree isolation.
      projectPath: workspace.path,
      isolation: advanced && worktree && workspace.isGitRepo ? 'worktree' : 'none',
      ...(advanced && worktree && workspace.isGitRepo && wtSetup.trim()
        ? { worktreeSetup: wtSetup.trim() }
        : {}),
      conversationRefTaskIds: conversationRefs.map((ref) => ref.taskId),
    });
    setSubmitting(false);
    if (ok) {
      setIntent('');
      setRefs([]);
      setConversationRefs([]);
      setTitleDraft('');
      setBoundaries('');
      setCriteria('');
      setSelectedVerif(new Set());
      setCustomVerif([]);
      setWorktreeTouched(false);
      setWtSetupTouched(false);
      // Stay on the Home surface (PIVOT-022): open the new task's room.
      const newId = useTaskStore.getState().activeTaskId;
      if (newId) app.openTaskRoom(newId);
    }
  };

  // ---------- drag & drop context feeding ----------

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDropActive(false);
    if (!workspace) {
      app.pushToast('warning', 'Choose a project before attaching files.');
      return;
    }
    // Sidebar tree drag: the payload is already workspace-relative.
    const rel = readDragRef(e);
    if (rel) {
      addRefs([rel]);
      inputRef.current?.focus();
      return;
    }
    const files = [...e.dataTransfer.files];
    const paths = files
      .map((f) => pathForDroppedFile(f))
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (paths.length === 0) return;
    const res = await rpcResult('workspace.relativize', { paths: paths.slice(0, 50) });
    if (!res.ok) {
      app.pushToast('error', res.error.userMessage);
      return;
    }
    if (res.data.inside.length > 0) addRefs(res.data.inside.map((i) => i.rel));
    if (res.data.outside.length > 0) {
      app.pushToast(
        'warning',
        `${res.data.outside.length} item(s) are outside the project and were skipped.`,
      );
    }
  };

  // ---------- @ file picker ----------

  const openPicker = (): void => {
    if (!workspace) {
      app.pushToast('warning', 'Choose a project first.');
      return;
    }
    setPickerOpen(true);
    setPickerQuery('');
    setPickerFiles([]);
    setPickerIndex(0);
    setTimeout(() => pickerInputRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const handle = setTimeout(() => {
      void rpcResult('search.files', { query: pickerQuery }).then((res) => {
        if (res.ok) {
          setPickerFiles(res.data.items.slice(0, 8).map((i) => i.path));
          setPickerIndex(0);
        }
      });
    }, 80);
    return () => clearTimeout(handle);
  }, [pickerOpen, pickerQuery]);

  const pickFile = (path: string): void => {
    addRefs([path]);
    setPickerOpen(false);
    inputRef.current?.focus();
  };

  const pickConversation = (task: TaskDto): void => {
    if (conversationRefs.some((ref) => ref.taskId === task.id)) {
      setPickerOpen(false);
      inputRef.current?.focus();
      return;
    }
    if (conversationRefs.length >= MAX_CONVERSATION_REFS) {
      app.pushToast('warning', 'You can reference up to 3 conversations.');
      return;
    }
    setConversationRefs((current) => [
      ...current,
      { taskId: task.id, title: task.title, projectName: task.projectName },
    ]);
    setPickerOpen(false);
    inputRef.current?.focus();
  };

  const pickerConversations = useMemo(() => {
    const query = pickerQuery.trim().toLocaleLowerCase();
    return taskStore.tasks
      .filter((task) => !task.external && task.state !== 'READY')
      .filter(
        (task) =>
          !query ||
          task.title.toLocaleLowerCase().includes(query) ||
          task.projectName.toLocaleLowerCase().includes(query),
      )
      .slice(0, 6);
  }, [pickerQuery, taskStore.tasks]);

  const pickerItems = useMemo<ReferencePickerItem[]>(
    () => [
      ...pickerConversations.map((task) => ({ kind: 'conversation' as const, task })),
      ...pickerFiles.map((path) => ({ kind: 'file' as const, path })),
    ],
    [pickerConversations, pickerFiles],
  );

  useEffect(() => {
    setPickerIndex((current) => Math.min(current, Math.max(0, pickerItems.length - 1)));
  }, [pickerItems.length]);

  const pickReference = (item: ReferencePickerItem): void => {
    if (item.kind === 'conversation') pickConversation(item.task);
    else pickFile(item.path);
  };

  const activeModeHint = MODE_META.find((m) => m.id === mode)?.hint;

  return (
    <main className="hm-main" data-testid="home-view">
      <div className="hm-main-top" />

      <div className="hm-hero">
        <h1>What should we build?</h1>
        <div className="hm-sub">
          Describe the outcome — plans, diffs and verification all wait for your OK.
        </div>
      </div>

      <div className="hm-composer">
        <div
          className={`hm-card ${dropActive ? 'drop' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={(e) => void onDrop(e)}
        >
          <div className="hm-chiprow">
            <button
              className="hm-chip"
              data-testid="home-project"
              onClick={() => setProjectMenuOpen(!projectMenuOpen)}
            >
              <Ic name="folder" size={14} />
              <span>{workspace ? workspace.displayName : 'Select a project'}</span>
              {workspace && branch ? (
                <>
                  <span className="hm-sep">·</span>
                  <Ic name="branch" size={13} />
                  <span>{branch}</span>
                </>
              ) : null}
              <Ic name="chevron" size={13} />
            </button>
            {refs.map((r) => (
              <span key={r} className="hm-refchip" data-testid={`home-ref-${r}`}>
                <Ic name={r.endsWith('/') ? 'folder' : 'file'} size={11} />
                <span>{r}</span>
                <button
                  aria-label={`Remove ${r}`}
                  onClick={() => setRefs(refs.filter((x) => x !== r))}
                >
                  <Ic name="x" size={11} />
                </button>
              </span>
            ))}
            {conversationRefs.map((ref) => (
              <span
                key={ref.taskId}
                className="hm-refchip conversation"
                data-testid={`home-conversation-ref-${ref.taskId}`}
                title={`${ref.title} · ${ref.projectName}`}
              >
                <Ic name="bot" size={12} />
                <span>{ref.title}</span>
                <button
                  aria-label={`Remove conversation ${ref.title}`}
                  onClick={() =>
                    setConversationRefs((current) =>
                      current.filter((item) => item.taskId !== ref.taskId),
                    )
                  }
                >
                  <Ic name="x" size={11} />
                </button>
              </span>
            ))}

            {projectMenuOpen ? (
              <div className="hm-menu" data-testid="home-project-menu">
                {recent.map((r) => (
                  <button
                    key={r.path}
                    className="hm-row"
                    data-testid={`home-menu-recent-${r.path}`}
                    onClick={() => {
                      setProjectMenuOpen(false);
                      app.setHomePick(true);
                      void workspaceStore.openPath(r.path);
                    }}
                  >
                    <Ic name="folder" />
                    <span className="hm-tt">
                      {r.displayName}
                      <span className="hm-mono">{r.path}</span>
                    </span>
                    {r.kind ? <span className="hm-kind">{r.kind}</span> : null}
                  </button>
                ))}
                <button
                  className="hm-row"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    app.setHomePick(true);
                    void workspaceStore.openViaDialog();
                  }}
                >
                  <Ic name="folder" />
                  <span className="hm-tt">Open Folder…</span>
                </button>
                <button
                  className="hm-row"
                  data-testid="home-menu-new-project"
                  onClick={() => {
                    setProjectMenuOpen(false);
                    app.setNewProjectOpen(true);
                  }}
                >
                  <Ic name="plus" />
                  <span className="hm-tt">New Project…</span>
                </button>
              </div>
            ) : null}

            {pickerOpen ? (
              <div
                className="hm-menu hm-reference-menu"
                data-testid="home-file-picker"
                role="listbox"
                aria-label="Reference files or conversations"
              >
                <input
                  ref={pickerInputRef}
                  data-testid="home-file-input"
                  placeholder="Search files and conversations…"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setPickerOpen(false);
                      inputRef.current?.focus();
                    } else if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setPickerIndex(
                        Math.min(pickerIndex + 1, Math.max(0, pickerItems.length - 1)),
                      );
                    } else if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setPickerIndex(Math.max(pickerIndex - 1, 0));
                    } else if (e.key === 'Enter' && pickerItems[pickerIndex]) {
                      e.preventDefault();
                      pickReference(pickerItems[pickerIndex]!);
                    }
                  }}
                />
                {pickerConversations.length > 0 ? (
                  <>
                    <div className="hm-sec hm-ref-section">
                      <span>CONVERSATIONS</span>
                      <span>{conversationRefs.length}/3 referenced</span>
                    </div>
                    {pickerConversations.map((task, i) => {
                      const selected = conversationRefs.some((ref) => ref.taskId === task.id);
                      return (
                        <button
                          key={task.id}
                          className={`hm-row hm-conversation-row ${i === pickerIndex ? 'active' : ''}`}
                          data-testid={`home-conversation-item-${task.id}`}
                          role="option"
                          aria-selected={selected}
                          onClick={() => pickConversation(task)}
                        >
                          <Ic name="bot" size={13} />
                          <span className="hm-tt">
                            {task.title}
                            <span className="hm-mono">
                              {task.projectName} · {presentedMeta(task).short}
                            </span>
                          </span>
                          {selected ? <Ic name="check" size={13} className="hm-check" /> : null}
                        </button>
                      );
                    })}
                  </>
                ) : null}
                {pickerFiles.length > 0 ? <div className="hm-sec hm-ref-section">FILES</div> : null}
                {pickerFiles.map((path, fileIndex) => {
                  const i = pickerConversations.length + fileIndex;
                  return (
                    <button
                      key={path}
                      className={`hm-row ${i === pickerIndex ? 'active' : ''}`}
                      data-testid={`home-file-item-${path}`}
                      role="option"
                      aria-selected={refs.includes(path)}
                      onClick={() => pickFile(path)}
                    >
                      <Ic name="file" size={13} />
                      <span className="hm-tt">{path}</span>
                      {refs.includes(path) ? (
                        <Ic name="check" size={13} className="hm-check" />
                      ) : null}
                    </button>
                  );
                })}
                {pickerItems.length === 0 ? (
                  <div className="hm-reference-empty">
                    No matching files or completed conversations.
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <textarea
            ref={inputRef}
            className="hm-ta"
            data-testid="home-intent"
            value={intent}
            placeholder="Describe an outcome, ask a question, or paste an error…"
            rows={2}
            onChange={(e) => {
              setIntent(e.target.value);
              slash.handleChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (slash.handleKeyDown(e)) {
                e.preventDefault();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              } else if (e.key === '@' && workspace) {
                e.preventDefault();
                openPicker();
              }
            }}
          />
          {slash.menu}

          {advanced && agent === 'pi' ? (
            <div className="hm-adv" data-testid="home-advanced">
              <div className="hm-field">
                <label>Title (optional — defaults to the first line)</label>
                <input
                  data-testid="home-adv-title"
                  placeholder="e.g. Add rate limiting to the login API"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                />
              </div>
              <div className="hm-field">
                <label>Boundaries</label>
                <input
                  data-testid="home-adv-boundaries"
                  placeholder="e.g. Only touch src/auth/** — don't change public API signatures"
                  value={boundaries}
                  onChange={(e) => setBoundaries(e.target.value)}
                />
              </div>
              <div className="hm-field">
                <label>Success criteria (one per line)</label>
                <textarea
                  data-testid="home-adv-criteria"
                  rows={2}
                  placeholder={
                    '429 after 5 failed attempts within a minute\nexisting tests stay green'
                  }
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                />
              </div>
              <div className="hm-field">
                <label>Verification</label>
                <div className="hm-vchips">
                  {suggestions.map((s) => (
                    <button
                      key={s.label}
                      className={`hm-vchip ${selectedVerif.has(s.label) ? 'on' : ''}`}
                      data-testid={`home-verif-${s.label}`}
                      onClick={() => {
                        const next = new Set(selectedVerif);
                        if (next.has(s.label)) next.delete(s.label);
                        else next.add(s.label);
                        setSelectedVerif(next);
                      }}
                    >
                      {selectedVerif.has(s.label) ? (
                        <Ic name="check" size={12} strokeWidth={2} />
                      ) : null}
                      {s.label}
                    </button>
                  ))}
                  {customVerif.map((c) => (
                    <button
                      key={c.label}
                      className="hm-vchip on"
                      title="Remove"
                      onClick={() => setCustomVerif(customVerif.filter((x) => x.label !== c.label))}
                    >
                      <Ic name="check" size={12} strokeWidth={2} />
                      {c.label}
                    </button>
                  ))}
                  <input
                    className="hm-vchip-add"
                    data-testid="home-verif-custom"
                    placeholder="+ custom command (⏎)"
                    value={customDraft}
                    onChange={(e) => setCustomDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const cmd = parseCustomCommand(customDraft);
                        if (cmd && !customVerif.some((c) => c.label === cmd.label)) {
                          setCustomVerif([...customVerif, cmd]);
                          setCustomDraft('');
                        }
                      }
                    }}
                  />
                </div>
              </div>
              {workspace ? (
                <div className="hm-field">
                  <label
                    className="hm-wtrow"
                    title={
                      workspace.isGitRepo
                        ? 'The task runs on its own branch in a separate checkout; accepting merges it back'
                        : 'Worktree isolation needs a git repository with at least one commit'
                    }
                  >
                    <input
                      type="checkbox"
                      data-testid="home-adv-worktree"
                      checked={workspace.isGitRepo ? worktree : false}
                      disabled={!workspace.isGitRepo}
                      onChange={(e) => {
                        setWorktree(e.target.checked);
                        setWorktreeTouched(true);
                      }}
                    />
                    <span>
                      Run in an isolated worktree
                      {!workspace.isGitRepo ? (
                        <span className="hm-wt-hint">
                          {' '}
                          — needs a git repository (this project has none)
                        </span>
                      ) : projectBusy ? (
                        <span className="hm-wt-hint">
                          {' '}
                          — recommended: this project already has an active task
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {workspace.isGitRepo && worktree ? (
                    <div className="hm-field" style={{ marginTop: 6 }}>
                      <label>
                        Worktree setup command — runs once in the fresh checkout before the agent
                        starts (a new worktree has no installed dependencies)
                      </label>
                      <input
                        data-testid="home-adv-wtsetup"
                        className="mono"
                        placeholder="e.g. npm ci — leave empty to skip"
                        value={wtSetup}
                        onChange={(e) => {
                          setWtSetup(e.target.value);
                          setWtSetupTouched(true);
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="hm-btmrow">
            <button
              className="hm-iconbtn"
              title="Reference files or conversations (or drop files here)"
              data-testid="home-attach"
              onClick={openPicker}
            >
              <Ic name="at" size={15} />
            </button>
            <div className="hm-agent-picker-wrap">
              <button
                type="button"
                className="hm-agent-picker"
                data-testid="home-agent"
                aria-haspopup="menu"
                aria-expanded={agentMenuOpen}
                title="Choose the Agent backend for this Session"
                onClick={() => setAgentMenuOpen(!agentMenuOpen)}
              >
                <ProviderMark provider={agent} size={15} />
                <span>{agent === 'pi' ? 'Charter' : agent === 'claude' ? 'Claude' : 'Codex'}</span>
                <Ic name="chevron" size={11} />
              </button>
              {agentMenuOpen ? (
                <div className="hm-agent-menu" data-testid="home-agent-menu" role="menu">
                  {(
                    [
                      ['pi', 'Charter Agent', 'Plans, permissions, tools and evidence ledger'],
                      [
                        'claude',
                        'Claude Code',
                        'Native CLI, preserved inside the same Session shell',
                      ],
                      ['codex', 'Codex', 'Native CLI, preserved inside the same Session shell'],
                    ] as const
                  ).map(([id, label, detail]) => (
                    <button
                      key={id}
                      type="button"
                      className={agent === id ? 'active' : ''}
                      role="menuitemradio"
                      aria-checked={agent === id}
                      data-testid={`home-agent-${id}`}
                      onClick={() => {
                        setAgent(id);
                        setAgentMenuOpen(false);
                      }}
                    >
                      <ProviderMark provider={id} size={18} />
                      <span>
                        <strong>{label}</strong>
                        <small>{detail}</small>
                      </span>
                      {agent === id ? <Ic name="check" size={12} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {agent === 'pi' ? (
              <div
                className="hm-seg"
                data-testid="home-mode"
                data-mode={mode}
                role="radiogroup"
                aria-label="Trust level"
                title={activeModeHint}
              >
                {MODE_META.map((m) => (
                  <button
                    key={m.id}
                    className={`${mode === m.id ? 'on' : ''} ${m.danger ? 'danger' : ''}`}
                    data-testid={`home-mode-${m.id}`}
                    role="radio"
                    aria-checked={mode === m.id}
                    title={`${m.label} — ${m.hint}`}
                    onClick={() => setMode(m.id)}
                  >
                    {m.seg}
                  </button>
                ))}
              </div>
            ) : (
              <span className="hm-native-chip">
                <Ic name="terminal" size={12} /> Native CLI permissions
              </span>
            )}
            <button
              className="hm-chip lite"
              data-testid="home-advanced-toggle"
              disabled={agent !== 'pi'}
              title={
                agent === 'pi'
                  ? 'Show Session charter options'
                  : 'Advanced charter options apply to managed Charter Agents'
              }
              onClick={() => setAdvanced(!advanced)}
            >
              {advanced ? 'Simple' : 'Advanced'}
            </button>
            <span className="hm-spacer" />
            {agent === 'pi' ? (
              <ModelEffortControl
                models={configuredModels}
                modelKey={modelKey}
                onModelKey={setModelKey}
                thinking={thinking}
                onThinking={setThinking}
                onConfigureModels={() => app.openSettings('models')}
                testid="home"
              />
            ) : null}
            <button
              className={`hm-send ${intent.trim() && !submitting && (agent !== 'pi' || modelKey) ? 'ready' : ''}`}
              data-testid="home-submit"
              disabled={!intent.trim() || submitting || (agent === 'pi' && !modelKey)}
              aria-label={
                agent === 'pi' && !modelKey
                  ? 'Configure a model before starting a Session'
                  : 'Start Session'
              }
              title={
                agent === 'pi' && !modelKey
                  ? 'Configure a model before starting a Session'
                  : 'Start Session'
              }
              onClick={() => void submit()}
            >
              <Ic name="arrowUp" size={15} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div
          className={`hm-hint ${agent === 'pi' && mode === 'full' ? 'danger' : ''}`}
          data-testid="home-mode-hint"
        >
          {agent === 'pi' ? (
            <>
              <b>{MODE_META.find((m) => m.id === mode)?.label}</b> — {activeModeHint}.
            </>
          ) : (
            <>
              <b>{agent === 'claude' ? 'Claude Code' : 'Codex'}</b> — opens a preserved native
              session in this project.
            </>
          )}{' '}
          ⏎ to start · ⇧⏎ new line.
        </div>
      </div>
    </main>
  );
}

/** Notification click → the task's room (PIVOT-014/021); registered once. */
export function registerHomeSurfaceListeners(): void {
  onEvent('app.focusTask', ({ taskId }) => {
    void useTaskStore.getState().openTask(taskId);
    useAppStore.getState().revealTaskSession(taskId);
  });
  useActivityStore.getState().init();
}
