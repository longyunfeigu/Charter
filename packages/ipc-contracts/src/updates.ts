import { z } from 'zod';

export const UpdateProgressSchema = z
  .object({
    percent: z.number().min(0).max(100),
    bytesPerSecond: z.number().nonnegative(),
    transferred: z.number().nonnegative(),
    total: z.number().nonnegative(),
  })
  .strict();

export const UpdateStateSchema = z
  .object({
    phase: z.enum([
      'disabled',
      'idle',
      'checking',
      'available',
      'downloading',
      'downloaded',
      'up-to-date',
      'error',
    ]),
    delivery: z.enum(['automatic', 'manual']),
    platform: z.enum(['darwin', 'win32', 'linux', 'other']),
    channel: z.enum(['stable', 'beta']),
    currentVersion: z.string(),
    availableVersion: z.string().nullable(),
    releaseName: z.string().nullable(),
    releaseDate: z.string().nullable(),
    releaseUrl: z.string().url().nullable(),
    checkedAt: z.string().nullable(),
    progress: UpdateProgressSchema.nullable(),
    message: z.string().nullable(),
    errorCode: z.string().nullable(),
    canCheck: z.boolean(),
    canInstall: z.boolean(),
  })
  .strict();

export type UpdateProgressDto = z.infer<typeof UpdateProgressSchema>;
export type UpdateStateDto = z.infer<typeof UpdateStateSchema>;
