import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LargeFixtureOptions {
  files?: number;
  dirs?: number;
  root?: string;
}

/** Generate a many-files fixture (default 10k files across 100 dirs) for tree/search tests. */
export function createLargeTreeFixture(options: LargeFixtureOptions = {}): string {
  const files = options.files ?? 10_000;
  const dirs = options.dirs ?? 100;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'pi-ide-large-'));
  const perDir = Math.ceil(files / dirs);
  let created = 0;
  for (let d = 0; d < dirs && created < files; d++) {
    const dir = join(root, `module-${String(d).padStart(3, '0')}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < perDir && created < files; f++) {
      writeFileSync(
        join(dir, `file-${String(f).padStart(4, '0')}.ts`),
        `export const value_${d}_${f} = ${d * perDir + f};\n// searchable-token-${d}-${f}\n`,
      );
      created++;
    }
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'large-fixture' }));
  return root;
}

export interface LargeTextFixtureOptions {
  /** Target size in bytes. §16.5 reference load is 1 GiB. */
  sizeBytes?: number;
  /** A token planted every `plantEvery` lines so search perf has real hits. */
  plantToken?: string;
  plantEvery?: number;
  root?: string;
  fileName?: string;
}

/**
 * Generate one large text file (default 64 MiB; the §16.5 1 GiB reference load
 * is `sizeBytes: 1024**3`). Written in streamed chunks so memory stays flat
 * regardless of size. Returns the absolute file path.
 */
export function createLargeTextFixture(options: LargeTextFixtureOptions = {}): string {
  const sizeBytes = options.sizeBytes ?? 64 * 1024 * 1024;
  const plantToken = options.plantToken ?? 'NEEDLE_TOKEN';
  const plantEvery = options.plantEvery ?? 5000;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'pi-ide-text-'));
  const file = join(root, options.fileName ?? 'huge.log');

  const fd = openSync(file, 'w');
  try {
    const CHUNK_LINES = 4096;
    let written = 0;
    let lineNo = 0;
    while (written < sizeBytes) {
      let chunk = '';
      for (let i = 0; i < CHUNK_LINES; i++) {
        lineNo++;
        chunk +=
          lineNo % plantEvery === 0
            ? `line ${lineNo} ${plantToken} sentinel payload here\n`
            : `line ${lineNo} lorem ipsum dolor sit amet consectetur ${lineNo * 7}\n`;
      }
      writeSync(fd, chunk);
      written += Buffer.byteLength(chunk);
    }
  } finally {
    closeSync(fd);
  }
  return file;
}
