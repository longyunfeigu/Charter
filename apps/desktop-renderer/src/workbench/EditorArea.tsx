import React, { useEffect, useRef, useState } from 'react';
import { monaco, modelUri } from '../monaco-setup.js';
import { useEditorStore, type EditorGroup } from '../store/editorStore.js';
import { useWorkspaceStore } from '../store/workspaceStore.js';
import { useAppStore } from '../store/appStore.js';
import { WelcomeView } from '../views/WelcomeView.js';
import { rpcResult } from '../bridge.js';
import { editorBannerRegistry } from './Workbench.js';
import { triggerRename } from '../contrib/intelligence.js';

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

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
  const settings = useAppStore((s) => s.settings);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setActiveLanguage = useEditorStore((s) => s.setActiveLanguage);
  const setActiveGroup = useEditorStore((s) => s.setActiveGroup);
  const docs = useEditorStore((s) => s.docs);
  const active = group.active;
  const meta = active ? docs[active] : undefined;

  useEffect(() => {
    if (!containerRef.current || editorRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: true,
      fontSize: settings?.editor.fontSize ?? 13,
      fontFamily: settings?.editor.fontFamily,
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
      theme: document.documentElement.dataset.theme === 'light' ? 'pi-light' : 'pi-dark',
    });
    editorRef.current = editor;
    // Product rename flow (preview + version checks) replaces Monaco's inline rename.
    editor.addCommand(monaco.KeyCode.F2, () => {
      void triggerRename();
    });
    editor.onDidChangeCursorPosition((e) => {
      setCursor(e.position.lineNumber, e.position.column);
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

  // Apply editor settings live.
  useEffect(() => {
    if (!editorRef.current || !settings) return;
    editorRef.current.updateOptions({
      fontSize: settings.editor.fontSize,
      fontFamily: settings.editor.fontFamily,
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
  }, [active, meta?.editable, meta?.readonly, setActiveLanguage]);

  return (
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        data-testid={`monaco-pane-${groupIndex}`}
      />
      {active && meta && !meta.editable ? (
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
        theme: document.documentElement.dataset.theme === 'light' ? 'pi-light' : 'pi-dark',
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
