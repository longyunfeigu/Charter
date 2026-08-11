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
});
export type AgentCatalogCapabilities = z.infer<typeof AgentCatalogCapabilitiesSchema>;

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
  source: z.enum(['builtin', 'user']),
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
});
export type AgentCatalogDto = z.infer<typeof AgentCatalogDtoSchema>;
