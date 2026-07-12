// Shared esbuild configuration for the three Node-side bundles.
import { build, context } from 'esbuild';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const alias = Object.fromEntries(
  [
    'foundation',
    'ipc-contracts',
    'agent-contract',
    'agent-runtime-mock',
    'agent-runtime-pi',
    'app-domain',
    'persistence',
    'tool-gateway',
    'workspace-service',
    'document-service',
    'search-service',
    'git-service',
    'terminal-service',
    'change-service',
    'verification-service',
    'language-service',
  ].map((p) => [`@pi-ide/${p}`, join(root, `packages/${p}/src/index.ts`)]),
);

/** @type {import('esbuild').BuildOptions[]} */
export const bundles = [
  {
    entryPoints: [join(root, 'apps/desktop-main/src/index.ts')],
    outfile: join(root, 'apps/desktop-main/dist/main.cjs'),
    platform: 'node',
    format: 'cjs',
    bundle: true,
    sourcemap: true,
    target: 'node22',
    alias,
    external: ['electron', 'node-pty', '@vscode/ripgrep'],
    define: { 'process.env.NODE_ENV': '"production"' },
  },
  {
    entryPoints: [join(root, 'apps/desktop-preload/src/index.ts')],
    outfile: join(root, 'apps/desktop-preload/dist/preload.cjs'),
    platform: 'node',
    format: 'cjs',
    bundle: true,
    sourcemap: true,
    target: 'node22',
    alias,
    external: ['electron'],
  },
  {
    entryPoints: [join(root, 'apps/agent-worker/src/index.ts')],
    outfile: join(root, 'apps/agent-worker/dist/worker.mjs'),
    platform: 'node',
    format: 'esm',
    bundle: true,
    sourcemap: true,
    target: 'node22',
    alias,
    // Pi SDK stays external: it is ESM-native with dynamic imports and wasm assets.
    external: ['electron', '@earendil-works/pi-coding-agent'],
  },
];

export async function buildAll() {
  await Promise.all(bundles.map((options) => build(options)));
}

export async function watchAll(onRebuild) {
  const contexts = [];
  for (const options of bundles) {
    const ctx = await context({
      ...options,
      plugins: [
        {
          name: 'notify',
          setup(buildApi) {
            buildApi.onEnd((result) => {
              if (onRebuild) onRebuild(options.outfile, result.errors);
            });
          },
        },
      ],
    });
    await ctx.watch();
    contexts.push(ctx);
  }
  return contexts;
}
