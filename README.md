<div align="center">

# Charter

### Let agents move fast. Keep every move in sight.

Charter is a local-first desktop Agent IDE where the Charter Agent, Claude Code, and Codex can work on real repositories—while you watch the edits happen, steer from the running preview, and approve evidence instead of promises.

[![Development Preview](https://img.shields.io/badge/status-development_preview-C47A19?style=flat-square)](#project-status)
[![CI](https://img.shields.io/github/actions/workflow/status/longyunfeigu/Charter/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/longyunfeigu/Charter/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-2F855A?style=flat-square)](LICENSE)
[![Website](https://img.shields.io/badge/website-charter--15n.pages.dev-1B1A16?style=flat-square)](https://charter-15n.pages.dev)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-417E38?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

[English](README.md) · [简体中文](README.zh-CN.md)

[Why Charter](#why-charter) · [Product tour](#product-tour) · [Capabilities](#capability-map) · [Quick start](#quick-start) · [Architecture](#architecture) · [Project status](#project-status)

</div>

![Charter Session showing the conversation, recorded file activity, inline diff, verification result, and review actions](docs/assets/readme/session-diff.png)

<p align="center"><sub>Conversation, live file activity, code, verification, and the final decision—one Session, one screen.</sub></p>

> [!IMPORTANT]
> Charter is a **development preview**. Credential-free Beta artifacts are published as unsigned GitHub prereleases with checksums and an SBOM. They may be blocked by operating-system trust policy; build from source if unsigned applications are not permitted. Signed Stable distribution remains open.

## Why Charter

Coding agents are fast. A spinner is not observability.

Most agent tools optimize the moment you send a prompt. Charter is built for everything that follows: seeing what is happening now, catching the exact moment your attention is needed, trying the result in context, and deciding whether the work deserves to land.

| The usual agent workflow | The Charter workflow |
| --- | --- |
| Wait for a transcript or final summary | Watch the current action, file writes, heat, rhythm, commands, and diff as they happen |
| Leave the conversation to find a browser preview | Open the task's live Preview beside the conversation and point at the exact UI element to change |
| Keep checking whether the agent is done | Get a clickable completion notice while the Session row ripples and lightly shakes for attention |
| Repeat the same correction next week | Distill review feedback into an editable project rule, then track where it is injected |
| Trust a generated “done” message | Review recorded changes, checks, preview evidence, and history before approving or rolling back |

In Charter, a **Session** is the durable unit of human-agent work—not just a chat:

```text
Session = project + agent + worktree + conversation + plan
        + live activity + files + terminals + preview
        + verification + review + replay + memory
```

The result is an agent workflow you can leave running without losing the thread—and return to without reconstructing what happened.

## Product tour

### Watch the edit happen—not a spinner

The Room narrates the active tool call while the Session canvas shows files heating up as the agent writes. Rhythm bars, a writing beacon, additions/deletions, and the chronological ledger all come from the same recorded events. Click a live file to open its read-only diff-so-far without leaving the conversation.

![Charter showing live file activity, writing heat, rhythm, and the current tool action inside a running Session](docs/assets/readme/live-file-activity.png)

- **Immediate presence:** see the current action, path, elapsed time, token flow, and write state.
- **File-level signal:** hot, warm, and cooling tiles reveal where work is concentrated.
- **One event stream:** the Session Rail, timeline, live tiles, Diff, and later Replay agree because they project the same ledger.
- **Safe steering:** reply while the run is active; you do not have to stop and restart just to add context.

### Walk away. Charter will call you back.

When an agent finishes, needs approval, answers a question, or is ready for review, Charter surfaces a clickable in-app notice. The exact Session also gains a short-lived water-ripple and reply-shake signal in the left rail, so the result is hard to miss without turning the whole app into an alarm panel.

![Charter completion notice with the corresponding Session highlighted by a water-ripple attention effect in the left rail](docs/assets/readme/completion-attention.png)

Click the notice to reveal the exact Session and state. Notifications are configurable, and quiet completed work remains discoverable in Session history.

### Preview in the Room. Point at what should change.

Charter detects a loopback dev server belonging to the task's own tree and opens it directly beside the conversation. No context switch, no vague “the orange text near the button” feedback.

![Charter live Preview beside the Session conversation with an element attachment ready to send back to the agent](docs/assets/readme/live-preview.png)

- **Open at any stage:** the Preview rail remains available during a run, at review, and after full-auto completion.
- **Pick an element:** select a real page element; Charter attaches its selector, bounds, text, URL, and screenshot to the composer.
- **Draw a region:** mark a visual area when a selector is not the right language.
- **Bring errors back:** preview console errors can be surfaced for manual sending or forwarded under the configured policy.
- **Keep isolation honest:** a worktree Session only shows ports attributed to that task tree—not a lookalike server from the main checkout.

### Turn review feedback into durable Memory

Corrections should improve the next run, but they should never become invisible model folklore. Charter captures review feedback as a candidate, lets you edit or dismiss it, and writes approved rules to the project's git-shareable `.charter/rules.md`.

![Charter Memory manager showing project rules, injection statistics, and optional distribution targets](docs/assets/readme/memory-management.png)

- **Review-as-learning:** request a fix, approve the inline distill card, and reuse the rule on the next managed run.
- **Inspectable statistics:** see enabled rules, injection counts, repeated slips, and unresolved candidates.
- **Controlled distribution:** optionally project rules into managed blocks in `CLAUDE.md` or `AGENTS.md`.
- **No silent overwrite:** hand-edited managed blocks are flagged as drift and require an explicit import, overwrite, or stop decision.
- **Private memory stays private:** browse supported Claude Code and Codex memory locations, then explicitly promote a copy into a Charter rule candidate when useful.

### One composer, whichever agent fits the job

Choose the managed Charter Agent, Claude Code, or Codex from the same Session composer. Pick the project, permission mode, model, thinking level, and verification plan before the run begins.

![Charter composer with Charter Agent, Claude Code, and Codex in one agent picker](docs/assets/readme/agent-picker.png)

The managed Charter Agent runs through the Tool Gateway. Installed Claude Code and Codex CLIs keep their native terminal experience and conversation identity, while Charter preserves the PTY, accounts for repository changes, and brings the result into the same review model.

### Proof before approval

Review is not a summary modal at the end of the chat. Charter keeps the outcome, changed files, additions/deletions, verification history, and final actions together. Inspect the inline Diff, rerun checks, request a fix with code context, roll back byte-for-byte, or approve the recorded change set.

![Charter review surface showing changed files, a passed verification run, and request, rollback, and approve actions](docs/assets/readme/session-review.png)

Checks keep their history: a new run does not overwrite the old one, and stale or superseded evidence stays visible. Completed Sessions can be replayed through result-first **Recap**, deeper **Explore**, and evidence-focused **Verify** views.

## Capability map

Charter is more than a chat surface around a model API. It combines agent orchestration, a desktop IDE, controlled execution, live observability, visual feedback, durable evidence, and project learning in one Session model.

### At a glance

| Capability | What it changes |
| --- | --- |
| **Structured context** | Attach files, folders, selected line ranges, search results, terminal output, images, and preview feedback as typed references—not pasted guesswork |
| **Isolated worktrees** | Let coding Sessions work away from your main checkout, then review, merge back, discard, or roll back explicitly |
| **Real terminals** | Keep persistent PTYs, command blocks, progress, reruns, and external CLI sessions inside the same desktop workspace |
| **Visible worker fleets** | Let one Session create and direct visible shell, Claude Code, or Codex workers while approvals, pause/takeover state, and every control action stay attributable |
| **Quick Console** | Press `⌥Space` for a persistent scratch/project terminal and send selected output straight into the current Room |
| **Managed skills** | Audit, enable, and invoke skills through the `/` picker; linked skill sources update live only after you trust them |
| **Four autonomy modes** | Choose Read, Approve, Auto, or Full; permission boundaries and blocked operations remain explicit |
| **Verification & Replay** | Record checks, preview evidence, approvals, and a reproducible receipt instead of collapsing history into “passed” |
| **Local-first state** | Keep projects, task state, evidence, and Memory on your machine; provider credentials never enter the renderer |

### Session and agent orchestration

- **One durable Session object:** the goal, plan, conversation, agent identity, worktree, files, terminals, Preview, checks, decisions, Replay, and Memory provenance stay linked after the run ends.
- **Three execution backends:** start the managed Charter Agent, Claude Code, or Codex from the same composer without forcing every backend into the same runtime model.
- **Plan-aware execution:** managed write tasks can propose a plan, wait for approval or revision, and refuse plan-gated writes until the plan is accepted.
- **Mid-run steering:** add instructions and structured context while the agent is working instead of restarting the entire task.
- **Conversation continuity:** follow up on managed Sessions and resume supported external CLI conversations with their recorded identity and working directory.
- **Global multi-project rail:** keep Sessions from multiple repositories visible while each task retains its own project context and state.
- **Session-directed worker fleets:** a managed agent or an authenticated Claude Code/Codex terminal can create, read, send to, and wait for visible sibling PTYs through the same Tool Gateway and Permission Engine. Workers remain open for follow-up until the user closes them.
- **Fleet and director UI:** worker Sessions nest under their commander in the rail; the commander Room adds live monitor tiles, pause-all, per-worker pause/takeover, synchronized approval cards, and an automatic or locked/manual director stage.
- **Four autonomy modes:** Read, Approve, Auto, and Full change how plans and permissions are handled without removing hard safety boundaries.

### Live execution and attention

- **Current-action narration:** see the active tool, target path, elapsed time, token flow, and whether the agent is reading, writing, waiting, or verifying.
- **Live file presence:** event-driven heat tiles, write rhythms, diff statistics, and a writing beacon reveal where the run is changing the repository right now.
- **Shared evidence stream:** the Session Rail, Room timeline, live tiles, Diff, Review, and Replay are projections of the same recorded task events.
- **Thinking visibility:** optionally show the live reasoning stream as a collapsible, explicitly non-evidence block.
- **Attention without babysitting:** clickable completion notices, Session-row ripple/shake signals, needs-attention filters, and configurable system notifications bring you back to the exact task.
- **Honest lifecycle states:** distinguish working, waiting for approval, ready for review, answered, accepted, rolled back, interrupted, and ended external sessions.

### Context, files, and IDE workflow

- **Typed context references:** attach files, folders, frozen line selections, images, search results, terminal excerpts, and Preview captures with provenance instead of flattening them into prompt prose.
- **Drag-and-drop context:** drag from the project tree or the operating system into the Room; out-of-project images are imported as bounded task attachments.
- **In-Room File Peek:** inspect a file or diff beside the conversation, pin multiple tabs, and preserve the task's worktree boundary.
- **Project navigation:** use the persistent file tree, Quick Open, global search, regex replace preview, Git Changes, Problems, and the command palette.
- **Language intelligence:** diagnostics, go-to-definition, and rename preview are available for supported language services.
- **Editor continuity:** drafts, selected context, open files, and the Room's reading position survive movement between the Session and Editor surfaces.

### Isolation and change control

- **Task-scoped Git worktrees:** coding Sessions can run against an isolated tree while the main checkout remains available for normal work.
- **Per-project execution contexts:** documents, changes, permissions, tools, and verification services are mounted against the correct repository or worktree root.
- **Recorded file operations:** writes create change records and content checkpoints used by Diff, Review, Replay, conflict checks, and rollback.
- **Conflict-aware merge back:** Charter checks whether the main project changed while the task ran before applying isolated work.
- **Byte-exact rollback:** restore the recorded baseline rather than asking the model to “undo what it did.”
- **Reviewable change sets:** inspect files, hunks, additions/deletions, verification state, and stale review data before deciding.

### Preview and visual feedback

- **Task-attributed server detection:** discover loopback ports by process working directory so a worktree Session does not accidentally show the main checkout's server.
- **Room-native Preview:** keep the running product beside the agent conversation during execution, review, or after full-auto completion.
- **One-click dev start:** launch the detected project dev command in a background task terminal and keep the Preview surface in place.
- **Element Pick:** capture a real selector, element text, bounds, page URL, and screenshot as a structured feedback attachment.
- **Draw mode:** mark a visual region when the problem is spatial rather than DOM-addressable.
- **Console feedback:** surface loopback Preview errors and send them manually or under a bounded auto-forward policy.
- **Visible acceptance:** combine code changes, checks, screenshots, visual feedback, and the final product decision in the same review loop.

### Terminals and external agents

- **Persistent real PTYs:** terminals survive tab and surface changes instead of being reconstructed from command logs.
- **Legible command blocks:** preserve command boundaries, output, exit status, duration, progress, rerun relationships, and jump navigation.
- **Quick Console:** open a persistent scratch or project terminal with `⌥Space`, then send selected output directly into the current Room.
- **Terminal-to-context flow:** attach command output to a managed agent without copying unbounded scrollback into the prompt.
- **External CLI detection:** recognize supported Claude Code and Codex processes, preserve their terminal UI, and account for repository changes around the live session.
- **Conversation identity and resume:** record supported external session IDs so continuation targets the original conversation instead of whichever CLI session happens to be newest.
- **Authenticated local control door:** Charter-launched Claude Code and Codex sessions receive six native `charter` MCP tools plus a `charter-terminal` command fallback; both use a per-terminal, memory-only capability for the `0600` Unix socket, translate back into the same audited Gateway path, and disappear when Session orchestration is disabled.
- **One-click CLI manual install:** Settings installs the `charter-terminal` skill into Charter's Skills store plus `~/.claude/skills` and `~/.codex/skills` with a freshness check, so hand-launched claude/codex sessions (aliases, custom PATH) can also discover and drive the control door.
- **Observed vs. managed honesty:** external CLIs enter the same review workflow without pretending Charter controlled their internal permissions or reasoning stream.

### Verification, review, and Replay

- **Configured verification plans:** choose known checks before a run or execute recorded checks from Review.
- **Immutable check history:** reruns do not erase failures; passed, failed, stale, and superseded results remain distinguishable.
- **Evidence-first Review:** keep the agent's outcome, changed files, Diff, checks, Preview, and final actions together.
- **Request changes with context:** steer a fix from a selected line or visual issue and retain the correction in the Session record.
- **Approve, merge, or roll back:** the decision acts on the recorded change set, not on a generated completion claim.
- **PR draft from evidence:** prepare copyable branch, body, and command guidance without silently creating commits, branches, or pushes.
- **Three Replay depths:** use **Recap** for the result, **Explore** for the semantic story, and **Verify** for cited evidence and the receipt.
- **Evidence-bounded receipts:** export a reproducible HTML/JSON record with per-row hashes and an explicit boundary around what the ledger cannot prove.

### Memory and managed skills

- **Review-as-learning:** capture request-fix and plan corrections as editable Memory candidates rather than silently changing future behavior.
- **Git-shareable project rules:** approved rules live in `.charter/rules.md`, while injection counts and candidate state remain machine-local.
- **Measured reuse:** track how many tasks received a rule and whether the same correction slipped again.
- **Controlled projections:** optionally sync managed blocks into `CLAUDE.md` or `AGENTS.md` with explicit drift handling—never a silent overwrite.
- **Private-memory boundaries:** discover supported external CLI memory locations through opaque IDs, then explicitly view, promote, edit, or backup-delete supported files.
- **Auditable skills:** inspect `SKILL.md` and bundled files, flag scripts, choose Off or Auto, and invoke enabled skills from the `/` picker.
- **Trusted live sources:** external Agent Skills sources remain off until trusted, then file changes can update the running catalog without copying ownership into Charter.

### Local state, security, and privacy

- **Narrow renderer bridge:** the UI uses a sandboxed Preload and versioned schema-validated IPC instead of direct Node or filesystem access.
- **Isolated model loop:** the Agent Worker owns the managed model runtime but has no direct filesystem tools, database, or secrets at rest.
- **Tool Gateway boundary:** every managed tool call is schema-checked, path-bounded, permission-classified, executed, redacted, and audited in Electron Main.
- **R0–R4 policy:** read, write, local execution, consequential external operations, and blocked operations have explicit product treatment.
- **OS-backed credentials:** provider secrets are encrypted with Electron `safeStorage`; the renderer receives redacted metadata only.
- **Local evidence ledger:** task events, decisions, verification history, Replay facts, and Memory metadata are stored locally in SQLite and bounded blob stores.
- **Preview containment:** embedded pages are limited to detected loopback servers with navigation, window-open, permission, and frame policies.
- **Privacy controls:** crash previews are redacted, transport claims remain explicit, and local history deletion covers task-derived records.

### Desktop reliability and accessibility

- **Real desktop windowing:** Electron owns native menus, theme following, persisted window state, notifications, and terminal process lifecycles.
- **Responsive Session canvas:** the conversation and tool canvas resize, reorder at narrow widths, and preserve a user-adjusted split.
- **Accessible Diff:** line-based text mode, keyboard hunk navigation, focus outlines, and live announcements support non-visual review.
- **UI zoom:** scale the complete desktop surface—including Monaco and terminals—from 80% to 200%.
- **Bounded large-session rendering:** timeline windows, stream caps, virtualized lists, and large-tree budgets keep long-running work inspectable.

## Quick start

### Download the unsigned beta

Download the current artifacts and `SHA256SUMS.txt` from
[GitHub Releases](https://github.com/longyunfeigu/Charter/releases). The macOS and Windows binaries
are unsigned and not notarized; read the [known limitations](docs/KNOWN_LIMITATIONS.md) before launch.
Updates are manual in this preview.

### Prerequisites

- [Node.js](https://nodejs.org/) **22.19 or newer** (Node 24 is used in CI)
- npm
- Git

### Run from source

```bash
git clone https://github.com/longyunfeigu/Charter.git
cd Charter
npm install
npm run dev
```

On first launch:

1. Open a Git project.
2. Open **Settings → Models**, add a provider, and fetch its model list.
3. Create a Session, choose the agent and permission mode, then describe the outcome you want.

Charter currently includes presets for Anthropic, OpenAI, OpenRouter, and LiteLLM, plus custom Anthropic- or OpenAI-compatible endpoints. Credentials are encrypted with Electron's OS-backed `safeStorage`; the renderer sees only redacted configuration metadata.

> [!NOTE]
> Local-first describes Charter's project orchestration, state, evidence, and Memory storage—not offline inference. Prompts and the context you attach are sent to the model endpoint you configure and remain subject to that provider's data policy.

To explore the complete flow without a provider key on macOS or Linux, use the deterministic mock runtime:

```bash
PI_IDE_FORCE_MOCK=1 npm run dev
```

To use **Claude Code** or **Codex** as external agents, install their CLI separately and make sure its executable is available on `PATH`.

## Architecture

Charter separates the product into six cooperating planes. Solid arrows in the map are command/result paths; dashed arrows are events and durable evidence. The managed Agent Worker and external CLI PTYs are intentionally separate execution paths with different trust guarantees.

![Detailed six-layer Charter architecture showing the experience, trust bridge, control, execution, workspace services, and evidence data planes](docs/assets/readme/architecture.webp)

| Plane | Responsibility |
| --- | --- |
| **01 — Experience** | Session Rail, Task Room, Editor, Review/Replay, Preview/Terminal, and Memory/Skills surfaces |
| **02 — Trust bridge** | Sandboxed Preload and versioned IPC schemas—the renderer's only route into privileged capabilities |
| **03 — Control** | Task state, project contexts, Tool Gateway, permissions, external-session accounting, Preview, Replay, and Memory orchestration |
| **04 — Execution** | The isolated managed Agent Worker and separately trusted Claude Code/Codex PTYs |
| **05 — Workspace services** | Workspace, documents, search/language, Git/change tracking, terminal, and verification services |
| **06 — Evidence & data** | SQLite ledger, content blobs and attachments, isolated worktrees, project rules, and OS-backed secrets |

The managed **Agent Worker** owns the model loop, but it cannot directly read files, run commands, or access secrets. Tool requests return to **Electron Main**, where the Tool Gateway validates schemas and workspace boundaries, applies permission policy, executes the operation, redacts sensitive output, and records evidence.

External Claude Code and Codex sessions deliberately have a different boundary. Charter preserves their real PTY, detects lifecycle and conversation identity, accounts for repository changes, and brings the result into review; the external CLI still owns its internal permission model.

Local SQLite is the evidence ledger. Project mutations go through workspace services and, for isolated coding Sessions, land in a dedicated Git worktree. Provider credentials are resolved outside the renderer.

### Permission model

| Level | Typical operation | Default treatment |
| --- | --- | --- |
| **R0 — Read** | Read files, search, diagnostics, `git status` / `diff` | Allowed |
| **R1 — Workspace write** | Create or edit files inside the isolated worktree | Ask, or allow after plan/mode policy |
| **R2 — Local execution** | Known local commands and verification | Known checks may run; unknown commands ask |
| **R3 — External / consequential** | Networked or consequential operations | Explicit confirmation every time unless a documented mode policy applies |
| **R4 — Blocked** | `sudo`, `git push`, secret reads, writes outside the workspace, broad destructive commands | Rejected by the product |

Application-level permissions are not an operating-system sandbox. Review commands before approval and use isolated environments for untrusted repositories or instructions.

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
  product specification, ADRs, implementation status, and release evidence
```

Useful design and engineering references:

- [Implementation status](docs/IMPLEMENTATION_STATUS.md) — what is implemented, verified, or still in progress
- [Product and engineering specification](docs/PRODUCT_ENGINEERING_SPEC.md) — requirements, state machines, security, and acceptance criteria
- [Session-first UX pivot](docs/UX_PIVOT_SPEC.md) — the product-object and shell model
- [Architecture decisions](docs/DECISIONS.md) — ADR index and rationale
- [Release checklist](docs/RELEASE_CHECKLIST.md) — what still blocks a stable release

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

Charter is being developed in public toward its first stable desktop release.

- The Session-first shell, managed agent path, external CLI accounting, live file presence, code context, Preview, Terminal, Verification, Review, Replay, Memory, skills, and core security boundaries are implemented.
- Credential-free macOS/Windows/Linux packaging, release manifests, checksums, SBOM/license inventory, packaged-app smoke tests, and database upgrade/restore rehearsals are implemented for the unsigned Beta channel.
- Signing/notarization, automatic updates, real-provider fixed-task qualification, and final Stable release remain blocked/open.
- The intended stable targets are macOS and Windows; Linux is a preview target.

See [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for the evidence-backed status of each milestone and [RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) for the remaining release gates.

## Contributing

Contributions that strengthen the Session model, evidence quality, platform reliability, security boundaries, accessibility, or release readiness are especially welcome.

1. Read [AGENTS.md](AGENTS.md) and the relevant product or ADR documentation.
2. Pick a scoped item from the [implementation backlog](docs/IMPLEMENTATION_BACKLOG.md) or open an issue describing the behavior you want to change.
3. Keep architectural boundaries intact and add tests proportional to the risk.
4. Run `npm run check`, `npm test`, and `npm run build` before opening a pull request; include targeted Electron E2E evidence for UI changes.

Please do not mark speculative or partially implemented behavior as complete. Charter's contribution standard is simple: claims should be backed by observable evidence.

## License

Charter is available under the [MIT License](LICENSE).
