# ADR-0022 — Visible acceptance: preview tab, marquee feedback, PR draft

Status: accepted
Date: 2026-07-16
Related: docs/design/inspo-cmux-preview-gate-pr.html (research note ④),
ADR-0013 (Review v2), ADR-0009 (worktrees), ADR-0012 (full mode),
spec GIT-007, VER-005/007/008; PIVOT-020 (annotator)

## Context

The acceptance gate today shows two kinds of evidence: the diff and the
verification records. "The code is right" and "the tests pass" still leave a
blind spot — *what the page actually looks like*. Visual regressions (a hint
wrapping to three lines, a button that should be disabled) pass both gates.

cmux→manaflow ships three ideas worth porting: a Live Web Preview embedded next
to the code, preview comments that turn into agent work, and one-click PR
creation. Each collides with a Charter boundary if ported naively: cmux
auto-starts and auto-publishes; Charter never lets an agent-adjacent surface
push, and never lets the app touch trees the task does not own.

## Decision

Review v2 grows a tab strip — **Changes | Preview | Checks** — three
projections of the same `task → main` evidence. After a successful accept, the
app offers a **PR draft** generated from the evidence ledger. Four boundaries
make the port Charter-shaped:

### 1. Preview only ever binds to the task's own tree

- A new main-process **port detection** service enumerates loopback TCP
  listeners (`lsof -nP -iTCP -sTCP:LISTEN`, one non-privileged call) and keeps
  only processes whose **current working directory** (per-pid `lsof -a -d cwd`)
  resolves inside the task's context root — the worktree for isolated tasks,
  the project root otherwise. Roots are realpath-normalized before prefix
  comparison. A dev server running in the main tree can never appear inside a
  worktree task's gate, and vice versa.
