# ADR-0012 — Full autonomy mode ("Full auto")

Status: accepted (explicit product-owner decision, 2026-07-14)
Date: 2026-07-14
Related: spec §4 (modes), §6.1 (state machine, amended), §10.2/§19.3 (permission defaults), CLAUDE.md invariant (amended), ADR-0009 (worktrees), peers: Claude Code `--dangerously-skip-permissions`, Codex full-auto, Pi full autonomy

## Context

The trust ladder stopped at Auto ("low-risk runs, risky pauses"), and completion
always parked at REVIEW_READY. For flows the user already trusts end-to-end,
every R2+/R3 prompt and every review click is friction they explicitly asked to
remove — the same reason claude code / codex ship a skip-permissions mode. The
product owner decided: a fourth mode, selectable directly in the composer (no
settings gate), that neither asks nor waits for review.

## Decision

**`full` joins `AgentMode`.** Per-task, chosen in the composer (danger-styled
segment + red hint) or the task dialog. It is NOT offered as the Settings
default mode — full autonomy is a per-dispatch choice.

### What full mode changes

1. **Permissions:** the engine auto-allows R1–R3 (`scope: 'auto'`). Standing
   user deny rules still win. **R4 and path/product boundaries are untouched**
   — full mode is "no prompts", never "no gateway": every call still flows
   through the Tool Gateway, risk classifier, audit and revision/hash checks.
2. **Plans:** required as before (AG-007 intact) but auto-approved instantly,
   same as Auto.
3. **Completion:** after the final report lands in REVIEW_READY, the system
   auto-accepts (`actor: 'system:full-auto'`, `task.accepted` records it; the
   timeline milestone reads "Completed & applied automatically"). Notification
   says "Completed & applied" (the mechanical REVIEW_READY pass-through stays
   silent).
4. **Honest fallbacks — auto-apply pauses and a human takes over:**
   - any verification run failed/timed out → stays REVIEW_READY, timeline note
     `AUTO_APPLY_SKIPPED`, attention notification;
   - worktree merge-back preflight found conflicts → stays REVIEW_READY with
     the merge-blocked card;
   - accept itself fails → stays REVIEW_READY with a warning.
   Run failures/user Stop keep their normal FAILED/CANCELLED paths.
5. **Undo instead of pre-approval:** the state machine gains
   `ACCEPTED → ROLLED_BACK`. Snapshots survive accept; the Task Room offers
   drift-checked "Roll back" on accepted non-worktree tasks. Exception: a
   merged worktree task cannot roll back post-accept (its change-record root —
   the worktree — is discarded on accept); surfaced with a clear message.

### Spec amendments recorded

- §4 mode list +Full; §6.1 invariant 5 gains the Full exception and
  `ACCEPTED → ROLLED_BACK`; CLAUDE.md non-negotiable reworded accordingly.
- Unverified-accept confirmation (VER-007) is satisfied by the mode choice
  itself: selecting Full IS the explicit standing consent (`confirmUnverified`
  is set by the system path). Failing verification still blocks — only the
  *absence* of verification is waived, mirroring the peers.

## Consequences

- E2E: p3-full-mode.spec — R3 without pause → auto-ACCEPTED → post-accept
  rollback byte-exact; failing verification keeps REVIEW_READY with the pause
  note. Permission-engine unit test: R1–R3 allow / R4 refuse / standing deny
  wins.
- The audit trail remains complete: every auto-allowed call is recorded with
  its risk and decision exactly like a user-approved one.
- Risk accepted by the owner: a full-mode agent can modify and apply anything
  the gateway permits inside the workspace without human eyes; mitigations are
  the R4 wall, deny rules, verification gate, snapshots and one-click rollback.
