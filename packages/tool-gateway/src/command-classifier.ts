import { isAbsolute, normalize } from 'node:path';
import type { RiskLevel } from './gateway.js';

export interface CommandSpec {
  executable: string;
  args: string[];
  cwd: string;
  requiresShell: boolean;
}

export interface CommandClassification {
  level: RiskLevel;
  reasons: string[];
  /** Recognized verification command (test/lint/typecheck/build) — eligible for auto-allow policies. */
  recognized: boolean;
  /** Stable key describing "the same kind of action" for scoped permission grants (PERM-002). */
  ruleKey: string;
}

const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
]);
const INSTALL_SUBCOMMANDS: Record<string, Set<string>> = {
  npm: new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'link', 'publish']),
  pnpm: new Set(['install', 'i', 'add', 'update', 'up', 'link', 'publish']),
  yarn: new Set(['install', 'add', 'up', 'upgrade', 'link', 'publish']),
  bun: new Set(['install', 'i', 'add', 'update', 'link', 'publish']),
  pip: new Set(['install', 'download', 'uninstall']),
  pip3: new Set(['install', 'download', 'uninstall']),
  pipx: new Set(['install', 'uninstall']),
  uv: new Set(['add', 'pip', 'sync']),
  brew: new Set(['install', 'uninstall', 'upgrade', 'tap']),
  apt: new Set(['install', 'remove', 'purge', 'upgrade']),
  'apt-get': new Set(['install', 'remove', 'purge', 'upgrade']),
  dnf: new Set(['install', 'remove', 'upgrade']),
  yum: new Set(['install', 'remove', 'upgrade']),
  gem: new Set(['install', 'uninstall']),
  cargo: new Set(['install', 'publish']),
  go: new Set(['install', 'get']),
};
const NETWORK_EXECUTABLES = new Set([
  'curl',
  'wget',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'telnet',
  'ftp',
]);
const GIT_NETWORK_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'remote',
  'submodule',
  'ls-remote',
]);
const DELETE_EXECUTABLES = new Set(['rm', 'rmdir', 'unlink', 'shred', 'del']);
const DESTRUCTIVE_SYSTEM = new Set([
  'mkfs',
  'fdisk',
  'diskutil',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'launchctl',
  'systemctl',
  'kextload',
  'csrutil',
]);
const PRIVILEGE_EXECUTABLES = new Set(['sudo', 'doas', 'su', 'pkexec']);
/** Forge CLIs can publish (PRs, releases, repo mutations) with stored auth —
 * the same outward-action class as `git push` (GIT-007 / ADR-0022). Reads are
 * plain network access; everything else, including unknown subcommands and
 * `gh api`, fails closed to R4. */
const FORGE_EXECUTABLES = new Set(['gh', 'glab', 'hub']);
const FORGE_READ_RESOURCES = new Set([
  'pr',
  'issue',
  'release',
  'repo',
  'run',
  'workflow',
  'gist',
  'label',
  'cache',
  'project',
  'mr',
]);
const FORGE_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks', 'download']);
const FORGE_READ_TOPLEVEL = new Set([
  'search',
  'status',
  'browse',
  'help',
  'completion',
  'version',
]);
/** Common credential locations the agent must never touch (PERM-008). */
const CREDENTIAL_PATH_RE =
  /(^|[\s/\\])\.(ssh|aws|gnupg|gpg|azure|kube|netrc|npmrc|pypirc|docker\/config\.json)([/\\]|$)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$|\.pem$|\.keychain(-db)?$|credentials(\.json)?$|\.netrc$/i;

const RECOGNIZED_VERIFICATION: Array<{ exe: string; match: (args: string[]) => boolean }> = [
  { exe: 'npm', match: (a) => a[0] === 'test' || a[0] === 't' },
  {
    exe: 'npm',
    match: (a) =>
      a[0] === 'run' && /^(test|lint|check|typecheck|build|format:check)/.test(a[1] ?? ''),
  },
  {
    exe: 'npx',
    match: (a) =>
      ['tsc', 'vitest', 'jest', 'eslint', 'prettier', 'playwright'].includes(a[0] ?? ''),
  },
  { exe: 'node', match: (a) => a[0] === '--test' },
  { exe: 'pytest', match: () => true },
  { exe: 'go', match: (a) => a[0] === 'test' || a[0] === 'vet' || a[0] === 'build' },
  { exe: 'cargo', match: (a) => ['test', 'check', 'clippy', 'build'].includes(a[0] ?? '') },
  { exe: 'make', match: (a) => ['test', 'lint', 'check', 'build', ''].includes(a[0] ?? '') },
  { exe: 'tsc', match: () => true },
  { exe: 'eslint', match: () => true },
  { exe: 'git', match: (a) => ['status', 'diff', 'log', 'show', 'branch'].includes(a[0] ?? '') },
];

function baseName(executable: string): string {
  const parts = executable.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? executable;
  return last.toLowerCase();
}

/** git global options whose value is the next argv entry (`git -C dir push`). */
const GIT_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

