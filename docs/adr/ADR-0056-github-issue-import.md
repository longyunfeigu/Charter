# ADR-0056: Read-only GitHub issue import into the Work board

- Status: PROPOSED (pending user acceptance of the working-tree change set)
- Date: 2026-08-09
- Related: ADR-0051 (role-neutral Work board), ADR-0022 (no external git writes),
  ADR-0047 (SshVaultService pattern), `docs/design/external-work-inbox-mock.html`

## Context

Work that Charter executes often starts life as a GitHub issue. Until now the only way to
work on an issue was to retype it into the Work board or the composer, losing the body,
labels, discussion, and the link back to the source. The External Work Inbox design mock
already sketches the destination product: external items flow into the Work queue, map to a
local repository, and start Missions/Sessions through the existing handoff.

An industry survey (2026-08-09) of Copilot coding agent, Google Jules, OpenHands, Devin,
Claude Code Action, and the open-sourced Terragon showed all of them are cloud services that
receive webhooks. A local-first desktop app has no public endpoint, and GitHub never retries
failed webhook deliveries, so a laptop that sleeps loses events permanently. Polling (or
one-shot fetches) with `since`/conditional requests is the correct desktop-native shape.

Charter also has three deliberate enforcement points that forbid writing to GitHub
(tool-gateway R4 for `git push`, no remote capability in `git-service`, PR draft that is
never executed). Any importer must not erode that line.

## Decision

1. **Manual, preview-first URL import.** "Import issue" first resolves the issue without
   creating local work, then shows the exact title/body, labels, checklist/discussion counts,
   credential state, and local-repository match. Only the explicit "Import to Work"
   confirmation creates one Work item. Automatic discovery (background polling) is a deliberate
   follow-up, not part of this change: the data model (external identity, dedup) is designed so a
   poller only adds a new entry point.
