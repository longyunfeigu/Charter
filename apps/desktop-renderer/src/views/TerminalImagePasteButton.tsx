import React, { useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';

/** Explicit Herdr-style image bridge entry. Main owns clipboard bytes,
 * private staging/SFTP and terminal writes; the renderer receives only the
 * outcome and never a host filesystem path. */
export function TerminalImagePasteButton({
  terminalId,
  className,
}: {
  terminalId: string;
  className?: string;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const paste = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await rpcResult('terminal.pasteClipboardImage', { id: terminalId });
      if (!result.ok) {
        useAppStore.getState().pushToast('error', result.error.userMessage);
        return;
      }
      useAppStore
        .getState()
        .pushToast(
          'success',
          result.data.remote
            ? 'Image uploaded privately; its SSH path was pasted without sending Enter.'
            : 'Private image path pasted without sending Enter.',
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={className}
      data-testid="session-bar-paste-image"
      disabled={busy}
      title="Stage the clipboard image privately and paste only its path; does not press Enter"
      onClick={() => void paste()}
    >
      {busy ? 'Staging…' : '▧ Paste image'}
    </button>
  );
}
