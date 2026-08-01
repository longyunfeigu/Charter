import React, { useEffect, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { Annotator } from './Annotator.js';
import { Ic } from './home-icons.js';

/** Image preview + annotation entry (PIVOT-020) replacing the binary dead end.
 * The canvas annotator itself is shared (Annotator.tsx, also the screenshot
 * quick card's editor); this view wires it to workspace-bounded persistence
 * via image.saveAnnotated. */
export function ImageView(props: { path: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [annotating, setAnnotating] = useState(false);

  useEffect(() => {
    setSrc(null);
    setError(null);
    setAnnotating(false);
    void rpcResult('fs.readImage', { path: props.path }).then((res) => {
      if (res.ok) {
        setSrc(`data:${res.data.mime};base64,${res.data.dataBase64}`);
        setSize(res.data.sizeBytes);
      } else {
        setError(res.error.userMessage);
      }
    });
  }, [props.path]);

  const saveAnnotated = async (dataBase64: string, attach: boolean): Promise<boolean> => {
    const pushToast = useAppStore.getState().pushToast;
    const res = await rpcResult('image.saveAnnotated', { sourcePath: props.path, dataBase64 });
    if (!res.ok) {
      pushToast('error', res.error.userMessage);
      return false;
    }
    pushToast('success', `Saved ${res.data.path}`);
    if (attach) {
      useAppStore.getState().addPendingRefs([res.data.path]);
      useAppStore.getState().openSessionHome();
    }
    return true;
  };

  return (
    <div
      data-testid="image-view"
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--bg-editor)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 2,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 12px',
          borderBottom: '1px solid var(--border)',
          fontSize: 12,
        }}
      >
        <span style={{ fontWeight: 600 }}>{props.path.split('/').pop()}</span>
        <span className="text-muted">{size > 0 ? `${(size / 1024).toFixed(0)} KB` : ''}</span>
        <span style={{ flex: 1 }} />
        {src ? (
          <button
            className="btn primary"
            data-testid="annotate-open"
            onClick={() => setAnnotating(true)}
          >
            <Ic name="pencil" size={13} /> Annotate
          </button>
        ) : null}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          padding: 16,
        }}
      >
        {error ? (
          <div className="empty-state">{error}</div>
        ) : src ? (
          <img
            src={src}
            alt={props.path}
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 6 }}
          />
        ) : (
          <div className="text-muted">Loading image…</div>
        )}
      </div>
      {annotating && src ? (
        <Annotator
          src={src}
          hint="The original file is never modified — annotations save as a new .annotated.png next to it."
          actions={[
            {
              testId: 'save',
              label: 'Save copy',
              primary: true,
              run: (dataBase64) => saveAnnotated(dataBase64, false),
            },
            {
              testId: 'attach',
              label: 'Save & attach to task',
              run: (dataBase64) => saveAnnotated(dataBase64, true),
            },
          ]}
          onClose={() => setAnnotating(false)}
        />
      ) : null}
    </div>
  );
}
