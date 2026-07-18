import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    switch (label) {
      case 'json':
        return new jsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker();
      case 'typescript':
      case 'javascript':
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

interface SyntaxPalette {
  background: string;
  foreground: string;
  muted: string;
  faint: string;
  accent: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  fn: string;
  selection: string;
  line: string;
  added: string;
  removed: string;
  commentItalic?: boolean;
  keywordBold?: boolean;
}

function defineAppearanceTheme(name: string, base: 'vs' | 'vs-dark', palette: SyntaxPalette): void {
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      {
        token: 'comment',
        foreground: palette.muted,
        fontStyle: palette.commentItalic ? 'italic' : '',
      },
      {
        token: 'keyword',
        foreground: palette.keyword,
        fontStyle: palette.keywordBold ? 'bold' : '',
      },
      { token: 'keyword.control', foreground: palette.keyword },
      { token: 'string', foreground: palette.string },
      { token: 'string.escape', foreground: palette.accent },
      { token: 'number', foreground: palette.number },
      { token: 'type', foreground: palette.type },
      { token: 'type.identifier', foreground: palette.type },
      { token: 'identifier', foreground: palette.foreground },
      { token: 'variable', foreground: palette.foreground },
      { token: 'function', foreground: palette.fn },
      { token: 'regexp', foreground: palette.accent },
      { token: 'delimiter', foreground: palette.faint },
    ],
    colors: {
      'editor.background': palette.background,
      'editor.foreground': palette.foreground,
      'editorCursor.foreground': palette.accent,
      'editorLineNumber.foreground': palette.faint,
      'editorLineNumber.activeForeground': palette.foreground,
      'editor.lineHighlightBackground': palette.line,
      'editor.selectionBackground': palette.selection,
      'editor.inactiveSelectionBackground': palette.selection,
      'editorIndentGuide.background1': palette.line,
      'editorIndentGuide.activeBackground1': palette.muted,
      'editorWhitespace.foreground': palette.faint,
      'editorWidget.background': palette.background,
      'editorWidget.border': palette.faint,
      'editorHoverWidget.background': palette.background,
      'editorSuggestWidget.background': palette.background,
      'editorSuggestWidget.selectedBackground': palette.line,
      'input.background': palette.background,
      focusBorder: palette.accent,
      'editorGutter.addedBackground': palette.added,
      'editorGutter.modifiedBackground': palette.accent,
      'editorGutter.deletedBackground': palette.removed,
      'diffEditor.insertedTextBackground': `${palette.added}28`,
      'diffEditor.removedTextBackground': `${palette.removed}28`,
      'diffEditor.insertedLineBackground': `${palette.added}12`,
      'diffEditor.removedLineBackground': `${palette.removed}12`,
    },
  });
}

/* The original Studio skin deliberately keeps Monaco's native VS token
 * language and historical editor backgrounds. */
monaco.editor.defineTheme('charter-studio-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff' },
});
monaco.editor.defineTheme('charter-studio-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#1e1e1e' },
});

defineAppearanceTheme('charter-terminal-light', 'vs', {
  background: '#f0f6f1',
  foreground: '#102417',
  muted: '#5f7f67',
  faint: '#91aa96',
  accent: '#087c32',
  keyword: '#087c32',
  string: '#3c764b',
  number: '#8a5b0a',
  type: '#126b67',
  fn: '#183f25',
  selection: '#b9dcc2',
  line: '#e4eee6',
  added: '#21864a',
  removed: '#b63843',
});
defineAppearanceTheme('charter-terminal-dark', 'vs-dark', {
  background: '#0d120f',
  foreground: '#b9f6c8',
  muted: '#52705a',
  faint: '#2e4a36',
  accent: '#52ff78',
  keyword: '#52ff78',
  string: '#a8eeb8',
  number: '#e7c75f',
  type: '#5ce1d4',
  fn: '#e2ffe8',
  selection: '#245b32',
  line: '#111b15',
  added: '#52ff78',
  removed: '#ff6677',
});
defineAppearanceTheme('charter-archive-light', 'vs', {
  background: '#fbf2df',
  foreground: '#392a21',
  muted: '#9b7965',
  faint: '#bea38d',
  accent: '#b94e32',
  keyword: '#b94e32',
  string: '#52704c',
  number: '#9a602d',
  type: '#81513c',
  fn: '#315c68',
  /* Mock-blue text selection from the code-context design mocks (design-qa:
   * "the new blue text selection" is a deliberate feature of this skin). */
  selection: '#9fc6f3',
  line: '#f4e7cf',
  added: '#5e8158',
  removed: '#bd5138',
  commentItalic: true,
});
defineAppearanceTheme('charter-archive-dark', 'vs-dark', {
  background: '#291f19',
  foreground: '#f0dfbd',
  muted: '#927962',
  faint: '#594638',
  accent: '#ef7b57',
  keyword: '#ef7b57',
  string: '#a6c28f',
  number: '#e0ab65',
  type: '#d6a08a',
  fn: '#9cc6cc',
  selection: '#664434',
  line: '#30251e',
  added: '#8fb37d',
  removed: '#f17b67',
  commentItalic: true,
});
defineAppearanceTheme('charter-index-light', 'vs', {
  background: '#ffffff',
  foreground: '#0b0b0b',
  muted: '#777773',
  faint: '#b0b0ac',
  accent: '#d20f2f',
  keyword: '#d20f2f',
  string: '#20201e',
  number: '#8c1830',
  type: '#4c4c49',
  fn: '#0b0b0b',
  selection: '#f3cbd2',
  line: '#f4f4f2',
  added: '#247345',
  removed: '#d20f2f',
  keywordBold: true,
});
defineAppearanceTheme('charter-index-dark', 'vs-dark', {
  background: '#070707',
  foreground: '#f5f5f2',
  muted: '#787875',
  faint: '#3d3d3b',
  accent: '#ff304f',
  keyword: '#ff304f',
  string: '#f5f5f2',
  number: '#ff7d91',
  type: '#b6b6b2',
  fn: '#ffffff',
  selection: '#5a1521',
  line: '#111111',
  added: '#5ec986',
  removed: '#ff405c',
  keywordBold: true,
});

export function monacoThemeName(): string {
  const skin = document.documentElement.dataset.skin ?? 'studio';
  const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  return `charter-${skin}-${theme}`;
}

export function monacoFontFamily(): string {
  const style = getComputedStyle(document.documentElement);
  return (
    style.getPropertyValue('--font-editor').trim() ||
    style.getPropertyValue('--font-mono').trim() ||
    "'SFMono-Regular', Menlo, Monaco, Consolas, monospace"
  );
}

export function applyMonacoTheme(): void {
  monaco.editor.setTheme(monacoThemeName());
  const fontFamily = monacoFontFamily();
  for (const editor of monaco.editor.getEditors()) editor.updateOptions({ fontFamily });
}

new MutationObserver(applyMonacoTheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme', 'data-skin', 'style'],
});

applyMonacoTheme();

export function modelUri(relativePath: string): monaco.Uri {
  return monaco.Uri.from({ scheme: 'pi-ws', path: `/${relativePath}` });
}

export { monaco };