- Detection is read-only: the gate **never starts a server**. No ports →
  an honest empty state that shows the exact boundary ("processes listening
  from `<root>`") and offers a refresh.
- The Preview tab is shown when ports are detected, and hidden for non-web
  projects. Heuristic for "web-ish" when no port is live yet: the context root
  has a `package.json` whose scripts include `dev`, `start`, `serve` or
  `preview`. Wrong-negative costs a hidden tab (the design's intent for
  non-web projects); wrong-positive costs an empty state with guidance.
- Renderer CSP changes exactly one directive: `frame-src 'none'` →
  `frame-src http://localhost:* http://127.0.0.1:*`. Everything else
  (script-src 'self', object-src 'none', form-action 'none', the
  will-navigate/main-frame guard, the webview block, the deny-all permission
  handler) is unchanged. The iframe carries
  `sandbox="allow-scripts allow-same-origin allow-forms"` — the minimum a dev
  server (HMR websocket, module scripts, form posts) needs; the frame is
  cross-origin to `app://` so it can never reach the bridge. A visible
  "task tree · isolated" badge names the boundary in the UI.
- "Open in browser" goes through a dedicated loopback-only check
  (`http://localhost:<port>` / `http://127.0.0.1:<port>` with a detected port);
  the general external-URL allowlist stays https-only.
- No embedded DevTools (deliberate cmux non-port): debugging happens in the
  system browser on the same port.

### 2. Visual feedback rides the existing request-fix loop

- "Mark issue" arms a marquee overlay above the iframe (an overlay is also the
  only way to observe drags over a cross-origin frame). Drag → selection rect →
  note popover → send.
- On send the renderer asks main to capture the preview region
  (`webContents.capturePage(rect)` — compositor pixels, works across origins),
  burns the selection rectangle into the PNG on a local canvas, and calls the
  same `task.message` channel Review v2 request-fix uses, now with an optional
  `preview` attachment `{ dataBase64(png), pageUrl, rect }` (schemaVersion 2).
- Main persists the screenshot under the task's artifact directory
  (`<userData>/artifacts/<taskId>/preview/…png` — never inside a workspace or
  worktree, so change accounting and merge-back stay byte-identical), records
  the `user.message` timeline event with
  `preview: { path, pageUrl, rect, thumbDataUrl }`, and forwards the image to
  the runtime.
- The runtime contract (`AgentRuntime.steer/followUp`, `StartRunInput`, worker
  protocol) gains an optional `images?: Array<{ data: base64, mimeType }>`.
  The Pi adapter passes them to `session.prompt(text, { images })` — the model
  actually sees the pixels (`PromptOptions.images` is native SDK surface, no
  patch). The mock runtime acknowledges image count deterministically for
  tests. From REVIEW_READY the send starts a new run, exactly like request-fix
  today — same conversation, no second comment system, Replay chain intact.

### 3. Checks tab is presentation only

- It renders the existing `task.verificationRuns` records grouped by label:
  latest run per label, earlier runs kept visible with their `superseded`
  mark (VER-005), `stale` when the code moved (VER-008), and a loud
  **Unverified** block when nothing ran (VER-007). Zero state-machine changes.

### 4. PR draft is an export of evidence, never an outward action

- When an accept lands (manual or full-mode ADR-0012), the task service
  generates a draft — branch name `charter/pr/<slug>`, title, markdown body —
  from the ledger: goal + acceptance list, merged file list with ± counts,
  verification matrix (pass/fail/superseded/stale/unverified), and the Replay
  receipt `manifestSha256`. The draft is recorded as a `task.prDraft` timeline
  event (persists in Room and Replay; full-mode accepts get it too) and only
  for git projects.
- The renderer shows a dismissible draft card after a manual accept: copy the
  body, copy a ready-to-paste command block
  (`git switch -c … && git add -A -- <paths> && git commit … && git push -u …
  && gh pr create --draft …`). The body is also written to the artifact
  directory so `--body-file` works.
- **The app never runs push, pr create, or any network git command.** GIT-007
  stays byte-true: the agent tool layer has no push, and the product's own UI
  stops at the clipboard. CI status readback is out of scope (future ADR).
- **The agent can't run the commands either.** Introducing a first-class PR
  flow made a latent hole load-bearing: forge CLIs (`gh`, `glab`, `hub`) were
  unclassified (R2/R3), so full mode's auto-allow could have published a PR
  with the user's stored `gh` auth. The command classifier now treats forge
  mutations — and unknown/`api` subcommands, fail-closed — as R4, the same
  class as `git push`; explicit reads (`pr view/list/checks`, `run view`,
  `auth status`, …) stay R3 network access.
- The audit branch a worktree leaves behind (ADR-0009) points at baseHead —
  the accepted work was never committed to it — so the draft commands create a
  fresh `charter/pr/…` branch from the user's current HEAD, carrying the
  just-merged working-tree changes.

## Amendment 1 (2026-07-16) — one-click dev start, user-domain

Field feedback on day one: "start a terminal yourself, run the dev command,
come back" is four hops — too long. The boundary stays ("the gate never owns
a server process") but its phrasing was too broad. What the gate must never do
is *own* the lifecycle: spawn hidden children, kill them on close, or pretend
a server it started is the task's. What it may do is what the user would have
done by hand: the empty state now offers **Run `npm run dev` here** — it opens
a task-context terminal (cwd = the task's tree, visible in the terminal panel,
stoppable like any terminal) and types the project's own dev script
(first of `dev/serve/preview/start` in the tree's package.json, surfaced as
`devCommand` on `task.previewPorts` v2). Attribution is unchanged — the poll
detects the port by cwd exactly as if the user had typed the command. This is
the TERM-005 precedent (typing into the user's terminal is user domain), not a
new process manager. Also fixed alongside: the Home worktree row no longer
vanishes silently for non-git projects — it renders disabled with the reason.

## Amendment 2 (2026-07-16) — the preview is the Room's window, not the gate's evidence

Two field failures on the same day exposed a framing error, not a bug: a user
couldn't find the preview twice. First it was buried behind the gate's Preview
tab; then — decisively — a Full-mode task (ADR-0012) auto-accepts and never
opens a gate at all, so the most agent-trusting users had no window into what
the agent was building. The industry has converged the other way (v0 Design
Mode, Lovable's preview toolbar, Windsurf Send-element, Replit self-test): the
preview is a **persistent primary surface**, and feedback is "point at the
thing, say a word," landing in the **same conversation input**. The design
note is `docs/design/room-live-preview-directions.html` (approved 1:1).

- **Persistent rail.** The Task Room grows a resizable preview column
  (`RoomPreviewRail`) available in EVERY state — running, review, full-auto,
  accepted. Detection only lights a header badge (`PreviewBadge`); the layout
  never moves on a weak signal (the external-CLI lesson). One shared
  `LivePreview` component serves both the rail (`variant="rail"`) and the gate
  Preview tab (`variant="gate"`) — same port detection, same iframe sandbox,
  same boundary. The rail and the in-room peek share the side slot (mutually
  exclusive). Width persists in localStorage.
- **Point-and-say feedback.** Two modes over the frame: **Pick (S)** and
  **Draw (R)**. Pick injects a self-cleaning element picker into the loopback
  frame via `webFrameMain.executeJavaScript` — gated to frames whose URL is
  loopback + the task's detected port; on any failure it falls back to the
  zero-injection marquee (Draw). The picker posts `{selector, rect, text}` to
  the parent; a cross-origin `message` listener filtered by the port's origin
  receives it. In the rail, the selection lands as a **composer attachment
  chip** (`draftStore.previewRefs`) — one input, one conversation, same steer
  loop; in the gate it keeps the direct note popover. A selection made after
  the task closed **seeds a follow-up task** whose first run carries the
  screenshot (`task.start` v2 gains an optional `preview`). Attachments carry
  the CSS `selector` now, so the agent locates code, not just pixels.
- **Console self-heal.** Zero-injection capture: main relays the window's own
  `console-message` events (`preview.console`), filtered to loopback origins.
  Renderer policy (`preview-console.ts`, pure + unit-tested): dedupe, count,
  and in `auto` mode forward errors to the agent ONLY when the task is running
  and the error landed within 15s of the agent's own last write — one send per
  write burst, capped 5/run, so a crash-loop can't spam the model. Warnings
  never auto-send. Setting `preview.consoleToAgent` (auto | manual | off);
  `manual` collects to a ⚠ chip with one-click send; `off` counts only. This
  makes Full mode "有窗有自愈" — a window and a reflex, not blind flight.
- **One-click start stays in place (fix).** Field report right after am.2:
  clicking "Run npm run dev here" yanked the user into the Editor's terminal
  panel, forcing a manual trip back to the Room. Root cause: `terminal.create`
  defaults to `reveal:true`, which calls `showBottomTab` → `setSurface`. The
  dev server is now started in a **background terminal** (`reveal:false`) — the
  surface never flips, the preview appears in place. Its log stays reachable
  through an explicit **Dev log** button (the Replit Console pattern: logs are
  a click away, never a side effect of starting the process). TERM-005 holds —
  the server is still a real, visible, stoppable terminal.
- **Injection boundary (security).** The picker is the first thing Charter
  runs INSIDE a preview page, so it is fenced: only frames matching the task's
  own detected loopback port; the script is self-contained and self-cleaning;
  it posts data, never receives commands; a missing/File frame silently
  degrades to marquee. `frame-src` is unchanged from am.0.

## Alternatives considered

- **Auto-starting the dev command from the gate**: rejected — turns a
  read-only review surface into a process manager (lifecycle, ports, crashes,
  cleanup on close) and blurs "the task's own verification commands" with
  app-owned processes.
- **Attributing ports by tracked child PIDs** (tool-gateway process tree)
  instead of cwd: rejected for V1 — misses servers the user starts by hand in
  the worktree (a stated flow), and dev servers commonly daemonize/re-parent,
  which makes ancestry lossy. cwd-inside-root is checkable, explainable in the
  empty state, and testable. PID-tree can tighten it later without UI change.
- **A `<webview>` instead of an iframe**: rejected — `will-attach-webview` is
  deliberately blocked (§12.3 hardening), and iframes with a scoped
  `frame-src` are the least-privilege container that still runs a dev server.
- **Spawning a fresh fix-run per preview comment (manaflow behavior)**:
  rejected — Charter keeps one conversation per task; a second feedback system
  would fork task history and break the Replay chain (design note §2).
- **`gh pr create` executed by the app after a confirm dialog**: rejected for
  V1 — GIT-007's value is that outward actions are *not reachable* from the
  product surface, not merely confirmed. Copy-commands keeps the friction near
  zero while the push stays in the user's shell, under the user's credentials.
- **Cloud-shareable preview URLs** (manaflow): out of scope — new threat
  surface (tunnels, auth, recording); needs its own ADR.

## Consequences

- New: `preview-service` (port detection) in desktop-main; channels
  `task.previewPorts`, `task.capturePreview`, `task.prDraft`; `task.message`
  schemaVersion 2 with optional preview attachment; runtime contract carries
  optional images end-to-end; ReviewView gains tabs and testids
  (`review-tab-*`, `preview-*`, `checks-*`, `pr-draft-*`).
- CSP `frame-src` widens to loopback http — recorded here as a deliberate
  security tradeoff; the security suite pins the exact directive so any
  further widening fails a test.
- E2E additions: port attribution never crosses trees (worktree vs main),
  marquee feedback round-trips into the timeline and a new run, superseded
  re-runs render without overwriting history, PR draft appears after accept
  with no push side effects, non-web projects show no Preview tab.
- The screenshot enters the evidence ledger (timeline payload + artifact
  file); receipts hash it like any other payload. Replay renders it as part of
  the user turn.
