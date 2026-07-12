import { z } from 'zod';

export const TrustStateSchema = z.enum(['untrusted', 'trusted']);

export const WorkspaceDtoSchema = z.object({
  id: z.string(),
  path: z.string(),
  displayName: z.string(),
  trustState: TrustStateSchema,
  isGitRepo: z.boolean(),
  openedAt: z.string(),
  hasPiProjectResources: z.boolean(),
});
export type WorkspaceDto = z.infer<typeof WorkspaceDtoSchema>;

export const RecentWorkspaceSchema = z.object({
  path: z.string(),
  displayName: z.string(),
  lastOpenedAt: z.string(),
  pinned: z.boolean(),
  exists: z.boolean(),
});
export type RecentWorkspaceDto = z.infer<typeof RecentWorkspaceSchema>;

export const AppInfoSchema = z.object({
  appVersion: z.string(),
  electron: z.string(),
  node: z.string(),
  chrome: z.string(),
  platform: z.string(),
  arch: z.string(),
  commit: z.string().nullable(),
  piSdkVersion: z.string().nullable(),
  updateChannel: z.string(),
  userDataDir: z.string(),
});
export type AppInfoDto = z.infer<typeof AppInfoSchema>;
