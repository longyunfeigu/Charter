import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RecentWorkspaceDto, TaskDto, VerificationCommandSchema } from '@pi-ide/ipc-contracts';
import type { z } from 'zod';
import { onEvent, pathForDroppedFile, rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useTaskStore, titleFromIntent, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useActivityStore, currentActionLine } from '../store/activityStore.js';
import { useGlowTasks } from './useGlow.js';
import { Ic } from './home-icons.js';
import { MODE_META, stateShort, stateTone } from './labels.js';
import { LiveBoard } from './LiveBoard.js';
import { FileLens } from './FileLens.js';
import '../styles/home.css';

type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

const ATTENTION_STATES = [
  'AWAITING_PERMISSION',
  'AWAITING_PLAN_APPROVAL',
  'REVIEW_READY',
  'INTERRUPTED',
  'FAILED',
];

/** Sidebar dot class from the shared tone (PIVOT-023). */
function dotClass(state: string): string {
  const tone = stateTone(state);
  return tone === 'idle' ? 'done' : tone;
}

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
 * Home surface v2 (PIVOT-011..015): Codex-style launcher — sidebar with
 * projects (selected project = working directory) and live tasks; composer
 * with inline approval/model, Advanced charter fields, drag/@ context feeding;
 * mission control cards under the composer.
 */