2. **Read-only, hard boundary.** The integration only ever performs GET requests. No
   comments, reactions, PRs, or state changes are sent to GitHub. Write-back requires its own
   ADR with an explicit approval gate (the mock's "your approval is the boundary" pattern).
3. **Credential strategy: PAT wins, `gh` CLI is the zero-setup fallback, anonymous works for
   public repositories.** A stored token lives in a dedicated `GithubVaultService`
   (safeStorage-encrypted, own directory) — deliberately not `SecretService`, whose
   provider/api-key shape would surface a GitHub token in the model catalog, mirroring the
   ADR-0047 reasoning for SSH. Tokens are verified against `/user` before storage; the
   renderer only ever sees booleans and the verified login. The `gh auth token` fallback is
   read via `execFile` with a 60 s cache.
4. **External identity makes import idempotent.** Migration v17 adds
   `work_item_external_refs` with a unique `(source, ref_key)` index (`owner/repo#number`,
   lowercased). Re-importing surfaces the existing card; a ref whose card was archived is
   released so re-import restores board visibility. (Lesson borrowed from the OpenHands
   resolver, which removes its trigger label to prevent re-entry.)
5. **Issues become ordinary Work items** (type Engineering, Inbox column): body →
   requested outcome; markdown task lists → acceptance checklist; labels → labels; author →
   source person; canonical issue URL → source URL; `owner/repo` → the Engineering
   "Repository / project" field; issue metadata plus the tail of the discussion (last 10
   comments) → background. A `link` evidence row records the source URL. The card then rides
   the existing handoff → composer → Session path and `linkExecution` back-links, unchanged.
6. **Local repository mapping via `remote.origin.url`.** Each known project (recent
   workspaces) is matched by its git remote (a new read-only `GitService.remoteOriginUrl()`;
   no network git). The preview exposes that match and lets the user override it or deliberately
   choose later. A confirmed match is recorded in the card background and becomes the dispatch
   target for the existing Session/Mission handoff.
7. **`CHARTER_GITHUB_API_URL` overrides the API base** (default `https://api.github.com`).
   This is the deterministic-backend seam for E2E (a local fake server, per the "Mock Runtime
   only as test backend" rule) and doubles as GitHub Enterprise support later.
8. **Execution lifecycle is projected, never painted.** The Inbox reads the current linked
   Session, Mission, or external-terminal task state whenever its lifecycle changes. Running,
   waiting, review, completed, and stopped are exact aggregates; a stopped execution cannot
   leave a stale “Work is running” card behind.
9. **The entry Agent is an explicit launch choice.** Final check offers Charter Agent plus
   every installed terminal-capable Agent (Claude Code, Codex, Kimi, or a registered custom
   Agent). Charter also exposes its configured model choice. The selected Agent receives the
   carried issue context first and leads either the Mission or single Session shape.
10. **Local deletion does not imply execution cancellation.** An imported item has a guarded
    Delete action. It archives the local Work card and audit projection, leaves GitHub untouched,
    and clearly warns that linked Sessions/Missions remain durable. Importing the URL again
    restores the issue as fresh visible work.
11. **A stopped or completed execution does not close the issue.** Its status card exposes a
    fresh launch action that returns to Final check, where the user can choose Mission/Session,
    entry Agent, and model again. The new execution is appended to the item; prior attempts remain
    linked as inspectable history.
12. **The Inbox is an independent main surface, and execution rows are navigation targets.**
    Opening a linked Session, Mission, or native terminal leaves the Inbox, routes immediately,
    and hydrates the transcript in the destination. Browser-style Back restores the exact Inbox
    selection. The launch check is organized as execution shape → Agent → runtime/model, with
    repository and acceptance context kept in a separate review column.
13. **Branch and worktree choices are launch context, not hidden host mutations.** The launcher
    reads the selected Project's local branches without opening it, lets the user choose a base
    branch, and offers either the existing checkout or an Agent-created worktree. Charter never
    checks out the branch or creates that worktree in this flow: it adds an explicit, preserved
    instruction to every entry-Agent prompt. Worktree mode tells the Agent to create a task branch
    and linked worktree from the selected base, do all work there, leave the original checkout
    untouched, and stop rather than fall back unsafely if setup fails.

## Alternatives considered

- **Webhooks via relay** (`gh webhook forward`, smee.io, Cloudflare Tunnel): sub-second
  latency but every option is unsupported-for-production, unauthenticated, or heavy to
  onboard — and undelivered events are lost forever for an app that is usually closed.
  Rejected for V1; polling with conditional requests loses only ~60 s of latency.
- **Storing the token in SecretService**: rejected; wrong shape (provider catalog) — see
  decision 3.
- **A separate "external inbox" surface** (as the mock draws): rejected for this iteration;
  the Work board already owns queue + handoff + notification mechanics. The mock's inbox can
  layer on top once auto-discovery exists.

## Security and data impact

- Token encrypted with OS keychain (`safeStorage`) in its own `secrets/github` directory;
  plaintext never crosses IPC; logs record logins, never tokens.
- All GitHub traffic originates in Electron Main; the renderer talks only versioned
  `github.*` channels (strict schemas).
- No new write path to the network: the ADR-0022 line (never push / never post) is untouched.
- New table `work_item_external_refs` cascades on work-item delete; migration v17 is
  additive and reversible by dropping the table.

## Verification evidence

- Unit: `apps/desktop-main/src/services/github-issue-service.test.ts` (25 tests: URL parse,
  side-effect-free preview/cache, remote normalization and override, task-list extraction,
  complete discussion tail, atomic/concurrent idempotence, archived-ref release, API-shape
  validation, PAT/gh precedence and auth-status race, 404/rate-limit/PR errors, token
  verify-before-store).
- E2E (deterministic backend): `tests/e2e/work-github-import.spec.ts` — failure paths,
  preview/confirm, duplicate flow, entry-Agent selection, handoff start, live waiting → stopped
  synchronization, a new launch after stop with prior execution history preserved, guarded local
  deletion, execution-row navigation and history return, selectable launch branch, Agent-owned
  worktree prompt propagation with proof that Charter creates no worktree, redesigned launch
  layout at wide/narrow Electron viewports, settings verify-reject, and Chinese layout at the
  app's narrowest window.
- E2E (real network, opt-in): `tests/e2e/work-github-import.real.spec.ts`
  (`RUN_REAL_GITHUB=1`) — imported live issue `longyunfeigu/Charter#2` with `gh` CLI
  credentials; temporary screenshots in `/tmp/charter-github-import-real/`.
