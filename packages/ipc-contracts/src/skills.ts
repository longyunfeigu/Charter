import { z } from 'zod';

/**
 * A skill in the product-managed store, as the renderer sees it (ADR-0015).
 * Derived from an imported SKILL.md folder — the product never scans project
 * directories for skills (AG-014). `enabled` is the user's Off/Auto toggle;
 * `explicitOnly` is intrinsic to the skill (frontmatter `disable-model-invocation`)
 * and means the model never auto-fires it — it only runs via `/skill:name`.
 */
export const SkillDtoSchema = z.object({
  /** Slug = directory name in the managed store; stable id across channels. */
  id: z.string(),
  /** SKILL.md frontmatter `name`. */
  name: z.string(),
  /** SKILL.md frontmatter `description`. */
  description: z.string(),
  /** User toggle: false = Off (disabled), true = Auto (enabled). */
  enabled: z.boolean(),
  /** Frontmatter `disable-model-invocation` — only `/skill:name`, never auto. */
  explicitOnly: z.boolean(),
  /** Provenance (V1: always 'local' — imported from a folder). */
  source: z.string(),
  /** Bundled files, relative to the skill root (for the audit view). */
  files: z.array(z.string()),
  /** How many bundled files look like executable scripts (audit signal). */
  scriptCount: z.number().int().nonnegative(),
  /** ISO import time. */
  importedAt: z.string(),
});
export type SkillDto = z.infer<typeof SkillDtoSchema>;