export function HomeView(): React.JSX.Element {
  const app = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const taskStore = useTaskStore();
  const perTask = useActivityStore((s) => s.perTask);
  const hydrate = useActivityStore((s) => s.hydrate);
  // PIVOT-016: fresh agent writes make their task rows/cards glow.
  const glowTasks = useGlowTasks();

  const [intent, setIntent] = useState('');
  const [mode, setMode] = useState<'ask' | 'edit' | 'auto'>('edit');
  const [modelKey, setModelKey] = useState('');
  const [recent, setRecent] = useState<RecentWorkspaceDto[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [refs, setRefs] = useState<string[]>([]);
  // Advanced charter (PIVOT-012)
  const [advanced, setAdvanced] = useState(false);
  const [boundaries, setBoundaries] = useState('');
  const [criteria, setCriteria] = useState('');
  const [suggestions, setSuggestions] = useState<VerificationCommand[]>([]);
  const [selectedVerif, setSelectedVerif] = useState<Set<string>>(new Set());
  const [customVerif, setCustomVerif] = useState<VerificationCommand[]>([]);
  const [customDraft, setCustomDraft] = useState('');
  // @ file picker (PIVOT-015)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickerItems, setPickerItems] = useState<string[]>([]);
  const [pickerIndex, setPickerIndex] = useState(0);
  // Live Board lens (PIVOT-025): read-only diff-so-far for one file.
  const [lens, setLens] = useState<{ taskId: string; path: string } | null>(null);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const workspace = workspaceStore.workspace;

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

  // Selected project = working directory: show its branch in the chip.
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

  // Mission control hydration for tasks that were already running/waiting.
  useEffect(() => {
    for (const t of taskStore.tasks) {
      if (RUNNING_TASK_STATES.has(t.state) || ATTENTION_STATES.includes(t.state)) {
        void hydrate(t.id);
      }
    }
  }, [taskStore.tasks, hydrate]);

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
    if (!projectMenuOpen && !pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        !target.closest('.hm-menu') &&
        !target.closest('[data-testid="home-project"]') &&
        !target.closest('[data-testid="home-attach"]')
      ) {
        setProjectMenuOpen(false);
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [projectMenuOpen, pickerOpen]);

  // ADR-0008 (PIVOT-021/022): tasks open in their Task Room — never the Editor.
  const openTask = useCallback(
    (taskId: string, options: { review?: boolean } = {}) => {
      void taskStore.openTask(taskId).then(() => {
        if (options.review) void taskStore.openReview();
      });
      app.openTaskRoom(taskId);
    },
    [taskStore, app],
  );

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
    const [providerId, modelId] = modelKey.split('::');
    if (!providerId || !modelId) {
      app.pushToast('warning', 'No model available — add a provider key in Settings.');
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

    setSubmitting(true);
    const ok = await taskStore.createAndStart({
      title: titleFromIntent(intent),
      goalMd: goal,
      acceptance,
      mode,
      model: { providerId, modelId },
      verification,
    });
    setSubmitting(false);
    if (ok) {
      setIntent('');
      setRefs([]);
      setBoundaries('');
      setCriteria('');
      setSelectedVerif(new Set());
      setCustomVerif([]);
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
    setPickerItems([]);
    setPickerIndex(0);
    setTimeout(() => pickerInputRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!pickerOpen) return;
    const handle = setTimeout(() => {
      void rpcResult('search.files', { query: pickerQuery }).then((res) => {
        if (res.ok) {
          setPickerItems(res.data.items.slice(0, 12).map((i) => i.path));
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

  // ---------- mission control ----------

  const needsYou = taskStore.tasks
    .filter((t) => ATTENTION_STATES.includes(t.state))
    .sort((a, b) => ATTENTION_STATES.indexOf(a.state) - ATTENTION_STATES.indexOf(b.state))
    .slice(0, 5);
  const running = taskStore.tasks
    .filter((t) => RUNNING_TASK_STATES.has(t.state) && t.state !== 'AWAITING_PERMISSION')
    .slice(0, 5);
  const recentTasks = taskStore.tasks.slice(0, 8);
  const reviewCount = taskStore.tasks.filter((t) => t.state === 'REVIEW_READY').length;

  const mcCard = (t: TaskDto): React.JSX.Element => {
    const attention = ATTENTION_STATES.includes(t.state);
    const activity = perTask[t.id];
    const action = currentActionLine(activity);
    const chip = (
      <span
        className={`hm-stchip ${t.state === 'FAILED' ? 'err' : attention ? 'warn' : 'run'}`}
        data-state={t.state}
      >
        {attention ? stateShort(t.state) : 'Running'}
      </span>
    );
    const button =
      t.state === 'AWAITING_PLAN_APPROVAL'
        ? 'Review plan'
        : t.state === 'AWAITING_PERMISSION'
          ? 'Approve'
          : t.state === 'REVIEW_READY'
            ? 'Review'
            : t.state === 'INTERRUPTED'
              ? 'Recover'
              : t.state === 'FAILED'
                ? 'Open'
                : 'Watch';
    const meta: React.ReactNode[] = [];
    if (action) {
      meta.push(<span key="a">{action.label}</span>);
      if (action.status === 'running')
        meta.unshift(<span key="d" className="hm-dot run" style={{ margin: 0 }} />);
    } else {
      meta.push(<span key="s">{stateShort(t.state)}</span>);
    }
    const touched = activity?.filesTouched.length ?? 0;
    if (touched > 0)
      meta.push(
        <span key="f">
          {' '}
          · {touched} file{touched === 1 ? '' : 's'} touched
        </span>,
      );
    return (
      <button
        key={t.id}
        className={`hm-tcard ${attention ? 'attention' : ''} ${glowTasks.has(t.id) ? 'glow-pulse' : ''}`}
        data-testid={`home-mc-card-${t.id}`}
        onClick={() => openTask(t.id, { review: t.state === 'REVIEW_READY' })}
      >
        {chip}
        <span className="hm-tinfo">
          <span className="hm-ttitle" style={{ display: 'block' }}>
            {t.title}
          </span>
          <span className="hm-tmeta">{meta}</span>
        </span>
        <span className={`hm-act ${attention ? '' : 'ghost'}`}>{button}</span>
      </button>
    );
  };

  const activeModeHint = MODE_META.find((m) => m.id === mode)?.hint;

  return (
    <div className="hm-root" data-testid="home-view">
      {/* ---------- sidebar ---------- */}
      <aside className="hm-side">
        <div className="hm-side-drag" />
        <div className="hm-brand">
          <Ic name="flag" size={17} />
          <b>Charter</b>
          <span className="hm-sp" />
        </div>

        <button
          className="hm-nav-item"
          data-testid="home-new-task"
          onClick={() => {
            setAdvanced(true);
            inputRef.current?.focus();
          }}
        >
          <Ic name="pencil" />
          <span>New Task</span>
        </button>
        <button
          className="hm-nav-item"
          data-testid="home-reviews"
          onClick={() => {
            const next = taskStore.tasks.find((t) => t.state === 'REVIEW_READY');
            if (next) openTask(next.id, { review: true });
            else app.pushToast('info', 'Nothing is waiting for review.');
          }}
        >
          <Ic name="inbox" />
          <span>Reviews</span>
          {reviewCount > 0 ? <span className="hm-badge">{reviewCount}</span> : null}
        </button>

        <div className="hm-sec">Projects</div>
        {recent.slice(0, 6).map((r) => {
          const active = workspace?.path === r.path;
          return (
            <button
              key={r.path}
              className={`hm-row ${active ? 'active' : ''} ${active && glowTasks.size > 0 ? 'glow-pulse' : ''}`}
              data-testid={`home-recent-${r.path}`}
              title={r.path}
              onClick={() => {
                if (active) return;
                app.setHomePick(true);
                void workspaceStore.openPath(r.path);
              }}
            >
              <Ic name="folder" />
              <span className="hm-tt">{r.displayName}</span>
              {r.kind ? <span className="hm-kind">{r.kind}</span> : null}
              {active ? (
                <span className="hm-check">
                  <Ic name="check" size={14} strokeWidth={2} />
                </span>
              ) : null}
            </button>
          );
        })}
        <button
          className="hm-row"
          data-testid="home-open-folder"
          onClick={() => {
            app.setHomePick(true);
            void workspaceStore.openViaDialog();
          }}
        >
          <Ic name="plus" />
          <span className="hm-tt" style={{ color: 'var(--fg-muted)' }}>
            Open folder…
          </span>
        </button>

        {recentTasks.length > 0 ? <div className="hm-sec">Tasks</div> : null}
        {recentTasks.map((t) => (
          <button
            key={t.id}
            className={`hm-row ${glowTasks.has(t.id) ? 'glow-pulse' : ''}`}
            data-testid={`home-task-${t.id}`}
            title={`${t.title} — ${stateShort(t.state)}`}
            onClick={() => openTask(t.id)}
          >
            <span className={`hm-dot ${dotClass(t.state)}`} />
            <span className="hm-tt">{t.title}</span>
          </button>
        ))}

        <div className="hm-grow" />
        <div className="hm-side-bottom">
          <button
            className="hm-row"
            data-testid="home-open-ide"
            title="Open the full editor (file tree, terminal, git)"
            onClick={() => app.setSurface('workspace')}
          >
            <Ic name="layout" size={15} />
            <span>Editor</span>
            <span className="hm-kbd">⌘E</span>
          </button>
          <button
            className="hm-row"
            data-testid="home-settings"
            onClick={() => {
              app.setSurface('workspace');
              app.setOverlay('settings');
            }}
          >
            <Ic name="sliders" size={15} />
            <span>Settings</span>
          </button>
        </div>
      </aside>

      {/* ---------- main ---------- */}
      <main className="hm-main">
        <div className="hm-main-top" />

        <div className={`hm-hero ${needsYou.length > 0 || running.length > 0 ? 'compact' : ''}`}>
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
                  <Ic name="file" size={11} />
                  <span>{r}</span>
                  <button
                    aria-label={`Remove ${r}`}
                    onClick={() => setRefs(refs.filter((x) => x !== r))}
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
                    <Ic name="plus" />
                    <span className="hm-tt">Open Folder…</span>
                  </button>
                </div>
              ) : null}

              {pickerOpen ? (
                <div className="hm-menu" data-testid="home-file-picker">
                  <input
                    ref={pickerInputRef}
                    data-testid="home-file-input"
                    placeholder="Reference a project file…"
                    value={pickerQuery}
                    onChange={(e) => setPickerQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setPickerOpen(false);
                        inputRef.current?.focus();
                      } else if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setPickerIndex(Math.min(pickerIndex + 1, pickerItems.length - 1));
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setPickerIndex(Math.max(pickerIndex - 1, 0));
                      } else if (e.key === 'Enter' && pickerItems[pickerIndex]) {
                        e.preventDefault();
                        pickFile(pickerItems[pickerIndex]!);
                      }
                    }}
                  />
                  {pickerItems.map((path, i) => (
                    <button
                      key={path}
                      className={`hm-row ${i === pickerIndex ? 'active' : ''}`}
                      data-testid={`home-file-item-${path}`}
                      onClick={() => pickFile(path)}
                    >
                      <Ic name="file" size={13} />
                      <span className="hm-tt">{path}</span>
                    </button>
                  ))}
                  {pickerItems.length === 0 ? (
                    <div className="hm-sec" style={{ padding: '8px 10px' }}>
                      Type to search files in {workspace?.displayName ?? 'the project'}.
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
              placeholder="Describe a task, ask a question, or paste an error…"
              rows={2}
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                } else if (e.key === '@' && workspace) {
                  e.preventDefault();
                  openPicker();
                }
              }}
            />

            {advanced ? (
              <div className="hm-adv" data-testid="home-advanced">
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
                        onClick={() =>
                          setCustomVerif(customVerif.filter((x) => x.label !== c.label))
                        }
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
              </div>
            ) : null}

            <div className="hm-btmrow">
              <button
                className="hm-iconbtn"
                title="Attach project files (or drop them here)"
                data-testid="home-attach"
                onClick={openPicker}
              >
                <Ic name="at" size={15} />
              </button>
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
                    className={mode === m.id ? 'on' : ''}
                    data-testid={`home-mode-${m.id}`}
                    role="radio"
                    aria-checked={mode === m.id}
                    title={m.hint}
                    onClick={() => setMode(m.id)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <button
                className="hm-chip lite"
                data-testid="home-advanced-toggle"
                onClick={() => setAdvanced(!advanced)}
              >
                {advanced ? 'Simple' : 'Advanced'}
              </button>
              <span className="hm-spacer" />
              <select
                className="hm-select"
                data-testid="home-model"
                value={modelKey}
                onChange={(e) => setModelKey(e.target.value)}
              >
                {configuredModels.length === 0 ? (
                  <option value="">No model — add a key in Settings</option>
                ) : (
                  configuredModels.map((m) => (
                    <option
                      key={`${m.providerId}::${m.modelId}`}
                      value={`${m.providerId}::${m.modelId}`}
                    >
                      {m.displayName}
                    </option>
                  ))
                )}
              </select>
              <button
                className={`hm-send ${intent.trim() && !submitting ? 'ready' : ''}`}
                data-testid="home-submit"
                disabled={!intent.trim() || submitting}
                aria-label="Start task"
                onClick={() => void submit()}
              >
                <Ic name="arrowUp" size={15} strokeWidth={2} />
              </button>
            </div>
          </div>
          <div className="hm-hint" data-testid="home-mode-hint">
            <b>{MODE_META.find((m) => m.id === mode)?.label}</b> — {activeModeHint}. ⏎ to start · ⇧⏎
            new line.
          </div>
        </div>

        {needsYou.length > 0 || running.length > 0 ? (
          <div className="hm-mc">
            {needsYou.length > 0 ? (
              <>
                <div className="hm-mc-label">
                  NEEDS YOU <span className="hm-count">{needsYou.length}</span>
                </div>
                <div data-testid="home-mc-needs">{needsYou.map(mcCard)}</div>
              </>
            ) : null}
            {running.length > 0 ? (
              <>
                <div className="hm-mc-label">RUNNING</div>
                <div data-testid="home-mc-running">
                  {running.map((t) => (
                    <React.Fragment key={t.id}>
                      {mcCard(t)}
                      <LiveBoard
                        taskId={t.id}
                        onOpenLens={(path) => setLens({ taskId: t.id, path })}
                      />
                    </React.Fragment>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div style={{ height: 26 }} />
        )}
      </main>

      {lens ? (
        <FileLens taskId={lens.taskId} path={lens.path} onClose={() => setLens(null)} />
      ) : null}
    </div>
  );
}

/** Notification click → the task's room (PIVOT-014/021); registered once. */
export function registerHomeSurfaceListeners(): void {
  onEvent('app.focusTask', ({ taskId }) => {
    void useTaskStore.getState().openTask(taskId);
    useAppStore.getState().openTaskRoom(taskId);
  });
  useActivityStore.getState().init();
}
