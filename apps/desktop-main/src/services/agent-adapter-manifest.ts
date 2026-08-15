import { z } from 'zod';
import { AgentIdSchema } from '@pi-ide/ipc-contracts';
import builtinAdapterData from './builtin-agent-manifests.json';
import builtinLifecycleData from './builtin-agent-lifecycle-manifests.json';

/** Bump only when the host contract changes incompatibly. Adapter manifests
 * declare the inclusive engine range they understand. */
export const AGENT_ADAPTER_ENGINE_VERSION = 1;

const StringListSchema = z.array(z.string().min(1).max(2_000)).max(32);

export type LifecycleRegion =
  | { kind: 'whole_recent' | 'osc_title' | 'after_last_horizontal_rule' }
  | { kind: 'top_non_empty_lines' | 'bottom_non_empty_lines'; count: number };

export interface LifecycleGate {
  all?: LifecycleGate[];
  any?: LifecycleGate[];
  not?: LifecycleGate[];
  contains?: string[];
  regex?: string[];
  lineRegex?: string[];
}

export interface LifecycleRule extends LifecycleGate {
  id: string;
  state: 'working' | 'blocked' | 'idle' | 'unknown';
  priority: number;
  region: LifecycleRegion;
  visibleIdle?: boolean;
  visibleBlocker?: boolean;
  visibleWorking?: boolean;
  skipStateUpdate?: boolean;
}

export interface AgentLifecycleManifest {
  id: string;
  version: string;
  sourceRevision: string;
  authority: 'full' | 'session-only' | 'none';
  aliases: string[];
  rules: LifecycleRule[];
}

const StringMatchersSchema = z.array(z.string().min(1).max(512)).max(32).optional();
const LifecycleGateSchema: z.ZodType<LifecycleGate> = z.lazy(() =>
  z
    .object({
      all: z.array(LifecycleGateSchema).max(32).optional(),
      any: z.array(LifecycleGateSchema).max(32).optional(),
      not: z.array(LifecycleGateSchema).max(32).optional(),
      contains: StringMatchersSchema,
      regex: StringMatchersSchema,
      lineRegex: StringMatchersSchema,
    })
    .strict(),
);

const LifecycleRegionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['whole_recent', 'osc_title', 'after_last_horizontal_rule']) }).strict(),
  z
    .object({
      kind: z.enum(['top_non_empty_lines', 'bottom_non_empty_lines']),
      count: z.number().int().positive().max(100),
    })
    .strict(),
]);

const LifecycleRuleSchema: z.ZodType<LifecycleRule> = z
  .object({
    id: z.string().min(1).max(100),
    state: z.enum(['working', 'blocked', 'idle', 'unknown']),
    priority: z.number().int(),
    region: LifecycleRegionSchema,
    visibleIdle: z.boolean().optional(),
    visibleBlocker: z.boolean().optional(),
    visibleWorking: z.boolean().optional(),
    skipStateUpdate: z.boolean().optional(),
    all: z.array(LifecycleGateSchema).max(32).optional(),
    any: z.array(LifecycleGateSchema).max(32).optional(),
    not: z.array(LifecycleGateSchema).max(32).optional(),
    contains: StringMatchersSchema,
    regex: StringMatchersSchema,
    lineRegex: StringMatchersSchema,
  })
  .strict();

export const AgentLifecycleManifestSchema: z.ZodType<AgentLifecycleManifest> = z
  .object({
    id: AgentIdSchema,
    version: z.string().min(1).max(100),
    sourceRevision: z.string().min(1).max(100),
    authority: z.enum(['full', 'session-only', 'none']),
    aliases: z.array(z.string().min(1).max(100)).max(16),
    rules: z.array(LifecycleRuleSchema).min(1).max(128),
  })
  .strict();

export const AgentCapabilityDeclarationsSchema = z
  .object({
    terminal: z.boolean(),
    acp: z.boolean(),
    loadSession: z.boolean(),
    sessionList: z.boolean(),
    sessionResume: z.boolean(),
    images: z.boolean(),
    embeddedContext: z.boolean(),
    mcp: z.boolean(),
    exactResume: z.boolean(),
    history: z.boolean(),
    skills: z.boolean(),
    instructions: z.boolean(),
    remote: z.boolean(),
    lifecycle: z.enum(['none', 'observed', 'structured']),
  })
  .strict();

