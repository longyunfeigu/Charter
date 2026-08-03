import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attributeListeners,
  cwdInsideRoot,
  devCommandForRoot,
  discoverStaticPreview,
  isRenderablePreviewResponse,
  isWebishRoot,
  parseLsofCwds,
  parseLsofListeners,
  previewLaunchForRoot,
} from './preview-service.js';

/** ADR-0022: the preview only ever binds to the task's own tree. */

const LISTEN_OUTPUT = [
  'p350',
  'cControlCe',
  'n127.0.0.1:7000',
  'n[::1]:7000',
  'p4242',
  'cnode',
  'n*:5173',
  'n[::]:5173',
  'p5001',
  'cpython3.11',
  'n192.168.1.20:8080', // explicit LAN-only bind — not reachable via localhost
  'p6001',
  'cbun',
  'nlocalhost:3000',
].join('\n');

describe('parseLsofListeners', () => {
  it('parses pid/command/port and keeps only loopback-or-wildcard binds', () => {
    const rows = parseLsofListeners(LISTEN_OUTPUT);
    expect(rows).toContainEqual({ pid: 350, command: 'ControlCe', port: 7000 });
    expect(rows).toContainEqual({ pid: 4242, command: 'node', port: 5173 });
    expect(rows).toContainEqual({ pid: 6001, command: 'bun', port: 3000 });
    // LAN-only bind excluded — an iframe to localhost:8080 would show nothing.
    expect(rows.some((r) => r.port === 8080)).toBe(false);
  });

  it('tolerates garbage lines and out-of-range ports', () => {
    expect(parseLsofListeners('')).toEqual([]);
    expect(parseLsofListeners('p1\ncx\nn127.0.0.1:99999\nn127.0.0.1:abc\nnnonsense')).toEqual([]);
  });
});

describe('parseLsofCwds', () => {
  it('maps pid to cwd (f-lines ignored)', () => {
    const map = parseLsofCwds('p4242\nfcwd\nn/Users/x/wt/task-1\np6001\nfcwd\nn/Users/x/proj');
    expect(map.get(4242)).toBe('/Users/x/wt/task-1');
    expect(map.get(6001)).toBe('/Users/x/proj');
  });
});

describe('attribution (never crosses trees)', () => {
  it('keeps only processes whose cwd is inside the root; dedupes v4+v6 pairs', () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'wt-')));
    const mainTree = realpathSync(mkdtempSync(join(tmpdir(), 'main-')));
    const sub = join(worktree, 'apps', 'web');
    mkdirSync(sub, { recursive: true });

    const listeners = parseLsofListeners(
      ['p10', 'cnode', 'n127.0.0.1:5173', 'n[::1]:5173', 'p20', 'cnode', 'n127.0.0.1:4321'].join(
        '\n',
      ),
    );
    const cwds = new Map<number, string>([
      [10, sub], // dev server inside the worktree (nested cwd)
      [20, mainTree], // dev server in the main tree — must NOT appear
    ]);

    const attributed = attributeListeners(listeners, cwds, worktree);
    expect(attributed).toEqual([{ port: 5173, pid: 10, command: 'node' }]);

    // Same listeners viewed from the main tree: only the main-tree server.
    const fromMain = attributeListeners(listeners, cwds, mainTree);
    expect(fromMain).toEqual([{ port: 4321, pid: 20, command: 'node' }]);
  });

  it('a sibling directory sharing the root as prefix is outside (no startsWith footgun)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'pv-')));
    const root = join(base, 'proj');
    const sibling = join(base, 'proj-evil');
    mkdirSync(root);
    mkdirSync(sibling);
    expect(cwdInsideRoot(root, root)).toBe(true);
    expect(cwdInsideRoot(sibling, root)).toBe(false);
  });
});

