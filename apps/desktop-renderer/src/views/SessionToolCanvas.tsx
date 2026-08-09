import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeSetDto, PrDraftDto, TaskDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore, type SessionTool } from '../store/appStore.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { currentActionLine, useActivityStore } from '../store/activityStore.js';
import { FilePeek } from './FilePeek.js';
import { RoomPreviewRail } from './RoomPreviewRail.js';
import { ReviewChecks } from './ReviewChecks.js';
import { ConfirmDangerButton } from './ui.js';
import { Ic } from './home-icons.js';
import { mountTerminal, observeTerminalFit, useTerminalStore } from './TerminalPanel.js';
import { canResumeExternal, isAnswered, presentedMeta } from './labels.js';
import { roomCopyFor } from './roomCopy.js';
import { LiveBoard } from './LiveBoard.js';
import { monaco } from '../monaco-setup.js';
import { addCodeContext } from '../codeContext.js';
import { CodeContextFloat } from './CodeContextFloat.js';
import { useExternalStore } from '../store/externalStore.js';
import { agentDisplayName } from '../store/agentCatalogStore.js';
import { displayedDiffFiles } from './session-file-projection.js';
import {
  isCurrentVerificationPass,
  latestFinalReport,
  reportExecutionFailed,
} from './verification-evidence.js';
import {
  announceChange,
  changeKindLabel,
  groupChanges,
  nextChangeIndex,
  type DiffLine,
} from './accessible-diff.js';

const NO_CANVAS_EVENTS: never[] = [];

export interface SessionVerification {
  label: string;
  state: string;
  stale: boolean;
  superseded: boolean;
}

export interface SessionFileStat {
  additions: number;
  deletions: number;
}

const SESSION_TABS: Array<{ id: SessionTool; label: string; icon: string }> = [
  { id: 'file', label: 'File', icon: 'file' },
  { id: 'diff', label: 'Diff', icon: 'file' },
  { id: 'preview', label: 'Output', icon: 'eye' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'review', label: 'Review', icon: 'check' },
];

/**
 * The Session-owned tool canvas. Files, diffs, preview, terminal and review
 * are states of one collaboration object — never a second application shell.
 */
