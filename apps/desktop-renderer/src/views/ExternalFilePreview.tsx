import React, { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ArtifactAnchorDto, ChannelResponse } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from '../store/appStore.js';
import { useEditorStore } from '../store/editorStore.js';
import { ArtifactPdfViewer } from './ArtifactPdfViewer.js';
import { Ic } from './home-icons.js';
import '../styles/artifact.css';
import '../styles/external-file-preview.css';

export type ExternalFilePreviewItem = Extract<
  ChannelResponse<'terminal.openPath'>,
  { action: 'preview' }
> & { terminalId: string };

interface ExternalFilePreviewStore {
  item: ExternalFilePreviewItem | null;
  show(item: ExternalFilePreviewItem): void;
  close(): void;
}

export const useExternalFilePreviewStore = create<ExternalFilePreviewStore>((set) => ({
  item: null,
  show: (item) => set({ item }),
  close: () => set({ item: null }),
}));

export function showExternalFilePreview(item: ExternalFilePreviewItem): void {
  useExternalFilePreviewStore.getState().show(item);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function ExternalFilePreview(): React.JSX.Element | null {
  const item = useExternalFilePreviewStore((state) => state.item);
  const close = useExternalFilePreviewStore((state) => state.close);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<'system' | 'reveal' | 'copy' | null>(null);
  const [pdfAnchor, setPdfAnchor] = useState<ArtifactAnchorDto>({ type: 'pdf', page: 1 });
  const pdfBytes = useMemo(
    () => (item?.preview.kind === 'pdf' ? decodeBase64(item.preview.dataBase64) : undefined),
    [item],
  );

  useEffect(() => {
    if (!item) return;
    setBusy(null);
    setPdfAnchor({ type: 'pdf', page: 1 });
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKeyDown);
      if (!useExternalFilePreviewStore.getState().item && returnFocus?.isConnected) {
        returnFocus.focus();
      }
    };
  }, [close, item]);

  if (!item) return null;
  const preview = item.preview;
  const name = fileName(item.path);

  const openWithSystem = async (): Promise<void> => {
    setBusy('system');
    const result = await rpcResult('terminal.externalFileAction', {
      id: item.terminalId,
      path: item.path,
      action: 'system',
    });
    okOrToast(result);
    setBusy(null);
  };

  const reveal = async (): Promise<void> => {
    setBusy('reveal');
    const result = await rpcResult('app.revealPath', { path: item.path });
    if (okOrToast(result) && !result.data.revealed) {
      useAppStore.getState().pushToast('warning', 'That file could not be revealed.');
    }
    setBusy(null);
  };

  const copyToProject = async (): Promise<void> => {
    setBusy('copy');
    const result = await rpcResult('terminal.externalFileAction', {
      id: item.terminalId,
      path: item.path,
      action: 'copy',
    });
    if (!okOrToast(result)) {
      setBusy(null);
      return;
    }
    const workspacePath = result.data.workspacePath;
    close();
    if (!workspacePath) return;
    useAppStore.getState().setProjectTool('editor');
    await useEditorStore.getState().openFile(workspacePath);
  };

  return (
    <div
      className="external-file-backdrop"
      data-testid="external-file-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={dialogRef}
        className="external-file-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`External file preview: ${name}`}
        data-testid="external-file-preview"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          const focusable = [
            ...(dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? []),
          ].filter((element) => element.getClientRects().length > 0);
          const first = focusable[0];
          const last = focusable.at(-1);
          if (!first || !last) return;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="external-file-header">
          <div className="external-file-heading">
            <span className="external-file-glyph" aria-hidden>
              <Ic name={preview.kind === 'image' ? 'image' : 'file'} size={18} />
            </span>
            <div>
              <div className="external-file-eyebrow">
                <span>External file</span>
                <span className="external-file-readonly">Read-only</span>
              </div>
              <h2>{name}</h2>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="external-file-close"
            aria-label="Close external file preview"
            data-testid="external-file-close"
            onClick={close}
          >
            <Ic name="x" size={16} />
          </button>
        </header>

        <div className="external-file-context">
          <code title={item.path}>{item.path}</code>
          <span>{formatBytes(preview.sizeBytes)}</span>
          <span>{preview.mime}</span>
        </div>

        <main className={`external-file-stage ${preview.kind}`}>
          {preview.kind === 'image' ? (
            <div className="external-file-image-wrap">
              <img
                src={`data:${preview.mime};base64,${preview.dataBase64}`}
                alt={`Preview of ${name}`}
                data-testid="external-file-image"
              />
            </div>
          ) : null}
          {preview.kind === 'pdf' && pdfBytes ? (
            <ArtifactPdfViewer
              data={pdfBytes}
              anchor={pdfAnchor}
              onAnchor={setPdfAnchor}
              allowRegionMarking={false}
            />
          ) : null}
          {preview.kind === 'text' ? (
            <pre data-testid="external-file-text">
              <code>{preview.text}</code>
            </pre>
          ) : null}
          {preview.kind === 'binary' ? (
            <div className="external-file-unavailable" data-testid="external-file-unavailable">
              <span className="external-file-unavailable-icon">
                <Ic name="file" size={26} />
              </span>
              <strong>Preview unavailable</strong>
              <p>{preview.reason}</p>
              <small>You can still open it with the system app or copy it into the project.</small>
            </div>
          ) : null}
          {preview.kind === 'text' && preview.truncated ? (
            <div className="external-file-truncated" role="status">
              {preview.reason}
            </div>
          ) : null}
        </main>

        <footer className="external-file-footer">
          <p>This snapshot is not editable, indexed, or added to Agent context.</p>
          <div className="external-file-actions">
            <button
              type="button"
              data-testid="external-file-system"
              disabled={busy !== null}
              onClick={() => void openWithSystem()}
            >
              <Ic name="external" size={14} />
              {busy === 'system' ? 'Opening...' : 'Open with system'}
            </button>
            <button
              type="button"
              data-testid="external-file-reveal"
              disabled={busy !== null}
              onClick={() => void reveal()}
            >
              <Ic name="folder-open" size={14} />
              {busy === 'reveal' ? 'Revealing...' : 'Reveal in Finder'}
            </button>
            <button
              type="button"
              className="primary"
              data-testid="external-file-copy"
              disabled={!item.canCopy || busy !== null}
              onClick={() => void copyToProject()}
            >
              <Ic name="clipboard" size={14} />
              {busy === 'copy'
                ? 'Copying...'
                : item.canCopy
                  ? `Copy to ${item.projectName}`
                  : 'Open a project to copy'}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