/** One complete, declarative Agent integration. Provider-specific commands,
 * session identity connectors and lifecycle evidence are named by data; core
 * discovery and launch code never branches on the Agent id. */
export const AgentAdapterManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    adapterVersion: z.string().min(1).max(100),
    engine: z
      .object({
        min: z.number().int().positive(),
        max: z.number().int().positive(),
      })
      .strict(),
    id: AgentIdSchema,
    displayName: z.string().min(1).max(100),
    shortName: z.string().min(1).max(40),
    description: z.string().max(300).default(''),
    mark: z.string().min(1).max(40),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i),
    discovery: z
      .object({
        commands: StringListSchema.min(1),
        knownPaths: StringListSchema.default([]),
        versionArgs: StringListSchema.default(['--version']),
      })
      .strict(),
    terminal: z
      .object({
        promptDelivery: z.enum(['argv', 'deferred']).default('deferred'),
        newSessionArgs: StringListSchema.optional(),
        initialPromptArgs: StringListSchema.optional(),
        startup: z
          .object({
            gateMarkers: StringListSchema.default([]),
            readyMarkers: StringListSchema.default([]),
            readyRequired: z.boolean().default(false),
            requireBracketedPaste: z.boolean().default(true),
            deferInitialProbe: z.boolean().default(false),
            updateGate: z
              .object({
                markers: StringListSchema.min(1),
                actions: z
                  .array(z.enum(['up', 'down', 'left', 'right', 'enter']))
                  .min(1)
                  .max(8),
              })
              .strict()
              .nullable()
              .default(null),
          })
          .strict()
          .default({
            gateMarkers: [],
            readyMarkers: [],
            readyRequired: false,
            requireBracketedPaste: true,
            deferInitialProbe: false,
            updateGate: null,
          }),
        exitSequence: z
          .array(z.enum(['interrupt', 'eof']))
          .min(1)
          .max(4)
          .default(['interrupt', 'eof']),
      })
      .strict()
      .nullable()
      .default(null),
    acp: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('native'), args: StringListSchema.default(['acp']) }).strict(),
        z.object({ kind: z.literal('bundled'), package: z.string().min(1).max(100) }).strict(),
      ])
      .nullable()
      .default(null),
    sessions: z
      .object({
        idPattern: z.string().min(1).max(500),
        preassignId: z.boolean().default(false),
        resumeArgs: StringListSchema.optional(),
        continueArgs: StringListSchema.optional(),
        homeEnv: z.string().min(1).max(100).optional(),
        defaultHome: z.string().min(1).max(2_000).optional(),
        historyConnector: z.string().min(1).max(100).optional(),
        identityConnector: z.string().min(1).max(100).optional(),
      })
      .strict()
      .nullable()
      .default(null),
    surfaces: z
      .object({
        skillRoots: StringListSchema.default([]),
        instructionRoots: StringListSchema.default([]),
        remote: z.boolean().default(false),
      })
      .strict(),
    capabilities: AgentCapabilityDeclarationsSchema,
    lifecycle: AgentLifecycleManifestSchema.nullable(),
  })
  .strict()
  .superRefine((adapter, context) => {
    if (adapter.engine.min > adapter.engine.max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['engine'],
        message: 'engine.min must be less than or equal to engine.max',
      });
    }
    if (adapter.lifecycle && adapter.lifecycle.id !== adapter.id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lifecycle', 'id'],
        message: 'lifecycle.id must match adapter.id',
      });
    }
    if (adapter.sessions) {
      try {
        new RegExp(adapter.sessions.idPattern, 'i');
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', 'idPattern'],
          message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const ruleIds = new Set<string>();
    const inspectGate = (
      gate: LifecycleGate,
      path: Array<string | number>,
      depth: number,
    ): void => {
      if (depth > 8) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'lifecycle gate nesting exceeds 8 levels',
        });
        return;
      }
      for (const key of ['regex', 'lineRegex'] as const) {
        for (const [index, source] of (gate[key] ?? []).entries()) {
          try {
            new RegExp(source, key === 'regex' ? 'imu' : 'iu');
          } catch (error) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [...path, key, index],
              message: `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
      }
      for (const key of ['all', 'any', 'not'] as const) {
        for (const [index, child] of (gate[key] ?? []).entries()) {
          inspectGate(child, [...path, key, index], depth + 1);
        }
      }
    };
    for (const [index, rule] of (adapter.lifecycle?.rules ?? []).entries()) {
      if (ruleIds.has(rule.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['lifecycle', 'rules', index, 'id'],
          message: `duplicate lifecycle rule id: ${rule.id}`,
        });
      }
      ruleIds.add(rule.id);
      inspectGate(rule, ['lifecycle', 'rules', index], 0);
    }
    const declared = adapter.capabilities;
    const requires = (
      enabled: boolean,
      implemented: boolean,
      path: keyof z.infer<typeof AgentCapabilityDeclarationsSchema>,
      message: string,
    ) => {
      if (enabled && !implemented) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['capabilities', path], message });
      }
    };
    requires(
      declared.terminal,
      adapter.terminal !== null,
      'terminal',
      'terminal adapter is missing',
    );
    requires(declared.acp, adapter.acp !== null, 'acp', 'ACP adapter is missing');
    requires(declared.loadSession, adapter.acp !== null, 'loadSession', 'ACP adapter is missing');
    requires(declared.sessionList, adapter.acp !== null, 'sessionList', 'ACP adapter is missing');
    requires(
      declared.sessionResume,
      adapter.acp !== null,
      'sessionResume',
      'ACP adapter is missing',
    );
    requires(
      declared.embeddedContext,
      adapter.acp !== null,
      'embeddedContext',
      'ACP adapter is missing',
    );
    requires(declared.mcp, adapter.acp !== null, 'mcp', 'ACP adapter is missing');
    requires(
      declared.exactResume,
      Boolean(adapter.sessions?.resumeArgs),
      'exactResume',
      'session resumeArgs are missing',
    );
    requires(
      declared.history,
      Boolean(adapter.sessions?.historyConnector),
      'history',
      'history connector is missing',
    );
    requires(
      declared.skills,
      adapter.surfaces.skillRoots.length > 0,
      'skills',
      'skill roots are missing',
    );
    requires(
      declared.instructions,
      adapter.surfaces.instructionRoots.length > 0,
      'instructions',
      'instruction roots are missing',
    );
    requires(
      declared.remote,
      adapter.surfaces.remote && adapter.terminal !== null,
      'remote',
      'remote terminal launch is missing',
    );
    requires(
      declared.lifecycle !== 'none',
      adapter.lifecycle !== null,
      'lifecycle',
      'lifecycle manifest is missing',
    );
  });

export type AgentAdapterManifest = z.infer<typeof AgentAdapterManifestSchema>;
export type AgentCapabilityDeclarations = z.infer<typeof AgentCapabilityDeclarationsSchema>;

const builtinLifecycles = z.array(AgentLifecycleManifestSchema).parse(builtinLifecycleData);
const lifecycleById = new Map(builtinLifecycles.map((manifest) => [manifest.id, manifest]));

export const BUILTIN_AGENT_ADAPTERS: readonly AgentAdapterManifest[] = z
  .array(AgentAdapterManifestSchema)
  .parse(
    (builtinAdapterData as unknown[]).map((adapter) => {
      const id =
        adapter && typeof adapter === 'object' && 'id' in adapter
          ? String((adapter as { id: unknown }).id)
          : '';
      return { ...(adapter as object), lifecycle: lifecycleById.get(id) ?? null };
    }),
  );

export function adapterEngineCompatible(adapter: AgentAdapterManifest): boolean {
  return (
    adapter.engine.min <= AGENT_ADAPTER_ENGINE_VERSION &&
    adapter.engine.max >= AGENT_ADAPTER_ENGINE_VERSION
  );
}
