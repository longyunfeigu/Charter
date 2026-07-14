# Charter — Dual-form Shell UX Spec (ADR-0004)

> Shell-layer spec. Supersedes spec §4 layout for entry/branding; everything
> engine-side (state machine, permissions, change/verification, review) is
> unchanged and stays governed by `PRODUCT_ENGINEERING_SPEC.md`.

## Surfaces

```
┌ Home (default entry) ─────────────────────┐   ┌ Workspace (full IDE) ────────┐
│            What should we build?          │   │ Activity bar · editor · agent │
│  [ 📁 project ]                           │⇄ │ panel · terminals · git · ... │
│  [ free-form intent…                    ] │   │ (existing workbench, intact)  │
│  [ approval: Ask/Edit/Auto ] [ model ▾ ]↑ │   │                               │
│  Recent tasks…                            │   │                               │
└───────────────────────────────────────────┘   └───────────────────────────────┘
```

## Acceptance (PIVOT-001..010)

| ID | Requirement |
| --- | --- |
| PIVOT-001 | App launches to Home; no directory is read until the user picks a project. |
| PIVOT-002 | Home has a project selector: recent workspaces + "Open Folder…"; selection opens the workspace (trust flow unchanged). |
| PIVOT-003 | Home has an inline model selector listing configured models (mock model when mock runtime is enabled). |
| PIVOT-004 | Home has an approval selector mapping to task modes with plain labels: Read-only (ask) / Approve changes (edit) / Auto, pause on risk (auto). |
| PIVOT-005 | Submitting the intent creates and starts a task (title derived from the first line ≤ 64 chars, full text as goal) and switches to the Workspace surface with the task open. Empty intent or no project is a guided no-op. |
| PIVOT-006 | Surface switching: opening a workspace auto-switches to Workspace; a persistent title-bar control returns Home; state is not lost either way. |
| PIVOT-007 | Home lists recent tasks (state chip); clicking one opens it in the Workspace surface. |
| PIVOT-008 | No user-visible surface (title, About, welcome, menus, dialogs, agent preamble, trust prompts, error copy) says "Pi". Product name: **Charter**. |
| PIVOT-009 | Settings → Models manages provider credentials (add/replace/delete per provider) and "Fetch models" pulls the live provider list with the stored key; fetched models merge into every model selector; fetch failures surface as readable errors. |
| PIVOT-010 | E2E: Home flow works with the mock runtime end-to-end (pick project → type intent → submit → task reaches REVIEW_READY) and the rebrand assertion holds. |

## Home v2 — agent visibility and light editing (ADR-0005, PIVOT-011..020)

Mockup: `docs/design/home-v2-mockup.html` (states ①–⑥, light/dark).
Phases: P1 = 011..015, P2 = 016..018, P3 = 019..020.

| ID | Requirement |
| --- | --- |
| PIVOT-011 | Home v2 layout per mockup: left sidebar (New Task, Reviews, Projects, Tasks; bottom Open IDE workspace / Settings) + bottom composer (project·branch chip, approval, model, attach, send). Theme follows the system (light + dark). **Selecting a project in the sidebar sets the working directory**, persists across restarts, and the composer targets it — the "Select a project" chip appears only when nothing is selected. |
| PIVOT-012 | Advanced charter in the composer: an Advanced toggle expands boundaries, success criteria and verification-command fields (suggestions + custom); Simple⇄Advanced preserves typed input. Sidebar "New Task" focuses the composer in Advanced mode. |
| PIVOT-013 | Mission control: below the composer, running tasks show their live current action (latest tool/plan step) and tasks in AWAITING_PLAN_APPROVAL / awaiting-permission / REVIEW_READY surface first as a "Needs you" group; one click jumps to the task. |
| PIVOT-014 | Native (macOS) notifications when a task enters AWAITING_PLAN_APPROVAL, waits on a permission request, reaches REVIEW_READY, or FAILED; clicking focuses the task; a Settings toggle disables them. No notification spam: one per state transition. |
| PIVOT-015 | Context feeding: dragging files/folders onto the composer inserts path reference chips included in the task goal; `@` opens a file picker over the selected project; file paths in timeline/report cards are clickable and open in the editor (workspace surface). |
| PIVOT-016 | Activity presence: project rows (Home) and file-tree nodes (Workspace) glow when the agent writes, driven by change events (never fs polling), decaying within seconds; multiple concurrent tasks show glow per project (worker-concurrency investigation is part of this item). |
| PIVOT-017 | Session replay: task detail/review offers a timeline scrubber that reconstructs per-step file states from recorded events, baselines and blobs; strictly read-only (never mutates the working tree); handles 100+ step tasks. |
| PIVOT-018 | ⌘K palette: global, keyboard-only operable search over projects, recent tasks and files of the selected project, with project-type badges (node/web/py/…); Esc closes, ⏎ opens. |
| PIVOT-019 | Light edit — Markdown: Notion-style WYSIWYG for `.md` with the same dirty-guard/conflict semantics as the Monaco path (editor dependency requires its own ADR before adoption). |
| PIVOT-020 | Light edit — images: annotation editor (arrows, rectangles, mosaic/redaction) that saves a copy (never overwrites the original in place without an explicit action) and offers "attach to task". |

