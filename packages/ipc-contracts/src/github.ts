import { z } from 'zod';
import { WorkChecklistItemSchema, WorkItemDtoSchema } from './work-items.js';

/**
 * Read-only GitHub issue import (ADR-0056). Charter pulls one issue into the
 * Work board on explicit user action; it never writes anything back to GitHub
 * (comments, PRs, state changes stay behind the ADR-0022 external-write line).
 */

export const GithubAuthMethodSchema = z.enum(['pat', 'gh-cli', 'none']);
export type GithubAuthMethod = z.infer<typeof GithubAuthMethodSchema>;

export const GithubAuthStatusDtoSchema = z
  .object({
    /** Credential the next import will use: stored PAT wins over gh CLI. */
    method: GithubAuthMethodSchema,
    hasToken: z.boolean(),
    /** Login verified when the PAT was stored; null for gh-cli / none. */
    tokenLogin: z.string().nullable(),
    ghCliAvailable: z.boolean(),
  })
  .strict();
export type GithubAuthStatusDto = z.infer<typeof GithubAuthStatusDtoSchema>;

export const GithubIssuePreviewDtoSchema = z
  .object({
    ref: z.string().min(1).max(300),
    url: z.string().url().max(4000),
    title: z.string().min(1).max(500),
    body: z.string().max(50_000),
    state: z.string().max(40),
    author: z.string().max(100),
    createdAt: z.string().max(100),
    labels: z.array(z.string().max(100)).max(30),
    commentCount: z.number().int().nonnegative(),
    recentCommentCount: z.number().int().nonnegative().max(10),
    acceptance: z.array(WorkChecklistItemSchema).max(100),
    localProject: z
      .object({
        path: z.string().min(1).max(4000),
        displayName: z.string().min(1).max(500),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type GithubIssuePreviewDto = z.infer<typeof GithubIssuePreviewDtoSchema>;

export const GithubIssueResolveResultSchema = z
  .object({
    /** Resolved source snapshot; null when the issue already exists locally. */
    preview: GithubIssuePreviewDtoSchema.nullable(),
    /** Existing Work item id when this issue is already on the board. */
    duplicateItemId: z.string().nullable(),
  })
  .strict();
export type GithubIssueResolveResult = z.infer<typeof GithubIssueResolveResultSchema>;

export const GithubIssueImportResultSchema = z
  .object({
    /** The created Work item; null when the issue was already imported. */
    item: WorkItemDtoSchema.nullable(),
    /** Existing Work item id when this issue is already on the board. */
    duplicateItemId: z.string().nullable(),
  })
  .strict();
export type GithubIssueImportResult = z.infer<typeof GithubIssueImportResultSchema>;
