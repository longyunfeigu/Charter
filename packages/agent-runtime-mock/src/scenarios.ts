import type { CreateSessionInput, TaskPlan } from '@pi-ide/agent-contract';

export type ScenarioStep =
  | { kind: 'assistant'; text: string; chunkSize?: number }
  | { kind: 'plan'; plan: TaskPlan }
  | { kind: 'plan-update'; plan: TaskPlan }
  /**
   * Tool call. String values equal to '$lastReadHash' are replaced with the
   * hash of the most recent successful read_file result (the mock executes
   * against the real gateway, so base hashes must be genuine). `echo: 'plan'`
   * emits a deterministic assistant message describing the plan returned by
   * the tool — proof the agent received the (possibly user-edited) plan.
   */
  | { kind: 'tool'; toolName: string; input: unknown; reason?: string; echo?: 'plan' }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'wait'; ms: number }
  | { kind: 'compaction' }
  | { kind: 'fail'; code: string; message: string };

export interface ScenarioContext {
  prompt: string;
  session: CreateSessionInput;
}

export type Scenario = (ctx: ScenarioContext) => ScenarioStep[];

function basicPlan(): TaskPlan {
  return {
    version: 1,
    summary: 'Read the target file and apply a focused fix.',
    steps: [
      {
        id: 'step-1',
        title: 'Inspect the relevant file',
        status: 'pending',
        expectedFiles: ['src/index.ts'],
      },
      {
        id: 'step-2',
        title: 'Apply the fix',
        status: 'pending',
        expectedFiles: ['src/index.ts'],
        verification: 'run tests',
      },
    ],
  };
}

/** Extract `[key:value]` markers from the prompt for parameterized scenarios. */
export function promptParam(prompt: string, key: string): string | undefined {
  const m = prompt.match(new RegExp(`\\[${key}:([^\\]]+)\\]`));
  return m?.[1];
}

