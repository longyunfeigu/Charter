import { z } from 'zod';
import { TerminalResizeRequestSchema, TerminalWriteRequestSchema } from './channels.js';

export interface SendChannelDef<S extends z.ZodType = z.ZodType> {
  name: string;
  schemaVersion: number;
  payload: S;
}

function sendChannel<S extends z.ZodType>(
  name: string,
  schemaVersion: number,
  payload: S,
): SendChannelDef<S> {
  return { name, schemaVersion, payload };
}

/**
 * Fixed renderer→main notification registry. These channels are deliberately
 * separate from RPC: latency-sensitive notifications have no response path,
 * while their payloads retain the same validation boundary.
 */
export const SEND_CHANNELS = {
  'terminal.write': sendChannel('terminal.write', 1, TerminalWriteRequestSchema),
  'terminal.resize': sendChannel('terminal.resize', 1, TerminalResizeRequestSchema),
  'terminal.active': sendChannel(
    'terminal.active',
    1,
    z.object({ id: z.string().nullable() }).strict(),
  ),
  'terminal.ack': sendChannel(
    'terminal.ack',
    1,
    z
      .object({
        id: z.string(),
        deliveryId: z.number().int().nonnegative(),
      })
      .strict(),
  ),
} as const;

export type SendChannelName = keyof typeof SEND_CHANNELS;
export type SendPayload<N extends SendChannelName> = z.infer<(typeof SEND_CHANNELS)[N]['payload']>;
