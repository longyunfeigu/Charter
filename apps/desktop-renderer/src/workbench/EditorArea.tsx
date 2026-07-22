import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '@pi-ide/foundation';
import { monaco, modelUri, monacoFontFamily, monacoThemeName } from '../monaco-setup.js';
import { useEditorStore, isMdRich, type EditorGroup } from '../store/editorStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useAppStore } from '../store/appStore.js';
import { useGitStatusStore, MARK_COLOR } from '../store/gitStatusStore.js';
import { parseGutterRanges, toDecorations } from './gutter-diff.js';
import { WelcomeView } from '../views/WelcomeView.js';
import { ImageView } from '../views/ImageView.js';
import { editorFontFamily } from '../appearance.js';
import { addCodeContext } from '../codeContext.js';
import { CodeContextFloat, codeContextFloatRange } from '../views/CodeContextFloat.js';

// Rich markdown pulls lexical/mdast (ADR-0007) — loaded only when first used.
const MarkdownEditor = React.lazy(() =>
  import('../views/MarkdownEditor.js').then((m) => ({ default: m.MarkdownEditor })),
);

/** A rich-editor crash must never take the workbench down — fail to a hint. */
class RichEditorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    void import('../store/appStore.js').then(({ reportClientError }) =>
      reportClientError('MD_RICH_CRASH', errorMessage(error)),
    );
  }
  override render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div
          className="empty-state"
          style={{ position: 'absolute', inset: 0, zIndex: 3, background: 'var(--bg-editor)' }}
          data-testid="md-rich-error"
        >
          <div className="es-title">Rich editor failed to load</div>
          <div>Switch back to Source view — your file is untouched.</div>
        </div>
      );
    }
    return this.props.children;
  }
}
import { rpcResult } from '../bridge.js';
import { editorBannerRegistry } from './Workbench.js';
import { triggerRename } from '../contrib/intelligence.js';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

/** Git status letter on a tab (ADR-0013 decorations). */
function TabGitMark({ path }: { path: string }): React.JSX.Element | null {
  const mark = useGitStatusStore((s) => s.byPath[path]);
  if (!mark) return null;
  return (
    <span
      className="mono"
      data-testid={`tab-git-${path}`}
      title={`git: ${mark}`}
      style={{ color: MARK_COLOR[mark], fontSize: 10, fontWeight: 700 }}
    >
      {mark}
    </span>
  );
}

