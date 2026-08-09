import { getLocale, hasSimplifiedChineseTranslation, t } from './i18n.js';

const LOCALIZED_ATTRIBUTES = ['aria-label', 'placeholder', 'title'] as const;
const CONTENT_BOUNDARY = [
  '.xterm',
  '.terminal-host',
  '.markdown-body',
  '.md-content',
  '.rt-user-turn',
  '.rt-assistant-copy',
  '.tr-user-copy',
  '.tr-agent-copy',
  'pre',
  'code',
  '[data-i18n-ignore]',
  // Identifiers are data, never copy: a branch, file, or project whose name
  // happens to match a catalog key (e.g. a branch called "main") must render
  // verbatim. `.mono` is the app-wide identifier convention; the tree rows
  // carry only file names. Mixed containers mark their data nodes with
  // [data-i18n-ignore] instead of a class-wide boundary.
  '.mono',
  '.pt-row',
  '.pc-tree-row',
  '.pc-header-git',
].join(',');

function belongsToProductChrome(node: Node, root: HTMLElement): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element || !root.contains(element)) return false;
  return element.closest(CONTENT_BOUNDARY) === null;
}

function translateTextNode(node: Text, root: HTMLElement): void {
  if (!belongsToProductChrome(node, root)) return;
  const value = node.data;
  const message = value.trim();
  if (!message || !hasSimplifiedChineseTranslation(message)) return;
  const translated = t(message);
  if (translated === message) return;
  const start = value.slice(0, value.indexOf(message));
  const end = value.slice(value.indexOf(message) + message.length);
  node.data = `${start}${translated}${end}`;
}

function translateElement(element: Element, root: HTMLElement): void {
  if (!belongsToProductChrome(element, root)) return;
  for (const name of LOCALIZED_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value && hasSimplifiedChineseTranslation(value)) element.setAttribute(name, t(value));
  }
}

function translateTree(root: HTMLElement, target: Node): void {
  if (target instanceof Text) {
    translateTextNode(target, root);
    return;
  }
  if (!(target instanceof Element)) return;
  translateElement(target, root);
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node instanceof Text) translateTextNode(node, root);
    else if (node instanceof Element) translateElement(node, root);
    node = walker.nextNode();
  }
}

/**
 * Compatibility layer for fixed JSX copy while call sites move to `t()`.
 * It only recognizes audited catalog entries and explicitly excludes user,
 * agent, Markdown, code, and terminal content.
 */
export function observeLocalizedChrome(root: HTMLElement): () => void {
  if (getLocale() !== 'zh-CN') return () => undefined;
  translateTree(root, root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateTree(root, record.target);
      if (record.type === 'attributes' && record.target instanceof Element) {
        translateElement(record.target, root);
      }
      for (const added of record.addedNodes) translateTree(root, added);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...LOCALIZED_ATTRIBUTES],
  });
  return () => observer.disconnect();
}