## Shell v3 — task-centric shell (ADR-0008, PIVOT-021..025)

Mockup: `docs/design/direction-picker.html` (IA option B + Studio direction,
product-owner approved). Three layers: **Home → Task Room → Editor**. The
workbench keeps every capability but demotes to an on-demand tool named
"Editor" in UI copy.

Revisions to earlier acceptance (authoritative where they conflict):

| ID | Revision |
| --- | --- |
| PIVOT-005 | Submit creates/starts the task but **stays on Home**; the task appears in mission control immediately. Empty intent / no project remain guided no-ops. |
| PIVOT-006 | Editor reachable via sidebar "Editor" row, ⌘E, and Task Room "Open in editor"; "⌂ Home" returns; state preserved both ways; the main-area workspace chip is removed. |
| PIVOT-007 | Clicking a task (sidebar, mission control, ⌘K) opens its **Task Room**. |
| PIVOT-013 | Mission-control cards jump to the Task Room (review states may deep-link to the review overlay). |

New acceptance:

| ID | Requirement |
| --- | --- |
| PIVOT-021 | Task Room: per-task page (timeline, plan/permission/question cards, changes + verification rail, decision panel, reply composer) with human state chip and "Open in editor"; plan approval, permission grants, review, accept and rollback all work without entering the Editor. |
| PIVOT-022 | Entry consolidation: no "Open IDE workspace" chips; sidebar "Editor" row + ⌘E + Task Room header are the only Editor entries; submitting never auto-switches surfaces. |
| PIVOT-023 | Humane language: no raw state enums, transition rows, or tool-status strings user-visible anywhere; one shared state-label dictionary; no emoji iconography in chrome/cards. |
| PIVOT-024 | Studio theme (light + dark, system-following) from shared tokens on both surfaces; review overlay renders without chrome collisions. |
| PIVOT-025 | Live Board: while tasks run, per-project boards show per-file tiles with write ripples, 60s-decay heat, rhythm bars and a "writing" beacon; tiles open a read-only diff-so-far lens; driven by change events only (no fs polling); pauses on unfocus/reduced-motion; collapses when idle. |
| PIVOT-026 | Provider endpoints: Settings → Models stores per-provider API key **plus optional Base URL** (gateway/proxy). The live model fetch honors the base URL; the pi runtime re-points that provider at the endpoint and synthesizes gateway-only model ids so real runs execute through it. Keys stay in the OS keychain scope; the base URL is non-secret meta. |
| PIVOT-027 | Home project tree: clicking the selected project row expands a lazy file tree in the sidebar (dirs expand in place, capped + ignored-filtered); clicking a file opens it in the Editor. Only the selected project expands (one open workspace at a time). |
| PIVOT-012r | Composer Advanced is the canonical full form: it carries an optional **Title** field (defaults to the first intent line), boundaries, success criteria and verification — full parity with the Editor's New-Task dialog. |

## Shell v4 — global mission control on a multi-mount engine (ADR-0009, PIVOT-028..032)

Mockup: `docs/design/persistent-shell.html` (persistent shell + three presence
layers, product-owner approved). Tasks are global citizens; a project is an
attribute of a task, never a container the UI is trapped inside.

Revisions to earlier acceptance (authoritative where they conflict):

| ID | Revision |
| --- | --- |
| PIVOT-013r | Mission control (Needs You / Running), the Inbox badge and the sidebar task list are **global across projects**; cards and rows carry a project chip when tasks span projects. Zero-change REVIEW_READY tasks are excluded from Needs You (see PIVOT-031). |
| PIVOT-025r | The Live Board keeps its per-task grouping and gains a third layer: launcher boards (fleet), the Task Room rail board (focus), and the sidebar action ticker (heartbeat). One animation budget: boards animate only while visible and focused; heartbeat rows pulse without layout shift; everything cools to static when idle. |

New acceptance:

