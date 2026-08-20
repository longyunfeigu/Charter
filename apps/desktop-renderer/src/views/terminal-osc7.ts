/**
 * ADR-0059 — OSC 7 working-directory reports.
 *
 * Terminals (and our own remote cwd-sync hook) announce the shell's cwd as
 * `OSC 7 ; file://host/path ST`. xterm.js hands us just the payload between
 * `]7;` and the terminator; this parses it into an absolute path.
 *
 * The emitters we accept are file: URIs. Anything else (empty payload, other
 * schemes, kitty's `file:` with no path) returns null so a garbled report can
 * never repoint an upload target.
 */
export function parseOsc7Cwd(payload: string): string | null {
  if (!payload.startsWith('file://')) return null;
  const rest = payload.slice('file://'.length);
  // `file:///path` (empty authority) and `file://host/path` both occur in the
  // wild; the path starts at the first `/` after the authority.
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const rawPath = rest.slice(slash);
  if (!rawPath.startsWith('/')) return null;
  let path = rawPath;
  // Percent-decode when the emitter encoded (iTerm2/VTE do); our own hook
  // sends raw bytes, which decodeURIComponent may reject — keep those as-is.
  if (rawPath.includes('%')) {
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      path = rawPath;
    }
  }
  // A cwd is a single line; embedded control bytes mean a corrupted report.
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}
