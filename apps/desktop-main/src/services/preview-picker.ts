/**
 * Element picker injected into the task's OWN loopback preview frame
 * (ADR-0022 am.2). Injection is main-process `webFrameMain.executeJavaScript`,
 * gated to frames whose URL is loopback + the task's detected port; the
 * renderer falls back to the zero-injection marquee when injection fails.
 *
 * The script is self-contained and self-cleaning: hover shows a halo + a
 * selector tag, click posts `{__charterPick}` to the parent window and cleans
 * up, Escape posts `{__charterPickCancel}` and cleans up. Re-injection first
 * runs any previous cleanup, so arming twice never stacks listeners.
 */
/**
 * The ONLY frame URLs the picker may be injected into: plain-http loopback on
 * the task's own detected port (matches the CSP frame-src grant exactly).
 * Pure so the security suite pins it (M11-01).
 */
export function isLoopbackPreviewUrl(rawUrl: string, port: number): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      Number(url.port) === port
    );
  } catch {
    return false; // frames without a URL (about:blank etc.) are never pick targets
  }
}

export const PICKER_JS = `(() => {
  if (window.__charterPickCleanup) window.__charterPickCleanup();
  const halo = document.createElement('div');
  halo.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:1.5px solid #3f7bd9;background:rgba(63,123,217,0.08);border-radius:4px;display:none';
  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:700 10px/1.7 ui-monospace,Menlo,monospace;background:#3f7bd9;color:#fff;border-radius:4px 4px 4px 0;padding:0 6px;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  document.documentElement.appendChild(halo);
  document.documentElement.appendChild(tag);
  const cssSelector = (el) => {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4 && cur !== document.body && cur !== document.documentElement) {
      if (cur.id) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let piece = cur.tagName.toLowerCase();
      const classes = Array.from(cur.classList).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      if (classes) {
        piece += classes;
      } else if (cur.parentElement) {
        const same = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) piece += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(piece);
      cur = cur.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const compact = (value, max) => String(value || '').replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max);
  const accessibleName = (el) => {
    const direct = compact(el.getAttribute('aria-label'), 300);
    if (direct) return direct;
    const labelledBy = compact(el.getAttribute('aria-labelledby'), 300);
    if (labelledBy) {
      const label = labelledBy.split(/\\s+/).slice(0, 3).map((id) => document.getElementById(id)).filter(Boolean).map((node) => compact(node.textContent, 120)).filter(Boolean).join(' ');
      if (label) return compact(label, 300);
    }
    return compact(el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder'), 300);
  };
  const componentName = (fiber) => {
    const type = fiber && (fiber.type || fiber.elementType);
    if (!type || typeof type === 'string') return '';
    return compact(type.displayName || type.name || (type.render && (type.render.displayName || type.render.name)), 100);
  };
  const frameworkHints = (el) => {
    try {
      const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      let fiber = key ? el[key] : null;
      const names = [];
      let sourceHint = '';
      for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
        const name = componentName(fiber);
        if (name && !names.includes(name) && names.length < 5) names.push(name);
        const source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
        if (!sourceHint && source && source.fileName) {
          sourceHint = String(source.fileName);
          for (const prefix of ['webpack-internal:///./', 'file:///']) {
            if (sourceHint.startsWith(prefix)) sourceHint = sourceHint.slice(prefix.length);
          }
          sourceHint = compact(sourceHint, 440);
          if (source.lineNumber) sourceHint += ':' + source.lineNumber;
          if (source.columnNumber) sourceHint += ':' + source.columnNumber;
        }
      }
      return {
        componentHint: names.length ? names.reverse().map((name) => '<' + name + '>').join(' > ') : '',
        sourceHint: compact(sourceHint, 500),
      };
    } catch {
      return { componentHint: '', sourceHint: '' };
    }
  };
  const elementContext = (el) => {
    const computed = window.getComputedStyle(el);
    const hints = frameworkHints(el);
    return {
      tagName: compact(el.tagName, 50).toLowerCase(),
      text: compact(el.textContent, 300),
      accessibleName: accessibleName(el),
      role: compact(el.getAttribute('role'), 100),
      testId: compact(el.getAttribute('data-testid'), 200),
      classes: Array.from(el.classList || []).map((name) => compact(name, 100)).filter(Boolean).slice(0, 6),
      componentHint: hints.componentHint,
      sourceHint: hints.sourceHint,
      styles: {
        display: compact(computed.display, 120),
        position: compact(computed.position, 120),
        margin: compact(computed.margin, 160),
        padding: compact(computed.padding, 160),
        gap: compact(computed.gap, 120),
        color: compact(computed.color, 160),
        backgroundColor: compact(computed.backgroundColor, 160),
        border: compact(computed.border, 200),
        borderRadius: compact(computed.borderRadius, 120),
        fontFamily: compact(computed.fontFamily, 300),
        fontSize: compact(computed.fontSize, 120),
        fontWeight: compact(computed.fontWeight, 120),
        lineHeight: compact(computed.lineHeight, 120),
        textAlign: compact(computed.textAlign, 120),
      },
    };
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    halo.style.display = 'block';
    halo.style.left = (r.left - 3) + 'px';
    halo.style.top = (r.top - 3) + 'px';
    halo.style.width = (r.width + 6) + 'px';
    halo.style.height = (r.height + 6) + 'px';
    tag.style.display = 'block';
    tag.textContent = cssSelector(el);
    tag.style.left = (r.left - 3) + 'px';
    tag.style.top = Math.max(0, r.top - 20) + 'px';
  };
  const onOver = (e) => { if (e.target instanceof Element) place(e.target); };
  const onClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target instanceof Element ? e.target : document.body;
    const r = el.getBoundingClientRect();
    parent.postMessage({ __charterPick: {
      selector: cssSelector(el),
      rect: { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) },
      elementContext: elementContext(el),
    } }, '*');
    cleanup();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      parent.postMessage({ __charterPickCancel: true }, '*');
      cleanup();
    }
  };
  function cleanup() {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    halo.remove();
    tag.remove();
    delete window.__charterPickCleanup;
  }
  window.__charterPickCleanup = cleanup;
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
})();`;

export const PICKER_CANCEL_JS = `(() => {
  if (window.__charterPickCleanup) window.__charterPickCleanup();
})();`;
