import { app, BrowserWindow, dialog, net, protocol, session } from 'electron';
import { join, normalize } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createLogger, consoleSink, type Logger } from '@pi-ide/foundation';
import { createAppPaths, type AppPaths } from './app-paths.js';
import { installGlobalSecurityHandlers, openExternalChecked } from './security.js';
import { registerHandlers } from './ipc/router.js';

const DEV_SERVER_URL = process.env.PI_IDE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

// Test hooks: E2E launches with an isolated user-data dir.
const userDataOverride = process.env.PI_IDE_USER_DATA;
if (userDataOverride) {
  app.setPath('userData', userDataOverride);
}

let logger: Logger = createLogger('main', consoleSink(), {
  minLevel: process.env.PI_IDE_LOG_LEVEL === 'debug' ? 'debug' : 'info',
});
let paths: AppPaths;
let mainWindow: BrowserWindow | null = null;

const CSP = [
  "default-src 'self'",
  // Monaco injects inline styles; no inline/eval script is ever allowed.
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

function registerAppProtocol(rendererDist: string): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const target = normalize(join(rendererDist, pathname));
    if (!target.startsWith(normalize(rendererDist))) {
      return new Response('forbidden', { status: 403 });
    }
    if (!existsSync(target)) {
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).toString(), { bypassCustomProtocolHandlers: true });
  });
}

function installCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppContent =
      details.url.startsWith('app://') ||
      (isDev && DEV_SERVER_URL && details.url.startsWith(DEV_SERVER_URL));
    if (!isAppContent) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });
}

function resolveRendererDist(): string {
  return join(app.getAppPath(), 'apps/desktop-renderer/dist');
}

function preloadPath(): string {
  return join(app.getAppPath(), 'apps/desktop-preload/dist/preload.cjs');
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Pi IDE',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: preloadPath(),
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  if (isDev && DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL('app://bundle/index.html');
  }
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function getAppInfo() {
  let commit: string | null = null;
  try {
    const head = readFileSync(join(app.getAppPath(), '.git/HEAD'), 'utf8').trim();
    commit = head.startsWith('ref:') ? null : head.slice(0, 12);
  } catch {
    commit = null;
  }
  return {
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    node: process.versions.node ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    commit,
    piSdkVersion: null as string | null,
    updateChannel: 'dev',
    userDataDir: app.getPath('userData'),
  };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    try {
      paths = createAppPaths(app.getPath('userData'));
      logger.info('app starting', { userData: paths.userData, dev: isDev });
      installGlobalSecurityHandlers(DEV_SERVER_URL, logger);
      installCsp();
      if (!isDev) registerAppProtocol(resolveRendererDist());

      registerHandlers(
        {
          'app.getInfo': async () => getAppInfo(),
          'app.openExternal': async ({ url }) => ({
            opened: await openExternalChecked(url, logger),
          }),
        },
        logger,
      );

      mainWindow = createMainWindow();
    } catch (e) {
      logger.error('startup failed', { error: e instanceof Error ? e.message : String(e) });
      dialog.showErrorBox(
        'Pi IDE failed to start',
        `The application could not start.\n\n${e instanceof Error ? e.message : String(e)}\n\nLogs: ${app.getPath('userData')}/logs`,
      );
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || process.env.PI_IDE_E2E) {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && app.isReady()) {
      mainWindow = createMainWindow();
    }
  });
}
