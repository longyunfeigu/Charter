import React, { useEffect, useRef, useState } from 'react';
import type { ChangeSetDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { useActivityStore } from '../store/activityStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { monaco, monacoFontFamily } from '../monaco-setup.js';
import { EditorArea } from '../workbench/EditorArea.js';
import { Ic } from './home-icons.js';

/**
 * In-room file peek (ADR-0014, PIVOT-034): a resident split panel beside the
 * conversation — never a modal. Changes mode renders the task's recorded diff
 * for the active file; File mode shows the file's CURRENT logical content read
 * through the task's own mount (`task.peekFile` — worktree-honest, live editor
 * buffer when the mount is focused). Edit mode reuses the real workspace
 * document model in this resident slot. Worktree files remain read-only until
 * accepted because the focused workspace does not own their path.
 */
export function FilePeek(props: {
  taskId: string;
  worktree: boolean;
  editableInWorkspace: boolean;
  onOpenInEditor: (path: string) => void;
}): React.JSX.Element | null {
  const app = useAppStore();
  const peek = useAppStore((s) => s.peek);
  const [changeSet, setChangeSet] = useState<ChangeSetDto | null>(null);
  const [diffLoading, setDiffLoading] = useState(true);
  const [diffAttempt, setDiffAttempt] = useState(0);

  const active = peek && peek.taskId === props.taskId ? peek.active : null;
  const mode = peek?.mode ?? 'diff';

  // A write pulse can precede the committed change record — follow the stream.
  const pulseVersion = useActivityStore(
    (s) =>
      s.pulses.filter((p) => p.taskId === props.taskId && (!active || p.paths.includes(active)))
        .length,
  );

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void rpcResult('task.changeSet', { taskId: props.taskId }).then((res) => {
      if (!alive) return;
      setDiffLoading(false);
      if (res.ok) {
        setChangeSet(res.data.changeSet);
        const found = res.data.changeSet.files.some((f) => f.path === active);
        // The record may land moments after the pulse — retry briefly.
        if (!found && mode === 'diff' && diffAttempt < 6) {
          setTimeout(() => alive && setDiffAttempt((n) => n + 1), 350);
        }
      }
    });
    return () => {
      alive = false;
    };
  }, [props.taskId, active, mode, pulseVersion, diffAttempt]);

  // Escape closes the peek — unless something renders above it (lens overlay,
  // review/replay, palette/launcher, settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const appState = useAppStore.getState();
      const taskState = useTaskStore.getState();
      if (
        appState.lens ||
        appState.overlay !== 'none' ||
        appState.paletteOpen ||
        appState.launcherOpen ||
        taskState.reviewOpen ||
        taskState.replayRequest !== null
      ) {
        return;
      }
      e.stopPropagation();
      appState.closePeek();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (!peek || peek.taskId !== props.taskId || !active) return null;

  const file = changeSet?.files.find((f) => f.path === active) ?? null;

  return (
    <section
      className={`tr-peek ${mode === 'edit' ? 'editing' : ''}`}
      data-testid="file-peek"
      aria-label={`File peek — ${active}`}
    >
      <div className="tr-peek-head">
        <div className="tr-peek-tabs" role="tablist">
          {peek.paths.map((path) => (
            <span
              key={path}
              role="tab"
              tabIndex={0}
              aria-selected={path === active}
              className={`tr-peek-tab ${path === active ? 'on' : ''}`}
              title={path}
              data-testid={`peek-tab-${path}`}
              onClick={() => app.setPeekActive(path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') app.setPeekActive(path);
              }}
            >
              <Ic name="file" size={11} />
              <span className="tr-peek-tab-name">{path.split('/').pop()}</span>
              <button
                className="tr-peek-tab-x"
                aria-label={`Close ${path}`}
                data-testid={`peek-tab-close-${path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  app.closePeekTab(path);
                }}
              >
                <Ic name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
        <button
          className="tr-peek-close"
          data-testid="peek-close"
          aria-label="Close peek"
          title="Close (Esc)"
          onClick={app.closePeek}
        >
          <Ic name="x" size={13} />
        </button>
      </div>

      <div className="tr-peek-bar">
        <div className="tr-peek-seg" role="radiogroup" aria-label="Peek mode">
          <button
            className={mode === 'diff' ? 'on' : ''}
            role="radio"
            aria-checked={mode === 'diff'}
            data-testid="peek-mode-diff"
            onClick={() => app.setPeekMode('diff')}
          >
            Changes
          </button>
          <button
            className={mode === 'file' ? 'on' : ''}
            role="radio"
            aria-checked={mode === 'file'}
            data-testid="peek-mode-file"
            onClick={() => app.setPeekMode('file')}
          >
            File
          </button>
          <button
            className={mode === 'edit' ? 'on' : ''}
            role="radio"
            aria-checked={mode === 'edit'}
            data-testid="peek-mode-edit"
            disabled={!props.editableInWorkspace}
            title={
              props.editableInWorkspace
                ? 'Edit this file without leaving the Session'
                : props.worktree
                  ? 'Accept the isolated worktree before editing it in the focused workspace'
                  : 'Focus this task’s project to edit here'
            }
            onClick={() => app.setPeekMode('edit')}
          >
            Edit
          </button>
        </div>
        <span className="tr-peek-ro">{mode === 'edit' ? 'live buffer' : 'read-only'}</span>
        {file ? (
          <span className="tr-peek-stat mono">
            <i className="plus">+{file.additions}</i> <i className="minus">−{file.deletions}</i>
          </span>
        ) : null}
        <span className="tr-peek-sp" />
        {!props.worktree ? (
          <>
            {props.editableInWorkspace && mode !== 'edit' ? (
              <button
                className="ghostbtn"
                data-testid="peek-edit-here"
                title="Edit this file beside the running Session"
                onClick={() => app.setPeekMode('edit')}
              >
                <Ic name="pencil" size={11} />
                Edit here
              </button>
            ) : null}
            <button
              className="ghostbtn"
              data-testid="peek-open-editor"
              title="Open the same buffer in the full workspace"
              onClick={() => props.onOpenInEditor(active)}
            >
              <Ic name="layout" size={11} />
              Full workspace
            </button>
          </>
        ) : (
          <span
            className="tr-peek-wt"
            title="This task works in an isolated worktree — the project tree does not contain these changes until you accept"
          >
            worktree
          </span>
        )}
      </div>

      <div className="tr-peek-body" data-testid="peek-body">
        {mode === 'diff' ? (
          <PeekDiff loading={diffLoading} file={file} />
        ) : mode === 'file' ? (
          <PeekFile taskId={props.taskId} path={active} pulseVersion={pulseVersion} />
        ) : (
          <PeekEditor path={active} />
        )}
      </div>
    </section>
  );
}

/** The real shared document model, embedded in the Session instead of opening
 * a second app surface. EditorArea retains Markdown rich/source switching,
 * autosave, conflict handling and the normal tab model. */
function PeekEditor({ path }: { path: string }): React.JSX.Element {
  const openFile = useEditorStore((state) => state.openFile);
  useEffect(() => {
    void openFile(path);
  }, [openFile, path]);
  return (
    <div className="tr-peek-editor">
      <EditorArea />
    </div>
  );
}

function PeekDiff({
  loading,
  file,
}: {
  loading: boolean;
  file: ChangeSetDto['files'][number] | null;
}): React.JSX.Element {
  if (loading) return <div className="tr-peek-note">Computing the diff…</div>;
  if (!file) {
    return (
      <div className="tr-peek-note" data-testid="peek-no-diff">
        No recorded changes for this file in this task — switch to <b>File</b> to read it.
      </div>
    );
  }
  if (file.binary) return <div className="tr-peek-note">Binary file — no text diff.</div>;
  return (
    <div className="tr-peek-diff">
      {file.hunks.map((hunk) => (
        <div key={hunk.key} className="fl-hunk">
          <div className="fl-hunk-head mono">{hunk.header}</div>
          {hunk.lines.map((line, i) => (
            <div
              key={i}
              className={`mono fl-line ${
                line.startsWith('+') ? 'plus' : line.startsWith('-') ? 'minus' : ''
              }`}
            >
              {line || ' '}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface PeekFileDto {
  content: string | null;
  binary: boolean;
  missing: boolean;
  truncated: boolean;
  sizeBytes: number;
  fromBuffer: boolean;
}

/** Read-only Monaco view of the file's current content in the task's mount. */
function PeekFile({
  taskId,
  path,
  pulseVersion,
}: {
  taskId: string;
  path: string;
  pulseVersion: number;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [meta, setMeta] = useState<PeekFileDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void rpcResult('task.peekFile', { taskId, path }).then((res) => {
      if (!alive) return;
      setLoading(false);
      if (!res.ok) {
        setMeta({
          content: null,
          binary: false,
          missing: true,
          truncated: false,
          sizeBytes: 0,
          fromBuffer: false,
        });
        return;
      }
      setMeta(res.data);
    });
    return () => {
      alive = false;
    };
  }, [taskId, path, pulseVersion]);

  const text = meta?.content ?? null;

  useEffect(() => {
    if (text === null || !hostRef.current) return;
    const uri = monaco.Uri.from({ scheme: 'peek', path: `/${taskId}/${path}` });
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(text, undefined, uri);
    } else if (model.getValue() !== text) {
      model.setValue(text);
    }
    if (!editorRef.current) {
      editorRef.current = monaco.editor.create(hostRef.current, {
        model,
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderLineHighlight: 'none',
        occurrencesHighlight: 'off',
        contextmenu: false,
        fontSize: 12,
        fontFamily: monacoFontFamily(),
        lineNumbersMinChars: 3,
        folding: false,
        wordWrap: 'off',
      });
    } else if (editorRef.current.getModel() !== model) {
      editorRef.current.setModel(model);
    }
  }, [text, taskId, path]);

  // Theme flips repaint the whole app, but the editor's composited layer can
  // hold stale pixels in Electron — nudge a re-layout when data-theme changes.
  useEffect(() => {
    const observer = new MutationObserver(() => editorRef.current?.layout());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin'],
    });
    return () => observer.disconnect();
  }, []);

  // Dispose the editor and every peek model when the file view unmounts.
  useEffect(() => {
    return () => {
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const model of monaco.editor.getModels()) {
        if (model.uri.scheme === 'peek') model.dispose();
      }
    };
  }, []);

  if (loading && !meta) return <div className="tr-peek-note">Reading the file…</div>;
  if (meta?.missing) {
    return (
      <div className="tr-peek-note" data-testid="peek-missing">
        This file does not exist in the task's project right now (deleted, renamed, or outside the
        project).
      </div>
    );
  }
  if (meta?.binary) {
    return <div className="tr-peek-note">Binary file — no text preview.</div>;
  }
  return (
    <div className="tr-peek-file">
      {meta?.truncated ? (
        <div className="tr-peek-banner">Large file — showing the first 1 MB.</div>
      ) : null}
      {meta?.fromBuffer ? (
        <div className="tr-peek-banner info">Showing the unsaved editor buffer.</div>
      ) : null}
      <div ref={hostRef} className="tr-peek-monaco" data-testid="peek-monaco" />
    </div>
  );
}
