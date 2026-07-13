import React, { useCallback, useEffect, useRef, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';

type Tool = 'arrow' | 'rect' | 'mosaic';

interface Shape {
  tool: Tool;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const STROKE = '#e5484d';

function drawShape(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  shape: Shape,
  scale: number,
): void {
  const { x1, y1, x2, y2 } = shape;
  ctx.save();
  ctx.strokeStyle = STROKE;
  ctx.fillStyle = STROKE;
  ctx.lineWidth = Math.max(2, 3 / scale);
  if (shape.tool === 'rect') {
    ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
  } else if (shape.tool === 'arrow') {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.max(10, 14 / scale);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - head * Math.cos(angle - Math.PI / 6),
      y2 - head * Math.sin(angle - Math.PI / 6),
    );
    ctx.lineTo(
      x2 - head * Math.cos(angle + Math.PI / 6),
      y2 - head * Math.sin(angle + Math.PI / 6),
    );
    ctx.closePath();
    ctx.fill();
  } else {
    // Mosaic: resample the ORIGINAL pixels at low resolution (true redaction —
    // the covered pixels never survive into the exported PNG).
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    if (w < 2 || h < 2) {
      ctx.restore();
      return;
    }
    const block = 14;
    const off = document.createElement('canvas');
    off.width = Math.max(1, Math.round(w / block));
    off.height = Math.max(1, Math.round(h / block));
    const offCtx = off.getContext('2d')!;
    offCtx.drawImage(image, x, y, w, h, 0, 0, off.width, off.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, off.width, off.height, x, y, w, h);
  }
  ctx.restore();
}

function Annotator(props: { path: string; src: string; onClose: () => void }): React.JSX.Element {
  const pushToast = useAppStore((s) => s.pushToast);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<Tool>('arrow');
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [scale, setScale] = useState(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      imageRef.current = image;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      const fit = Math.min(
        1,
        (window.innerWidth * 0.78) / image.naturalWidth,
        (window.innerHeight * 0.66) / image.naturalHeight,
      );
      setScale(fit);
      setReady(true);
    };
    image.src = props.src;
  }, [props.src]);

  // Redraw on every state change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!canvas || !image || !ready) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0);
    for (const shape of shapes) drawShape(ctx, image, shape, scale);
    if (draft) drawShape(ctx, image, draft, scale);
  }, [shapes, draft, ready, scale]);

  const toImageCoords = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const save = async (attach: boolean): Promise<void> => {
    const canvas = canvasRef.current;
    if (!canvas || saving) return;
    setSaving(true);
    const dataUrl = canvas.toDataURL('image/png');
    const res = await rpcResult('image.saveAnnotated', {
      sourcePath: props.path,
      dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
    });
    setSaving(false);
    if (!res.ok) {
      pushToast('error', res.error.userMessage);
      return;
    }
    pushToast('success', `Saved ${res.data.path}`);
    if (attach) {
      useAppStore.getState().addPendingRefs([res.data.path]);
      useAppStore.getState().setSurface('home');
    }
    props.onClose();
  };

  return (
    <div
      data-testid="annotator"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 55,
        background: 'var(--bg-overlay)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '6px 10px',
        }}
      >
        {(['arrow', 'rect', 'mosaic'] as Tool[]).map((t) => (
          <button
            key={t}
            className={`btn ${tool === t ? 'primary' : ''}`}
            data-testid={`annot-tool-${t}`}
            onClick={() => setTool(t)}
          >
            {t === 'arrow' ? '↗ Arrow' : t === 'rect' ? '▢ Box' : '▦ Mosaic'}
          </button>
        ))}
        <span style={{ width: 8 }} />
        <button
          className="btn"
          data-testid="annot-undo"
          disabled={shapes.length === 0}
          onClick={() => setShapes(shapes.slice(0, -1))}
        >
          ↩ Undo
        </button>
        <button
          className="btn primary"
          data-testid="annot-save"
          disabled={saving}
          onClick={() => void save(false)}
        >
          Save copy
        </button>
        <button
          className="btn"
          data-testid="annot-attach"
          disabled={saving}
          title="Save a copy and reference it in a new task"
          onClick={() => void save(true)}
        >
          Save & attach to task
        </button>
        <button className="btn" data-testid="annot-close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <canvas
        ref={canvasRef}
        data-testid="annot-canvas"
        style={{
          width: ready && imageRef.current ? imageRef.current.naturalWidth * scale : 200,
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-editor)',
          cursor: 'crosshair',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        }}
        onMouseDown={(e) => {
          const p = toImageCoords(e);
          setDraft({ tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y });
        }}
        onMouseMove={(e) => {
          if (!draft) return;
          const p = toImageCoords(e);
          setDraft({ ...draft, x2: p.x, y2: p.y });
        }}
        onMouseUp={() => {
          if (!draft) return;
          if (Math.abs(draft.x2 - draft.x1) > 3 || Math.abs(draft.y2 - draft.y1) > 3) {
            setShapes([...shapes, draft]);
          }
          setDraft(null);
        }}
        onMouseLeave={() => setDraft(null)}
      />
      <div className="text-muted" style={{ fontSize: 11.5 }}>
        The original file is never modified — annotations save as a new .annotated.png next to it.
      </div>
    </div>
  );
}

/** Image preview + annotation entry (PIVOT-020) replacing the binary dead end. */
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
            ✏️ Annotate
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
        <Annotator path={props.path} src={src} onClose={() => setAnnotating(false)} />
      ) : null}
    </div>
  );
}