export const SCENARIOS: Record<string, Scenario> = {
  'ask-basic': (ctx) => [
    { kind: 'wait', ms: 5 },
    {
      kind: 'assistant',
      text: `Looking at the workspace at ${ctx.session.workspaceRoot}: this appears to be a TypeScript project. The entry point wires the main services together, and tests live alongside sources. (deterministic mock answer)`,
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 320, outputTokens: 96 },
  ],
  'ask-with-read': (ctx) => {
    const target = promptParam(ctx.prompt, 'target') ?? 'package.json';
    return [
      { kind: 'assistant', text: 'Let me check the file first.', chunkSize: 12 },
      { kind: 'tool', toolName: 'read_file', input: { path: target }, reason: 'inspect file' },
      {
        kind: 'assistant',
        text: `Based on ${target}, the project defines its scripts and dependencies there. (deterministic mock answer)`,
        chunkSize: 24,
      },
      { kind: 'usage', inputTokens: 400, outputTokens: 120 },
    ];
  },
  'edit-basic': () => [
    { kind: 'plan', plan: basicPlan() },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Read the target file and apply a focused fix.',
        steps: [{ title: 'Apply the fix', expectedFiles: ['src/index.ts'] }],
      },
      reason: 'plan before writing',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'inspect' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'apply fix',
      },
      reason: 'apply the fix',
    },
    { kind: 'assistant', text: 'I applied the fix to src/index.ts.', chunkSize: 16 },
    { kind: 'usage', inputTokens: 900, outputTokens: 210 },
  ],
  // ADR-0009: the user requests plan changes from the composer; the agent
  // revises and proposes v2, then proceeds after approval.
  'plan-request-changes': () => [
    { kind: 'assistant', text: 'Proposing a first plan.', chunkSize: 24 },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'First attempt: apply the fix directly.',
        steps: [{ title: 'Apply the fix', expectedFiles: ['src/index.ts'] }],
      },
      reason: 'initial plan',
    },
    {
      kind: 'assistant',
      text: 'Revising the plan per your feedback. (deterministic mock answer)',
      chunkSize: 24,
    },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Revised: apply the fix, then verify with the test suite.',
        steps: [
          { title: 'Apply the fix', expectedFiles: ['src/index.ts'] },
          { title: 'Run the test suite', verification: 'npm test' },
        ],
      },
      reason: 'revised plan',
      echo: 'plan',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'inspect' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'apply fix per the revised plan',
      },
      reason: 'apply the fix',
    },
    {
      kind: 'assistant',
      text: 'Fix applied after the plan revision. (deterministic mock answer)',
      chunkSize: 16,
    },
    { kind: 'usage', inputTokens: 1100, outputTokens: 300 },
  ],
  slow: () => [
    { kind: 'assistant', text: 'Working on a long analysis. '.repeat(20), chunkSize: 8 },
    { kind: 'wait', ms: 50 },
    { kind: 'assistant', text: 'Still going. '.repeat(10), chunkSize: 8 },
    { kind: 'usage', inputTokens: 100, outputTokens: 500 },
  ],
  'run-error': () => [
    { kind: 'assistant', text: 'Starting…', chunkSize: 8 },
    { kind: 'fail', code: 'AG_PROVIDER_ERROR', message: 'Deterministic provider failure (mock).' },
  ],
  // E2E-012: agent wants to install a dependency (R3). User will decide.
  'command-install': () => [
    { kind: 'assistant', text: 'This needs a new dependency. Let me install it.', chunkSize: 16 },
    {
      kind: 'tool',
      toolName: 'run_command',
      input: { executable: 'npm', args: ['install', 'left-pad'], purpose: 'other' },
      reason: 'install the left-pad dependency',
    },
    {
      kind: 'assistant',
      text: 'If installation is not allowed, I can vendor a tiny helper instead — no dependency needed. (deterministic mock answer)',
      chunkSize: 16,
    },
    { kind: 'usage', inputTokens: 500, outputTokens: 140 },
  ],
  // E2E-013: model attempts forbidden commands; product refuses with zero side effects.
  'command-highrisk': () => [
    { kind: 'assistant', text: 'Attempting a privileged operation.', chunkSize: 16 },
    {
      kind: 'tool',
      toolName: 'run_command',
      input: { executable: 'sudo', args: ['npm', 'install', '-g', 'x'], purpose: 'other' },
      reason: 'install globally',
    },
    {
      kind: 'tool',
      toolName: 'run_command',
      input: { executable: 'git', args: ['push', 'origin', 'main'], purpose: 'other' },
      reason: 'push changes',
    },
    {
      kind: 'assistant',
      text: 'Both actions were refused by product policy, as expected. (deterministic mock answer)',
      chunkSize: 16,
    },
    { kind: 'usage', inputTokens: 320, outputTokens: 90 },
  ],
  // Recognized verification command (R2) — auto-allowed in Auto, asked in Edit.
  'command-test': (ctx) => {
    const target = promptParam(ctx.prompt, 'cmd') ?? 'test';
    return [
      {
        kind: 'assistant',
        text: 'Running the test suite to check the current state.',
        chunkSize: 16,
      },
      {
        kind: 'tool',
        toolName: 'run_command',
        input: { executable: 'npm', args: [target], purpose: 'test' },
        reason: 'run the tests',
      },
      { kind: 'assistant', text: 'Test run complete. (deterministic mock answer)', chunkSize: 16 },
      { kind: 'usage', inputTokens: 260, outputTokens: 80 },
    ];
  },
  // E2E-010: plan → approve → patch two files, create one, run tests → REVIEW_READY.
  'edit-multifile': () => [
    { kind: 'assistant', text: 'I will propose a plan before modifying anything.', chunkSize: 24 },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Update the math functions, add a helper module and verify with the test suite.',
        steps: [
          { title: 'Adjust main() in src/index.ts', expectedFiles: ['src/index.ts'] },
          { title: 'Add mul() to src/util.ts', expectedFiles: ['src/util.ts'] },
          { title: 'Create src/created-by-agent.ts', expectedFiles: ['src/created-by-agent.ts'] },
          { title: 'Run the test suite', verification: 'npm test' },
        ],
      },
      reason: 'plan before first write',
      echo: 'plan',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'get hash' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'change the main() sum per the plan',
      },
      reason: 'apply planned change to index.ts',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/util.ts' }, reason: 'get hash' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/util.ts',
        patch:
          '--- src/util.ts\n+++ src/util.ts\n@@ -5,3 +5,7 @@\n export function sub(a: number, b: number): number {\n   return a - b;\n }\n+\n+export function mul(a: number, b: number): number {\n+  return a * b;\n+}\n',
        baseHash: '$lastReadHash',
        reason: 'add mul() per the plan',
      },
      reason: 'apply planned change to util.ts',
    },
    {
      kind: 'tool',
      toolName: 'create_file',
      input: {
        path: 'src/created-by-agent.ts',
        content: 'export const CREATED_BY_AGENT = true;\n',
        reason: 'add the helper module per the plan',
      },
      reason: 'create helper module',
    },
    {
      kind: 'tool',
      toolName: 'update_plan',
      input: {
        updates: [
          { id: 'step-1-1', status: 'done' },
          { id: 'step-1-2', status: 'done' },
          { id: 'step-1-3', status: 'done' },
        ],
      },
      reason: 'mark write steps done',
    },
    {
      kind: 'tool',
      toolName: 'run_command',
      input: { executable: 'npm', args: ['test'], purpose: 'test' },
      reason: 'run the planned verification',
    },
    {
      kind: 'tool',
      toolName: 'update_plan',
      input: { updates: [{ id: 'step-1-4', status: 'done' }] },
      reason: 'mark verification done',
    },
    {
      kind: 'assistant',
      text: 'All three files are updated and the test suite passed. Ready for review. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 2400, outputTokens: 620 },
  ],
  // E2E-011: plan proposed; the user may edit before approving; the agent echoes the plan it must follow.
  'edit-plan-review': () => [
    { kind: 'assistant', text: 'Let me lay out the plan first.', chunkSize: 24 },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Two-step refactor of the utility module.',
        steps: [
          { title: 'Tidy the add function', expectedFiles: ['src/util.ts'] },
          { title: 'Document the module', expectedFiles: ['src/util.ts'] },
        ],
      },
      reason: 'plan before writing',
      echo: 'plan',
    },
    {
      kind: 'assistant',
      text: 'I will proceed exactly along the approved steps. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 700, outputTokens: 160 },
  ],
  // E2E-014: read → user edits meanwhile (ask_user pause) → stale patch conflicts → re-read → succeed.
  'edit-conflict': () => [
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Patch src/index.ts to change the sum.',
        steps: [{ title: 'Patch src/index.ts', expectedFiles: ['src/index.ts'] }],
      },
      reason: 'plan before writing',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'get hash' },
    {
      kind: 'tool',
      toolName: 'ask_user',
      input: {
        question: 'I am about to patch src/index.ts. Continue?',
        options: ['Continue'],
      },
      reason: 'checkpoint before writing (test hook)',
    },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'apply the planned change (stale base)',
      },
      reason: 'first attempt with the pre-edit hash',
    },
    {
      kind: 'assistant',
      text: 'A version conflict was reported — the file changed since I read it. Re-reading and retrying without touching your edit. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 're-read' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'retry with the fresh hash',
      },
      reason: 'second attempt after re-reading',
    },
    {
      kind: 'assistant',
      text: 'Patched successfully on retry; your edit is preserved. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 1200, outputTokens: 300 },
  ],
  // E2E-015: one file, two well-separated hunks for per-hunk review.
  /** Live-board hook (PIVOT-025): two spaced writes keep the run observable. */
  'edit-live': () => [
    { kind: 'assistant', text: 'Writing two files with pauses (live-board test hook).' },
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Create two note files with pauses.',
        steps: [
          { title: 'Create notes-live-a.txt', expectedFiles: ['notes-live-a.txt'] },
          { title: 'Create notes-live-b.txt', expectedFiles: ['notes-live-b.txt'] },
        ],
      },
      reason: 'plan before writing (AG-007 gate)',
    },
    {
      kind: 'tool',
      toolName: 'create_file',
      input: { path: 'notes-live-a.txt', content: 'live board A\n', reason: 'first live write' },
      reason: 'first write',
    },
    { kind: 'wait', ms: 1400 },
    {
      kind: 'tool',
      toolName: 'create_file',
      input: { path: 'notes-live-b.txt', content: 'live board B\n', reason: 'second live write' },
      reason: 'second write',
    },
    { kind: 'wait', ms: 1400 },
    { kind: 'assistant', text: 'Done with the live edits.' },
  ],

  'edit-hunks': () => [
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Adjust alpha() and omega() in src/mathlib.ts.',
        steps: [{ title: 'Patch mathlib', expectedFiles: ['src/mathlib.ts'] }],
      },
      reason: 'plan before writing',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/mathlib.ts' }, reason: 'get hash' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/mathlib.ts',
        patch:
          '--- src/mathlib.ts\n+++ src/mathlib.ts\n@@ -1,3 +1,3 @@\n export function alpha(x: number): number {\n-  return x + 1;\n+  return x + 100;\n }\n@@ -13,3 +13,3 @@\n export function omega(x: number): number {\n-  return x / 2;\n+  return x / 4;\n }\n',
        baseHash: '$lastReadHash',
        reason: 'adjust both functions',
      },
      reason: 'apply the two-part change',
    },
    {
      kind: 'assistant',
      text: 'Both functions are adjusted in one patch — review the two change blocks. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 900, outputTokens: 210 },
  ],
  // E2E-016: create + modify + delete + rename, then the user rolls everything back.
  'edit-rollback': () => [
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Touch files in all four ways (create/modify/delete/rename).',
        steps: [{ title: 'Apply the four changes' }],
      },
      reason: 'plan before writing',
    },
    {
      kind: 'tool',
      toolName: 'create_file',
      input: { path: 'rollback-note.txt', content: 'temporary note\n', reason: 'create sample' },
      reason: 'create a new file',
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'get hash' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch:
          "--- src/index.ts\n+++ src/index.ts\n@@ -1,5 +1,5 @@\n import { add } from './util';\n \n export function main(): number {\n-  return add(2, 3);\n+  return add(3, 4);\n }\n",
        baseHash: '$lastReadHash',
        reason: 'modify a file',
      },
      reason: 'modify index.ts',
    },
    {
      kind: 'tool',
      toolName: 'delete_file',
      input: { path: 'src/util.ts', reason: 'delete sample' },
      reason: 'delete util.ts',
    },
    {
      kind: 'tool',
      toolName: 'rename_file',
      input: { from: 'src/mathlib.ts', to: 'src/mathlib-renamed.ts', reason: 'rename sample' },
      reason: 'rename mathlib',
    },
    {
      kind: 'assistant',
      text: 'Created, modified, deleted and renamed files as planned. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 1500, outputTokens: 380 },
  ],
  // E2E-017: verification fails, the agent fixes the code, the re-run passes.
  'verify-fail-fix': () => [
    {
      kind: 'tool',
      toolName: 'propose_plan',
      input: {
        summary: 'Create the check target, verify, fix until the check passes.',
        steps: [{ title: 'Create target and verify' }, { title: 'Fix and re-verify' }],
      },
      reason: 'plan before writing',
    },
    {
      kind: 'tool',
      toolName: 'create_file',
      input: { path: 'check-target.txt', content: 'WRONG\n', reason: 'seed the check target' },
      reason: 'create the target (intentionally failing first)',
    },
    { kind: 'tool', toolName: 'run_verification', input: {}, reason: 'first verification' },
    {
      kind: 'assistant',
      text: 'The verification failed as recorded — fixing the target now. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'tool', toolName: 'read_file', input: { path: 'check-target.txt' }, reason: 'hash' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'check-target.txt',
        patch: '--- check-target.txt\n+++ check-target.txt\n@@ -1,1 +1,1 @@\n-WRONG\n+RIGHT\n',
        baseHash: '$lastReadHash',
        reason: 'fix the check target',
      },
      reason: 'fix the target',
    },
    { kind: 'tool', toolName: 'run_verification', input: {}, reason: 'second verification' },
    {
      kind: 'assistant',
      text: 'Second verification passed; the failed record is kept in history. (deterministic mock answer)',
      chunkSize: 24,
    },
    { kind: 'usage', inputTokens: 1800, outputTokens: 420 },
  ],
  // ask_user flow — clarifying question pauses the run until answered.
  'ask-clarify': () => [
    { kind: 'assistant', text: 'I need one detail before continuing.', chunkSize: 16 },
    {
      kind: 'tool',
      toolName: 'ask_user',
      input: {
        question: 'Which package manager should I assume — npm or pnpm?',
        options: ['npm', 'pnpm'],
      },
      reason: 'clarify package manager',
    },
    {
      kind: 'assistant',
      text: 'Thanks — proceeding with your choice. (deterministic mock answer)',
      chunkSize: 16,
    },
    { kind: 'usage', inputTokens: 220, outputTokens: 70 },
  ],
};

export function resolveScenario(ctx: ScenarioContext): { name: string; steps: ScenarioStep[] } {
  const tagged = ctx.prompt.match(/\[scenario:([a-z0-9-]+)\]/)?.[1];
  const name =
    tagged ?? ctx.session.scenario ?? (ctx.session.mode === 'ask' ? 'ask-basic' : 'edit-basic');
  const scenario = SCENARIOS[name] ?? SCENARIOS['ask-basic']!;
  return { name, steps: scenario(ctx) };
}
