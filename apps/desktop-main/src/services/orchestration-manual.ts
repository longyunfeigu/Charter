import { ORCHESTRATION_COMMAND_REGISTRY } from '@pi-ide/tool-gateway';

const ORCHESTRATION_COMMAND_HELP = ORCHESTRATION_COMMAND_REGISTRY.map(
  (entry) => `- \`orchestration.${entry.command}\`: ${entry.description}`,
).join('\n');

export const CHARTER_ORCHESTRATION_SKILL = `---
name: charter-orchestration
description: Coordinate durable recursive Charter Missions. Use when work benefits from independently verifiable delegation, parallel agents, a specialist runtime, or independent review. Every Mission member may delegate directly through orchestration tools or the charter CLI.
disable-model-invocation: false
---

# Charter Mission orchestration

Charter Missions are a durable team protocol. A Mission contains a Task dependency graph, an
Assignment responsibility tree, and one active execution Attempt per Assignment. Runtime lifetime
and Assignment completion are separate. Use native \`orchestration.*\` tools when present; in a Charter
terminal use \`charter orchestration ...\`. MCP names replace the dot with an underscore.

## Decide whether to delegate

Delegate when a bounded subproblem can be independently verified, parallel work will not cause
uncoordinated writes, another runtime/model is materially better, a focused investigation would
pollute this context, or independent review reduces a concrete risk. Work locally when the step is
tiny, sequential, needs all private conversation context, or has no distinct acceptance contract.

Before delegating, call \`orchestration.inspect\`. Every child request must include its goal,
acceptance criteria, dependencies, expected evidence, work mode, why delegation is useful, and a
stable idempotency key. Choose \`read-only\` for research/review, \`isolated-write\` for parallel code
changes, and \`shared-write\` only when coordination is explicit.

Every Mission member may delegate recursively. If you are B and discover bounded work D, create D
yourself with \`orchestration.delegate\`; never ask A to proxy the operation.

## Working protocol

1. Inspect Mission state, then use \`sync\` whenever a durable inbox doorbell arrives.
2. Perform your Assignment and report meaningful phases with \`orchestration.progress\`.
3. Use \`message\` for FYI context, \`request\` when another Agent owes an answer/action, and durable
   \`park\` for work that outlives this turn. A message alone never creates anybody's to-do.
4. Escalate blockers through the supervisor tree. Only the Lead uses \`request_decision\`, and only
   when a user choice is genuinely irreducible. Include options, impact, and a recommendation.
5. Finish exactly once with \`orchestration.complete\` and concrete artifacts/evidence. After completion,
   stop mutating the Assignment until a new Attempt or follow-up is issued.

Use \`delegate_many\` for independent siblings so Charter can start them concurrently. \`ask\` is a
compatibility shortcut that creates an Agent Action Request and waits for its resolution; new flows
should prefer \`request\` plus \`park\`. Resolve requests assigned to you with \`resolve_request\`.
For delegated work that may outlive this agent turn, call
\`park\` with Assignment/message conditions and the latest \`sync\` cursor, then end the turn
immediately. Charter persists the condition, matches committed events, and resumes the same
Claude Code/Codex/ACP Session at a safe idle boundary. The injected resume prompt calls
\`continue\` idempotently before work proceeds. \`wait\` and \`join\` remain compatibility tools for
short bounded waits; never repeat them in a polling loop.

## Command surface

${ORCHESTRATION_COMMAND_HELP}

An \`isolated-write\` Assignment runs in its own Charter worktree. Its completion proves the local
contract; it does not silently merge into the Mission target tree. Before Mission acceptance, the
Lead creates an Integration Task (or performs an explicit Lead integration for a trivial change),
uses the persisted managed-task/worktree artifacts as lineage, resolves conflicts, and runs
post-integration verification. Report \`filesModified\` and structured \`verification\` evidence in
\`orchestration.complete\`. A \`shared-write\` Assignment has no isolation; coordinate its write
scope explicitly and treat Charter's overlap escalation as real attribution ambiguity.

Only the active Attempt can report progress or completion. A late result from an older Attempt is
stored as suppressed and cannot complete a retry. Calls are authorized from Charter's trusted
runtime/terminal identity; never place Principal, Assignment, Attempt, or control tokens in a tool
payload. Permissions are inherited uniformly from the user's host Agent policy—there are no
per-child grants. Communication may cross the team, but control does not: the user can control the
Mission, the Lead controls the Mission tree, supervisors control their own subtrees, and a worker
controls itself. Peers cannot pause, cancel, steer, retry, or reassign one another.

## CLI examples

\`\`\`bash
charter orchestration inspect --json
charter orchestration delegate_many --request-file children.json --json
charter orchestration message --to assign_123 --subject "API ready" --body-file note.md --json
charter orchestration request --request-file agent-review.json --json
charter orchestration request_decision --request-file user-choice.json --json
charter orchestration resolve_request --request-file resolution.json --json
charter orchestration sync --request-json '{"afterSequence":42}' --json
charter orchestration park --request-file continuation.json --json
charter orchestration continue --continuation continuation_123 --json
charter orchestration complete --request-file result.json --json
\`\`\`

Never print or persist \`CHARTER_CTL_TOKEN\`. Low-level \`terminal.*\` remains available for manual
screen/process control, but terminal text, quiet output, or process exit never changes Mission state.
`;

export const CHARTER_ORCHESTRATION_PREAMBLE = `## Charter Mission orchestration

When a bounded subproblem is independently verifiable, parallelizable, suited to another runtime,
or needs independent review, load the charter-orchestration Skill. Every Mission member may call
orchestration.delegate recursively; a child does not ask its parent to proxy delegation. Use
structured message/request/park/progress/complete operations, and never infer completion from terminal
quiet or process exit. After a successful park call, end the current turn; Charter resumes the same
Session when committed conditions match.`;
