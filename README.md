<div align="center">

# Charter

### Let agents move fast. Keep every move in sight.

**Charter is the local-first cockpit for coding agents that need to show their work.**<br>
Run the built-in Charter Agent, Claude Code, and Codex on real repositories; watch every edit as it happens, steer from the running product, and approve evidence instead of promises.

*The agent says it is done. Charter shows you why you should believe it.*

[![Beta 2](https://img.shields.io/badge/release-v1.0.0--beta.2-C47A19?style=flat-square)](https://github.com/longyunfeigu/Charter/releases/tag/v1.0.0-beta.2)
[![CI](https://img.shields.io/github/actions/workflow/status/longyunfeigu/Charter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/longyunfeigu/Charter/actions/workflows/ci.yml)
[![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-1B1A16?style=flat-square&logo=apple&logoColor=white)](https://github.com/longyunfeigu/Charter/releases/latest)
[![Windows](https://img.shields.io/badge/Windows-x64-0078D4?style=flat-square&logo=windows&logoColor=white)](https://github.com/longyunfeigu/Charter/releases/latest)
[![Linux](https://img.shields.io/badge/Linux-x64-F4B728?style=flat-square&logo=linux&logoColor=111111)](https://github.com/longyunfeigu/Charter/releases/latest)
[![MIT License](https://img.shields.io/badge/license-MIT-2F855A?style=flat-square)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

[Download Beta](https://github.com/longyunfeigu/Charter/releases/latest) · [Product tour](#product-tour) · [What it does](#what-it-does) · [Quick start](#quick-start) · [Architecture](#architecture)

</div>

![Charter Session showing the conversation, recorded file activity, inline diff, verification result, and review actions](docs/assets/readme/session-diff.png)

<p align="center"><sub>A real Charter Session: conversation, live work, code, verification, and the final decision on one screen. README captures come directly from the Electron app through Playwright.</sub></p>

> [!IMPORTANT]
> Charter is a **development preview**. Beta artifacts are unsigned and not notarized, so operating-system trust policy may warn or block them. Published releases include SHA-256 checksums, an SBOM, and a machine-readable manifest. Do not disable OS security globally; build from source if unsigned applications are not permitted on your machine.

## Why Charter

Coding agents are fast. A spinner is not observability, and a generated summary is not proof.

Most agent tools optimize the moment you send a prompt. Charter is built for everything that follows: seeing what is happening now, knowing when your attention is needed, trying the result in context, and deciding whether the work deserves to land.

| The usual agent workflow | The Charter workflow |
| --- | --- |
| Wait for a transcript or final summary | Watch the current action, file writes, commands, and diff as they happen |
| Switch between chat, terminal, editor, and browser | Keep the conversation, real PTY, files, and live Preview in one Session |
| Describe a visual bug from memory | Pick the exact element or draw a region and send structured visual context back |
| Keep checking whether the agent is done | Let Charter call you back to the exact Session that needs attention |
| Repeat the same correction next week | Distill review feedback into an editable, project-owned rule |
| Trust a generated "done" message | Review recorded changes, checks, preview evidence, and history before approving |

In Charter, a **Session** is the durable unit of human-agent work, not just a chat:

```text
Session = project + agent + worktree + conversation + plan
        + live activity + files + terminals + preview
        + verification + review + replay + memory
```

### One continuous loop

| 1. Charter | 2. Watch | 3. Steer | 4. Decide |
| --- | --- | --- | --- |
| Choose a project, agent, autonomy mode, model, and verification plan | Follow tool calls, file heat, commands, child workers, and progress live | Attach code, terminal output, screenshots, Preview elements, or a correction mid-run | Inspect Diff and checks, request changes, approve, merge back, or roll back byte-for-byte |

You can leave a long-running Session without losing the thread, then return to the same conversation, PTYs, files, evidence, and decision state.

## Product tour

### Watch the edit happen, not a spinner

The Room narrates the active tool call while the Session canvas shows files heating up as the agent writes. Rhythm bars, write beacons, additions and deletions, and the chronological ledger all project the same recorded events. Click a live file to inspect its diff-so-far without leaving the conversation.

![Charter showing live file activity, writing heat, rhythm, and the current tool action inside a running Session](docs/assets/readme/live-file-activity.png)

- **Immediate presence:** see the current action, target path, elapsed time, token flow, and read/write state.
- **File-level signal:** hot, warm, and cooling tiles reveal where work is concentrated.
- **Safe steering:** add instructions and structured context while the run is active instead of restarting it.
- **One event stream:** the Rail, Room, Diff, Review, and Replay agree because they read the same ledger.

### One composer, whichever agent fits the job

Start the managed Charter Agent, Claude Code, or Codex from the same composer. Choose the project, permission mode, model, thinking level, and checks before work begins.

![Charter composer with Charter Agent, Claude Code, and Codex in one agent picker](docs/assets/readme/agent-picker.png)

The managed agent works through Charter's Tool Gateway. Installed Claude Code and Codex CLIs keep their native terminal experience and conversation identity while Charter preserves the PTY, accounts for repository changes, and brings the outcome into the same review model.

A Session can also direct a visible fleet of shell, Claude Code, and Codex workers. Workers stay attributable and open for follow-up; approvals, pause/takeover state, and control actions remain visible instead of disappearing into background jobs.

### Preview the real product and point at the problem

Charter detects a loopback dev server belonging to the task's own tree and opens it beside the conversation. There is no context switch and no vague "the orange text near the button" feedback.

![Charter live Preview beside the Session conversation with an element attachment ready to send back to the agent](docs/assets/readme/live-preview.png)

- **Open at any stage:** keep Preview available during the run, at review, and after completion.
- **Pick an element:** attach its selector, bounds, text, page URL, and screenshot.
- **Draw a region:** mark a visual area when a DOM selector is not the right language.
- **Bring errors back:** send captured Preview console errors manually or through a bounded policy.
- **Keep isolation honest:** a worktree Session only shows servers attributed to that task tree.

### Walk away; Charter will call you back

When an agent finishes, needs approval, answers a question, or is ready for review, Charter surfaces a clickable notice. The exact Session gains a short-lived ripple and reply signal in the Rail, making it easy to find without turning the whole app into an alarm panel.

![Charter completion notice with the corresponding Session highlighted by a water-ripple attention effect in the left rail](docs/assets/readme/completion-attention.png)

Notifications are configurable, and quiet completed work remains discoverable in Session history.

### Proof before approval

Review is not a summary modal at the end of a chat. Charter keeps the outcome, changed files, additions and deletions, verification history, and final actions together.

![Charter review surface showing changed files, a passed verification run, and request, rollback, and approve actions](docs/assets/readme/session-review.png)

Inspect an inline or accessible text Diff, rerun checks, request a fix with line context, roll back the recorded change set, or approve it. Check history is immutable: a new run never overwrites an old failure, and stale or superseded evidence stays visible. Completed Sessions open in result-first **Recap**, deeper **Explore**, and evidence-focused **Verify** views.

### Make corrections improve the next run

Charter captures review feedback as a Memory candidate, lets you edit or dismiss it, and writes approved rules to the project's git-shareable `.charter/rules.md`.

![Charter Memory manager showing project rules, injection statistics, and optional distribution targets](docs/assets/readme/memory-management.png)

- **Review as learning:** turn a requested fix or plan correction into an explicit reusable rule.
- **Measured reuse:** see where rules were injected and whether the same slip happened again.
- **Controlled distribution:** optionally project managed blocks into `CLAUDE.md` or `AGENTS.md`.
- **No silent overwrite:** hand-edited managed blocks require an explicit import, overwrite, or stop decision.
- **Private memory stays private:** external CLI memory is only promoted into project rules when you choose.

## What it does

Charter combines agent orchestration, a desktop IDE, controlled execution, live observability, visual feedback, durable evidence, and project learning in one Session model.

### Sessions and agent orchestration

- **Three execution backends:** use the managed Charter Agent, Claude Code, or Codex without flattening their different trust models into one fiction.
- **Four autonomy modes:** choose Read, Approve, Auto, or Full while hard safety boundaries remain explicit.
- **Plan-aware execution:** write tasks can propose a plan and wait for approval before plan-gated changes begin.
- **Visible worker fleets:** create and direct sibling shell or agent PTYs with a live monitor, synchronized approvals, pause-all, and per-worker takeover.
- **Conversation continuity:** keep following up on managed Sessions and resume supported external CLI conversations with their original identity and working directory.
- **Multi-project Rail:** monitor Sessions across repositories while every task retains its own project context, worktree, and state.

### Observe and steer

- **Live file presence:** see write heat, rhythm, diff statistics, and a writing beacon while changes land.
- **Structured context:** attach files, folders, frozen line selections, images, search results, terminal excerpts, and Preview captures with provenance.
- **Screenshot express:** on supported macOS setups, a new screenshot or clipboard capture can be attached to the active agent, annotated, or filed into project assets.
- **Attention routing:** completion notices, needs-attention filters, Rail signals, and system notifications return you to the exact Session.
- **Session archaeology:** discover supported local Claude Code and Codex histories, inspect their project attribution, and adopt resumable work into Charter.
- **Honest lifecycle states:** distinguish working, waiting, review-ready, answered, accepted, rolled back, interrupted, and ended external sessions.

### Files, editor, and terminals

- **One project tree:** browse, create, rename, trash, drag as context, and inspect Git decorations without a second competing file explorer.
- **IDE navigation:** use Quick Open, global search and replace preview, Git Changes, Problems, and the command palette.
- **Language intelligence:** diagnostics, go-to-definition, and rename preview are available through supported language services.
- **Persistent real PTYs:** terminals survive surface changes and preserve command boundaries, output, exit status, duration, progress, and reruns.
- **Quick Console:** press `Option+Space` for a persistent scratch or project terminal, then send selected output into the current Room.
- **Clickable terminal paths:** command output can open a file, line, or local HTML page directly in Charter or the default browser.
- **Four coordinated skins:** Studio, Terminal, Archive, and Index change the complete interface language, not just one accent color.

### Preview, change control, and evidence

- **Task-attributed Preview:** discover loopback ports by process working directory so the wrong checkout cannot impersonate the task's app.
- **Isolated Git worktrees:** let coding Sessions work away from the main checkout, then review, merge back, discard, or roll back explicitly.
- **Recorded file operations:** writes create checkpoints used by Diff, Review, Replay, conflict checks, and byte-exact rollback.
- **Immutable verification history:** preserve passed, failed, stale, and superseded check results rather than replacing history with one green badge.
- **Evidence-first Review:** keep outcome, files, hunks, checks, Preview evidence, and the final decision together.
- **Reproducible Replay:** export bounded HTML/JSON receipts with per-row hashes and an explicit statement of what the ledger cannot prove.
- **Side-effect-free PR draft:** prepare branch, body, and command guidance without silently committing, pushing, or publishing anything.

### Memory and skills

- **Project-owned rules:** approved Memory lives in `.charter/rules.md`; candidate state and usage counters stay machine-local.
- **Drift-aware projections:** sync controlled blocks into external instruction files without overwriting hand edits silently.
- **Auditable skills:** inspect `SKILL.md` and bundled files, flag scripts, enable trusted sources, and invoke skills from the `/` picker.
- **Live skill sources:** trusted Agent Skills directories can update the catalog without copying ownership into Charter.
- **Usage insight:** see which skills were used, by which supported consumer, and where unused or costly context may need cleanup.

### Local state, security, and privacy

- **Sandboxed renderer:** the UI reaches privileged capabilities only through a narrow Preload bridge and versioned, schema-validated IPC.
- **Isolated model loop:** the Agent Worker owns the managed model runtime but has no direct filesystem, database, or at-rest secret access.
- **Tool Gateway boundary:** managed calls are schema-checked, path-bounded, permission-classified, redacted, executed, and audited in Electron Main.
- **OS-backed credentials:** provider secrets use Electron `safeStorage`; the renderer receives redacted metadata only.
- **Local evidence ledger:** projects, task state, decisions, Replay facts, and Memory metadata remain in local SQLite and bounded blob stores.
- **Preview containment:** embedded pages are limited to detected loopback servers with navigation, popup, permission, and frame policies.

> [!NOTE]
> Local-first does not mean offline inference. Prompts and the context you attach are sent to the model endpoint you configure and remain subject to that provider's data policy. External Claude Code and Codex sessions also retain their own permission and network models.

## Quick start

### Download the unsigned Beta

Download the current artifact and `SHA256SUMS.txt` from the [latest GitHub Release](https://github.com/longyunfeigu/Charter/releases/latest).

| Platform | Artifact | Preview target |
| --- | --- | --- |
| macOS | `.dmg` or `.zip` | Apple Silicon (`arm64`) |
| Windows | NSIS installer | `x64` |
| Linux | `.tar.gz` | `x64` Preview |

The binaries are unsigned and not notarized. Gatekeeper, SmartScreen, Smart App Control, enterprise policy, or antivirus software may refuse to launch them. Read the [release notes](docs/RELEASE_NOTES.md), [known limitations](docs/KNOWN_LIMITATIONS.md), [privacy notice](PRIVACY.md), and [security policy](SECURITY.md) before using the preview on an important repository. Updates are manual.

### Run from source

Prerequisites: [Node.js](https://nodejs.org/) **22.19 or newer**, npm, and Git.

```bash
git clone https://github.com/longyunfeigu/Charter.git
cd Charter
npm install
npm run dev
```

On first launch:

1. Open a Git project.
2. Open **Settings -> Models**, add a provider, and fetch its model list.
3. Create a Session, choose an agent and autonomy mode, then describe the outcome you want.
4. Attach files, lines, images, or a verification plan when the task needs concrete context.
5. Follow the live Session and review the recorded evidence before accepting changes.

Charter includes presets for Anthropic, OpenAI, OpenRouter, and LiteLLM, plus custom Anthropic- or OpenAI-compatible endpoints.

To explore the complete managed flow without a provider key on macOS or Linux, use the deterministic mock runtime:

```bash
PI_IDE_FORCE_MOCK=1 npm run dev
```

To use **Claude Code** or **Codex** as external agents, install the CLI separately and ensure its executable is on `PATH`.

## Shortcuts

macOS keys are shown; use `Ctrl` in place of `Command` on Windows and Linux where applicable.

| Action | Shortcut | Action | Shortcut |
| --- | --- | --- | --- |
| Search everything | `Command+K` | New Session | `Command+N` |
| Open Editor | `Command+E` | Quick Console | `Option+Space` |
| Command Palette | `Command+Shift+P` | Quick Open | `Command+P` |
| Open project | `Command+O` | Workspace search | `Command+Shift+F` |
| Toggle Agent panel | `Command+L` | Toggle bottom panel | `Command+J` |
| New terminal | `Control+Backtick` | Stop active agent | `Command+Escape` |

## Architecture

Charter separates the experience, model loop, tool execution, project services, and durable evidence into distinct trust boundaries.

![Detailed six-layer Charter architecture showing the experience, trust bridge, control, execution, workspace services, and evidence data planes](docs/assets/readme/architecture.webp)

| Plane | Responsibility |
| --- | --- |
| **01 - Experience** | Session Rail, Room, Editor, Preview, Terminal, Review, Replay, Memory, and Skills |
| **02 - Trust bridge** | Sandboxed Preload and versioned IPC schemas, the renderer's only route to privileged capabilities |
| **03 - Control** | Task state, project contexts, Tool Gateway, permissions, Preview, Replay, and orchestration |
| **04 - Execution** | The isolated managed Agent Worker and separately trusted Claude Code/Codex PTYs |
| **05 - Workspace services** | Documents, search/language, Git/change tracking, terminals, and verification |
| **06 - Evidence and data** | SQLite ledger, content blobs, attachments, worktrees, project rules, and OS-backed secrets |

The managed **Agent Worker** owns the model loop but cannot directly read files, run commands, or access secrets. Tool requests return to **Electron Main**, where the Tool Gateway validates schemas and workspace boundaries, applies permission policy, executes the operation, redacts sensitive output, and records evidence.

External Claude Code and Codex sessions deliberately have a different boundary. Charter preserves their real PTY, observes lifecycle and conversation identity, accounts for repository changes, and brings the result into Review; the external CLI still owns its internal permission model.

### Permission model

| Level | Typical operation | Default treatment |
| --- | --- | --- |
| **R0 - Read** | Read files, search, diagnostics, `git status` and `git diff` | Allowed |
| **R1 - Workspace write** | Create or edit files inside the isolated worktree | Ask, or allow after plan/mode policy |
| **R2 - Local execution** | Known local commands and verification | Known checks may run; unknown commands ask |
| **R3 - External or consequential** | Networked or consequential operations | Explicit confirmation unless a documented mode policy applies |
| **R4 - Blocked** | `sudo`, `git push`, secret reads, outside-workspace writes, broad destructive commands | Rejected by the product |

Application-level permissions are not an operating-system sandbox. Review commands before approval and use additional isolation for untrusted repositories or instructions.

## Built with

| Layer | Core technology |
| --- | --- |
| Desktop shell | Electron 43, sandboxed Preload, hardened packaging fuses |
| Interface | React 19, Zustand, Vite |
| Editing | Monaco Editor, MDXEditor, React Markdown |
| Terminal | node-pty, xterm.js, WebGL, Unicode 11 support |
| Search | ripgrep-backed workspace search |
| Agent runtime | Pi coding-agent adapter plus external Claude Code/Codex PTYs |
| Quality | TypeScript, Vitest, Playwright Electron, security and performance gates |
| Distribution | electron-builder, checksums, SPDX SBOM, release manifest |

The exact third-party inventory is generated from the release lockfile. See [THIRD_PARTY_LICENSES.md](docs/THIRD_PARTY_LICENSES.md) for how published artifacts record licenses and notices.

## Repository layout

```text
apps/
  desktop-main/       Electron host, IPC routing, task engine, services
  desktop-preload/    Narrow, versioned renderer bridge
  desktop-renderer/   Session-first React interface
  agent-worker/       Isolated managed model loop
packages/
  agent-runtime-pi/   Pi runtime adapter
  tool-gateway/       Tool policy, execution, and evidence boundary
  persistence/        Local SQLite state and ledger
  *-service/          Workspace, Git, files, search, terminal, verification
tests/
  unit + security + performance + Playwright Electron E2E
docs/
  product specification, ADRs, implementation status, release evidence
```

Useful references:

- [Implementation status](docs/IMPLEMENTATION_STATUS.md) - evidence-backed feature and milestone status.
- [Product and engineering specification](docs/PRODUCT_ENGINEERING_SPEC.md) - requirements, state machines, security, and acceptance criteria.
- [Session-first UX specification](docs/UX_PIVOT_SPEC.md) - the product object and shell model.
- [Architecture decisions](docs/DECISIONS.md) - ADR index and rationale.
- [Release checklist](docs/RELEASE_CHECKLIST.md) - completed Beta gates and remaining Stable gates.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build and launch the Electron app in development mode |
| `npm run build` | Produce renderer, preload, main, and worker builds |
| `npm run check` | Run formatting, architecture-boundary, and TypeScript checks |
| `npm test` | Run the unit and integration suite |
| `npm run test:e2e` | Build and run the Playwright Electron suite |
| `npm run test:security` | Run secret scanning, security tests, build, and security E2E |
| `npm run test:perf` | Run performance gates |
| `npm run package -- --dir-only` | Build an unpacked desktop artifact for smoke testing |

For a focused Electron test while iterating:

```bash
npm run build
npx playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/session-canvas.spec.ts
```

The product screenshots in this README are reproducible from the real application:

```bash
npm run build
CHARTER_README_SHOTS=1 npx playwright test \
  --config tests/e2e/playwright.config.ts \
  tests/e2e/readme-assets.spec.ts
```

## Project status

Charter is being developed in public toward its first signed Stable desktop release.

- **Published now:** `v1.0.0-beta.2` is the first downloadable unsigned preview for macOS Apple Silicon, Windows x64, and Linux x64.
- **Implemented on the current source tree:** the Session-first shell, managed agent path, external CLI accounting and orchestration, live file presence, structured context, Preview, Terminal, Verification, Review, Replay, Memory, Skills, and core security boundaries.
- **Release pipeline:** three-platform packaging, manifests, checksums, SBOM/license inventory, packaged-app smoke tests, database upgrade/restore rehearsal, and credential-free gates are in place.
- **Still open for Stable:** Apple notarization, trusted Windows signing, automatic updates, fixed-task real-provider qualification, and final owner sign-off.

The README follows the current source tree; the downloadable Beta may trail ongoing work on `main`. See the [Beta 2 release notes](docs/RELEASE_NOTES.md) for its exact contents and [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for current evidence.

## Contributing

Contributions that strengthen the Session model, evidence quality, platform reliability, security boundaries, accessibility, or release readiness are especially welcome.

1. Read [AGENTS.md](AGENTS.md) and the relevant product or ADR documentation.
2. Pick a scoped item from the [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md), or open an issue describing the behavior you want to change.
3. Keep architectural boundaries intact and add tests proportional to the risk.
4. Run `npm run check`, `npm test`, and `npm run build` before opening a pull request; include targeted Electron E2E evidence for UI changes.

Please do not mark speculative or partially implemented behavior as complete. Charter's contribution standard is simple: claims should be backed by observable evidence.

## License

Charter is available under the [MIT License](LICENSE).

---

<div align="center">

**Prompts start the work. Evidence earns the approval.**

[Download Beta](https://github.com/longyunfeigu/Charter/releases/latest) · [Website](https://charter-15n.pages.dev) · [Report an issue](https://github.com/longyunfeigu/Charter/issues)

</div>
