import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeSetDto, TaskDto } from '@pi-ide/ipc-contracts';
import { useAppStore, type SessionTool } from '../store/appStore.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { currentActionLine, useActivityStore } from '../store/activityStore.js';
import { FilePeek } from './FilePeek.js';
import { RoomPreviewRail } from './RoomPreviewRail.js';
import { ReviewChecks } from './ReviewChecks.js';
import { ConfirmDangerButton } from './ui.js';
import { Ic } from './home-icons.js';
import { mountTerminal, observeTerminalFit, useTerminalStore } from './TerminalPanel.js';
import { isAnswered, presentedMeta } from './labels.js';
import { roomCopyFor } from './roomCopy.js';
import { LiveBoard } from './LiveBoard.js';
import { monaco } from '../monaco-setup.js';
import { addCodeContext } from '../codeContext.js';
import { CodeContextFloat } from './CodeContextFloat.js';

export interface SessionVerification {
  label: string;
  state: string;
}

export interface SessionFileStat {
  additions: number;
  deletions: number;
}

const SESSION_TABS: Array<{ id: SessionTool; label: string; icon: string }> = [
  { id: 'file', label: 'File', icon: 'file' },
  { id: 'diff', label: 'Diff', icon: 'file' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
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
  const expanded = useAppStore((state) => state.sessionToolExpanded);
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
    } else if (task.state === 'ROLLED_BACK' && current.sessionTool === 'review') {
      // The proposed change set no longer exists after rollback. Preserve the
      // timeline record, but retire the active review surface immediately.
      current.setSessionTool('summary');
    }
  }, [task.state, task.id, files.length]);

  const chooseTool = (next: SessionTool): void => {
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
      className={`session-tool-canvas ${expanded ? 'expanded' : ''}`}
      data-testid="session-tool-canvas"
      data-task-id={task.id}
      data-active-tool={tool}
      aria-label="Session tools"
    >
      <header className="session-tool-tabs">
        <div className="session-tool-tablist" role="tablist" aria-label="Session tools">
          {toolTabs.map((item) => {
            const active = item.id === tool;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={active ? 'active' : ''}
                data-testid={`session-tool-${item.id}`}
                disabled={(item.id === 'diff' || item.id === 'file') && files.length === 0}
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
          className="session-tool-expand"
          data-testid="session-tool-expand"
          aria-pressed={expanded}
          title={expanded ? 'Restore balanced Session view' : 'Give the tool canvas more room'}
          onClick={() => app.setSessionToolExpanded(!expanded)}
        >
          <Ic name="layout" size={13} />
          <span>{expanded ? 'Balance' : 'Expand'}</span>
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

      <SessionActionDock task={task} files={files} />
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
  'working-tree': '新版本',
  baseline: '旧版本',
  'diff-patch': 'diff 片段',
};

function SessionDiffReview(props: {
  task: TaskDto;
  files: string[];
  fileStats: Record<string, SessionFileStat>;
  verifications: SessionVerification[];
}): React.JSX.Element {
  const store = useTaskStore();
  const app = useAppStore();
  const peek = useAppStore((state) => state.peek);
  const diffBodyRef = useRef<HTMLDivElement>(null);
  const diffCardRef = useRef<HTMLElement>(null);
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

  const changeSet = store.changeSet?.taskId === props.task.id ? store.changeSet : null;
  const changeFiles = changeSet?.files ?? [];
  const requestedPath = peek?.taskId === props.task.id ? peek.active : null;
  const selected =
    changeFiles.find((file) => file.path === requestedPath) ?? changeFiles[0] ?? null;

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

  const additions =
    changeSet?.totalAdditions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.additions, 0);
  const deletions =
    changeSet?.totalDeletions ??
    Object.values(props.fileStats).reduce((sum, stat) => sum + stat.deletions, 0);

  const selectFile = (path: string): void => app.openPeek(props.task.id, path, 'diff');
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
            {props.files.length} file{props.files.length === 1 ? '' : 's'} changed
          </h2>
          <span className="session-diff-grand-total mono">
            <i className="plus">+{additions}</i> <i className="minus">−{deletions}</i>
          </span>
        </header>
        <div className="session-diff-file-list">
          {(changeFiles.length > 0 ? changeFiles : props.files).map((entry) => {
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

      {store.loadingChangeSet && !selected ? (
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
            <button type="button" aria-label="Copy diff" title="Copy diff" onClick={copyPatch}>
              <Ic name="clipboard" size={15} />
            </button>
            <button
              type="button"
              aria-label="Open advanced review"
              title="Open advanced review"
              onClick={() => void store.openReview()}
            >
              <Ic name="sliders" size={15} />
            </button>
          </header>
          {selected.binary ? (
            <div className="session-diff-loading">Binary file — no inline text diff.</div>
          ) : selected.hunks.length === 0 ? (
            <div className="session-diff-loading">No text hunks recorded for this file.</div>
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
              label={`已选 ${contextSelection.rowEnd - contextSelection.rowStart + 1} 行 · ${DIFF_VERSION_LABEL[contextSelection.version]}`}
              style={{ top: contextSelection.anchorTop }}
              onAttach={() => void attachDiffSelection()}
            />
          ) : null}
        </section>
      ) : (
        <div className="session-diff-loading">No reviewable text changes were recorded.</div>
      )}

      <SessionDiffVerification task={props.task} verifications={props.verifications} />
    </div>
  );
}

function SessionDiffVerification(props: {
  task: TaskDto;
  verifications: SessionVerification[];
}): React.JSX.Element {
  const store = useTaskStore();
  const configured = props.task.verification.length > 0;
  const passed = props.verifications.filter((item) => item.state === 'passed').length;
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
  const liveLabel = streamingThinking
    ? 'Thinking through the next change…'
    : (current?.label ??
      (streaming
        ? 'Composing the next update…'
        : (action?.label ??
          (props.task.state === 'REVIEW_READY'
            ? 'The change set is ready for your decision.'
            : 'No action is currently running.'))));

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
  const store = useTaskStore();
  const copy = roomCopyFor(`${props.task.title}\n${props.task.goalMd}`);

  useEffect(() => {
    if (props.task.state === 'REVIEW_READY' || props.files.length > 0) {
      void store.refreshChangeSet();
    }
    // task id is the refresh boundary; event updates refresh through the review overlay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task.id]);

  const changeSet = store.changeSet?.taskId === props.task.id ? store.changeSet : null;

  const report = useMemo(() => {
    for (let index = store.timeline.length - 1; index >= 0; index -= 1) {
      const event = store.timeline[index]!;
      if (event.type === 'report.final') return event.payload as Record<string, unknown>;
    }
    return null;
  }, [store.timeline]);

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
        <span className="session-review-icon">
          <Ic name="check" size={16} />
        </span>
        <div>
          <span>{copy.reviewReady}</span>
          <strong>
            {props.files.length} file{props.files.length === 1 ? '' : 's'} changed
          </strong>
          <p>{copy.evidenceNote}</p>
        </div>
        <span className="session-diff-total mono">
          <i className="plus">+{additions}</i> <i className="minus">−{deletions}</i>
        </span>
      </section>

      {agentSummary ? (
        <section className="session-review-narrative">
          <h3>Outcome</h3>
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
  const store = useTaskStore();
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
              const passed = verification.state === 'passed';
              return (
                <div key={verification.label}>
                  <Ic name={passed ? 'check' : 'alert'} size={12} />
                  <span>{verification.label}</span>
                  <strong className={passed ? 'ok' : 'bad'}>
                    {passed ? 'Passed' : verification.state}
                  </strong>
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

function SessionActionDock({ task, files }: { task: TaskDto; files: string[] }): React.JSX.Element {
  const store = useTaskStore();
  const app = useAppStore();
  const running = RUNNING_TASK_STATES.has(task.state);
  const answered = isAnswered(task);

  if (task.state === 'REVIEW_READY' && !answered) {
    return (
      <footer className="session-action-dock review-decision" data-testid="session-action-dock">
        {task.external ? (
          <button
            type="button"
            className="btn"
            data-testid="task-resume"
            onClick={() => void store.resumeTask(task.id)}
          >
            Resume {task.external.cli === 'claude' ? 'Claude' : 'Codex'} session
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            data-testid="session-request-changes"
            onClick={() => {
              app.setSessionTool('summary');
              app.focusComposer();
            }}
          >
            Request changes
          </button>
        )}
        <ConfirmDangerButton
          label={task.worktree ? 'Discard worktree' : 'Rollback'}
          confirmLabel={task.worktree ? 'Confirm — discard worktree' : 'Confirm — roll back'}
          testid="task-rollback"
          quiet
          icon="undo"
          onConfirm={() => void store.rollbackTask()}
        />
        <button
          type="button"
          className="btn primary session-approve"
          data-testid="review-bar-accept"
          onClick={() => void store.acceptTask()}
        >
          <Ic name="checkCircle" size={15} /> Approve changes
        </button>
      </footer>
    );
  }

  if (task.state === 'REVIEW_READY' && answered) {
    return (
      <footer className="session-action-dock" data-testid="session-action-dock">
        <span className="session-action-note" data-testid="task-room-answered">
          Answer complete · no file changes
        </span>
        {task.external ? (
          <button
            className="btn"
            data-testid="task-resume"
            onClick={() => void store.resumeTask(task.id)}
          >
            Resume {task.external.cli === 'claude' ? 'Claude' : 'Codex'} session
          </button>
        ) : null}
        <button
          className="btn primary"
          data-testid="task-done"
          onClick={() => void store.acceptTask()}
        >
          Done
        </button>
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
            testid="task-rollback"
            quiet
            onConfirm={() => void store.rollbackTask()}
          />
        ) : null}
        <span className="session-action-note">The Session stopped before completion.</span>
        <button
          className="btn primary"
          data-testid="task-resume"
          onClick={() => void store.resumeTask(task.id)}
        >
          Resume
        </button>
      </footer>
    );
  }

  if (running) {
    return (
      <footer className="session-action-dock compact" data-testid="session-action-dock">
        <span className="session-action-live">
          <i /> Agent working
        </span>
        <span className="session-action-note">You can steer it from the composer.</span>
        {!task.external ? (
          <button className="btn danger" data-testid="agent-stop" onClick={() => void store.stop()}>
            Stop
          </button>
        ) : null}
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
          testid="task-rollback"
          quiet
          onConfirm={() => void store.rollbackTask()}
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
