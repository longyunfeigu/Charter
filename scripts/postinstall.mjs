#!/usr/bin/env node
// Post-install fixups that npm's script sandboxing skips.
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

// node-pty ships N-API prebuilds but the spawn-helper loses its exec bit through npm.
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(root, 'node_modules/node-pty/prebuilds', arch, 'spawn-helper');
  if (existsSync(helper)) {
    chmodSync(helper, 0o755);
    console.log(`postinstall: chmod +x ${helper}`);
  }
}

// Electron binary: ensure it is present (downloads may be script-blocked on install).
const electronDist = join(root, 'node_modules/electron/dist');
if (!existsSync(electronDist)) {
  console.warn(
    'postinstall: electron binary missing — run `node node_modules/electron/install.js` (electron_mirror is configured in .npmrc)',
  );
}
