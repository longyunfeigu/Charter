import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobStore } from '@pi-ide/change-service';
import type { SqlDatabase } from '@pi-ide/persistence';
import type { Logger } from '@pi-ide/foundation';
import type { TaskService } from './task-service.js';
import {
  ArtifactService,
  classifyArtifact,
  inspectPdfDiagnostics,
  parseZipManifest,
} from './artifact-service.js';

function zipManifest(name: string, size: number): Buffer {
  const nameBytes = Buffer.from(name);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(size, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([central, eocd]);
}

describe('artifact classification and archive boundaries', () => {
  it('classifies every rich renderer family without trusting MIME input', () => {
    expect(classifyArtifact('data/results.csv', Buffer.from('a,b\n1,2')).kind).toBe('table');
    expect(classifyArtifact('page.html', Buffer.from('<h1>Hi</h1>')).kind).toBe('html');
    expect(classifyArtifact('photo.heic', Buffer.from([0, 1, 2])).kind).toBe('image');
    expect(classifyArtifact('movie.mp4', Buffer.from([0, 1, 2])).kind).toBe('video');
    expect(classifyArtifact('unknown.bin', Buffer.from([0, 1, 2])).kind).toBe('binary');
  });

  it('reads ZIP central-directory names without extracting data', () => {
    expect(parseZipManifest(zipManifest('nested/report.csv', 123))).toEqual({
      entries: [
        { path: 'nested/report.csv', compressedBytes: 123, sizeBytes: 123, directory: false },
      ],
      truncated: false,
    });
    expect(parseZipManifest(Buffer.from('not a zip')).entries).toEqual([]);
  });

  it('warns about symbol glyph substitutions that no PDF viewer can recover', () => {
    const broken = Buffer.from(
      '%PDF-1.4 /BaseFont /Helvetica /BaseFont /ZapfDingbats /Subtype /Type1',
      'latin1',
    );
    expect(inspectPdfDiagnostics(broken)).toEqual([
      expect.objectContaining({
        code: 'pdf.symbol_font_without_unicode',
        level: 'warning',
        repairHint: expect.stringContaining('embedded CJK font'),
      }),
    ]);
    expect(
      inspectPdfDiagnostics(Buffer.from('%PDF-1.4 /BaseFont /Helvetica /Subtype /Type1')),
    ).toEqual([]);
    expect(
      inspectPdfDiagnostics(
        Buffer.from('%PDF-1.4 /BaseFont /Symbol /ToUnicode 8 0 R /Subtype /Type1'),
      ),
    ).toEqual([]);
  });
});

describe('ArtifactService immutable projection and protocol', () => {
  it('groups versions, rejects foreign hashes, serves ranges and isolates HTML', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artifact-root-'));
    const blobs = new BlobStore(join(root, '.blobs'));
    const oldCsv = await blobs.put(Buffer.from('name,value\nA,1\n'));
    const newCsv = await blobs.put(Buffer.from('name,value\nA,2\n'));
    const video = await blobs.put(Buffer.from('0123456789'));
    const html = await blobs.put(
      Buffer.from(
        '<!doctype html><body><button id="go">Go</button><script>window.originalPageScript = true</script></body>',
      ),
    );
    const rows = [
      {
        relative_path: 'reports/data.csv',
        kind: 'modified',
        before_hash: oldCsv.hash,
        after_hash: newCsv.hash,
        rename_to: null,
        created_at: '2026-07-22T01:00:00.000Z',
      },
      {
        relative_path: 'demo.mp4',
        kind: 'created',
        before_hash: null,
        after_hash: video.hash,
        rename_to: null,
        created_at: '2026-07-22T01:01:00.000Z',
      },
      {
        relative_path: 'site/index.html',
        kind: 'created',
        before_hash: null,
        after_hash: html.hash,
        rename_to: null,
        created_at: '2026-07-22T01:02:00.000Z',
      },
    ];
    const db = { prepare: () => ({ all: () => rows }) } as unknown as SqlDatabase;
    const tasks = {
      getTask: () => ({ external: null }),
      contextForTask: () => ({ root, blobs }),
    } as unknown as TaskService;
    const logger = { warn: () => undefined } as unknown as Logger;
    const service = new ArtifactService(db, tasks, logger);

    const list = await service.list('task-1');
    const csv = list.find((item) => item.path === 'reports/data.csv')!;
    expect(csv.versionCount).toBe(2);
    expect(csv.currentVersion).toBe(2);

    const old = await service.open({
      taskId: 'task-1',
      path: csv.path,
      contentHash: oldCsv.hash,
      htmlMode: 'safe',
    });
    expect(old.stale).toBe(true);
    expect(old.text).toContain('A,1');
    await expect(
      service.open({
        taskId: 'task-1',
        path: csv.path,
        contentHash: 'f'.repeat(64),
        htmlMode: 'safe',
      }),
    ).rejects.toMatchObject({ error: { code: 'ARTIFACT_HASH_MISMATCH' } });

    const videoOpen = await service.open({
      taskId: 'task-1',
      path: 'demo.mp4',
      htmlMode: 'safe',
    });
    const ranged = await service.handleResource(
      new Request(videoOpen.assetUrl!, { headers: { Range: 'bytes=2-5' } }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await ranged.text()).toBe('2345');

    const htmlOpen = await service.open({
      taskId: 'task-1',
      path: 'site/index.html',
      htmlMode: 'safe',
    });
    const htmlResponse = await service.handleResource(new Request(htmlOpen.assetUrl!));
    expect(htmlResponse.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(htmlResponse.headers.get('content-security-policy')).toContain("script-src 'nonce-");
    const safeHtml = await htmlResponse.text();
    expect(safeHtml).toContain('charter-artifact-picked');
    expect(safeHtml).toContain('charter-artifact-picker-ready');
    expect(safeHtml).toContain('charter-artifact-picker-state');
    expect(safeHtml).toContain("event.data.action === 'clear'");
    expect(safeHtml).not.toContain('originalPageScript');

    const interactiveOpen = await service.open({
      taskId: 'task-1',
      path: 'site/index.html',
      htmlMode: 'interactive',
    });
    const interactiveResponse = await service.handleResource(
      new Request(interactiveOpen.assetUrl!),
    );
    expect(interactiveResponse.headers.get('content-security-policy')).toContain(
      "script-src 'unsafe-inline' artifact:",
    );
    expect(await interactiveResponse.text()).toContain('originalPageScript');
  });
});