function MonacoPane({
  group,
  groupIndex,
}: {
  group: EditorGroup;
  groupIndex: number;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const currentPath = useRef<string | null>(null);
  const gutterDecos = useRef<string[]>([]);
  const gitVersion = useGitStatusStore((s) => s.version);
  const gitIsRepo = useGitStatusStore((s) => s.isRepo);
  const settings = useAppStore((s) => s.settings);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setActiveLanguage = useEditorStore((s) => s.setActiveLanguage);
  const setActiveGroup = useEditorStore((s) => s.setActiveGroup);
  const docs = useEditorStore((s) => s.docs);
  const mdRich = useEditorStore((s) => s.mdRich);
  const toggleMdRich = useEditorStore((s) => s.toggleMdRich);
  const active = group.active;
  const meta = active ? docs[active] : undefined;
  const taskRoomTaskId = useAppStore((state) => state.taskRoomTaskId);
  const [codeSelection, setCodeSelection] = useState<{
    path: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    text: string;
  } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const codeSelectionRef = useRef(codeSelection);
  const floatMinTopRef = useRef(6);

  // Anchor the floating action to the end of the selection, mock-style:
  // bubble bottom sits on the selected range, caret points down, right: 18px.
  // Clamped inside the pane so the action stays reachable after scrolling;
  // the minimum top drops below the md Rich/Source toggle when it is shown.
  const positionFloat = useCallback((): void => {
    const editor = editorRef.current;
    const bubble = floatRef.current;
    const sel = codeSelectionRef.current;
    if (!editor || !bubble || !sel) return;
    const pos = editor.getScrolledVisiblePosition({
      lineNumber: sel.endLine,
      column: sel.endColumn,
    });
    if (!pos) return;
    const height = editor.getLayoutInfo().height;
    const minTop = floatMinTopRef.current;
    const top = Math.min(
      Math.max(pos.top + pos.height - 36, minTop),
      Math.max(minTop, height - 42),
    );
    bubble.style.top = `${top}px`;
  }, []);

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      fontSize: settings?.editor.fontSize ?? 13,
      fontFamily: editorFontFamily(settings?.editor.fontFamily),
      lineHeight: Math.round(
        (settings?.editor.fontSize ?? 13) * (settings?.editor.lineHeight ?? 1.55),
      ),
      tabSize: settings?.editor.tabSize ?? 2,
      insertSpaces: settings?.editor.insertSpaces ?? true,
      wordWrap: settings?.editor.wordWrap ?? 'off',
      minimap: { enabled: settings?.editor.minimap ?? true },
      renderWhitespace: settings?.editor.renderWhitespace ?? 'none',
      scrollBeyondLastLine: false,
      folding: true,
      multiCursorModifier: 'alt',
      theme: monacoThemeName(),
    });
    editorRef.current = editor;
    editor.onDidScrollChange(() => positionFloat());
    editor.onDidLayoutChange(() => positionFloat());
    // Product rename flow (preview + version checks) replaces Monaco's inline rename.
    editor.addCommand(monaco.KeyCode.F2, () => {
      void triggerRename();
    });
    editor.onDidChangeCursorPosition((e) => {
      setCursor(e.position.lineNumber, e.position.column);
    });
    editor.onDidChangeCursorSelection(({ selection }) => {
      const path = currentPath.current;
      const model = editor.getModel();
      if (!path || !model || selection.isEmpty()) {
        setCodeSelection(null);
        return;
      }
      const text = model.getValueInRange(selection);
      setCodeSelection(
        text
          ? {
              path,
              startLine: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLine: selection.endLineNumber,
              endColumn: selection.endColumn,
              text,
            }
          : null,
      );
    });
    editor.onDidFocusEditorText(() => {
      setActiveGroup(groupIndex);
      const model = editor.getModel();
      setActiveLanguage(model ? model.getLanguageId() : null);
    });
    return () => {
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ADR-0013: gutter change bars vs the git index — refreshed when the file
  // is (re)opened, saved (dirty→clean), or the watcher bumps the git status.
  const activeDirty = meta?.dirty === true;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !active || !gitIsRepo || activeDirty) return;
    let cancelled = false;
    void rpcResult('git.diffFile', { path: active, staged: false }).then((res) => {
      const model = editor.getModel();
      if (cancelled || !model || currentPath.current !== active) return;
      const diff = res.ok ? res.data.diff : '';
      gutterDecos.current = model.deltaDecorations(
        gutterDecos.current,
        toDecorations(parseGutterRanges(diff ?? '')),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [active, activeDirty, gitVersion, gitIsRepo]);

  // Apply editor settings live.
  useEffect(() => {
    if (!editorRef.current || !settings) return;
    editorRef.current.updateOptions({
      fontSize: settings.editor.fontSize,
      fontFamily: editorFontFamily(settings.editor.fontFamily),
      lineHeight: Math.round(settings.editor.fontSize * settings.editor.lineHeight),
      tabSize: settings.editor.tabSize,
      insertSpaces: settings.editor.insertSpaces,
      wordWrap: settings.editor.wordWrap,
      minimap: { enabled: settings.editor.minimap },
      renderWhitespace: settings.editor.renderWhitespace,
    });
  }, [settings]);

  // Switch models when the active tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (currentPath.current && currentPath.current !== active) {
      viewStates.set(currentPath.current, editor.saveViewState());
    }
    if (active && meta?.editable) {
      const model = monaco.editor.getModel(modelUri(active));
      if (model && editor.getModel() !== model) {
        editor.setModel(model);
        const state = viewStates.get(active);
        if (state) editor.restoreViewState(state);
        setActiveLanguage(model.getLanguageId());
      }
      editor.updateOptions({ readOnly: Boolean(meta?.readonly) });
      currentPath.current = active;
    } else {
      editor.setModel(null);
      currentPath.current = active ?? null;
    }
    setCodeSelection(null);
  }, [active, meta?.editable, meta?.readonly, setActiveLanguage]);

  const richActive = Boolean(active && meta?.editable && isMdRich({ mdRich }, active));
  const mdToggleShown = Boolean(active && meta?.editable && active.toLowerCase().endsWith('.md'));

  useLayoutEffect(() => {
    codeSelectionRef.current = codeSelection;
    floatMinTopRef.current = mdToggleShown ? 46 : 6;
    positionFloat();
  }, [codeSelection, mdToggleShown, positionFloat]);

  return (
    <div
      className={richActive ? 'editor-pane md-rich-pane' : 'editor-pane'}
      style={{ flex: 1, minHeight: 0, position: 'relative' }}
    >
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        data-testid={`monaco-pane-${groupIndex}`}
      />
      {taskRoomTaskId && codeSelection && !richActive ? (
        <CodeContextFloat
          ref={floatRef}
          testid={`editor-code-selection-bar-${groupIndex}`}
          buttonTestid={`editor-add-code-context-${groupIndex}`}
          label={`Editor · ${codeContextFloatRange(codeSelection.startLine, codeSelection.endLine)}`}
          onAttach={() => {
            void addCodeContext(taskRoomTaskId, {
              ...codeSelection,
              origin: 'editor',
              version: 'working-tree',
              contentHash: null,
            }).then((ref) => {
              if (ref) editorRef.current?.setSelection(new monaco.Selection(1, 1, 1, 1));
            });
          }}
        />
      ) : null}
      {/* PIVOT-019: Notion-style editing for .md, one toggle away. */}
      {active && meta?.editable && active.toLowerCase().endsWith('.md') ? (
        <div className="md-mode-toggle" data-testid="md-mode-toggle">
          <button
            className={richActive ? 'on' : ''}
            data-testid="md-mode-rich"
            onClick={() => {
              if (!richActive) toggleMdRich(active);
            }}
          >
            ✨ Rich
          </button>
          <button
            className={richActive ? '' : 'on'}
            data-testid="md-mode-source"
            onClick={() => {
              if (richActive) toggleMdRich(active);
            }}
          >
            {'</>'} Source
          </button>
        </div>
      ) : null}
      {richActive && active ? (
        <RichEditorBoundary key={`b-${active}`}>
          <React.Suspense
            fallback={
              <div className="empty-state" style={{ position: 'absolute', inset: 0, zIndex: 3 }}>
                <div className="text-muted">Loading rich editor…</div>
              </div>
            }
          >
            <MarkdownEditor key={active} path={active} />
          </React.Suspense>
        </RichEditorBoundary>
      ) : null}
      {/* PIVOT-020: images get a preview + annotation instead of a dead end. */}
      {active && meta && !meta.editable && meta.binary && IMAGE_EXTENSIONS.test(active) ? (
        <ImageView path={active} />
      ) : active && meta && !meta.editable ? (
        <div
          className="empty-state"
          style={{ position: 'absolute', inset: 0, background: 'var(--bg-editor)' }}
        >
          <div className="es-title">{active.split('/').pop()}</div>
          <div>
            {meta.binary
              ? 'Binary file — open it with the system default application instead.'
              : `This file is too large to edit safely (${(meta.sizeBytes / 1024 / 1024).toFixed(1)} MB).`}
          </div>
        </div>
      ) : null}
      {!active ? (
        <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
          <div className="text-muted">No file open in this group</div>
          <button
            className="btn"
            data-testid="editor-empty-browse-files"
            style={{ marginTop: 10 }}
            onClick={() => useAppStore.getState().setRailView('files')}
          >
            Browse project files
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ConflictBar({ path }: { path: string }): React.JSX.Element | null {
  const docs = useEditorStore((s) => s.docs);
  const resolveConflict = useEditorStore((s) => s.resolveConflict);
  const setCompareWith = useEditorStore((s) => s.setCompareWith);
  const save = useEditorStore((s) => s.save);
  const meta = docs[path];
  if (!meta || meta.externalState === 'clean') return null;
  return (
    <div
      role="alert"
      data-testid="conflict-bar"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        padding: '6px 12px',
        background: 'var(--bg-card)',
        borderBottom: '2px solid var(--warning)',
        fontSize: 12,
      }}
    >
      <span style={{ flex: 1 }}>
        {meta.externalState === 'externallyDeleted'
          ? 'This file was deleted on disk. Your buffer is preserved — save to restore it, or close the tab to drop it.'
          : 'This file changed on disk while you have unsaved edits.'}
      </span>
      {meta.externalState === 'externallyModified' ? (
        <>
          <button
            className="btn"
            data-testid="conflict-compare"
            onClick={() => setCompareWith(path)}
          >
            Compare
          </button>
          <button
            className="btn"
            data-testid="conflict-reload"
            onClick={() => void resolveConflict(path, 'reload')}
          >
            Reload from disk
          </button>
          <button
            className="btn"
            data-testid="conflict-keep"
            onClick={() => void resolveConflict(path, 'keep')}
          >
            Keep my version
          </button>
        </>
      ) : (
        <button className="btn" onClick={() => void save(path)}>
          Save to restore
        </button>
      )}
    </div>
  );
}

function CompareOverlay(): React.JSX.Element | null {
  const compareWith = useEditorStore((s) => s.compareWith);
  const setCompareWith = useEditorStore((s) => s.setCompareWith);
  const resolveConflict = useEditorStore((s) => s.resolveConflict);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!compareWith || !hostRef.current) return;
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let diskModel: monaco.editor.ITextModel | null = null;
    let cancelled = false;
    void rpcResult('doc.readDisk', { path: compareWith }).then((res) => {
      if (cancelled || !hostRef.current) return;
      const diskContent = res.ok && res.data.exists ? res.data.content : '';
      const bufferModel = monaco.editor.getModel(modelUri(compareWith));
      diskModel = monaco.editor.createModel(diskContent, bufferModel?.getLanguageId());
      diffEditor = monaco.editor.createDiffEditor(hostRef.current, {
        automaticLayout: true,
        readOnly: false,
        originalEditable: false,
        renderSideBySide: true,
        fontFamily: monacoFontFamily(),
        theme: monacoThemeName(),
      });
      diffEditor.setModel({ original: diskModel, modified: bufferModel! });
    });
    return () => {
      cancelled = true;
      diffEditor?.dispose();
      diskModel?.dispose();
    };
  }, [compareWith]);

  if (!compareWith) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        style={{ width: '94vw', height: '86vh' }}
        data-testid="compare-overlay"
      >
        <div className="modal-header">
          <span>
            Disk ⟷ Your buffer — <span className="mono">{compareWith}</span>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={() => void resolveConflict(compareWith, 'reload')}>
              Take disk version
            </button>
            <button
              className="btn primary"
              onClick={() => void resolveConflict(compareWith, 'keep')}
            >
              Keep my version
            </button>
            <button className="modal-close" aria-label="Close" onClick={() => setCompareWith(null)}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body" style={{ overflow: 'hidden' }}>
          <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
        </div>
      </div>
    </div>
  );
}

