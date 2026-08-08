# ADR-0051: Role-neutral Work board above execution

- Status: Accepted and implemented
- Date: 2026-08-08
- Related: ADR-0044, ADR-0050

## Context

Charter can run work in different Agent Sessions and Missions, but execution surfaces are not a
durable place to manage the outcome itself. Product managers, operators, researchers, content
teams, data practitioners, engineers, and approvers all need to capture work before choosing how
it will be delivered. One outcome may be completed by one autonomous Agent, several alternative
Agent Sessions, a Mission, human collaboration, or a mixture of those approaches.

A programming-only issue model would force unrelated work into engineering terminology. A
session-only model would also lose the request source, background, deadline, reminders, acceptance
criteria, evidence, and state when execution moves between people or Agents.

## Decision

1. Add a local-first **Work** surface as a primary application destination. It owns durable work
   items; Sessions, Missions, terminals, and human contributions are execution links beneath an
   item.
2. Use a board workflow seeded with Inbox, In progress, Waiting, Review, and Done. Planned is not a
   separate default stage: Inbox represents work that is not yet committed, while start/deadline
   and priority express scheduling intent. Every new item enters Inbox without asking for an
   initial stage. Users move cards directly between columns by drag and drop; the detail stage
   selector remains as a keyboard-accessible fallback. The five default stages share the available
   desktop width; horizontal scrolling is reserved for narrow windows or user-added stages.
3. Treat the board as personal by default. Do not expose an Owner field or a redundant `You` value.
   Request source remains a separate concept through source person, channel, and link fields.
4. Keep work types lightweight and optional from the user's perspective. General is the default;
   Product, Operations, Research, Content, Data, Engineering, and Approval add relevant structured
   context and evidence without changing the common workflow. Users can define additional types.
5. Preserve outcome-level information independently of execution: title, requested outcome,
   background, source, priority, labels, start/deadline, acceptance criteria, deliverables,
   type-specific fields, evidence, reminders, and activity history.
6. Allow many execution links per item. A user can start a new Charter Agent or terminal with the
   work context prefilled, attach existing Sessions or Missions, record human participation, and
   classify each link as primary, collaborator, reviewer, or alternative.
7. Project live execution state into the work detail while keeping board stage user-controlled.
   An Agent stopping or completing must not silently decide that the business outcome is Done.
8. Deliver in-app and operating-system reminders. A due reminder can focus the exact work item and
   can be snoozed or dismissed; overdue and fired reminders contribute to the attention count.
9. Persist board state in SQLite with optimistic version checks, stable ordering, workflow WIP
   limits, archival, evidence, activity events, and restart recovery.
10. Give the board the full main workspace. Do not add a second contextual side rail or a first-run
    overlay that obscures the empty board.

## User stories

- As a product manager, I can capture a customer request, its source, problem statement, expected
  outcome, deadline, and acceptance criteria before deciding which Agent should investigate it.
- As an operator, I can record an incident or campaign task with operational context and evidence
  on the same board as every other kind of work.
- As a researcher, content owner, data practitioner, engineer, or approver, I can select a type that
  asks for domain-relevant context without being forced into a software issue template.
- As a user capturing work quickly, I only need a title; General is selected and the item lands in
  Inbox automatically.
- As a board user, I can drag a card from one stage to another and see counts and attention metrics
  update immediately.
- As a user with time-sensitive work, I can set a deadline and reminder, receive a popup even while
  viewing another Session, open the exact task, snooze it, or dismiss it.
- As an Agent user, I can start an autonomous Session with the outcome, background, constraints,
  acceptance criteria, and deliverables already in its prompt.
- As a collaborator, I can connect several Agent approaches, a Mission, and human reviewers to one
  outcome and inspect their current execution states in one place.
- As a reviewer, I can attach evidence and check acceptance or deliverable items before moving the
  outcome to Done.
- As a workflow owner, I can add a work type or workflow stage and enforce a WIP limit where needed.
- As a returning user, I find the board, reminders, links, evidence, and activity intact after an
  application restart.

## Consequences

- Work status represents the user's outcome workflow; execution status represents what an Agent,
  Mission, terminal, or person is currently doing. The two are deliberately not conflated.
- Types provide useful structure but do not make task capture heavy. General remains a valid path
  for every role.
- The initial release is a personal, local-first board. Real-time multi-user synchronization,
  remote team assignment, and recurring tasks are future collaboration features rather than
  implicit behavior.

## Verification

- Contract, migration, service, and renderer-store tests cover validation, sparse updates,
  ordering, WIP limits, conflicts, archive behavior, reminders, evidence, execution links, custom
  types, custom stages, restart persistence, and stale-read protection.
- Electron tests create Product, Operations, Research, and Content examples; verify default Inbox
  creation and real drag-and-drop; exercise type and stage creation, search and filters, evidence,
  checklists, restart recovery, reminder routing and snooze, autonomous Agent and terminal handoff,
  multiple execution links, and human review.
- The targeted Work Electron suite passes three consecutive repetitions. The full Electron suite
  passes with only environment-gated cases skipped, and visual checks cover intended and narrow
  desktop viewports.
