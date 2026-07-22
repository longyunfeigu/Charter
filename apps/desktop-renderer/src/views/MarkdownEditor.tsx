import './prism-setup.js';
import React, { useEffect, useRef, useState } from 'react';
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
  CodeToggle,
  StrikeThroughSupSubToggles,
  Separator,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  InsertImage,
  imagePlugin,
  useCodeBlockEditorContext,
  type MDXEditorMethods,
  type CodeBlockEditorDescriptor,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';
import '../styles/markdown-editor.css';
import { monaco, modelUri } from '../monaco-setup.js';
import { replaceModelContent } from '../store/editorStore.js';

const CODE_LANGUAGES = [
  ['', 'Plain text'],
  ['bash', 'Bash / shell'],
  ['css', 'CSS'],
  ['diff', 'Diff'],
  ['go', 'Go'],
  ['html', 'HTML'],
  ['javascript', 'JavaScript'],
  ['json', 'JSON'],
  ['markdown', 'Markdown'],
  ['python', 'Python'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['typescript', 'TypeScript'],
  ['yaml', 'YAML'],
] as const;

const SLASH_COMMANDS = [
  { label: 'Heading 2', hint: 'Section heading', markdown: '## ' },
  { label: 'Bulleted list', hint: 'Start a list', markdown: '- ' },
  { label: 'Task item', hint: 'Unchecked task', markdown: '- [ ] ' },
  { label: 'Quote', hint: 'Callout or quotation', markdown: '> ' },
  { label: 'Code block', hint: 'Fenced code', markdown: '\n```\n\n```\n' },
  {
    label: 'Table',
    hint: 'Three-column table',
    markdown: '\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n',
  },
  { label: 'Divider', hint: 'Thematic break', markdown: '\n---\n' },
] as const;

interface FloatingPosition {
  top: number;
  left: number;
}

/** Dependency-free code block editing (ADR-0007: no CodeMirror). */
const PlainCodeEditor: CodeBlockEditorDescriptor = {
  match: () => true,
  priority: 0,
  Editor: (props) => {
    const { setCode, setLanguage } = useCodeBlockEditorContext();
    const knownLanguage = CODE_LANGUAGES.some(([value]) => value === props.language);
    return (
      <div
        onKeyDown={(event) => {
          const save = (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's';
          if (!save) event.nativeEvent.stopImmediatePropagation();
        }}
        className="md-plain-code"
      >
        <div className="md-plain-code-bar">
          <label>
            <span>Language</span>
            <select
              aria-label="Code block language"
              value={props.language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              {!knownLanguage && props.language ? (
                <option value={props.language}>{props.language}</option>
              ) : null}
              {CODE_LANGUAGES.map(([value, label]) => (
                <option key={value || 'plain'} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <span>fenced code</span>
        </div>
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
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const applyingFromRich = useRef(false);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The serializer's normalized form of content both sides agree on. A change
   * equal to this is a normalization echo (must NOT dirty the file); anything
   * else is a real edit — including edits made the instant the editor mounts. */
  const baseline = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark');
  const [slashMenu, setSlashMenu] = useState<FloatingPosition | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [selectionToolbar, setSelectionToolbar] = useState<FloatingPosition | null>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme === 'dark');
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-skin'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = (): void => {
      const host = hostRef.current;
      const selection = window.getSelection();
      if (!host || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionToolbar(null);
        return;
      }
      const anchor = selection.anchorNode;
      if (!anchor || !host.contains(anchor)) {
        setSelectionToolbar(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      setSelectionToolbar({
        top: Math.max(48, rect.top - hostRect.top - 42),
        left: Math.min(
          Math.max(12, rect.left - hostRect.left + rect.width / 2),
          hostRect.width - 12,
        ),
      });
    };
    document.addEventListener('selectionchange', update);
    return () => document.removeEventListener('selectionchange', update);
  }, []);

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

  const commit = (markdown: string): void => {
    if (norm(model.getValue()) === norm(markdown)) return;
    applyingFromRich.current = true;
    try {
      // Undo-preserving replacement; the model listener drives dirty/mirror.
      replaceModelContent(model, markdown);
    } finally {
      applyingFromRich.current = false;
    }
  };

  const flushPending = (): void => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = null;
    if (pending.current !== null) commit(pending.current);
  };

  const push = (markdown: string): void => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      commit(markdown);
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

  const openSlashMenu = (): void => {
    const host = hostRef.current;
    const selection = window.getSelection();
    const hostRect = host?.getBoundingClientRect();
    const rangeRect = selection?.rangeCount
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
    setSlashIndex(0);
    setSlashMenu({
      top: hostRect && rangeRect ? Math.max(52, rangeRect.bottom - hostRect.top + 8) : 64,
      left:
        hostRect && rangeRect
          ? Math.min(Math.max(12, rangeRect.left - hostRect.left), hostRect.width - 292)
          : 24,
    });
  };

  const runSlashCommand = (index: number): void => {
    const command = SLASH_COMMANDS[index];
    if (!command) return;
    editorRef.current?.insertMarkdown(command.markdown);
    setSlashMenu(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  };

  const applySelectionFormat = (label: string): void => {
    hostRef.current
      ?.querySelector<HTMLElement>(`.mdxeditor-toolbar [aria-label="${label}"]`)
      ?.click();
  };

  return (
    <div
      ref={hostRef}
      className="md-rich-host"
      data-testid="md-rich-editor"
      onKeyDownCapture={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
          // The global save command must see the latest rich-editor value, even
          // when it lands inside the 200ms model-update coalescing window.
          flushPending();
        }
        if (slashMenu) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            setSlashIndex(
              (index) => (index + direction + SLASH_COMMANDS.length) % SLASH_COMMANDS.length,
            );
          } else if (event.key === 'Enter') {
            event.preventDefault();
            runSlashCommand(slashIndex);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setSlashMenu(null);
          } else if (event.key === '/') {
            event.preventDefault();
            setSlashMenu(null);
            editorRef.current?.insertMarkdown('/');
          }
          return;
        }
        const target = event.target;
        if (
          event.key === '/' &&
          !event.metaKey &&
          !event.ctrlKey &&
          target instanceof HTMLElement &&
          target.closest('.md-rich-content') &&
          !target.closest('.md-plain-code')
        ) {
          event.preventDefault();
          openSlashMenu();
        }
      }}
    >
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
          imagePlugin(),
          codeBlockPlugin({ codeBlockEditorDescriptors: [PlainCodeEditor] }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BoldItalicUnderlineToggles />
                <CodeToggle />
                <StrikeThroughSupSubToggles options={['Strikethrough']} />
                <Separator />
                <BlockTypeSelect />
                <ListsToggle />
                <CreateLink />
                <Separator />
                <InsertCodeBlock />
                <InsertTable />
                <InsertThematicBreak />
                <InsertImage />
              </>
            ),
          }),
        ]}
      />
      {slashMenu ? (
        <div
          className="md-slash-menu"
          data-testid="md-slash-menu"
          role="listbox"
          aria-label="Insert block"
          style={{ top: slashMenu.top, left: slashMenu.left }}
        >
          <div className="md-slash-title">Insert block</div>
          {SLASH_COMMANDS.map((command, index) => (
            <button
              key={command.label}
              type="button"
              role="option"
              aria-selected={index === slashIndex}
              className={index === slashIndex ? 'active' : ''}
              onMouseEnter={() => setSlashIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runSlashCommand(index)}
            >
              <strong>{command.label}</strong>
              <span>{command.hint}</span>
            </button>
          ))}
          <div className="md-slash-foot">↑↓ choose · Enter insert · / type slash</div>
        </div>
      ) : null}
      {selectionToolbar ? (
        <div
          className="md-selection-toolbar"
          data-testid="md-selection-toolbar"
          style={{ top: selectionToolbar.top, left: selectionToolbar.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            aria-label="Bold selection"
            onClick={() => applySelectionFormat('Bold')}
          >
            B
          </button>
          <button
            type="button"
            aria-label="Italicize selection"
            onClick={() => applySelectionFormat('Italic')}
          >
            <i>I</i>
          </button>
          <button
            type="button"
            aria-label="Code format selection"
            onClick={() => applySelectionFormat('Inline code format')}
          >
            {'</>'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