function CloseDialog(): React.JSX.Element | null {
  const closeRequest = useEditorStore((s) => s.closeRequest);
  if (!closeRequest) return null;
  return (
    <div className="modal-backdrop">
      <div
        className="modal small"
        role="dialog"
        aria-label="Unsaved changes"
        data-testid="close-dialog"
      >
        <div className="modal-header">Unsaved changes</div>
        <div style={{ padding: 16 }}>
          <p>
            <span className="mono">{closeRequest.path}</span> has unsaved changes.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => closeRequest.resolve('cancel')}>
              Cancel
            </button>
            <button className="btn danger" onClick={() => closeRequest.resolve('discard')}>
              Don't save
            </button>
            <button className="btn primary" onClick={() => closeRequest.resolve('save')}>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabsRow({
  group,
  groupIndex,
}: {
  group: EditorGroup;
  groupIndex: number;
}): React.JSX.Element {
  const docs = useEditorStore((s) => s.docs);
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);
  const closeOthers = useEditorStore((s) => s.closeOthers);
  const closeSaved = useEditorStore((s) => s.closeSaved);
  const togglePin = useEditorStore((s) => s.togglePin);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        overflowX: 'auto',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-titlebar)',
        minHeight: 32,
      }}
    >
      {group.tabs.map((tab) => {
        const meta = docs[tab.path];
        const isActive = group.active === tab.path;
        const name = tab.path.split('/').pop();
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={isActive}
            data-testid={`tab-${tab.path}`}
            title={tab.path}
            onClick={() => setActive(tab.path, groupIndex)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, path: tab.path });
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeTab(tab.path, groupIndex);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 10px',
              cursor: 'pointer',
              borderRight: '1px solid var(--border)',
              background: isActive ? 'var(--bg-editor)' : 'transparent',
              color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
              whiteSpace: 'nowrap',
              fontSize: 12,
            }}
          >
            {tab.pinned ? <span aria-label="pinned">📌</span> : null}
            <span>{name}</span>
            <TabGitMark path={tab.path} />
            {meta?.externalState !== 'clean' && meta ? (
              <span className="text-warning" title="External change">
                ⚠
              </span>
            ) : null}
            <button
              aria-label={meta?.dirty ? `${name} has unsaved changes — close` : `Close ${name}`}
              className="modal-close"
              style={{ padding: '0 2px', fontSize: 12 }}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.path, groupIndex);
              }}
            >
              {meta?.dirty ? '●' : '✕'}
            </button>
          </div>
        );
      })}
      {menu ? (
        <>
          <div
            className="overlay-backdrop"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="quickpick"
            style={{ top: menu.y, left: menu.x, transform: 'none', width: 220 }}
            role="menu"
          >
            {[
              { label: 'Close', run: () => void closeTab(menu.path, groupIndex) },
              { label: 'Close Others', run: () => void closeOthers(menu.path, groupIndex) },
              { label: 'Close Saved', run: () => closeSaved(groupIndex) },
              { label: 'Pin / Unpin', run: () => togglePin(menu.path, groupIndex) },
            ].map((item) => (
              <button
                key={item.label}
                className="quickpick-item"
                role="menuitem"
                onClick={() => {
                  item.run();
                  setMenu(null);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function EditorArea(): React.JSX.Element {
  const workspace = useWorkspaceStore((s) => s.workspace);
  const groups = useEditorStore((s) => s.groups);

  if (!workspace) return <WelcomeView />;

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }} data-testid="editor-groups">
      {groups.map((group, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <div style={{ width: 1, background: 'var(--border)' }} /> : null}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <TabsRow group={group} groupIndex={i} />
            {group.active ? <ConflictBar path={group.active} /> : null}
            {i === 0 ? editorBannerRegistry.map((C, bi) => <C key={bi} />) : null}
            <MonacoPane group={group} groupIndex={i} />
          </div>
        </React.Fragment>
      ))}
      <CompareOverlay />
      <CloseDialog />
    </div>
  );
}
