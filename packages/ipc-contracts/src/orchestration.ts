import { z } from 'zod';

export const OrchestrationWorkerSchema = z.object({
  terminalId: z.string(),
  commanderTaskId: z.string(),
  commanderTerminalId: z.string().nullable(),
  createdAt: z.string(),
  launch: z.enum(['shell', 'claude', 'codex']),
  title: z.string(),
  projectName: z.string(),
  taskId: z.string().nullable(),
  status: z.enum(['streaming', 'quiet', 'completed', 'failed', 'exited']),
  busy: z.boolean(),
  paused: z.boolean(),
  takeover: z.boolean(),
  queuedSends: z.number().int().nonnegative(),
  exitCode: z.number().int().nullable(),
  outputTail: z.string(),
  updatedAt: z.string(),
});

export const OrchestrationSnapshotSchema = z.object({
  enabled: z.boolean(),
  fleetPausedTaskIds: z.array(z.string()),
  workers: z.array(OrchestrationWorkerSchema),
});

export type OrchestrationWorkerDto = z.infer<typeof OrchestrationWorkerSchema>;
export type OrchestrationSnapshotDto = z.infer<typeof OrchestrationSnapshotSchema>;
