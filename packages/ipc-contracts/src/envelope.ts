import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

export const ProductErrorSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error', 'fatal']),
  userMessage: z.string(),
  technicalMessage: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
});

export const IpcRequestSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  workspaceId: z.string().optional(),
  payload: z.unknown(),
});

export const IpcResponseSchema = z
  .object({
    requestId: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: ProductErrorSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.ok && !value.error) {
      ctx.addIssue({ code: 'custom', message: 'error is required when ok=false' });
    }
  });

export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
