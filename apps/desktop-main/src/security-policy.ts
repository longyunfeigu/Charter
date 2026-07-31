/**
 * Pure navigation/external-URL policy (§12.3, §16.4), electron-free so the
 * security suite can pin it directly (M11-01). `security.ts` wires these into
 * WebContents handlers; malicious Markdown links also land here because the
 * shared <Markdown> component routes every anchor through `app.openExternal`.
 */

/** Origins the renderer may navigate to (dev server only, and only in dev). */
export function allowedNavigation(devServerUrl: string | undefined, url: string): boolean {
  if (!devServerUrl) return url.startsWith('app://');
  return url.startsWith(devServerUrl) || url.startsWith('app://');
}

export function isAllowedExternalUrl(url: string): boolean {
  if (url.trim() !== url) return false;
  // WHATWG URL parsing repairs malformed web URLs such as `https:/host` and
  // `https:///host`. Require an explicit, non-empty authority before parsing
  // so the desktop shell never opens a normalized form the user did not see.
  if (!/^https?:\/\/[^/?#\\\s]+(?:[/?#]|$)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}
