import { z } from 'zod';

/** Stable, renderer-safe identity for a discovered external coding Agent. */
export const AgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export type AgentId = z.infer<typeof AgentIdSchema>;

export const AgentTransportSchema = z.enum(['terminal', 'acp']);
export type AgentTransport = z.infer<typeof AgentTransportSchema>;

/**
 * A model reference forwarded verbatim to an external CLI (`--model <ref>`).
 * The shape gate — not a whitelist — is the security boundary: identifiers
 * like `opus`, `gpt-5.6-sol` or `codermartin/kimi-k3` pass, while anything
 * that could read as a flag or shell text (leading `-`, spaces, quotes) is
 * rejected. Catalogs churn too fast for an enum to stay truthful.
 */
export const AgentModelRefSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:-]*$/);
export type AgentModelRef = z.infer<typeof AgentModelRefSchema>;

/** One selectable model for an external Agent's native CLI launch. */
export const AgentModelChoiceSchema = z.object({
  id: AgentModelRefSchema,
  label: z.string().min(1).max(100),
  /** The CLI's own configured default on this computer, when discoverable. */
  isDefault: z.boolean(),
});
export type AgentModelChoice = z.infer<typeof AgentModelChoiceSchema>;

export const AgentCatalogCapabilitiesSchema = z.object({
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
  /** How lifecycle state is established. `observed` means bounded OSC/screen
   * evidence; `structured` is an authoritative Agent integration. */
  lifecycle: z.enum(['none', 'observed', 'structured']),
});
export type AgentCatalogCapabilities = z.infer<typeof AgentCatalogCapabilitiesSchema>;

export const AgentAdapterMetadataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  adapterVersion: z.string().min(1).max(100),
  engineMin: z.number().int().positive(),
  engineMax: z.number().int().positive(),
  source: z.enum(['builtin', 'pack', 'override']),
  sourcePath: z.string().nullable(),
  lifecycleVersion: z.string().nullable(),
  lifecycleAuthority: z.enum(['full', 'session-only', 'none']),
});
export type AgentAdapterMetadata = z.infer<typeof AgentAdapterMetadataSchema>;

export const AgentAdapterDiagnosticSchema = z.object({
  agentId: AgentIdSchema.nullable(),
  sourcePath: z.string(),
  severity: z.enum(['warning', 'error']),
  code: z.enum([
    'invalid-json',
    'invalid-manifest',
    'incompatible-engine',
    'duplicate-pack',
    'duplicate-override',
    'override-disabled',
  ]),
  message: z.string().min(1).max(2_000),
});
export type AgentAdapterDiagnostic = z.infer<typeof AgentAdapterDiagnosticSchema>;

/** Public projection of one trusted Agent manifest plus its current host detection. */
export const DetectedAgentDtoSchema = z.object({
  id: AgentIdSchema,
  displayName: z.string().min(1).max(100),
  shortName: z.string().min(1).max(40),
  description: z.string().max(300),
  mark: z.string().min(1).max(40),
  accent: z.string().regex(/^#[0-9a-f]{6}$/i),
  installed: z.boolean(),
  executable: z.string().nullable(),
  version: z.string().nullable(),
  adapter: AgentAdapterMetadataSchema,
  capabilities: AgentCatalogCapabilitiesSchema,
  /** Selectable models for a native terminal launch — static manifest
   * suggestions merged with choices discovered from the CLI's own local
   * config. Empty when the manifest declares no model flag. */
  models: z.array(AgentModelChoiceSchema).max(64).default([]),
});
export type DetectedAgentDto = z.infer<typeof DetectedAgentDtoSchema>;

export const AgentCatalogDtoSchema = z.object({
  agents: z.array(DetectedAgentDtoSchema),
  scannedAt: z.string(),
  engineVersion: z.number().int().positive(),
  overrideEnabled: z.boolean(),
  diagnostics: z.array(AgentAdapterDiagnosticSchema),
});
export type AgentCatalogDto = z.infer<typeof AgentCatalogDtoSchema>;

/** Installed, data-only Agent Pack. Pack files may declare Adapter manifests
 * but never executable JavaScript; `local` means the user explicitly chose an
 * unsigned file, while `verified` means its Ed25519 signature matched a host
 * trust key. */
export const AgentPackDtoSchema = z.object({
  id: AgentIdSchema,
  displayName: z.string().min(1).max(100),
  publisher: z.string().min(1).max(100),
  currentVersion: z.string().min(1).max(100),
  previousVersion: z.string().min(1).max(100).nullable(),
  availableVersions: z.array(z.string().min(1).max(100)).max(32),
  enabled: z.boolean(),
  trust: z.enum(['local', 'verified']),
  adapterIds: z.array(AgentIdSchema).min(1).max(16),
  installedAt: z.string(),
  sourcePath: z.string(),
  /** Bundled Packs are shipped and verified with Charter itself. They may be
   * disabled, but cannot be removed or replaced by a local import. */
  bundled: z.boolean().default(false),
});
export type AgentPackDto = z.infer<typeof AgentPackDtoSchema>;

export const AgentPackCatalogDtoSchema = z.object({
  packs: z.array(AgentPackDtoSchema),
});
export type AgentPackCatalogDto = z.infer<typeof AgentPackCatalogDtoSchema>;

export const AgentPackActionResultDtoSchema = z.object({
  changed: z.boolean(),
  catalog: AgentPackCatalogDtoSchema,
});
export type AgentPackActionResultDto = z.infer<typeof AgentPackActionResultDtoSchema>;
