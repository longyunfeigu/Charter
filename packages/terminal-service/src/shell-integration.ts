/**
 * ADR-0021 — shell integration injection. The scripts emit OSC 133 semantic
 * prompt marks (A prompt start / B command start / C output start / D;exit)
 * that the renderer parses into blocks. Everything here is host-owned: the
 * desktop process writes these files under its own data directory and spawns
 * the user's shell pointed at them; the renderer never contributes shell text.
 *
 * Degradation contract: an unknown shell, a disabled setting or a missing
 * script directory must produce exactly today's spawn — same args, same env.
 */

const ZSH_ZSHENV = `# Charter shell integration shim (ADR-0021) — loads your own config first.
CHARTER_SHIM_ZDOTDIR="\${ZDOTDIR:-}"
if [[ -n "\${CHARTER_USER_ZDOTDIR-}" ]]; then
  ZDOTDIR="$CHARTER_USER_ZDOTDIR"
else
  builtin unset ZDOTDIR
fi
if [[ -f "\${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  builtin source "\${ZDOTDIR:-$HOME}/.zshenv"
fi
# Respect a ZDOTDIR the user's .zshenv may have set, then restore the shim so
# our .zshrc (which chains to theirs) is the one zsh loads next.
CHARTER_USER_ZDOTDIR="\${ZDOTDIR:-$HOME}"
export CHARTER_USER_ZDOTDIR
ZDOTDIR="$CHARTER_SHIM_ZDOTDIR"
builtin unset CHARTER_SHIM_ZDOTDIR
`;

const ZSH_ZSHRC = `# Charter shell integration (ADR-0021): OSC 133 semantic prompt marks.
if [[ -f "\${CHARTER_USER_ZDOTDIR:-$HOME}/.zshrc" ]]; then
  ZDOTDIR="\${CHARTER_USER_ZDOTDIR:-$HOME}"
  builtin source "\${CHARTER_USER_ZDOTDIR:-$HOME}/.zshrc"
fi
if [[ -o interactive && -z "\${CHARTER_SHELL_INTEGRATION-}" ]]; then
  export CHARTER_SHELL_INTEGRATION=1
  autoload -Uz add-zsh-hook
  __charter_in_command=""
  __charter_precmd() {
    local __charter_status=$?
    if [[ -n "$__charter_in_command" ]]; then
      __charter_in_command=""
      builtin printf '\\e]133;D;%s\\a' "$__charter_status"
    fi
    builtin printf '\\e]133;A\\a'
  }
  __charter_preexec() {
    __charter_in_command=1
    builtin printf '\\e]133;C\\a'
  }
  add-zsh-hook precmd __charter_precmd
  add-zsh-hook preexec __charter_preexec
  # Mark end-of-prompt = start of the command line; %{…%} keeps zle width math intact.
  PS1="$PS1%{$(builtin printf '\\e]133;B\\a')%}"
fi
`;

const BASH_INIT = `# Charter shell integration (ADR-0021) — loads your own bashrc first.
if [ -f "$HOME/.bashrc" ]; then
  builtin source "$HOME/.bashrc"
fi
if [ -z "\${CHARTER_SHELL_INTEGRATION-}" ]; then
  export CHARTER_SHELL_INTEGRATION=1
  __charter_in_command=""
  # Empty until the first prompt renders: the DEBUG trap must not treat the
  # remainder of this init file (PS1 assignment below) as a typed command.
  __charter_at_prompt=""
  __charter_prompt() {
    local __charter_status=$?
    if [ -n "$__charter_in_command" ]; then
      __charter_in_command=""
      builtin printf '\\e]133;D;%s\\a' "$__charter_status"
    fi
    builtin printf '\\e]133;A\\a'
    __charter_at_prompt=1
    return $__charter_status
  }
  __charter_preexec() {
    # DEBUG fires for every simple command; only the first one typed at a
    # prompt is the command start (bash-preexec's minimal guard).
    if [ -n "\${COMP_LINE-}" ]; then return; fi
    if [ -z "$__charter_at_prompt" ]; then return; fi
    case "$BASH_COMMAND" in
      __charter_prompt*) return ;;
    esac
    __charter_at_prompt=""
    __charter_in_command=1
    builtin printf '\\e]133;C\\a'
  }
  PROMPT_COMMAND="__charter_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  trap '__charter_preexec' DEBUG
  PS1="$PS1\\[\\e]133;B\\a\\]"
fi
`;

const FISH_CONF = `# Charter shell integration (ADR-0021): OSC 133 semantic prompt marks.
if status is-interactive; and not set -q CHARTER_SHELL_INTEGRATION
    set -gx CHARTER_SHELL_INTEGRATION 1
    function __charter_preexec --on-event fish_preexec
        printf '\\e]133;C\\a'
    end
    function __charter_postexec --on-event fish_postexec
        printf '\\e]133;D;%s\\a' $status
    end
    function __charter_prompt_mark --on-event fish_prompt
        printf '\\e]133;A\\a'
    end
    if functions -q fish_prompt
        functions -c fish_prompt __charter_user_prompt
        function fish_prompt
            __charter_user_prompt
            printf '\\e]133;B\\a'
        end
    end
end
`;

/** Files the host writes once per launch (relative to the integration dir). */
export const SHELL_INTEGRATION_FILES: ReadonlyArray<{ path: string; content: string }> = [
  { path: 'zsh/.zshenv', content: ZSH_ZSHENV },
  { path: 'zsh/.zshrc', content: ZSH_ZSHRC },
  { path: 'bash/charter-integration.bash', content: BASH_INIT },
  { path: 'fish-xdg/fish/vendor_conf.d/charter-integration.fish', content: FISH_CONF },
];

export interface ShellIntegrationConfig {
  /** Directory the SHELL_INTEGRATION_FILES were written into; null = not available. */
  dir: string | null;
  /** settings.terminal.shellIntegration at spawn time. */
  enabled: boolean;
}

export interface ShellSpawnPlan {
  args: string[];
  env: Record<string, string>;
  /** True when this spawn will emit OSC 133 (known shell + enabled + dir). */
  injected: boolean;
}

function shellBasename(shell: string): string {
  const clean = shell.split('\\').join('/');
  return clean
    .slice(clean.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/^-/, '');
}

/**
 * Map (shell, config) → spawn args/env. Pure so tests can cover the whole
 * degradation matrix without a PTY.
 */
export function shellIntegrationSpawn(
  shell: string,
  config: ShellIntegrationConfig | null,
  baseEnv: Record<string, string | undefined> = process.env,
): ShellSpawnPlan {
  const none: ShellSpawnPlan = { args: [], env: {}, injected: false };
  if (!config || !config.enabled || !config.dir) return none;
  const name = shellBasename(shell);
  if (name === 'zsh') {
    const env: Record<string, string> = { ZDOTDIR: `${config.dir}/zsh` };
    if (baseEnv.ZDOTDIR) env.CHARTER_USER_ZDOTDIR = baseEnv.ZDOTDIR;
    return { args: [], env, injected: true };
  }
  if (name === 'bash') {
    return {
      args: ['--init-file', `${config.dir}/bash/charter-integration.bash`],
      env: {},
      injected: true,
    };
  }
  if (name === 'fish') {
    const xdg = `${config.dir}/fish-xdg`;
    const existing = baseEnv.XDG_DATA_DIRS;
    return {
      args: [],
      env: {
        XDG_DATA_DIRS: existing ? `${xdg}:${existing}` : `${xdg}:/usr/local/share:/usr/share`,
      },
      injected: true,
    };
  }
  return none;
}
