import { z } from 'zod';

export const SkillSourceKindSchema = z.enum(['managed', 'agents', 'codex', 'claude', 'custom']);
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>;

/** One directory Charter discovers skills from (ADR-0019). */
export const SkillSourceDtoSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: SkillSourceKindSchema,
  /** Display path only. All reads remain in main through SkillStore. */
  path: z.string(),
  available: z.boolean(),
  /** A trusted external source may offer enabled skills to the agent. */
  trusted: z.boolean(),
  /** Newly discovered skills inherit Auto when this is enabled. */
  autoEnableNew: z.boolean(),
  /** Built-in source definitions cannot be disconnected. */
  removable: z.boolean(),
  live: z.boolean(),
  skillCount: z.number().int().nonnegative(),
  lastScannedAt: z.string(),
});
export type SkillSourceDto = z.infer<typeof SkillSourceDtoSchema>;

/**
 * One managed or externally-linked skill as the renderer sees it
 * (ADR-0015 + ADR-0019). Project-local sources remain opt-in (AG-014).
 */
export const SkillDtoSchema = z.object({
  /** Stable catalog id. Managed skills preserve their legacy slug ids. */
  id: z.string(),
  /** Unique invocation name. Conflicts are qualified, e.g. pdf@claude. */
  name: z.string(),
  /** Original frontmatter name before conflict qualification. */
  displayName: z.string(),
  /** SKILL.md frontmatter `description`. */
  description: z.string(),
  /** User toggle: false = Off (disabled), true = Auto (enabled). */
  enabled: z.boolean(),
  /**
   * Whether the owning Agent can currently discover this installed copy.
   * Linked Claude/Codex copies may be parked outside their live source while
   * remaining visible here so the user can restore them. Older peers omit it.
   */
  agentEnabled: z.boolean().optional(),
  /** Agent/vendor built-ins are visible for usage insight but cannot be moved or deleted. */
  protected: z.boolean().optional(),
  /** Frontmatter `disable-model-invocation` — only `/skill:name`, never auto. */
  explicitOnly: z.boolean(),
  source: SkillSourceKindSchema,
  sourceId: z.string(),
  sourceLabel: z.string(),
  /** Home-shortened path for provenance/audit UI. */
  sourcePath: z.string(),
  /** Linked sources follow their owner; managed skills are copied snapshots. */
  live: z.boolean(),
  status: z.enum(['ready', 'conflict', 'invalid']),
  compatibility: z.enum(['compatible', 'needs-review']),
  issues: z.array(z.string()),
  /** Metadata/content revision written into load_skill results and audit trail. */
  revision: z.string(),
  /** Bundled files, relative to the skill root (for the audit view). */
  files: z.array(z.string()),
  /** How many bundled files look like executable scripts (audit signal). */
  scriptCount: z.number().int().nonnegative(),
  /** ISO import time. */
  importedAt: z.string(),
  /** Latest bundled-file mtime observed by discovery. */
  updatedAt: z.string(),
});
export type SkillDto = z.infer<typeof SkillDtoSchema>;

/**
 * Who ran the skill (ADR-0040): Charter's own ledgers, or an external CLI
 * whose transcripts we can read. Order is fixed — 'charter' first, then the
 * DISCOVERED_CLIS of archaeology.ts — and the UI renders it verbatim.
 */
export const SKILL_CONSUMERS = ['charter', 'claude', 'codex'] as const;
export const SkillConsumerSchema = z.enum(SKILL_CONSUMERS);
export type SkillConsumer = z.infer<typeof SkillConsumerSchema>;

/** One consumer's slice of a skill's usage (ADR-0040). */
export const SkillConsumerUsageSchema = z.object({
  uses: z.number().int().nonnegative(),
  /** ISO time of this consumer's most recent invocation inside the window. */
  lastUsedAt: z.string().nullable(),
  /** Same bucket count as the merged weekly (usageWeekCount(windowDays)). */
  weekly: z.array(z.number().int().nonnegative()),
});
export type SkillConsumerUsage = z.infer<typeof SkillConsumerUsageSchema>;

/**
 * Ledger-derived usage + per-turn context cost for one catalog skill
 * (ADR-0037). Joined to SkillDto by `name` so the catalog schema stays put.
 * Top-level uses/lastUsedAt/weekly are merged across all consumers; the
 * per-consumer split lives in byConsumer (ADR-0040).
 */
export const SkillUsageDtoSchema = z.object({
  /** Runtime invocation name (matches SkillDto.name). */
  name: z.string(),
  /**
   * Estimated tokens this skill adds to EVERY turn's preamble. 0 means it is
   * not in the preamble (disabled, invalid, or explicit-only — those cost
   * nothing until invoked).
   */
  preambleTokens: z.number().int().nonnegative(),
  /** Invocations inside the window, merged across all consumers. */
  uses: z.number().int().nonnegative(),
  /** ISO time of the most recent invocation inside the window, if any. */
  lastUsedAt: z.string().nullable(),
  /** Per-week invocation buckets, oldest → newest, merged across consumers. */
  weekly: z.array(z.number().int().nonnegative()),
  byConsumer: z.object({
    /** In-app: load_skill tool calls + explicit `/skill:name` runs. */
    charter: SkillConsumerUsageSchema,
    /** Claude Code transcripts (Skill tool_use events, ADR-0040). */
    claude: SkillConsumerUsageSchema,
    /** Reserved: no verified Codex invocation format yet — always zeros. */
    codex: SkillConsumerUsageSchema,
  }),
});
export type SkillUsageDto = z.infer<typeof SkillUsageDtoSchema>;

/**
 * ADR-0045: install state of the charter-terminal manual on one external
 * CLI's user-level skills directory (~/.claude/skills, ~/.codex/skills).
 * upToDate is a byte-for-byte comparison against the bundled manual, so the
 * settings panel can offer an update after the product revises the text.
 */
export const CharterTerminalSurfaceDtoSchema = z.object({
  target: z.enum(['claude', 'codex']),
  /** Absolute SKILL.md path inside the CLI's user-level skills directory. */
  path: z.string(),
  installed: z.boolean(),
  upToDate: z.boolean(),
  /** Read/write failure for this target; null when the surface is healthy. */
  error: z.string().nullable(),
});
export type CharterTerminalSurfaceDto = z.infer<typeof CharterTerminalSurfaceDtoSchema>;
