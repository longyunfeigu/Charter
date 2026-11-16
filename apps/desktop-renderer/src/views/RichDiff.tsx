import React, { useEffect, useMemo, useState } from 'react';
import { rpcResult } from '../bridge.js';
import { Markdown } from './Markdown.js';
import {
  collapseUnchanged,
  markdownBlockDiff,
  referenceDefinitions,
  type MdBlockRow,
} from './markdown-block-diff.js';
import '../styles/rich-diff.css';

/**
 * Rich review projections (ADR-0060): changed Markdown is compared as readers
 * see it, changed images as pixels. Both read the same recorded baseline and
 * current file as the text diff — they are views, never a second source.
 */

export type RichDiffKind = 'markdown' | 'image';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
  'svg',
]);

export function richDiffKind(path: string): RichDiffKind | null {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return null;
}

/** Raster images have no text form; SVG keeps its source diff as an option. */
export function richDiffHasSource(path: string): boolean {
  return richDiffKind(path) !== 'image' || path.toLowerCase().endsWith('.svg');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- Markdown ----------

function MarkdownCell(props: {
  block: string | null;
  refs: string;
  side: 'before' | 'after';
  kind: MdBlockRow['kind'];
}): React.JSX.Element {
  if (props.block === null) {
    return <div className={`rd-md-cell empty ${props.side}`} aria-hidden="true" />;
  }
  const text = props.refs ? `${props.block}\n\n${props.refs}` : props.block;
  return (
    <div className={`rd-md-cell ${props.side} ${props.kind}`}>
      <Markdown text={text} className="rd-md-body" />
    </div>
  );
}

/** Side-by-side rendered Markdown, aligned block by block. */
export function MarkdownCompare(props: {
  before: string | null;
  after: string | null;
}): React.JSX.Element {
  const rows = useMemo(
    () => markdownBlockDiff(props.before, props.after),
    [props.before, props.after],
  );
  const display = useMemo(() => collapseUnchanged(rows), [rows]);
  const refsBefore = useMemo(
    () => (props.before === null ? '' : referenceDefinitions(props.before)),
    [props.before],
  );
  const refsAfter = useMemo(
    () => (props.after === null ? '' : referenceDefinitions(props.after)),
    [props.after],
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  useEffect(() => setExpanded(new Set()), [display]);

  const counts = { changed: 0, added: 0, removed: 0 };
  for (const row of rows) if (row.kind !== 'same') counts[row.kind] += 1;
  const changedTotal = counts.changed + counts.added + counts.removed;

  const renderRow = (row: MdBlockRow, key: string): React.JSX.Element => (
    <div key={key} className={`rd-md-row ${row.kind}`} data-testid={`md-row-${row.kind}`}>
      <MarkdownCell block={row.before} refs={refsBefore} side="before" kind={row.kind} />
      <MarkdownCell block={row.after} refs={refsAfter} side="after" kind={row.kind} />
    </div>
  );

  return (
    <div className="rd-md" data-testid="rich-diff-markdown">
      <div className="rd-md-head">
        <span>{props.before === null ? 'Did not exist' : 'Before'}</span>
        <span>{props.after === null ? 'Deleted' : 'After'}</span>
      </div>
      <div className="rd-md-summary" data-testid="rich-diff-markdown-summary">
        {changedTotal === 0
          ? 'No visible change — the source differs only in whitespace or line endings.'
          : [
              counts.changed ? `${counts.changed} changed` : null,
              counts.added ? `${counts.added} added` : null,
              counts.removed ? `${counts.removed} removed` : null,
            ]
              .filter(Boolean)
              .join(' · ') + ` section${changedTotal === 1 ? '' : 's'}`}
      </div>
      <div className="rd-md-rows">
        {display.map((entry, index) => {
          if (entry.kind !== 'gap') return renderRow(entry, `r${index}`);
          if (expanded.has(index)) {
            return (
              <React.Fragment key={`g${index}`}>
                {entry.rows.map((row, offset) => renderRow(row, `g${index}-${offset}`))}
              </React.Fragment>
            );
          }
          return (
            <button
              key={`g${index}`}
              type="button"
              className="rd-md-gap"
              data-testid="rich-diff-markdown-gap"
              onClick={() => setExpanded((prev) => new Set(prev).add(index))}
            >
              Show {entry.rows.length} unchanged sections
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Fetching wrapper for surfaces that only hold the change-set projection. */
export function MarkdownReviewCompare(props: {
  taskId: string;
  path: string;
  refreshKey: string | null;
}): React.JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; before: string | null; after: string | null }
  >({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void rpcResult('task.reviewFile', { taskId: props.taskId, path: props.path }).then((res) => {
      if (!alive) return;
      if (!res.ok) setState({ status: 'error', message: res.error.userMessage });
      else setState({ status: 'ready', before: res.data.baseline, after: res.data.current });
    });
    return () => {
      alive = false;
    };
  }, [props.taskId, props.path, props.refreshKey]);
  if (state.status === 'loading') return <div className="rd-note">Rendering both versions…</div>;
  if (state.status === 'error') return <div className="rd-note">{state.message}</div>;
  return <MarkdownCompare before={state.before} after={state.after} />;
}

// ---------- Images ----------

interface ImageSide {
  dataBase64: string | null;
  sizeBytes: number;
  tooLarge: boolean;
}

function ImageMeta(props: {
  label: string;
  side: ImageSide | null;
  dims: { w: number; h: number } | null;
}): React.JSX.Element {
  return (
    <span className="rd-img-meta">
      <b>{props.label}</b>
      {props.side ? (
        <>
          {props.dims ? (
            <span className="mono">
              {props.dims.w}×{props.dims.h}
            </span>
          ) : null}
          <span className="mono">{formatBytes(props.side.sizeBytes)}</span>
        </>
      ) : (
        <span>{props.label === 'Before' ? 'did not exist' : 'deleted'}</span>
      )}
    </span>
  );
}

function ImagePane(props: {
  src: string | null;
  side: ImageSide | null;
  label: string;
  testid: string;
  onDims: (dims: { w: number; h: number }) => void;
}): React.JSX.Element {
  return (
    <figure className="rd-img-pane" data-testid={props.testid}>
      <figcaption>{props.label}</figcaption>
      <div className="rd-img-canvas">
        {props.src ? (
          <img
            src={props.src}
            alt={props.label}
            draggable={false}
            onLoad={(e) =>
              props.onDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
        ) : (
          <span className="rd-img-missing">
            {props.side?.tooLarge
              ? `Too large to preview (${formatBytes(props.side.sizeBytes)})`
              : props.label === 'Before'
                ? 'Did not exist before this Session'
                : 'Deleted in this Session'}
          </span>
        )}
      </div>
    </figure>
  );
}

/** Before/after image compare: a reveal slider over one stage, or side by side. */
export function ImageCompare(props: {
  taskId: string;
  path: string;
  refreshKey: string | null;
}): React.JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; mime: string; before: ImageSide | null; after: ImageSide | null }
  >({ status: 'loading' });
  const [mode, setMode] = useState<'slider' | 'side'>('slider');
  const [position, setPosition] = useState(50);
  const [beforeDims, setBeforeDims] = useState<{ w: number; h: number } | null>(null);
  const [afterDims, setAfterDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    setBeforeDims(null);
    setAfterDims(null);
    void rpcResult('task.reviewImage', { taskId: props.taskId, path: props.path }).then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setState({ status: 'error', message: res.error.userMessage });
        return;
      }
      setState({
        status: 'ready',
        mime: res.data.mime,
        before: res.data.baseline,
        after: res.data.current,
      });
    });
    return () => {
      alive = false;
    };
  }, [props.taskId, props.path, props.refreshKey]);

  if (state.status === 'loading') return <div className="rd-note">Loading both versions…</div>;
  if (state.status === 'error') return <div className="rd-note">{state.message}</div>;

  const url = (side: ImageSide | null): string | null =>
    side?.dataBase64 ? `data:${state.mime};base64,${side.dataBase64}` : null;
  const beforeSrc = url(state.before);
  const afterSrc = url(state.after);
  const canSlide = beforeSrc !== null && afterSrc !== null;
  const effectiveMode = canSlide ? mode : 'side';

  return (
    <div className="rd-img" data-testid="rich-diff-image">
      <div className="rd-img-bar">
        <ImageMeta label="Before" side={state.before} dims={beforeDims} />
        <ImageMeta label="After" side={state.after} dims={afterDims} />
        <span className="rd-sp" />
        {canSlide ? (
          <div className="rd-seg" role="radiogroup" aria-label="Image compare">
            <button
              type="button"
              role="radio"
              aria-checked={effectiveMode === 'slider'}
              className={effectiveMode === 'slider' ? 'on' : ''}
              data-testid="image-compare-mode-slider"
              onClick={() => setMode('slider')}
            >
              Slider
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={effectiveMode === 'side'}
              className={effectiveMode === 'side' ? 'on' : ''}
              data-testid="image-compare-mode-side"
              onClick={() => setMode('side')}
            >
              Side by side
            </button>
          </div>
        ) : null}
      </div>
      {effectiveMode === 'slider' ? (
        <div className="rd-img-stage" data-testid="image-compare-slider">
          <img
            className="rd-img-layer"
            src={beforeSrc!}
            alt="Before"
            draggable={false}
            onLoad={(e) =>
              setBeforeDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
          <img
            className="rd-img-layer after"
            src={afterSrc!}
            alt="After"
            draggable={false}
            style={{ clipPath: `inset(0 0 0 ${position}%)` }}
            onLoad={(e) =>
              setAfterDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
          <span className="rd-img-handle" style={{ left: `${position}%` }} aria-hidden="true" />
          <span className="rd-img-tag before">Before</span>
          <span className="rd-img-tag after">After</span>
          <input
            className="rd-img-range"
            type="range"
            min={0}
            max={100}
            step={0.5}
            value={position}
            aria-label="Drag to reveal the before and after image"
            data-testid="image-compare-range"
            onChange={(e) => setPosition(Number(e.currentTarget.value))}
          />
        </div>
      ) : (
        <div className="rd-img-side">
          <ImagePane
            src={beforeSrc}
            side={state.before}
            label="Before"
            testid="image-compare-before"
            onDims={setBeforeDims}
          />
          <ImagePane
            src={afterSrc}
            side={state.after}
            label="After"
            testid="image-compare-after"
            onDims={setAfterDims}
          />
        </div>
      )}
    </div>
  );
}