export function SessionToolCanvas(props: {
  task: TaskDto;
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  verifications: SessionVerification[];
  editableInWorkspace: boolean;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const { task, files, fileStats, verifications } = props;
  const app = useAppStore();
  const tool = useAppStore((state) => state.sessionTool);
  const open = useAppStore((state) => state.sessionToolsOpen);
  const expanded = useAppStore((state) => state.sessionToolExpanded);
  const tablistRef = useRef<HTMLDivElement>(null);
  const running = RUNNING_TASK_STATES.has(task.state);
  const toolTabs =
    running || files.length === 0 || isAnswered(task) || task.state === 'ROLLED_BACK'
      ? [{ id: 'summary' as const, label: 'Summary', icon: 'map' }, ...SESSION_TABS.slice(1)]
      : SESSION_TABS;

  useEffect(() => {
    const current = useAppStore.getState();
    if (task.state === 'REVIEW_READY' && files.length > 0 && current.sessionTool === 'summary') {
      current.setSessionTool('review');
    } else if (isAnswered(task) && current.sessionTool === 'review') {
      // A zero-change answer has nothing to inspect. Keep the Session summary
      // and its Done action in focus instead of presenting a 0-file review.
      current.setSessionTool('summary');
      current.setSessionToolsOpen(false);
    } else if (
      (task.state === 'ROLLED_BACK' || task.state === 'IDLE') &&
      current.sessionTool === 'review'
    ) {
      // Settlement (ADR-0032) or rollback retires the active review surface;
      // the timeline record stays, and the rail turn list reopens Review on
      // demand for any still-pending turn.
      current.setSessionTool('summary');
      current.setSessionToolsOpen(false);
    }
  }, [task.state, task.id, files.length]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      tablistRef.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, tool]);

  const chooseTool = (next: SessionTool): void => {
    if (next === 'diff' && task.external?.status === 'active' && task.external.snapshotRef) {
      app.setSessionTool('diff');
      void rpcResult('external.reconcileSession', { taskId: task.id }).then(async (result) => {
        if (!result.ok) {
          app.pushToast('error', result.error.userMessage);
          return;
        }
        const external = useExternalStore.getState();
        useExternalStore.setState({
          sessions: {
            ...external.sessions,
            [task.id]: result.data.session,
          },
        });
        await useTaskStore.getState().refreshChangeSet();
      });
      return;
    }
    if (next === 'file' && files.length > 0) {
      const active = app.peek?.taskId === task.id ? app.peek.active : files[0]!;
      app.openPeek(task.id, active, 'file');
      return;
    }
    if (next === 'preview') {
      app.openPreviewRail(task.id);
      return;
    }
    app.setSessionTool(next);
  };

  return (
    <aside
      className={`session-tool-canvas ${open ? 'open' : 'closed'} ${expanded ? 'expanded' : ''}`}
      data-testid="session-tool-canvas"
      data-task-id={task.id}
      data-active-tool={tool}
      data-open={open ? 'true' : 'false'}
      aria-hidden={!open}
      aria-label="Session tools"
    >
      <header className="session-tool-tabs">
        <div
          ref={tablistRef}
          className="session-tool-tablist"
          role="tablist"
          aria-label="Session tools"
        >
          {toolTabs.map((item) => {
            const active = item.id === tool;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-label={item.label}
                aria-selected={active}
                title={item.label}
                className={active ? 'active' : ''}
                data-testid={`session-tool-${item.id}`}
                disabled={
                  (item.id === 'file' && files.length === 0) ||
                  (item.id === 'diff' && files.length === 0 && !task.external?.snapshotRef)
                }
                onClick={() => chooseTool(item.id)}
              >
                <Ic name={item.icon} size={13} />
                <span>{item.label}</span>
                {item.id === 'diff' && files.length > 0 ? <small>{files.length}</small> : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className="session-tool-close"
          data-testid="session-tool-close"
          title="Back to conversation"
          onClick={() => app.setSessionToolsOpen(false)}
        >
          <Ic name="x" size={13} />
          <span>Conversation</span>
        </button>
        <button
          type="button"
          className="session-tool-expand"
          data-testid="session-tool-expand"
          aria-pressed={expanded}
          title={
            tool === 'preview'
              ? expanded
                ? 'Return to the conversation and compact Output'
                : 'Open Output as a full Session workspace'
              : expanded
                ? 'Restore balanced Session view'
                : 'Give the tool canvas more room'
          }
          onClick={() => {
            // Output Focus temporarily covers the split, so the user's exact
            // conversation ratio can return unchanged with Back to Session.
            if (tool !== 'preview') app.setSessionSplit(task.id, null);
            app.setSessionToolExpanded(!expanded);
          }}
        >
          <Ic name="layout" size={13} />
          <span>
            {tool === 'preview'
              ? expanded
                ? 'Back to Session'
                : 'Focus'
              : expanded
                ? 'Balance'
                : 'Expand'}
          </span>
        </button>
      </header>

      <div className="session-tool-body">
        {tool === 'diff' ? (
          files.length > 0 ? (
            <SessionDiffReview
              task={task}
              files={files}
              fileStats={fileStats}
              verifications={verifications}
            />
          ) : (
            <ToolEmpty icon="file" title="No changes yet">
              Files touched by this Session will appear here without replacing the conversation.
            </ToolEmpty>
          )
        ) : tool === 'file' ? (
          files.length > 0 ? (
            <FilePeek
              taskId={task.id}
              worktree={task.worktree !== null}
              editableInWorkspace={props.editableInWorkspace}
              onOpenInEditor={props.onOpenFile}
            />
          ) : (
            <ToolEmpty icon="file" title="No changes yet">
              Files touched by this Session will appear here without replacing the conversation.
            </ToolEmpty>
          )
        ) : tool === 'preview' ? (
          <RoomPreviewRail task={task} />
        ) : tool === 'terminal' ? (
          <SessionTerminalTool task={task} />
        ) : tool === 'review' ? (
          <SessionReviewSummary
            task={task}
            files={files}
            fileStats={fileStats}
            verifications={verifications}
            onOpenDiff={(path) => app.openPeek(task.id, path, 'diff')}
          />
        ) : (
          <SessionSummary
            task={task}
            files={files}
            fileStats={fileStats}
            verifications={verifications}
            onOpenDiff={(path) => app.openPeek(task.id, path, 'diff')}
          />
        )}
      </div>
    </aside>
  );
}

type ChangeFile = ChangeSetDto['files'][number];
type ChangeHunk = ChangeFile['hunks'][number];

interface InlineDiffLine {
  key: string;
  kind: 'context' | 'addition' | 'deletion';
  lineNumber: number | null;
  text: string;
}

function inlineLines(hunk: ChangeHunk): InlineDiffLine[] {
  const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(hunk.header);
  let oldLine = Number(match?.[1] ?? 1);
  let newLine = Number(match?.[2] ?? 1);
  return hunk.lines.map((raw, index) => {
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const line: InlineDiffLine = {
        key: `${hunk.key}-add-${index}`,
        kind: 'addition',
        lineNumber: newLine,
        text: raw.slice(1),
      };
      newLine += 1;
      return line;
    }
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      const line: InlineDiffLine = {
        key: `${hunk.key}-del-${index}`,
        kind: 'deletion',
        lineNumber: oldLine,
        text: raw.slice(1),
      };
      oldLine += 1;
      return line;
    }
    const line: InlineDiffLine = {
      key: `${hunk.key}-ctx-${index}`,
      kind: 'context',
      lineNumber: newLine,
      text: raw.startsWith(' ') ? raw.slice(1) : raw,
    };
    oldLine += 1;
    newLine += 1;
    return line;
  });
}

function languageForPath(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const languages: Record<string, string> = {
    cjs: 'javascript',
    css: 'css',
    html: 'html',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    mjs: 'javascript',
    py: 'python',
    scss: 'scss',
    sh: 'shell',
    ts: 'typescript',
    tsx: 'typescript',
    yaml: 'yaml',
    yml: 'yaml',
  };
  return languages[extension] ?? 'plaintext';
}

function ColorizedDiffCode(props: { path: string; code: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void monaco.editor
      .colorize(props.code || ' ', languageForPath(props.path), { tabSize: 2 })
      .then((colored) => {
        if (!cancelled && colored.includes('<span')) setHtml(colored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.code, props.path]);
  return html ? (
    <code dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <code>{props.code || ' '}</code>
  );
}

const DIFF_VERSION_LABEL: Record<'working-tree' | 'baseline' | 'diff-patch', string> = {
  'working-tree': 'new version',
  baseline: 'old version',
  'diff-patch': 'diff excerpt',
};

function SessionDiffReview(props: {
  task: TaskDto;
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  verifications: SessionVerification[];
}): React.JSX.Element {
  // ADR-0055: changeSet is the ACTIVE task's projection — a hidden kept-alive
  // room pins to constants so the visible session's churn never re-renders it.
  const storeChangeSet = useTaskStore((s) =>
    s.activeTaskId === props.task.id ? s.changeSet : null,
  );
  const loadingChangeSet = useTaskStore((s) =>
    s.activeTaskId === props.task.id ? s.loadingChangeSet : false,
  );
  const store = useTaskStore.getState(); // stable actions
  const app = useAppStore.getState(); // stable actions
  const peek = useAppStore((state) => state.peek);
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const diffCardRef = useRef<HTMLElement>(null);
  // A11Y-005: an accessible text mode linearizes the diff into focusable
  // changes with F7/⇧F7 navigation and a live-region announcer.
  const [diffMode, setDiffMode] = useState<'inline' | 'text'>('inline');
  const [announce, setAnnounce] = useState('');
  const changeCardRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [contextSelection, setContextSelection] = useState<{
    startLine: number;
    endLine: number;
    text: string;
    version: 'working-tree' | 'baseline' | 'diff-patch';
    hunkHeader?: string;
    /** Flat indices of the selected data rows — drives the mock's full-width band. */
    rowStart: number;
    rowEnd: number;
    /** Bubble top inside `.session-inline-diff`, anchored to the selection end. */
    anchorTop: number;
  } | null>(null);

  useEffect(() => {
    void store.refreshChangeSet();
    // task id is the refresh boundary; write events update the store projection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task.id]);

  const changeSet = storeChangeSet?.taskId === props.task.id ? storeChangeSet : null;
  const changeFiles = changeSet?.files ?? [];
  // The detailed ChangeSet is the same source rendered by the rows below. Its
  // count must win over the watcher-derived fallback or the heading can say
  // "3 files" while the list visibly contains six aggregated worker changes.
  const displayedFiles = displayedDiffFiles(changeFiles, props.files);
  const requestedPath = peek?.taskId === props.task.id ? peek.active : null;
  // Approved design D (docs/design/diff-panel-redesign.html): no file expands
  // until the reviewer picks one, and the pick is reversible. Dismissal is
  // view-local so collapsing the card never drops the shared peek tabs; any
  // fresh openPeek (file row, rail, timeline) produces a new peek object and
  // re-expands through the effect below.
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [peek]);
  const selected =
    !dismissed && requestedPath
      ? (changeFiles.find((file) => file.path === requestedPath) ?? null)
      : null;

  useEffect(() => setContextSelection(null), [selected?.path]);

  // Flat row offsets so the mouseup selection (indexed over data rows) can be
  // painted back onto the rendered rows as the mock's full-width band.
  const hunkRows = useMemo(() => {
    let offset = 0;
    return (selected?.hunks ?? []).map((hunk) => {
      const entry = { hunk, lines: inlineLines(hunk), offset };
      offset += entry.lines.length;
      return entry;
    });
  }, [selected]);

  // Accessible-text-mode changes: every changed-line run in the selected file.
  const textChanges = useMemo(() => {
    const flat: DiffLine[] = hunkRows.flatMap(({ lines }) =>
      lines.map((line) => ({ kind: line.kind, lineNumber: line.lineNumber, text: line.text })),
    );
    return groupChanges(flat);
  }, [hunkRows]);

  const focusChange = (index: number): void => {
    const target = changeCardRefs.current[index];
    if (!target || !selected) return;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
    setAnnounce(announceChange(selected.path, textChanges[index]!, textChanges.length));
  };
  const stepChange = (dir: 1 | -1): void => {
    if (textChanges.length === 0) return;
    const currentIndex = changeCardRefs.current.findIndex((el) => el === document.activeElement);
    focusChange(nextChangeIndex(currentIndex, textChanges.length, dir));
  };

  // A11Y-005: F7 / ⇧F7 step between changes from anywhere while text mode is on
  // (a change card need not already hold focus). Ignored while typing.
  useEffect(() => {
    if (diffMode !== 'text') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'F7') return;
      const el = document.activeElement;
      if (
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName))
      )
        return;
      event.preventDefault();
      stepChange(event.shiftKey ? -1 : 1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffMode, textChanges, selected?.path]);

  const additions =
    changeSet?.totalAdditions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.additions, 0);
  const deletions =
    changeSet?.totalDeletions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.deletions, 0);

  const selectFile = (path: string): void => {
    // Clicking the expanded file again collapses it (same as the ✕ button).
    if (selected?.path === path) {
      setDismissed(true);
      return;
    }
    app.openPeek(props.task.id, path, 'diff');
  };
  const copyPatch = async (): Promise<void> => {
    if (!selected) return;
    const patch = selected.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines]).join('\n');
    try {
      await navigator.clipboard.writeText(patch);
      app.pushToast('success', `Copied diff for ${selected.path}`);
    } catch {
      app.pushToast('error', 'The diff could not be copied.');
    }
  };

  const readDiffSelection = (): void => {
    const host = diffBodyRef.current;
    const selection = window.getSelection();
    if (!host || !selection || selection.isCollapsed || selection.rangeCount === 0) {
      setContextSelection(null);
      return;
    }
    const rowForNode = (node: Node | null): HTMLElement | null => {
      const element = node instanceof HTMLElement ? node : node?.parentElement;
      return element?.closest<HTMLElement>('[data-code-context-row]') ?? null;
    };
    const anchor = rowForNode(selection.anchorNode);
    const focus = rowForNode(selection.focusNode);
    if (!anchor || !focus || !host.contains(anchor) || !host.contains(focus)) {
      setContextSelection(null);
      return;
    }
    const rows = [...host.querySelectorAll<HTMLElement>('[data-code-context-row]')];
    const anchorIndex = rows.indexOf(anchor);
    const focusIndex = rows.indexOf(focus);
    if (anchorIndex < 0 || focusIndex < 0) return;
    const picked = rows.slice(
      Math.min(anchorIndex, focusIndex),
      Math.max(anchorIndex, focusIndex) + 1,
    );
    const kinds = picked.map((row) => row.dataset.kind ?? 'context');
    const version = kinds.every((kind) => kind === 'deletion')
      ? ('baseline' as const)
      : kinds.every((kind) => kind !== 'deletion')
        ? ('working-tree' as const)
        : ('diff-patch' as const);
    const text = picked
      .map((row) => {
        const code = row.dataset.code ?? '';
        if (version !== 'diff-patch') return code;
        return `${row.dataset.kind === 'addition' ? '+' : row.dataset.kind === 'deletion' ? '-' : ' '}${code}`;
      })
      .join('\n');
    const lineNumbers = picked
      .map((row) => Number(row.dataset.lineNumber))
      .filter((line) => Number.isFinite(line) && line > 0);
    const headers = [...new Set(picked.map((row) => row.dataset.hunkHeader).filter(Boolean))];
    if (!text.trim() || lineNumbers.length === 0) return;
    const card = diffCardRef.current;
    const lastRow = picked[picked.length - 1]!;
    const anchorTop = card
      ? Math.max(6, lastRow.getBoundingClientRect().bottom - card.getBoundingClientRect().top - 36)
      : 0;
    setContextSelection({
      startLine: Math.min(...lineNumbers),
      endLine: Math.max(...lineNumbers),
      text,
      version,
      ...(headers.length === 1 ? { hunkHeader: headers[0] } : {}),
      rowStart: Math.min(anchorIndex, focusIndex),
      rowEnd: Math.max(anchorIndex, focusIndex),
      anchorTop,
    });
  };

  const attachDiffSelection = async (): Promise<void> => {
    if (!selected || !contextSelection) return;
    await addCodeContext(props.task.id, {
      path: selected.path,
      origin: 'diff',
      version: contextSelection.version,
      startLine: contextSelection.startLine,
      startColumn: 1,
      endLine: contextSelection.endLine,
      endColumn:
        (contextSelection.text
          .split('\n')
          .at(-1)
          ?.replace(/^[+\- ]/u, '').length ?? 0) + 1,
      text: contextSelection.text,
      contentHash: contextSelection.version === 'working-tree' ? selected.currentHash : null,
      ...(contextSelection.hunkHeader ? { hunkHeader: contextSelection.hunkHeader } : {}),
    });
    window.getSelection()?.removeAllRanges();
    setContextSelection(null);
  };

  return (
    <div className="session-diff-review" data-testid="session-diff-review">
      <section className="session-diff-overview" aria-label="Changed files">
        <header>
          <h2>
            {displayedFiles.length} file{displayedFiles.length === 1 ? '' : 's'} changed
          </h2>
          <span className="session-diff-grand-total mono">
            <i className="plus">+{additions}</i> <i className="minus">−{deletions}</i>
          </span>
        </header>
        <div className="session-diff-file-list">
          {displayedFiles.map((entry) => {
            const path = typeof entry === 'string' ? entry : entry.path;
            const stat = typeof entry === 'string' ? props.fileStats[path] : entry;
            const active = selected?.path === path;
            return (
              <button
                key={path}
                type="button"
                className={active ? 'active' : ''}
                data-testid={`session-diff-file-${path}`}
                aria-pressed={active}
                onClick={() => selectFile(path)}
              >
                <span className="session-code-file-icon">
                  <Ic name="terminal" size={12} strokeWidth={1.9} />
                </span>
                <span>{path}</span>
                {stat ? (
                  <small className="mono">
                    <i className="plus">+{stat.additions}</i>{' '}
                    <i className="minus">−{stat.deletions}</i>
                  </small>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      {!selected && !dismissed && requestedPath && loadingChangeSet ? (
        <div className="session-diff-loading">Computing the review diff…</div>
      ) : selected ? (
        <section
          ref={diffCardRef}
          className="session-inline-diff"
          data-testid="session-inline-diff"
        >
          <header>
            <strong className="mono">{selected.path}</strong>
            <span />
            <div
              className="session-diff-viewmode"
              role="radiogroup"
              aria-label="Diff view"
              data-testid="diff-viewmode"
            >
              <button
                type="button"
                role="radio"
                aria-checked={diffMode === 'inline'}
                className={diffMode === 'inline' ? 'on' : ''}
                data-testid="diff-viewmode-inline"
                onClick={() => setDiffMode('inline')}
              >
                Inline
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={diffMode === 'text'}
                className={diffMode === 'text' ? 'on' : ''}
                data-testid="diff-viewmode-text"
                onClick={() => {
                  setDiffMode('text');
                  setAnnounce(
                    `Text mode. ${textChanges.length} ${textChanges.length === 1 ? 'change' : 'changes'} in ${selected.path}. Press F7 to move to the first change.`,
                  );
                }}
              >
                Text mode
              </button>
            </div>
            <button type="button" aria-label="Copy diff" title="Copy diff" onClick={copyPatch}>
              <Ic name="clipboard" size={15} />
            </button>
            <button
              type="button"
              className="session-open-review-details"
              aria-label="Open advanced review"
              title="Open advanced review"
              onClick={() => void store.openReview()}
            >
              <Ic name="sliders" size={14} />
              <span>Full review</span>
            </button>
            <button
              type="button"
              aria-label="Collapse diff"
              title="Collapse diff"
              data-testid="session-diff-collapse"
              onClick={() => setDismissed(true)}
            >
              <Ic name="x" size={15} />
            </button>
          </header>
          {selected.binary ? (
            <div className="session-diff-loading">Binary file — no inline text diff.</div>
          ) : selected.hunks.length === 0 ? (
            <div className="session-diff-loading">No text hunks recorded for this file.</div>
          ) : diffMode === 'text' ? (
            <AccessibleDiffText
              path={selected.path}
              changes={textChanges}
              cardRefs={changeCardRefs}
              onFocusChange={(index) => {
                setAnnounce(announceChange(selected.path, textChanges[index]!, textChanges.length));
              }}
            />
          ) : (
            <div
              ref={diffBodyRef}
              className="session-inline-diff-body"
              role="table"
              aria-label={selected.path}
              onMouseUp={readDiffSelection}
              onKeyUp={readDiffSelection}
            >
              {hunkRows.map(({ hunk, lines, offset }) => (
                <React.Fragment key={hunk.key}>
                  <div className="session-inline-hunk mono" role="row">
                    {hunk.header}
                  </div>
                  {lines.map((line, index) => {
                    const banded =
                      contextSelection !== null &&
                      offset + index >= contextSelection.rowStart &&
                      offset + index <= contextSelection.rowEnd;
                    return (
                      <div
                        key={line.key}
                        className={`session-inline-line ${line.kind}${banded ? ' ctx-selected' : ''}`}
                        role="row"
                        data-code-context-row
                        data-kind={line.kind}
                        data-code={line.text}
                        data-line-number={line.lineNumber ?? ''}
                        data-hunk-header={hunk.header}
                      >
                        <span className="session-inline-number mono">{line.lineNumber ?? ''}</span>
                        <span className="session-inline-marker mono">
                          {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ''}
                        </span>
                        <ColorizedDiffCode path={selected.path} code={line.text} />
                      </div>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
          {contextSelection ? (
            <CodeContextFloat
              testid="diff-code-selection-bar"
              buttonTestid="diff-add-code-context"
              label={`${contextSelection.rowEnd - contextSelection.rowStart + 1} lines selected · ${DIFF_VERSION_LABEL[contextSelection.version]}`}
              style={{ top: contextSelection.anchorTop }}
              onAttach={() => void attachDiffSelection()}
            />
          ) : null}
        </section>
      ) : displayedFiles.length === 0 ? (
        <div className="session-diff-loading">
          {loadingChangeSet
            ? 'Computing the review diff…'
            : 'No reviewable text changes were recorded.'}
        </div>
      ) : null}

      <div className="visually-hidden" role="status" aria-live="polite" data-testid="diff-live">
        {announce}
      </div>

      <SessionDiffVerification task={props.task} verifications={props.verifications} />
    </div>
  );
}

/** A11Y-005: linear, screen-reader-friendly change list with F7/⇧F7 navigation. */
function AccessibleDiffText(props: {
  path: string;
  changes: ReturnType<typeof groupChanges>;
  cardRefs: React.MutableRefObject<Array<HTMLDivElement | null>>;
  onFocusChange: (index: number) => void;
}): React.JSX.Element {
  if (props.changes.length === 0) {
    return <div className="session-diff-loading">No line changes to read.</div>;
  }

  return (
    <div
      className="session-diff-text"
      data-testid="session-diff-text"
      aria-label={`${props.path}: ${props.changes.length} changes. Press F7 and Shift+F7 to move between changes.`}
    >
      {props.changes.map((change, index) => {
        const kind = changeKindLabel(change);
        return (
          <div
            key={`${change.index}-${change.line ?? 'x'}`}
            ref={(el) => {
              props.cardRefs.current[index] = el;
            }}
            className="session-diff-change"
            data-testid={`diff-change-${index}`}
            tabIndex={0}
            role="group"
            aria-label={`Change ${index + 1} of ${props.changes.length}`}
            onFocus={() => props.onFocusChange(index)}
          >
            <div className="session-diff-change-meta">
              <span className="idx mono">
                {index + 1}/{props.changes.length}
              </span>
              <span className="where mono">
                {props.path}
                {change.line !== null ? ` · line ${change.line}` : ''}
              </span>
              <span className={`kind ${kind}`}>{kind}</span>
            </div>
            <div className="session-diff-change-lines mono">
              {change.lines.map((line, i) => (
                <span key={i} className={`cl ${line.kind}`}>
                  {line.kind === 'addition' ? '+ ' : line.kind === 'deletion' ? '− ' : '  '}
                  {line.text}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionDiffVerification(props: {
  task: TaskDto;
  verifications: SessionVerification[];
}): React.JSX.Element {
  const store = useTaskStore.getState(); // actions only
  const configured = props.task.verification.length > 0;
  const passed = props.verifications.filter(isCurrentVerificationPass).length;
  const allPassed = props.verifications.length > 0 && passed === props.verifications.length;

  return (
    <details className={`session-diff-verification ${allPassed ? 'passed' : ''}`} open>
      <summary>
        <span className="session-diff-verification-icon">
          <Ic name={allPassed ? 'check' : 'alert'} size={16} strokeWidth={2} />
        </span>
        <strong>Verification</strong>
        <span />
        <b className={allPassed ? 'ok' : 'muted'}>
          {allPassed
            ? `${passed} ${passed === 1 ? 'check' : 'checks'} passed`
            : props.verifications.length > 0
              ? `${passed}/${props.verifications.length} passed`
              : 'Not run'}
        </b>
      </summary>
      <div className="session-diff-verification-detail">
        <span>
          {props.verifications.length > 0
            ? `Executed ${props.verifications.length} recorded ${props.verifications.length === 1 ? 'check' : 'checks'}.`
            : configured
              ? `${props.task.verification.length} configured ${props.task.verification.length === 1 ? 'check has' : 'checks have'} not run yet.`
              : 'No verification commands are configured for this Session.'}
        </span>
        {configured && props.verifications.length === 0 ? (
          <button
            type="button"
            className="btn"
            data-testid="session-diff-run-verification"
            onClick={(event) => {
              event.preventDefault();
              void store.runVerification();
            }}
          >
            Run verification
          </button>
        ) : (
          <Ic name="chevron" size={14} className="session-diff-verification-chevron" />
        )}
      </div>
    </details>
  );
}

function ToolEmpty(props: {
  icon: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="session-tool-empty">
      <Ic name={props.icon} size={20} />
      <strong>{props.title}</strong>
      <div className="session-tool-empty-copy">{props.children}</div>
    </div>
  );
}

function SessionSummary(props: {
  task: TaskDto;
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  verifications: SessionVerification[];
  onOpenDiff: (path: string) => void;
}): React.JSX.Element {
  const activity = useActivityStore((state) => state.perTask[props.task.id]);
  const action = currentActionLine(activity);
  const meta = presentedMeta(props.task);
  const running = RUNNING_TASK_STATES.has(props.task.state);
  const streaming = useTaskStore(
    (state) => state.activeTaskId === props.task.id && state.streaming,
  );
  const streamingThinking = useTaskStore((state) =>
    state.activeTaskId === props.task.id ? state.streamingThinking : null,
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const current = activity?.current ?? null;
  const elapsed = current ? Math.max(0, Math.round((now - Date.parse(current.at)) / 1000)) : null;
  const hasStaleVerification = props.verifications.some(
    (verification) => verification.stale || verification.superseded,
  );
  const liveLabel = running
    ? streamingThinking
      ? 'Thinking through the next change…'
      : (current?.label ??
        (streaming ? 'Composing the next update…' : (action?.label ?? 'Working…')))
    : props.task.state === 'REVIEW_READY'
      ? 'The change set is ready for your decision.'
      : hasStaleVerification
        ? 'Previous verification is stale — re-run checks before relying on it.'
        : 'No action is currently running.';

  return (
    <div className="session-summary" data-testid="session-summary">
      {running ? (
        <LiveBoard
          taskId={props.task.id}
          variant="rail"
          currentAction={{
            label: liveLabel,
            path: current?.paths[0] ?? action?.paths[0] ?? null,
            elapsed,
          }}
          fileStats={props.fileStats}
          onOpenLens={props.onOpenDiff}
        />
      ) : (
        <>
          <section className="session-summary-lead">
            <div className={`session-status-mark ${meta.tone}`}>
              <Ic name={meta.tone === 'ok' ? 'check' : 'clock'} size={15} />
            </div>
            <div>
              <span>Session status</span>
              <strong>{meta.label}</strong>
              <p>{liveLabel}</p>
            </div>
          </section>
          <EvidenceSection
            files={props.files}
            fileStats={props.fileStats}
            onOpenDiff={props.onOpenDiff}
          />
        </>
      )}
      <VerificationSection verifications={props.verifications} task={props.task} />
    </div>
  );
}

function SessionReviewSummary(props: {
  task: TaskDto;
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  verifications: SessionVerification[];
  onOpenDiff: (path: string) => void;
}): React.JSX.Element {
  // ADR-0055: active-gated singleton reads (see SessionDiffReview above).
  const storeChangeSet = useTaskStore((s) =>
    s.activeTaskId === props.task.id ? s.changeSet : null,
  );
  const timeline = useTaskStore((s) => s.timelines[props.task.id] ?? NO_CANVAS_EVENTS);
  const store = useTaskStore.getState(); // stable actions
  const copy = roomCopyFor(`${props.task.title}\n${props.task.goalMd}`);

  useEffect(() => {
    if (props.task.state === 'REVIEW_READY' || props.files.length > 0) {
      void store.refreshChangeSet();
    }
    // task id is the refresh boundary; event updates refresh through the review overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task.id]);

  const changeSet = storeChangeSet?.taskId === props.task.id ? storeChangeSet : null;

  const report = useMemo(() => latestFinalReport(timeline), [timeline]);
  const executionFailed = reportExecutionFailed(report);

  const agentSummary = typeof report?.agentSummary === 'string' ? report.agentSummary : null;
  const risks = Array.isArray(report?.unresolvedRisks)
    ? report.unresolvedRisks.filter((risk): risk is string => typeof risk === 'string')
    : [];
  const additions =
    changeSet?.totalAdditions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.additions, 0);
  const deletions =
    changeSet?.totalDeletions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.deletions, 0);

  return (
    <div className="session-review-summary" data-testid="review-bar">
      <section className="session-review-lead">
        <span className={`session-review-icon ${executionFailed ? 'failed' : ''}`}>
          <Ic name={executionFailed ? 'alert' : 'check'} size={16} />
        </span>
        <div>
          <span>{executionFailed ? 'Latest request did not complete' : copy.reviewReady}</span>
          <strong>
            {props.files.length} file{props.files.length === 1 ? '' : 's'} changed
          </strong>
          <p>
            {executionFailed
              ? 'A requested file action failed. These existing changes remain reviewable, but the latest fix is not proven complete.'
              : copy.evidenceNote}
          </p>
        </div>
        <span className="session-diff-total mono">
          <i className="plus">+{additions}</i> <i className="minus">−{deletions}</i>
        </span>
      </section>

      {agentSummary ? (
        <section className="session-review-narrative">
          <h3>{executionFailed ? "Agent's unverified summary" : "Agent's summary"}</h3>
          <p>{agentSummary}</p>
        </section>
      ) : null}

      <EvidenceSection
        files={props.files}
        fileStats={props.fileStats}
        onOpenDiff={props.onOpenDiff}
      />
      <div className="session-review-checks">
        <ReviewChecks task={props.task} />
      </div>

      {risks.length > 0 ? (
        <section className="session-risk" data-testid="session-review-risks">
          <div>
            <Ic name="alert" size={14} />
            <strong>{copy.risks}</strong>
          </div>
          <ul>
            {risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <button
        type="button"
        className="session-open-full-diff"
        data-testid="review-bar-open"
        onClick={() => void store.openReview()}
      >
        <span>{copy.reviewChanges}</span>
        <Ic name="chevron" size={13} className="session-arrow-right" />
      </button>
    </div>
  );
}

function EvidenceSection(props: {
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  onOpenDiff: (path: string) => void;
}): React.JSX.Element {
  return (
    <section className="session-evidence-section">
      <header>
        <h3>Changed files</h3>
        <span>{props.files.length}</span>
      </header>
      {props.files.length === 0 ? (
        <p className="session-tool-muted">Nothing touched yet.</p>
      ) : (
        <div className="session-file-ledger">
          {props.files.slice(-12).map((path) => {
            const stat = props.fileStats[path];
            return (
              <button
                key={path}
                type="button"
                data-testid={`task-room-file-${path}`}
                onClick={() => props.onOpenDiff(path)}
              >
                <Ic name="file" size={12} />
                <span>{path}</span>
                {stat ? (
                  <small className="mono">
                    <i className="plus">+{stat.additions}</i>{' '}
                    <i className="minus">−{stat.deletions}</i>
                  </small>
                ) : null}
                <Ic name="chevron" size={11} className="session-row-chevron" />
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function VerificationSection(props: {
  verifications: SessionVerification[];
  task: TaskDto;
}): React.JSX.Element {
  const store = useTaskStore.getState(); // actions only
  const configured = props.task.verification.length > 0;
  return (
    <section className="session-evidence-section" data-testid="session-verification">
      <header>
        <h3>Verification</h3>
        <span>{props.verifications.length}</span>
      </header>
      {props.verifications.length === 0 ? (
        <div className="session-verification-empty">
          <p className="session-tool-muted" data-testid="session-verification-pending">
            {configured
              ? `${props.task.verification.length} configured check${props.task.verification.length === 1 ? ' has' : 's have'} not run yet.`
              : 'No verification configured.'}
          </p>
          {configured ? (
            <button
              type="button"
              className="btn"
              data-testid="session-run-verification"
              onClick={() => void store.runVerification()}
            >
              Run checks
            </button>
          ) : null}
        </div>
      ) : (
        <div className="session-verification-result">
          <div className="session-check-ledger" data-testid="session-verification-ledger">
            {props.verifications.map((verification) => {
              const passed = isCurrentVerificationPass(verification);
              const status = verification.stale
                ? 'Stale'
                : verification.superseded
                  ? 'Superseded'
                  : passed
                    ? 'Passed'
                    : verification.state;
              return (
                <div key={verification.label}>
                  <Ic name={passed ? 'check' : 'alert'} size={12} />
                  <span>{verification.label}</span>
                  <strong className={passed ? 'ok' : 'bad'}>{status}</strong>
                </div>
              );
            })}
          </div>
          {configured ? (
            <button
              type="button"
              className="session-verification-rerun"
              data-testid="session-run-verification"
              onClick={() => void store.runVerification()}
            >
              Re-run checks
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function SessionActionDock({
  task,
  files,
  verifications,
}: {
  task: TaskDto;
  files: string[];
  verifications: SessionVerification[];
}): React.JSX.Element | null {
  const timeline = useTaskStore((s) => s.timelines[task.id] ?? NO_CANVAS_EVENTS);
  const store = useTaskStore.getState(); // stable actions
  const app = useAppStore.getState(); // stable actions
  const resumingExternalTaskId = useExternalStore((state) => state.resumingTaskId);
  const externalSessionStatus = useExternalStore((state) => state.sessions[task.id]?.status);
  const externalAgent = useExternalStore((state) =>
    task.external ? state.agentByTerminal[task.external.terminalId] : undefined,
  );
  const externalTerminalExited = useTerminalStore((state) =>
    task.external
      ? state.items.find((terminal) => terminal.id === task.external?.terminalId)?.exited
      : undefined,
  );
  const running = RUNNING_TASK_STATES.has(task.state);
  const answered = isAnswered(task);
  const report = useMemo(() => latestFinalReport(timeline), [timeline]);
  const executionFailed = reportExecutionFailed(report);
  const failedChecks = verifications.filter(
    (verification) => !isCurrentVerificationPass(verification),
  );
  const recordedLabels = new Set(verifications.map((verification) => verification.label));
  const missingChecks = task.verification.filter((check) => !recordedLabels.has(check.label));
  const hasUnverifiedChanges = verifications.length === 0 || missingChecks.length > 0;
  const hasEvidenceRisk =
    task.mode !== 'ask' && (executionFailed || failedChecks.length > 0 || hasUnverifiedChanges);
  const [settledPrDraft, setSettledPrDraft] = useState<PrDraftDto | null>(null);
  const externalLive =
    task.external !== null &&
    externalTerminalExited !== true &&
    (externalAgent === task.external.cli ||
      (externalSessionStatus ?? task.external.status) === 'active');
  const externalResumable = task.external !== null && canResumeExternal(task) && !externalLive;
  const resumeDisabled = task.external !== null && resumingExternalTaskId !== null;
  const resumeTask = (): void => {
    if (task.external) {
      void useExternalStore.getState().resumeTask(task);
      return;
    }
    void store.resumeTask(task.id);
  };

  useEffect(() => {
    let active = true;
    setSettledPrDraft(null);
    if (!task.external || task.state !== 'IDLE' || (task.changedFiles ?? 0) === 0) {
      return () => {
        active = false;
      };
    }
    void rpcResult('task.prDraft', { taskId: task.id }).then((result) => {
      if (active && result.ok) setSettledPrDraft(result.data.draft ?? null);
    });
    return () => {
      active = false;
    };
  }, [task.changedFiles, task.external, task.id, task.state]);

  if (task.state === 'REVIEW_READY' && !answered) {
    const evidenceRiskCopy = executionFailed
      ? 'Latest request failed · accepting keeps the existing changes without the requested fix'
      : failedChecks.length > 0
        ? `${failedChecks.length} check${failedChecks.length === 1 ? '' : 's'} failed · accepting keeps an unverified result`
        : missingChecks.length > 0
          ? `${missingChecks.length} configured check${missingChecks.length === 1 ? ' has' : 's have'} not run · accepting requires confirmation`
          : 'No verification has run · accepting requires confirmation';
    return (
      <footer className="session-action-dock review-decision" data-testid="session-action-dock">
        <span
          className={`session-action-note ${hasEvidenceRisk ? 'has-risk' : ''}`}
          {...(hasEvidenceRisk ? { 'data-testid': 'review-failed-checks-warning' } : {})}
        >
          {hasEvidenceRisk ? (
            <>
              <span className="session-action-risk">
                <Ic name="alert" size={13} /> {evidenceRiskCopy}
              </span>
              <span className="session-action-separator" aria-hidden="true">
                ·
              </span>
            </>
          ) : null}
          Keeps reviewed files in your workspace · does not create a Git commit
        </span>
        {task.external && externalResumable ? (
          <button
            type="button"
            className="btn"
            data-testid="task-resume"
            disabled={resumeDisabled}
            onClick={resumeTask}
          >
            {resumingExternalTaskId === task.id
              ? 'Resuming…'
              : `Resume ${agentDisplayName(task.external.cli)} session`}
          </button>
        ) : !task.external ? (
          <button
            type="button"
            className="btn"
            data-testid="session-request-changes"
            onClick={() => {
              app.setSessionTool('summary');
              app.setSessionToolsOpen(false);
              app.focusComposer();
            }}
          >
            Request changes
          </button>
        ) : null}
        <ConfirmDangerButton
          label={task.worktree ? 'Discard worktree' : 'Rollback'}
          confirmLabel={task.worktree ? 'Confirm — discard worktree' : 'Confirm — roll back'}
          confirmDescription={
            task.worktree
              ? `Deletes this Session’s isolated worktree and its ${files.length} unaccepted changed ${files.length === 1 ? 'file' : 'files'}. Your main checkout and Git commits stay unchanged; current verification becomes stale.`
              : `Restores ${files.length} changed ${files.length === 1 ? 'file' : 'files'} to the recorded pre-Session bytes and discards this Session’s unaccepted edits. Git commits are not rewritten; current verification becomes stale.`
          }
          testid="task-rollback"
          quiet
          icon="undo"
          onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
        />
        {hasEvidenceRisk ? (
          <ConfirmDangerButton
            label={
              executionFailed
                ? 'Accept despite failed request…'
                : failedChecks.length > 0
                  ? 'Accept despite failed checks…'
                  : 'Accept without verification…'
            }
            confirmLabel={
              executionFailed
                ? 'Confirm — accept without requested fix'
                : failedChecks.length > 0
                  ? 'Confirm — accept failed checks'
                  : 'Confirm — accept unverified changes'
            }
            testid="review-bar-accept"
            onConfirm={() => void store.acceptTask({ confirmEvidenceRisk: true })}
          />
        ) : (
          <button
            type="button"
            className="btn primary session-approve"
            data-testid="review-bar-accept"
            onClick={() => void store.acceptTask()}
          >
            <Ic name="checkCircle" size={15} /> Approve changes
          </button>
        )}
      </footer>
    );
  }

  // ADR-0032: answered turns settle straight to IDLE — the light "Answered"
  // dock survives on both (historic REVIEW_READY rows keep working). There is
  // no decision left to confirm, so this state deliberately has no Done action.
  if ((task.state === 'REVIEW_READY' || task.state === 'IDLE') && answered) {
    return (
      <footer className="session-action-dock" data-testid="session-action-dock">
        <span className="session-action-note" data-testid="task-room-answered">
          {task.external ? 'Session ended · no file changes' : 'Answer complete · no file changes'}
        </span>
        {task.external && externalResumable ? (
          <button
            className="btn"
            data-testid="task-resume"
            disabled={resumeDisabled}
            onClick={resumeTask}
          >
            {resumingExternalTaskId === task.id
              ? 'Resuming…'
              : `Resume ${agentDisplayName(task.external.cli)} session`}
          </button>
        ) : null}
      </footer>
    );
  }

  if (task.state === 'FAILED' || task.state === 'INTERRUPTED') {
    return (
      <footer className="session-action-dock" data-testid="session-action-dock">
        {files.length > 0 ? (
          <button
            className="btn"
            data-testid="review-open"
            onClick={() => app.setSessionTool('review')}
          >
            Review evidence
          </button>
        ) : null}
        {files.length > 0 ? (
          <ConfirmDangerButton
            label={task.worktree ? 'Discard…' : 'Rollback…'}
            confirmLabel={task.worktree ? 'Confirm — discard worktree' : 'Confirm — roll back'}
            confirmDescription={
              task.worktree
                ? `Deletes this Session’s isolated worktree and its ${files.length} changed ${files.length === 1 ? 'file' : 'files'}. Your main checkout and Git commits stay unchanged; current verification becomes stale.`
                : `Restores ${files.length} changed ${files.length === 1 ? 'file' : 'files'} to the recorded pre-Session bytes. Git commits are not rewritten; current verification becomes stale.`
            }
            testid="task-rollback"
            quiet
            onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
          />
        ) : null}
        <span className="session-action-note">The Session stopped before completion.</span>
        {!task.external || externalResumable ? (
          <button
            className="btn primary"
            data-testid="task-resume"
            disabled={resumeDisabled}
            onClick={resumeTask}
          >
            {resumingExternalTaskId === task.id ? 'Resuming…' : 'Resume'}
          </button>
        ) : null}
      </footer>
    );
  }

  if (
    task.state === 'AWAITING_USER' ||
    task.state === 'AWAITING_PERMISSION' ||
    task.state === 'AWAITING_PLAN_APPROVAL'
  ) {
    return (
      <footer className="session-action-dock compact waiting" data-testid="session-action-dock">
        <span className="session-action-live">
          <i /> Waiting for your decision
        </span>
        <span className="session-action-note">
          {task.state === 'AWAITING_USER'
            ? 'Answer the question in the conversation so the Agent can continue.'
            : task.state === 'AWAITING_PERMISSION'
              ? 'Review the requested action before the Agent can continue.'
              : 'Approve, edit, or cancel the proposed plan.'}
        </span>
      </footer>
    );
  }

  if (running) {
    // A live external session needs no status bar: the terminal on screen IS
    // the live status, and the dock offers no action for it — dropping it
    // gives that height back to the session. Managed runs keep the dock for
    // its Stop control.
    if (task.external) return null;
    return (
      <footer className="session-action-dock compact" data-testid="session-action-dock">
        <span className="session-action-live">
          <i /> Agent working
        </span>
        <span className="session-action-note">You can steer it from the composer.</span>
        <button className="btn danger" data-testid="agent-stop" onClick={() => void store.stop()}>
          Stop
        </button>
      </footer>
    );
  }

  // ADR-0032: a settled conversation keeps its escape hatch — snapshots
  // survive settlement, so "roll back everything" stays one click away.
  if (task.state === 'IDLE' && (task.changedFiles ?? 0) > 0) {
    return (
      <footer className="session-action-dock compact" data-testid="session-action-dock">
        <span className="session-action-note" data-testid="task-room-accepted">
          Settled · snapshots retained
        </span>
        {settledPrDraft ? (
          <button
            type="button"
            className="btn"
            data-testid="settled-pr-draft-open"
            onClick={() => store.openPrDraft(task.id, settledPrDraft)}
          >
            Review PR draft
          </button>
        ) : null}
        <ConfirmDangerButton
          label="Roll back everything…"
          confirmLabel="Confirm — restore all files"
          confirmDescription="Restores every recorded file to its pre-Session bytes. Git commits are not rewritten; current verification becomes stale."
          testid="task-rollback"
          quiet
          onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
        />
      </footer>
    );
  }

  if (task.state === 'ACCEPTED' && !task.worktree) {
    return (
      <footer className="session-action-dock compact" data-testid="session-action-dock">
        <span className="session-action-note" data-testid="task-room-accepted">
          Accepted · snapshot retained
        </span>
        <ConfirmDangerButton
          label="Rollback…"
          confirmLabel="Confirm — restore all files"
          confirmDescription="Restores every recorded file to its pre-Session bytes. Git commits are not rewritten; current verification becomes stale."
          testid="task-rollback"
          quiet
          onConfirm={() => void store.rollbackTask({ confirmDestructive: true })}
        />
      </footer>
    );
  }

  return <footer className="session-action-dock empty" data-testid="session-action-dock" />;
}

function SessionTerminalTool({ task }: { task: TaskDto }): React.JSX.Element {
  const terminalStore = useTerminalStore();
  const hostRef = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState(false);
  // An external Agent's PTY is the room's conversation surface, not the
  // command shell behind this tool tab. Never re-parent that xterm out of the
  // center column; this canvas owns only an independent Session shell.
  const item = terminalStore.items.find(
    (candidate) =>
      !candidate.hidden &&
      candidate.launch === 'shell' &&
      candidate.contextTaskId === task.id &&
      candidate.id !== task.external?.terminalId,
  );

  useEffect(() => {
    terminalStore.init();
  }, [terminalStore]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !item) return;
    mountTerminal(host, item);
    return observeTerminalFit(host, item);
  }, [item]);

  const createTerminal = async (): Promise<void> => {
    if (creating) return;
    setCreating(true);
    await terminalStore.create({
      taskId: task.id,
      context: { kind: 'task', taskId: task.id },
      launch: 'shell',
      title: task.worktree?.branch ?? (task.external ? `${task.projectName} shell` : task.title),
      reveal: false,
    });
    setCreating(false);
  };

  if (!item) {
    return (
      <ToolEmpty icon="terminal" title="Session terminal">
        <span>
          Open a terminal in this Session's {task.worktree ? 'isolated worktree' : 'project'}.
        </span>
        <button
          className="btn primary"
          data-testid="session-terminal-create"
          disabled={creating}
          onClick={() => void createTerminal()}
        >
          {creating ? 'Opening…' : 'Open terminal'}
        </button>
      </ToolEmpty>
    );
  }

  return (
    <section
      className="session-terminal-tool"
      data-testid="session-terminal-tool"
      data-terminal-id={item.id}
    >
      <header>
        <span>
          <Ic name="terminal" size={13} /> {item.title}
        </span>
        <small>{item.contextLabel}</small>
        <span className={`session-terminal-state ${item.exited ? 'ended' : ''}`}>
          {item.exited ? 'Ended' : 'Live'}
        </span>
      </header>
      <div ref={hostRef} className="session-terminal-host" />
    </section>
  );
}
