# ADR-0031 — Replay V3.1: conversation-first recap, quoted conclusion, pivots and outward actions

- Status: Accepted (product owner approved the mocks; implementation delivered for owner review)
- Date: 2026-07-20
- Extends: ADR-0017 Amendment 8 (Replay V3 — one story, three depths)
- Related: ADR-0006 (activity projection), ADR-0016 (completion report presents as state)

## Context

Owner field review of Replay V3 concluded it had won "trustworthy" but not yet
"useful": the result card was a file-count template, the story list dropped
non-chapter facts silently, strategy changes (the most human part of the story)
had no signal, and the whole experience was file-centric — a session with zero
file changes opened on "未记录文件变更", which reads as an error to the
product's non-coding users.

Two rounds of mock review (`docs/design/replay-v4-recap-mock.html`,
`docs/design/replay-v4-recap-mock-noncode.html`) also killed two candidate
additions as duplicates of the room: a "next steps" action panel (the room's
review bar is the single review entry per ADR-0016, and replay is an overlay
over that room) and a cost strip (RunDetails already aggregates usage/cost).

Capability check against the recorded substrate (and the providers' current
JSON streams) showed everything kept in the mocks is derivable
deterministically from the existing ledger — no AI generation, no new
source-of-truth tables.

## Decisions

1. **Quoted conclusion line, not a synthesized narrative.**
   `session.summary.conclusion` is a verbatim, sentence-boundary excerpt of the
   agent's recorded final report (`report.final.agentSummary` → activity
   `detail`), anchored to that fact id and labeled 推导叙事/引自最终报告 in the
   UI with clickable citation chips (`summary.citations`). Null when no report
   prose was recorded. The deterministic `result` template stays alongside it.

2. **Return line instead of an action panel; no cost in replay.**
   The result card carries one line — "Esc 关闭回放 · 回到房间…（回放保持只读）"
   — that closes the overlay. Review/accept/rollback remain room-only
   (ADR-0016); usage/cost remains RunDetails-only. Replay receipts continue to
   embed the session summary as before.

3. **Fold placeholders: the story has no silent holes.**
   Between two kept story nodes, the hidden span renders as an expandable
   `<details>` row ("折叠了 N 条：K 次读取… · 时长") with a 3-item sample and a
   jump to Explore. Purely a rendering change over the existing kept-set logic.

4. **Pivot: recorded strategy revisions become first-class.**
   A NEW agent plan proposal after an earlier one (`kind: 'plan'`,
   `author: 'agent'`, `status !== 'info'`, different key — same-key
   running→terminal lifecycles and `agent.planUpdated` progress ticks are
   excluded) is marked `fact.pivot { reason, refFactIds }`. The reason is the
   plan's own recorded prose (null → the UI says 未记录修订原因说明). Refs are
   id-backed only: the prior plan plus failures recorded since it. Pivots get a
   chapter category `pivot` (score 91) and a violet card in the story list.

5. **Outward actions: the non-file result track.**
   `fact.outward` is true only for agent facts carrying a **recorded** app
   identity (MCP/provider-emitted `app`; reads/searches stay inward) — never
   inferred from tool names or paths. `summary.outward` lists them with their
   recorded reversibility; irreversible/high-risk outward actions are pinned
   first in `summary.attention`. The result template is dual-track:
   files → files phrase; no files but outward actions → "N 项对外动作（M 项不可逆），未记录文件变更"; neither → "未记录文件变更或对外动作".

6. **Input ledger.** `session.inputs.files` collects the code refs the user
   attached to request/answer messages (now surfaced as `paths` on those
   activity items). Memory/rule injections are NOT ledgered yet, and the
   contract cell says 「注入清单未入账本 — 回放不做声称」 instead of guessing.

7. **Conversation is first-class in Recap.** `user.message` / `agent.message`
   activity items now carry bounded full prose (`detail`, ≤2000 chars);
   Recap renders user/agent/report facts as bubbles (YOU/AGENT, full text),
   always kept in the story list. The compact action rows, context expansion
   and one-active-node semantics are unchanged.

8. **External pivot signal.** The structured parser maps Claude
   `TodoWrite`/`ExitPlanMode` tool calls and Codex `todo_list` items to
   `plan` observations (previously misclassified as write/dropped), so pivots
   also emerge from structured external sessions.

## Alternatives rejected

- "Next steps" panel and cost cells inside replay — duplicates of the room's
  review bar and RunDetails; two states to drift apart.
- AI-condensed conclusion / AI-recovered pivot reasons — deferred; if added
  later they must be one-shot, citation-validated, Inferred-labeled, and fall
  back to the deterministic template (fail closed), per the V3 honesty rules.
- Tool-name heuristics for outward/irreversible classification — rejected as
  inference; only recorded identity and recorded reversibility are shown.

## Security and data impact

No schema migration; no new tables. `ReplaySessionDto` gains
`summary.conclusion`, `summary.outward`, `inputs`; `ReplayFactDto` gains
optional `outward`/`pivot`; chapter categories gain `pivot`. All fields are
projection outputs of the existing ledger. Message prose in `detail` passes
through the existing redaction path (external observations were already
redacted; Pi prose was already persisted in the ledger).

## Honest limits (recorded, not hidden)

- Interactive TUI external sessions remain `observed`: no bubbles, pivots or
  conclusions — the semantic layer needs a structured stream (headless
  stream-json / exec --json) or a future transcript-file upgrade path.
- `irreversible` currently has no production source (the gateway has no tool
  side-effect metadata); the badge renders recorded three-state reversibility
  honestly (可回滚/可补偿/可逆性未知), and high-risk (R3/R4) outward actions
  pin via recorded risk. Gateway/tool metadata is the upgrade path.
- External sessions still have no verification semantics (a test run is just a
  command); the 已验证 level remains Pi-managed-only.

## Verification evidence

- Unit: `packages/ipc-contracts/src/replay.test.ts` +9 (pivot detection incl.
  progress-tick/lifecycle exclusions, outward recorded-only + dual-track
  template, attention pinning, conclusion quoting/null, inputs collection);
  parser +2 (TodoWrite → plan lifecycle, Codex todo_list → plan). Full unit
  suite 619/619; `npm run check` clean.
- E2E: `tests/e2e/replay-v3.spec.ts` 5/5 — new assertions for the conclusion
  (引自最终报告), return line closing the overlay, input cell, user bubble,
  10k fold placeholder with samples, plus a new test driving the
  `plan-request-changes` scenario to a pivot card with clickable id-backed
  grounds and a pivot chapter on the axis. `replay-semantic-ui.spec.ts` 3/3
  (assertion updated: the removed "Agent 当时正在做什么" header → result card +
  return line), `p2-parallel-replay` green.
