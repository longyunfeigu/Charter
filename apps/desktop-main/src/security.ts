import { app, shell, type WebContents } from 'electron';
import type { Logger } from '@pi-ide/foundation';

/** Origins the renderer may navigate to (dev server only, and only in dev). */
function allowedNavigation(devServerUrl: string | undefined, url: string): boolean {
  if (!devServerUrl) return url.startsWith('app://');
  return url.startsWith(devServerUrl) || url.startsWith('app://');
}

const EXTERNAL_URL_ALLOWLIST = [/^https:\/\//i];

export function isAllowedExternalUrl(url: string): boolean {
  return EXTERNAL_URL_ALLOWLIST.some((re) => re.test(url));
}

/** APP-010 / §12.3: deny arbitrary navigation, window.open and permission grants. */
export function hardenWebContents(
  contents: WebContents,
  devServerUrl: string | undefined,
  logger: Logger,
): void {
  contents.setWindowOpenHandler(({ url }) => {
    logger.warn('window.open blocked', { url });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!allowedNavigation(devServerUrl, url)) {
      event.preventDefault();
      logger.warn('navigation blocked', { url });
    }
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('webview blocked');
  });
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    // Renderer needs clipboard only; everything else is denied by default.
    callback(permission === 'clipboard-sanitized-write');
  });
}

export function installGlobalSecurityHandlers(
  devServerUrl: string | undefined,
  logger: Logger,
): void {
  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents, devServerUrl, logger);
  });
}

/** Open an external URL in the system browser after allowlist check (never in-app). */
export async function openExternalChecked(url: string, logger: Logger): Promise<boolean> {
  if (!isAllowedExternalUrl(url)) {
    logger.warn('external url rejected', { url });
    return false;
  }
  await shell.openExternal(url);
  return true;
}
