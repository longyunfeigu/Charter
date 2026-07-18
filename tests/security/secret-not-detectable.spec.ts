import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from '../e2e/helpers/launch';

/**
 * §16.4: a configured API key is not detectable in the renderer heap snapshot,
 * localStorage, ordinary logs, or the support bundle. The key is stored via the
 * real provider IPC (safeStorage keychain); the renderer is then reloaded so any
 * transient input copy is gone — a persisted key must never rehydrate into the
 * renderer or leak into an artifact.
 */
const SENTINEL = 'sk-secretE2E-DO-NOT-LOG-9f3a7c1e5b2d8406';

function scanDirForSentinel(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && !e.name.endsWith('.bin')) {
        try {
          if (readFileSync(full, 'utf8').includes(SENTINEL)) hits.push(full);
        } catch {
          // binary / unreadable — skip
        }
      }
    }
  };
  walk(dir);
  return hits;
}

test.describe('M11-02 secret not detectable (four paths)', () => {
  test('API key never surfaces in heap / localStorage / logs / support bundle', async () => {
    const { app, page, userDataDir } = await launchApp();
    try {
      // 1. Store the key through the real provider path (keychain-encrypted).
      const stored = await page.evaluate(async (key) => {
        const res = (await window.product.rpc['secrets.set']!({
          providerId: 'openrouter',
          apiKey: key,
        })) as { ok: boolean; data?: unknown; error?: unknown };
        return res.ok ? res.data : { error: res.error };
      }, SENTINEL);
      expect(stored).toMatchObject({ configured: true });

      // Reload the renderer: a persisted key must not rehydrate into it.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(
        page.getByTestId('workbench').or(page.getByTestId('home-view')).first(),
      ).toBeVisible();

      // ── PATH A: renderer heap snapshot (CDP HeapProfiler) ──────────────────
      const cdp = await app.context().newCDPSession(page);
      let snapshot = '';
      cdp.on('HeapProfiler.addHeapSnapshotChunk', (m: { chunk: string }) => {
        snapshot += m.chunk;
      });
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      await cdp.detach();
      expect(snapshot.length).toBeGreaterThan(1000); // snapshot really captured
      expect(snapshot.includes(SENTINEL)).toBe(false);

      // ── PATH B: localStorage (+ sessionStorage) ───────────────────────────
      const webStorage = await page.evaluate(() => {
        const dump: string[] = [];
        for (const store of [window.localStorage, window.sessionStorage]) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i)!;
            dump.push(`${k}=${store.getItem(k)}`);
          }
        }
        return dump.join('\n');
      });
      expect(webStorage.includes(SENTINEL)).toBe(false);

      // ── PATH C: ordinary logs on disk ─────────────────────────────────────
      const logsDir = join(userDataDir, 'logs');
      const logHits = existsSync(logsDir) ? scanDirForSentinel(logsDir) : [];
      expect(logHits).toEqual([]);

      // ── PATH D: support bundle ────────────────────────────────────────────
      const bundle = await page.evaluate(async () => {
        const res = (await window.product.rpc['diagnostics.supportBundle']!({})) as {
          ok: boolean;
          data?: unknown;
          error?: unknown;
        };
        return res.ok ? res.data : { error: res.error };
      });
      expect(bundle).toHaveProperty('path');
      const bundlePath = (bundle as { path: string }).path;
      expect(readFileSync(bundlePath, 'utf8').includes(SENTINEL)).toBe(false);

      // ── on-disk secret store: ciphertext only, meta carries just the hint ──
      const secretsDir = join(userDataDir, 'secrets');
      if (existsSync(secretsDir)) {
        for (const f of readdirSync(secretsDir)) {
          const raw = readFileSync(join(secretsDir, f));
          expect(raw.includes(SENTINEL)).toBe(false); // .bin encrypted, .meta hint-only
          if (f.endsWith('.meta')) {
            const meta = JSON.parse(raw.toString('utf8')) as { hint: string };
            expect(meta.hint).not.toContain(SENTINEL);
            expect(meta.hint.length).toBeLessThan(12); // '…' + last 4
          }
        }
      }
    } finally {
      await app.close();
    }
  });
});