| ID | Requirement |
| --- | --- |
| PIVOT-028 | Persistent shell: the Home sidebar never unmounts — Launcher and Task Room swap in the content area beside it. The current room's row is highlighted; every sidebar control (tasks, projects, New task, Inbox, Editor, Settings) works from inside a room. Settings opens as an overlay without switching surfaces. |
| PIVOT-029 | Multi-mount engine: each task executes against its own mounted context (project root or task worktree) — tool gateway, permission engine, change tracking and verification are per-mount. Switching the focused project never cancels pending gates, never rebinds a running task's root, and tasks of non-focused projects remain fully operable (approve, review, accept, rollback) from their rooms. The restart recovery scan covers all projects. |
| PIVOT-030 | Worktree isolation: git projects can dispatch a task into its own `git worktree` (Advanced toggle, default-on when the project already has an active task). The room header shows the isolation branch. Accept merges the net change set back file-by-file with baseline conflict preflight; conflicts stop the merge and can only be overridden by a second explicit confirmation. Rollback discards the worktree; the main tree is untouched throughout. |
| PIVOT-031 | Light completion: a REVIEW_READY task with zero net changed files is presented as “Answered” — no Final-report card, no Review button, a quiet Done (plain accept), exclusion from Needs You / Inbox counts, and an “answered” notification. The machine state remains REVIEW_READY and stays test-visible via `data-state`. |
| PIVOT-033 | Multi-provider registry: Settings → Models configures any number of providers side by side — presets (Anthropic, OpenAI, OpenRouter, LiteLLM) plus custom Anthropic-/OpenAI-compatible gateways (id + protocol + Base URL + key + display name). Keys stay in the OS keychain scope; protocol/endpoint/name are non-secret meta. Each provider fetches its live model list over its own protocol (Bearer vs x-api-key; OpenRouter name/context_length mapped); the runtime registers non-builtin providers with their wire protocol and synthesizes gateway-listed model ids. The Home model picker groups models per provider when more than one is configured. Deleting a provider evicts its fetched models immediately. |
| PIVOT-032 | Timeline v2 (Task Room): ✓ milestones with elapsed time, quiet YOU/AGENT bubbles, single-line tool rows (verb + target + diffstat/status) that expand to evidence on demand, numbered-chip plan presentation, compact final report. While a plan awaits approval the reply composer IS “Request changes”: sending feedback resolves propose_plan with PLAN_CHANGES_REQUESTED and the agent proposes a revised version. Plan card buttons stay Approve + Edit plan + Cancel task. |

## Shell v5 — room zoom continuum (ADR-0014, PIVOT-034..037)

Mockup: `docs/design/room-peek-directions.html` (A+B fused end state,
product-owner approved). One anchor rule: **no plain click on a file reference
moves the user off the conversation** — the Editor is reached by explicit
intent only.

Revisions to earlier acceptance (authoritative where they conflict):

| ID | Revision |
| --- | --- |
| PIVOT-006r | ⌘E is room-aware: from a Task Room it opens the Editor with that task's context (agent panel visible, task active, cross-project focus handled); from elsewhere it toggles surfaces as before. State preserved both ways (unchanged). |
| PIVOT-015r | File paths in room timeline/report cards open the in-room peek (PIVOT-034), not the Editor. ⌘/alt-click keeps the direct Editor jump. |
| PIVOT-025r2 | In-room Live Board tiles open the peek in Changes mode (replacing the modal lens inside rooms). Launcher boards keep the global lens overlay. |
| PIVOT-027r | Home tree file clicks open the peek while a Task Room of the focused project is open; otherwise (launcher context) they open the Editor as before. |

New acceptance:

| ID | Requirement |
| --- | --- |
| PIVOT-034 | In-room file peek: activating a file reference in a Task Room (changes rail, live board tile, timeline evidence path, Home tree, ⌘K file result) opens a resident split panel — Changes/File dual mode, pinned tabs, read-only, contents via the task's own mount (`task.peekFile`, worktree-honest, live-following while the agent writes; binary/missing/truncated render honest notes). Esc or close restores the rail; the timeline and composer stay interactive throughout. Opening another task's room resets the peek. |
| PIVOT-035 | Editor demoted to explicit intent: peek header "Open in editor" (hidden for worktree tasks), ⌘/alt-click on file references, sidebar Editor row, ⌘E, and the room header button are the only Editor entries from the Home surface. No plain file click switches surfaces. Launcher-context file opens (no room) still go to the Editor. |
| PIVOT-036 | L2 continuity: room → Editor → room round-trips preserve the task selection, the reply draft and the timeline scroll position (per task, session-scoped), and the peek state. |
| PIVOT-037 | Shell unification (staged, not this round): the Editor becomes a content-area state of the persistent shell; surfaces disappear; transitions morph around the conversation column. Recorded as the end-state skeleton in ADR-0014. |

## Notes

- Fast path vs full form: the Home input is the primary path; the Workspace
  surface keeps its New-Task dialog until PIVOT-012 lands, after which the
  composer's Advanced mode is the canonical full form.
- Phase 2 (unchanged, from ADR-0004): meta-agent drafts acceptance criteria and
  verification commands from the intent for one-tap confirmation; task budgets
  (steps/tokens/time); auto-iterate-until-verification-green loop mode.
- "Workspace" naming: user-visible copy says **project** (folder) and
  **Editor** (workbench surface); engine identifiers keep `workspace`.
