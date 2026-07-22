# ADR-0045: User-level instruction surfaces for external CLIs (skill install to ~/.claude and ~/.codex)

- Status: Accepted
- Date: 2026-07-22
- Related: ADR-0044 (session orchestration, decision 8 "instruction surfaces"), ADR-0015 (managed
  skills store), ADR-0017 (external sessions). External reference: alchaincyf/fanbox
  `builtinSkillInstall` (copies its bundled skill into `~/.claude/skills/` from a settings click,
  with an installed/upToDate byte comparison).

## Context

ADR-0044 deliberately avoided editing `~/.claude`, `~/.codex`, or project files: external CLIs
receive the `charter` MCP server through ephemeral wrapper scripts in
`<userData>/terminal-control/bin`, prepended to every product pty's PATH.

Field failure (2026-07-22, first real orchestration attempt from a hand-launched Claude Code
session): the wrapper chain was bypassed three independent ways on one ordinary developer machine —

1. **Shell aliases win over PATH.** The user's `codex` is an alias (proxy env prefix); an alias
   resolves before any PATH lookup, so the wrapper never runs.
2. **Profile PATH prepends outrank the injected binDir.** `~/.zshrc` prepends `~/.local/bin` (and
   others) in front of the pty-injected wrapper directory; the real `claude` lives there and
   shadows the wrapper.
3. **Installer migration leaves a stale wrapper.** The wrapper pins the CLI's absolute path as
   resolved at app launch. After the user migrated claude from an nvm global to the native
   installer, launches logged `claude:false`, the old wrapper (pointing at a deleted path) was left
   behind, and pty-spawned `terminal.create launch:'claude'` would exec a nonexistent file.

The observable symptom: the agent, asked to "create a codex worker", had no `terminal_*` tools and
fell back to probing `codex --help` with Bash. Meanwhile FanBox's skill-only route has none of
these failure modes, because it depends only on (a) a file in the CLI's user-level skills
directory, read regardless of how the CLI was launched, and (b) pty-injected environment
variables, which aliases and profiles cannot remove. Codex CLI has supported the same user-level
skills directory (`~/.codex/skills`, SKILL.md standard) since December 2025, so one manual serves
both CLIs.

## Decision

1. **User-level skill install, explicit click only.** The existing settings action ("External CLI
   instructions") now installs the bundled `charter-terminal` manual into three places: Charter's
   managed skills store (unchanged, for the Pi runtime surface), `~/.claude/skills/charter-terminal/SKILL.md`,
   and `~/.codex/skills/charter-terminal/SKILL.md`. Writes are atomic (tmp + rename), happen only
   on the user's click, and never run at app launch or in the background. This amends ADR-0044's
   "without editing ~/.claude, ~/.codex" line: the wrapper still avoids silent edits; the skill
   install is a user-initiated, inspectable file the user can delete at any time.
2. **FanBox-style freshness.** A status IPC (`skills.charterTerminalStatus`) compares each
   installed SKILL.md byte-for-byte against the bundled manual and reports
   installed/upToDate/error per target; the settings row shows the state and the same button
   updates outdated copies. A user-edited copy therefore shows as "update available" and is
   overwritten only by another explicit click.
3. **The manual carries its own trigger conditions.** The skill description names the trigger
   scenarios (open/direct another terminal or Claude/Codex window, parallel experiments) and the
   availability gate (`CHARTER_CTL` present); the body opens with a door self-check and routes
   sessions without the `charter` MCP server to the `charter-terminal` Bash command or raw
   `curl --unix-socket` — the same door with the same host-side enforcement. Etiquette prose stays
   non-normative: every safety rule remains enforced by the Permission Engine and the control door
   (ADR-0044 decisions 2–7).
4. **Wrapper chain hardened, not removed.** MCP wrappers remain the zero-prompt-overhead path for
   product-launched sessions. Two fixes land with this ADR: CLI resolution searches well-known
   installer directories (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`) after the
   process PATH, and a launch that no longer finds a CLI deletes that CLI's stale wrapper instead
   of leaving a dead exec target.

## Alternatives

- **Wrapper-only (status quo)**: rejected by field evidence — three independent bypasses on one
  machine, all outside the product's control.
- **`claude mcp add --scope user` / codex `config.toml` edits**: rejected for now — writes to CLI
  config files the product does not own, harder to inspect and undo than a skill folder; can be
  revisited as an opt-in button later.
- **AGENTS.md marker block for codex**: superseded — codex reads `~/.codex/skills` natively, so
  the skill file suffices; `CHARTER_TERMINAL_AGENTS_SNIPPET` remains available as a manual
  copy-paste aid.
- **Automatic install at app launch**: rejected — silent writes into another tool's home
  directory violate the user's ownership of `~/.claude`/`~/.codex`; the click is the consent.

## Security and data impact

The skill file contains instructions only (no token, no socket path — those stay in pty env).
Installing it grants no capability: without `CHARTER_CTL`/`CHARTER_CTL_TOKEN` in the environment,
the documented commands fail closed (403/`CTL_IDENTITY_MISSING`), and with them every call still
traverses the token door, Permission Engine, budgets, and ledger (ADR-0044). Risk of stale manuals
diverging from the product is bounded by the upToDate comparison surfaced in settings.

## Migration and rollback

No schema changes. `skills.installCharterTerminal` response gains a `surfaces` field (channel
version 2); `skills.charterTerminalStatus` is new. Rollback: revert the commit; installed
SKILL.md files are inert documentation the user can delete (`rm -r ~/.claude/skills/charter-terminal
~/.codex/skills/charter-terminal`).

## Verification

- Unit: surfaces install/status/refresh/partial-failure (`charter-terminal-surfaces.test.ts`);
  stale-wrapper cleanup and fallback-dir resolution (`terminal-control-integration.test.ts`);
  trigger-condition presence in the manual (`terminal-control-manual.test.ts`).
- Manual field check: hand-launched (aliased) claude/codex sessions in a Charter terminal can
  discover and drive the door via the installed skill with no MCP wrapper involved.
