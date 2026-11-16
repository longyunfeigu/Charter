import { describe, expect, it } from 'vitest';
import { classifyCommand } from './command-classifier.js';

function classify(
  executable: string,
  args: string[] = [],
  extra?: Partial<Parameters<typeof classifyCommand>[0]>,
) {
  return classifyCommand({ executable, args, cwd: '', requiresShell: false, ...extra });
}

describe('command classifier (§10.2/§10.4, PERM-008/009, CMD-001/002)', () => {
  // ---- R2: local execution floor ----
  it('classifies recognized verification commands as R2 recognized', () => {
    for (const [exe, args] of [
      ['npm', ['test']],
      ['npm', ['run', 'lint']],
      ['npx', ['tsc', '--noEmit']],
      ['pytest', []],
      ['node', ['--test']],
    ] as Array<[string, string[]]>) {
      const c = classify(exe, args);
      expect(c.level, `${exe} ${args.join(' ')}`).toBe('R2');
      expect(c.recognized, `${exe} ${args.join(' ')}`).toBe(true);
    }
  });

  it('classifies unknown commands as R2 unrecognized (ask by default)', () => {
    const c = classify('made-up-tool', ['--flag']);
    expect(c.level).toBe('R2');
    expect(c.recognized).toBe(false);
  });

  it('never returns a level below R2 — executing a process is at minimum local execution', () => {
    expect(classify('echo', ['hi']).level).toBe('R2');
  });

  // ---- R3: installs / network / vcs-write / deletion / shell ----
  it('classifies dependency installs as R3 (§10.4)', () => {
    for (const [exe, args] of [
      ['npm', ['install']],
      ['npm', ['i', 'leftpad']],
      ['npm', ['ci']],
      ['pip', ['install', 'requests']],
      ['pnpm', ['add', 'x']],
      ['brew', ['install', 'jq']],
    ] as Array<[string, string[]]>) {
      expect(classify(exe, args).level, `${exe} ${args.join(' ')}`).toBe('R3');
    }
  });

  it('classifies network commands as R3 (PERM-009)', () => {
    for (const [exe, args] of [
      ['curl', ['https://example.com']],
      ['wget', ['https://example.com']],
      ['git', ['clone', 'https://github.com/x/y']],
      ['git', ['fetch']],
      ['git', ['pull']],
      ['ssh', ['host']],
    ] as Array<[string, string[]]>) {
      expect(classify(exe, args).level, `${exe} ${args.join(' ')}`).toBe('R3');
    }
  });

  it('classifies git commit and file deletion as R3 (§10.4, §10.2)', () => {
    expect(classify('git', ['commit', '-m', 'msg']).level).toBe('R3');
    expect(classify('rm', ['-rf', 'node_modules']).level).toBe('R3');
    expect(classify('rmdir', ['dist']).level).toBe('R3');
  });

  it('escalates to at least R3 when shell syntax is required (CMD-002)', () => {
    const c = classify('echo hi && echo bye', [], { requiresShell: true });
    expect(c.level).toBe('R3');
    expect(c.reasons.join(' ')).toMatch(/shell/i);
  });

  it('treats direct shell interpreters as shell commands even without requiresShell', () => {
    expect(classify('sh', ['-c', 'echo hi']).level).toBe('R3');
    expect(classify('bash', ['-c', 'ls | wc -l']).level).toBe('R3');
  });

  // ---- R4: forbidden (PERM-008) ----
  it('classifies sudo as R4', () => {
    expect(classify('sudo', ['npm', 'install']).level).toBe('R4');
  });

  it('classifies git push as R4, including via shell strings', () => {
    expect(classify('git', ['push']).level).toBe('R4');
    expect(classify('git', ['push', '--force', 'origin', 'main']).level).toBe('R4');
    expect(classify('git commit -m x && git push', [], { requiresShell: true }).level).toBe('R4');
    expect(classify('sh', ['-c', 'git push origin main']).level).toBe('R4');
  });

  it('does not let git global option values hide the subcommand', () => {
    expect(classify('git', ['-C', '.', 'push']).level).toBe('R4');
    expect(classify('git', ['-c', 'a=b', 'push', 'origin', 'main']).level).toBe('R4');
    expect(classify('sh', ['-c', 'git -C . push origin main']).level).toBe('R4');
    // Grants stay scoped to the literal form: `git -C . status` must not reuse
    // a standing allow for plain `git status`.
    expect(classify('git', ['-C', '.', 'status']).ruleKey).not.toBe('run_command:git:status');
  });

  // ADR-0022: forge CLIs are the same outward-action class as git push.
  it('classifies forge CLI mutations as R4 (gh pr create, gh api, glab, unknown subs fail closed)', () => {
    expect(classify('gh', ['pr', 'create', '--draft']).level).toBe('R4');
    expect(classify('gh', ['pr', 'merge', '1']).level).toBe('R4');
    expect(classify('gh', ['release', 'create', 'v1']).level).toBe('R4');
    expect(classify('gh', ['api', 'repos/x/y', '-f', 'a=b']).level).toBe('R4');
    expect(classify('gh', ['api', 'repos/x/y']).level).toBe('R4'); // api fails closed even for GETs
    expect(classify('gh', ['auth', 'login']).level).toBe('R4');
    expect(classify('gh', []).level).toBe('R4');
    expect(classify('glab', ['mr', 'create']).level).toBe('R4');
    expect(classify('sh', ['-c', 'git commit -m x; gh pr create']).level).toBe('R4');
  });

  it('classifies forge CLI reads as R3 network access', () => {
    expect(classify('gh', ['pr', 'view', '12']).level).toBe('R3');
    expect(classify('gh', ['pr', 'list']).level).toBe('R3');
    expect(classify('gh', ['run', 'view', '99']).level).toBe('R3');
    expect(classify('gh', ['pr', 'checks', '12']).level).toBe('R3');
    expect(classify('gh', ['auth', 'status']).level).toBe('R3');
    expect(classify('glab', ['mr', 'list']).level).toBe('R3');
  });

  it('classifies destructive root commands as R4', () => {
    expect(classify('rm', ['-rf', '/']).level).toBe('R4');
    expect(classify('rm', ['-fr', '/*']).level).toBe('R4');
    expect(classify('mkfs.ext4', ['/dev/sda1']).level).toBe('R4');
    expect(classify('shutdown', ['-h', 'now']).level).toBe('R4');
  });

  it('classifies credential-path access as R4', () => {
    expect(classify('cat', ['~/.ssh/id_rsa']).level).toBe('R4');
    expect(classify('cat', ['/Users/me/.aws/credentials']).level).toBe('R4');
    expect(classify('cp', ['../.netrc', '.']).level).toBe('R4');
  });

  it('classifies workspace-escaping cwd as R4 (workspace-external execution)', () => {
    expect(classify('npm', ['test'], { cwd: '../elsewhere' }).level).toBe('R4');
    expect(classify('npm', ['test'], { cwd: '/tmp' }).level).toBe('R4');
    expect(classify('npm', ['test'], { cwd: 'packages/app' }).level).toBe('R2');
  });

  it('sudo hidden inside a shell string is still R4', () => {
    expect(classify('echo ok; sudo rm -rf /', [], { requiresShell: true }).level).toBe('R4');
  });

  it('does not flag "sudo" appearing as data rather than a command', () => {
    // grep for the word sudo in files: word appears as an argument, not a command position.
    expect(classify('grep', ['-r', 'sudo', 'src']).level).toBe('R2');
  });

  // ---- rule keys for "same kind of action" grants (PERM-002) ----
  it('produces stable rule keys from executable + subcommand', () => {
    expect(classify('npm', ['test']).ruleKey).toBe('run_command:npm:test');
    expect(classify('npm', ['run', 'lint']).ruleKey).toBe('run_command:npm:run');
    expect(classify('pytest', []).ruleKey).toBe('run_command:pytest');
    expect(classify('echo hi', [], { requiresShell: true }).ruleKey).toBe('run_command:shell');
  });

  it('always explains its reasons', () => {
    expect(classify('sudo', ['ls']).reasons.length).toBeGreaterThan(0);
    expect(classify('npm', ['install']).reasons.length).toBeGreaterThan(0);
  });
});
