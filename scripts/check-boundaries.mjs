#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoundaries } from './boundaries-core.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name.startsWith('.'))
      continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) yield full;
  }
}

const files = [];
for (const base of ['packages', 'apps']) {
  try {
    for (const file of walk(join(root, base))) {
      const rel = relative(root, file).split('\\').join('/');
      // Build-time config files (vite.config.ts etc.) run in Node, not in the app processes.
      if (!rel.includes('/src/')) continue;
      files.push({
        path: relative(root, file).split('\\').join('/'),
        content: readFileSync(file, 'utf8'),
      });
    }
  } catch {
    // directory may not exist yet
  }
}

const violations = checkBoundaries(files);
if (violations.length > 0) {
  console.error(`Dependency boundary violations (${violations.length}):`);
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.path} imports "${v.spec}"`);
  }
  process.exit(1);
}
console.log(`Boundary check OK (${files.length} files).`);
