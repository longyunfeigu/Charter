import type { CreateSessionInput, TaskPlan } from '@pi-ide/agent-contract';

export type ScenarioStep =
  | { kind: 'assistant'; text: string; chunkSize?: number }
  | { kind: 'plan'; plan: TaskPlan }
  | { kind: 'plan-update'; plan: TaskPlan }
  | { kind: 'tool'; toolName: string; input: unknown; reason?: string }
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
    { kind: 'tool', toolName: 'read_file', input: { path: 'src/index.ts' }, reason: 'inspect' },
    {
      kind: 'tool',
      toolName: 'apply_patch',
      input: {
        path: 'src/index.ts',
        patch: '@@ -1 +1 @@\n-old\n+new\n',
        baseHash: 'mock',
        reason: 'apply fix',
      },
      reason: 'apply the fix',
    },
    { kind: 'assistant', text: 'I applied the fix to src/index.ts.', chunkSize: 16 },
    { kind: 'usage', inputTokens: 900, outputTokens: 210 },
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
};

export function resolveScenario(ctx: ScenarioContext): { name: string; steps: ScenarioStep[] } {
  const tagged = ctx.prompt.match(/\[scenario:([a-z0-9-]+)\]/)?.[1];
  const name =
    tagged ?? ctx.session.scenario ?? (ctx.session.mode === 'ask' ? 'ask-basic' : 'edit-basic');
  const scenario = SCENARIOS[name] ?? SCENARIOS['ask-basic']!;
  return { name, steps: scenario(ctx) };
}
