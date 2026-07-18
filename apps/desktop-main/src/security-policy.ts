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

/** External links open in the system browser and must be plain https. */
const EXTERNAL_URL_ALLOWLIST = [/^https:\/\//i];

export function isAllowedExternalUrl(url: string): boolean {
  return EXTERNAL_URL_ALLOWLIST.some((re) => re.test(url));
}
