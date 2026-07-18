import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
