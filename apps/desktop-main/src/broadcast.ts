import { BrowserWindow } from 'electron';
import { EVENT_CHANNELS, type EventChannelName, type EventPayload } from '@pi-ide/ipc-contracts';

/** Schema-validated main→renderer event broadcast; never sends to destroyed contents. */
export function broadcast<N extends EventChannelName>(
  channel: N,
  payload: EventPayload<N>,
): number {
  const def = EVENT_CHANNELS[channel];
  const parsed = def.payload.safeParse(payload);
  if (!parsed.success) {
    console.error(`event payload invalid for ${channel}`);
    return 0;
  }
  let recipients = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(`evt:${channel}`, parsed.data);
      recipients += 1;
    }
  }
  return recipients;
}
