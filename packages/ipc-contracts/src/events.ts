import { z } from 'zod';

export interface EventChannelDef<S extends z.ZodType = z.ZodType> {
  name: string;
  schemaVersion: number;
  payload: S;
}

function ev<S extends z.ZodType>(
  name: string,
  schemaVersion: number,
  payload: S,
): EventChannelDef<S> {
  return { name, schemaVersion, payload };
}

/** Fixed main→renderer event channel registry. Grows with milestones. */
export const EVENT_CHANNELS = {
  'app.menuAction': ev('app.menuAction', 1, z.object({ action: z.string() })),
  'app.themeChanged': ev(
    'app.themeChanged',
    1,
    z.object({ theme: z.enum(['light', 'dark', 'system']), effective: z.enum(['light', 'dark']) }),
  ),
} as const;

export type EventChannelName = keyof typeof EVENT_CHANNELS;
export type EventPayload<N extends EventChannelName> = z.infer<
  (typeof EVENT_CHANNELS)[N]['payload']
>;

export function isKnownEventChannel(name: string): name is EventChannelName {
  return Object.prototype.hasOwnProperty.call(EVENT_CHANNELS, name);
}
