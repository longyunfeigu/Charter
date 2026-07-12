// Dependency boundary rules (spec §9.5). Pure logic so it is unit-testable;
// the CLI wrapper walks the repository and feeds files in.

const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
  'sqlite',
]);

const PURE_CONTRACT_DIRS = [
  'packages/foundation/',
  'packages/ipc-contracts/',
  'packages/agent-contract/',
];

const RENDERER_ALLOWED_PI_IDE = new Set([
  '@pi-ide/foundation',
  '@pi-ide/ipc-contracts',
  '@pi-ide/agent-contract',
]);

const PRELOAD_ALLOWED_PI_IDE = new Set(['@pi-ide/foundation', '@pi-ide/ipc-contracts']);

function isNodeBuiltin(spec) {
  if (spec.startsWith('node:')) return true;
  const bare = spec.split('/')[0];
  return NODE_BUILTINS.has(bare);
}

function isUiLib(spec) {
  return (
    spec === 'react' ||
    spec.startsWith('react/') ||
    spec === 'react-dom' ||
    spec.startsWith('react-dom/')
  );
}

const RULES = [
  {
    id: 'pi-only-in-adapter',
    check(path, spec) {
      return spec.startsWith('@earendil-works/') && !path.startsWith('packages/agent-runtime-pi/');
    },
  },
  {
    id: 'renderer-no-electron',
    check(path, spec) {
      return (
        path.startsWith('apps/desktop-renderer/') &&
        (spec === 'electron' || spec.startsWith('electron/'))
      );
    },
  },
  {
    id: 'renderer-no-node',
    check(path, spec) {
      return path.startsWith('apps/desktop-renderer/') && isNodeBuiltin(spec);
    },
  },
  {
    id: 'renderer-allowed-packages',
    check(path, spec) {
      return (
        path.startsWith('apps/desktop-renderer/') &&
        spec.startsWith('@pi-ide/') &&
        !RENDERER_ALLOWED_PI_IDE.has(spec)
      );
    },
  },
  {
    id: 'preload-allowed-packages',
    check(path, spec) {
      return (
        path.startsWith('apps/desktop-preload/') &&
        spec.startsWith('@pi-ide/') &&
        !PRELOAD_ALLOWED_PI_IDE.has(spec)
      );
    },
  },
  {
    id: 'contracts-pure',
    check(path, spec) {
      if (!PURE_CONTRACT_DIRS.some((d) => path.startsWith(d))) return false;
      return isNodeBuiltin(spec) || spec === 'electron' || isUiLib(spec);
    },
  },
  {
    id: 'domain-no-ui',
    check(path, spec) {
      if (!path.startsWith('packages/')) return false;
      if (PURE_CONTRACT_DIRS.some((d) => path.startsWith(d))) return false;
      return isUiLib(spec) || spec === 'electron' || spec.startsWith('electron/');
    },
  },
];

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

export function extractImports(content) {
  const specs = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * @param {{path: string, content: string}[]} files repo-relative posix paths
 * @returns {{path: string, spec: string, rule: string}[]}
 */
export function checkBoundaries(files) {
  const violations = [];
  for (const file of files) {
    const specs = extractImports(file.content);
    for (const spec of specs) {
      for (const rule of RULES) {
        if (rule.check(file.path, spec)) {
          violations.push({ path: file.path, spec, rule: rule.id });
        }
      }
    }
  }
  return violations;
}
