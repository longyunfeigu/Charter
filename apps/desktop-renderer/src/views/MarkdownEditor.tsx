import './prism-setup.js';
import React, { useEffect, useRef } from 'react';
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  markdownShortcutPlugin,
  codeBlockPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
  useCodeBlockEditorContext,
  type MDXEditorMethods,
  type CodeBlockEditorDescriptor,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import '../styles/markdown-editor.css';
import { monaco, modelUri } from '../monaco-setup.js';
import { replaceModelContent } from '../store/editorStore.js';
import { useAppStore } from '../store/appStore.js';

/** Dependency-free code block editing (ADR-0007: no CodeMirror). */
const PlainCodeEditor: CodeBlockEditorDescriptor = {
  match: () => true,
  priority: 0,
  Editor: (props) => {
    const { setCode } = useCodeBlockEditorContext();
    return (
      <div onKeyDown={(e) => e.nativeEvent.stopImmediatePropagation()} className="md-plain-code">
        <textarea
          rows={Math.min(18, Math.max(3, props.code.split('\n').length + 1))}
          defaultValue={props.code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  },
};

const norm = (text: string): string => text.replace(/\r\n/g, '\n');

/**
 * Notion-style rich editing for .md files (PIVOT-019, ADR-0007). Edits write
 * through the SAME Monaco model the source view uses, so dirty state, the
 * doc.update mirror, ⌘S save, autosave and the external-change/conflict flow
 * are the exact code paths the plain editor already guarantees.
 */
export function MarkdownEditor(props: { path: string }): React.JSX.Element | null {
  const model = monaco.editor.getModel(modelUri(props.path));
  const editorRef = useRef<MDXEditorMethods>(null);
  const applyingFromRich = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The serializer's normalized form of content both sides agree on. A change
   * equal to this is a normalization echo (must NOT dirty the file); anything
   * else is a real edit — including edits made the instant the editor mounts. */
  const baseline = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const dark =
    useAppStore((s) => s.settings?.general.theme) === 'dark' ||
    (useAppStore.getState().settings?.general.theme !== 'light' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  // Model → rich: external reloads and conflict resolutions update the view.
  useEffect(() => {
    if (!model) return;
    const listener = model.onDidChangeContent(() => {
      if (applyingFromRich.current) return;
      const value = model.getValue();
      const current = editorRef.current?.getMarkdown() ?? '';
      if (norm(current) !== norm(value)) {
        editorRef.current?.setMarkdown(value);
        baseline.current = norm(editorRef.current?.getMarkdown() ?? value);
      }
    });
    return () => listener.dispose();
  }, [model]);

  // Capture the post-init normalized baseline, then flush anything the user
  // managed to type while lexical was still initializing.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (baseline.current === null) {
        baseline.current = norm(editorRef.current?.getMarkdown() ?? model?.getValue() ?? '');
      }
      if (pending.current !== null && norm(pending.current) !== baseline.current) {
        push(pending.current);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      if (pushTimer.current) clearTimeout(pushTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!model) return null;

  const push = (markdown: string): void => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      if (norm(model.getValue()) === norm(markdown)) return;
      applyingFromRich.current = true;
      try {
        // Undo-preserving replacement; the model listener drives dirty/mirror.
        replaceModelContent(model, markdown);
      } finally {
        applyingFromRich.current = false;
      }
    }, 200);
  };

  const onChange = (markdown: string): void => {
    pending.current = markdown;
    // Before the baseline exists we cannot tell echo from edit — the init
    // effect flushes pending right after. Equal-to-baseline = echo, skip.
    if (baseline.current === null) return;
    if (norm(markdown) === baseline.current) return;
    push(markdown);
  };

  return (
    <div className="md-rich-host" data-testid="md-rich-editor">
      <MDXEditor
        ref={editorRef}
        markdown={model.getValue()}
        onChange={onChange}
        className={dark ? 'dark-theme md-rich' : 'md-rich'}
        contentEditableClassName="md-rich-content"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          tablePlugin(),
          codeBlockPlugin({ codeBlockEditorDescriptors: [PlainCodeEditor] }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