function firstSubcommand(exe: string, args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // Skip an option's value too, or `git -C . push` would read "." as the
    // subcommand and slip past the push policy.
    if (exe === 'git' && GIT_OPTIONS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

/** Extract tokens sitting in "command position" of a shell string: start and after ; | && || & newline. */
function shellCommandHeads(text: string): string[][] {
  return text
    .split(/(?:\|\||&&|[;|&\n])/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.split(/\s+/));
}

function isRootDestructive(exe: string, args: string[]): boolean {
  if (!DELETE_EXECUTABLES.has(exe)) return false;
  const targets = args.filter((a) => !a.startsWith('-'));
  return targets.some((t) =>
    /^\/(\*|$)|^\/(bin|etc|usr|var|home|System|Library|Users)?\/?\*?$/.test(t),
  );
}

/** Classify one simple command (executable + argv, no shell operators). */
function classifySimple(exe: string, args: string[], reasons: string[]): RiskLevel {
  const sub = firstSubcommand(exe, args);

  if (PRIVILEGE_EXECUTABLES.has(exe)) {
    reasons.push(`privilege escalation via ${exe} is forbidden`);
    return 'R4';
  }
  if (exe === 'git' && sub === 'push') {
    reasons.push('git push is forbidden by product policy');
    return 'R4';
  }
  if (FORGE_EXECUTABLES.has(exe)) {
    const nonFlags = args.filter((a) => !a.startsWith('-'));
    const resource = nonFlags[0] ?? '';
    const verb = nonFlags[1] ?? '';
    const isRead =
      FORGE_READ_TOPLEVEL.has(resource) ||
      (resource === 'auth' && verb === 'status') ||
      (FORGE_READ_RESOURCES.has(resource) && FORGE_READ_VERBS.has(verb));
    if (!isRead) {
      reasons.push(
        `${exe} ${resource || '(no subcommand)'} can publish or mutate outside the repo — outward actions are yours to run (GIT-007)`,
      );
      return 'R4';
    }
    reasons.push(`${exe} ${resource} ${verb} reads from a remote (network access)`);
    return 'R3';
  }
  if (isRootDestructive(exe, args)) {
    reasons.push('destructive command targeting the filesystem root');
    return 'R4';
  }
  if (DESTRUCTIVE_SYSTEM.has(exe) || exe.startsWith('mkfs')) {
    reasons.push(`system-level command ${exe} is forbidden`);
    return 'R4';
  }
  if (exe === 'dd' && args.some((a) => /^of=\/dev\//.test(a))) {
    reasons.push('writing to raw devices is forbidden');
    return 'R4';
  }
  // Credential paths are checked on every argument: reading them is forbidden (PERM-008).
  for (const arg of args) {
    if (CREDENTIAL_PATH_RE.test(arg)) {
      reasons.push(`argument references a credential path (${arg})`);
      return 'R4';
    }
  }

  if (INSTALL_SUBCOMMANDS[exe]?.has(sub ?? '')) {
    reasons.push(`${exe} ${sub} installs or publishes packages (external side effects)`);
    return 'R3';
  }
  if (NETWORK_EXECUTABLES.has(exe)) {
    reasons.push(`${exe} performs network access (R3 by default, PERM-009)`);
    return 'R3';
  }
  if (exe === 'git' && GIT_NETWORK_SUBCOMMANDS.has(sub ?? '')) {
    reasons.push(`git ${sub} contacts a remote (network access)`);
    return 'R3';
  }
  if (exe === 'git' && sub === 'commit') {
    reasons.push('git commit changes repository history');
    return 'R3';
  }
  if (DELETE_EXECUTABLES.has(exe) || (exe === 'find' && args.includes('-delete'))) {
    reasons.push('deletes files (hard to reverse)');
    return 'R3';
  }
  return 'R2';
}

const LEVEL_ORDER: RiskLevel[] = ['R0', 'R1', 'R2', 'R3', 'R4'];
function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * Risk classification for run_command (CMD-001/002, §10.2/§10.4, PERM-008/009).
 * The floor is R2: executing any process is local execution. Shell strings are
 * R3 and are additionally scanned for forbidden commands in command position.
 */
export function classifyCommand(spec: CommandSpec): CommandClassification {
  const reasons: string[] = [];
  const exe = baseName(spec.executable);
  let level: RiskLevel = 'R2';

  // cwd must stay inside the workspace; escaping it is workspace-external execution.
  const cwd = spec.cwd ?? '';
  if (isAbsolute(cwd) || normalize(cwd === '' ? '.' : cwd).split(/[/\\]/)[0] === '..') {
    reasons.push('cwd escapes the workspace');
    return { level: 'R4', reasons, recognized: false, ruleKey: 'run_command:external-cwd' };
  }

  const shellMode = spec.requiresShell || SHELL_INTERPRETERS.has(exe);
  if (shellMode) {
    reasons.push('shell syntax requested — pipes/redirection/expansion possible (CMD-002)');
    level = 'R3';
    // Scan every command position of the shell string(s) for higher-risk commands.
    const scripts = spec.requiresShell
      ? [[spec.executable, ...spec.args].join(' ')]
      : spec.args.filter((a) => !a.startsWith('-'));
    for (const script of scripts) {
      for (const head of shellCommandHeads(script)) {
        const [headExe, ...headArgs] = head;
        if (!headExe) continue;
        level = maxLevel(level, classifySimple(baseName(headExe), headArgs, reasons));
      }
    }
    return { level, reasons, recognized: false, ruleKey: 'run_command:shell' };
  }

  level = classifySimple(exe, spec.args, reasons);
  const recognized =
    level === 'R2' && RECOGNIZED_VERIFICATION.some((r) => r.exe === exe && r.match(spec.args));
  if (level === 'R2') {
    reasons.push(
      recognized
        ? `recognized verification command (${exe})`
        : `local execution of ${exe} (unrecognized command — review before allowing)`,
    );
  }
  // The standing-grant key keeps the literal first positional argument, so an
  // "always allow git status" grant never extends to `git -c <config> status`
  // or `git -C <other repo> status` (risk above still sees the real subcommand).
  const keyword = spec.args.find((a) => !a.startsWith('-'));
  const ruleKey = keyword ? `run_command:${exe}:${keyword}` : `run_command:${exe}`;
  return { level, reasons, recognized, ruleKey };
}