describe('renderable HTTP service filtering', () => {
  it('keeps actual HTML pages and rejects project-local JSON control APIs', () => {
    expect(
      isRenderablePreviewResponse({
        statusCode: 200,
        contentType: 'text/html; charset=utf-8',
        location: null,
        bodyPrefix: '<!doctype html><title>App</title>',
      }),
    ).toBe(true);
    expect(
      isRenderablePreviewResponse({
        statusCode: 404,
        contentType: 'application/json; charset=utf-8',
        location: null,
        bodyPrefix: '{"error":"unknown endpoint"}',
      }),
    ).toBe(false);
  });

  it('sniffs HTML only when the server omits a content type', () => {
    expect(
      isRenderablePreviewResponse({
        statusCode: 200,
        contentType: '',
        location: null,
        bodyPrefix: '\n<html><body>App</body></html>',
      }),
    ).toBe(true);
    expect(
      isRenderablePreviewResponse({
        statusCode: 200,
        contentType: 'text/plain',
        location: null,
        bodyPrefix: '<html><body>Not served as a page</body></html>',
      }),
    ).toBe(false);
  });
});

describe('isWebishRoot (Preview tab visibility heuristic)', () => {
  it('true for a dev/start/serve/preview script; false otherwise', async () => {
    const web = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(
      join(web, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite', test: 'x' } }),
    );
    const nonWeb = mkdtempSync(join(tmpdir(), 'cli-'));
    writeFileSync(join(nonWeb, 'package.json'), JSON.stringify({ scripts: { test: 'node t' } }));
    const empty = mkdtempSync(join(tmpdir(), 'none-'));
    expect(await isWebishRoot(web)).toBe(true);
    expect(await isWebishRoot(nonWeb)).toBe(false);
    expect(await isWebishRoot(empty)).toBe(false);
  });

  it('recognizes a nested zero-dependency index.html as a previewable app', async () => {
    const root = mkdtempSync(join(tmpdir(), 'static-web-'));
    const site = join(root, 'examples', 'meal-picker');
    const dependencySite = join(root, 'node_modules', 'ignore-me');
    mkdirSync(site, { recursive: true });
    mkdirSync(dependencySite, { recursive: true });
    writeFileSync(join(site, 'index.html'), '<!doctype html><title>Meal picker</title>');
    writeFileSync(join(dependencySite, 'index.html'), '<!doctype html><title>Dependency</title>');

    expect(await discoverStaticPreview(root)).toEqual({
      entryPath: 'examples/meal-picker/index.html',
      directory: 'examples/meal-picker',
    });
    expect(await isWebishRoot(root)).toBe(true);
    expect(await previewLaunchForRoot(root)).toEqual({
      webish: true,
      command: "python3 -m http.server 0 --bind 127.0.0.1 --directory 'examples/meal-picker'",
      kind: 'static',
      staticEntry: 'examples/meal-picker/index.html',
    });
  });
});

describe('devCommandForRoot (one-click start, ADR-0022 am.1)', () => {
  it('picks the first of dev > serve > preview > start; null when none', async () => {
    const both = mkdtempSync(join(tmpdir(), 'dc-'));
    writeFileSync(
      join(both, 'package.json'),
      JSON.stringify({ scripts: { start: 'node s', dev: 'vite' } }),
    );
    writeFileSync(join(both, 'index.html'), '<!doctype html>');
    expect(await devCommandForRoot(both)).toBe('npm run dev');

    const serveOnly = mkdtempSync(join(tmpdir(), 'dc2-'));
    writeFileSync(join(serveOnly, 'package.json'), JSON.stringify({ scripts: { serve: 'x' } }));
    expect(await devCommandForRoot(serveOnly)).toBe('npm run serve');

    const none = mkdtempSync(join(tmpdir(), 'dc3-'));
    writeFileSync(join(none, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    expect(await devCommandForRoot(none)).toBeNull();
    expect(await devCommandForRoot(mkdtempSync(join(tmpdir(), 'dc4-')))).toBeNull();
  });
});
