# ADR-0053: Work item capture/edit becomes a document page

- Status: Accepted
- Date: 2026-08-09
- Relates to: ADR-0051 (role-neutral work board)

## Context

The work board (ADR-0051) captured new items through a single modal form:
fifteen fields rendered flat in one scrolling dialog, native
`datetime-local` controls, and the same component doing double duty for
"new" and "edit". Only the title is actually required, but the layout made
every field read as mandatory. User verdict on the interaction: unacceptable
("信息密度非常高的填空 UI"). Four interactive mock directions were built and
reviewed in the browser (`docs/design/work-capture-directions/`); the user
chose Direction D — "creating is a page, not a form" — and in a second
review pass added: a real calendar for dates, an attachments section, no
Start field, and **no focus boxes around text inputs while typing**.

## Decision

1. **One document page for create and edit** (`WorkItemPage.tsx`), replacing
   `WorkItemForm.tsx` entirely. It owns the whole Work surface (no modal).
   The title is a serif document heading; enumerable properties (stage,
   type, priority, deadline, first reminder, labels) are one chip row under
   the title; source and type-specific fields are quiet property rows;
   outcome/background/type long-texts are body sections; acceptance and
   deliverables are real checklists, not one-per-line textareas.
2. **Create = crash-safe local draft, committed on leave.** Leaving the page
   (Board button, Esc, ⌘↩) with a title creates the item through the
   existing versioned `workItem.create` channel; an empty draft is
   discarded. The draft persists to `localStorage` on every change, so a
   crash never loses typed text. There is deliberately **no submit button**.
   We did not adopt "create as soon as a title exists" (mock semantics):
   per-keystroke durable updates would flood the item's event log and the
   board with version churn for no user-visible benefit.
3. **Edit = per-field durable commits.** Popover picks commit immediately;
   typed fields commit on blur (one activity event per finished thought).
   All durable mutations run through a serialized save queue so each update
   carries the version produced by the previous one, keeping the optimistic
   concurrency gate meaningful. Conflicts roll back through the store as
   before.
4. **No native pickers, no focus boxes.** Dates use a custom
   calendar popover (Monday-first grid, time chips, quick options, and a
   typed grammar — `workDates.ts`, unit-tested). Inside the page, text
   inputs suppress the global `:focus-visible` outline: the caret is the
   focus indicator. Buttons/chips keep the ring for keyboard accessibility.
5. **Attachments & links are part of capture.** A page section accepts
   pasted links/paths and native file picking via the new
   `workItem.attachment.pick` channel (dialog in Main; the renderer only
   ever sees chosen paths). Rows persist as the existing `file`/`link`
   evidence, so the page and the detail drawer stay one source of truth.
   Links open through `app.openExternal`; files reveal through
   `app.revealPath`. Queued attachments on the create page become evidence
   immediately after the item exists.
6. **Start field removed from the page.** `startAt` stays in the contract
   and existing data is untouched, but the capture/edit surface no longer
   asks for it — it never earned its slot.

## Consequences

- `work-board` / `work-board-theme` e2e specs now drive the page flow
  (chips, calendar day picks, attachment queue → evidence).
- The detail drawer keeps reminders/evidence/executions/activity; its Edit
  button routes to the page (`onEdit`), so "new" and "edit" finally share
  one surface without the modal.
- The reminder field only appears on create; ongoing reminder management
  stays in the drawer.
- First-run draft restore is silent and reversible (Discard clears it).
