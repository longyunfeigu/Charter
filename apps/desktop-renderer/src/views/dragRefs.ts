import type React from 'react';

/**
 * Internal drag payload for context feeding (PIVOT-015): a workspace-relative
 * path dragged from a project tree onto a composer. Directories carry a
 * trailing "/" so drop targets can render/label them correctly. A plain-text
 * fallback ("@path") is attached for external drop targets.
 */
export const REF_MIME = 'application/x-charter-ref';

export function setDragRef(e: React.DragEvent, rel: string): void {
  e.dataTransfer.setData(REF_MIME, rel);
  e.dataTransfer.setData('text/plain', `@${rel}`);
  e.dataTransfer.effectAllowed = 'copy';
}

/** Payload data is only readable on drop — returns null for foreign drags. */
export function readDragRef(e: React.DragEvent): string | null {
  const rel = e.dataTransfer.getData(REF_MIME);
  return rel.length > 0 ? rel : null;
}

/** Type list IS readable during dragover — use for highlight gating. */
export function hasDragRef(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(REF_MIME);
}
