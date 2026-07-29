import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ArtifactAnchorDto } from '@pi-ide/ipc-contracts';

const PDF_CMAP_ASSETS = import.meta.glob('../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;
const PDF_STANDARD_FONT_ASSETS = import.meta.glob(
  '../../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf,otf}',
  { eager: true, import: 'default', query: '?url' },
) as Record<string, string>;

function indexPdfAssets(sources: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sources).map(([sourcePath, assetUrl]) => [
      sourcePath.slice(sourcePath.lastIndexOf('/') + 1),
      assetUrl,
    ]),
  );
}

const PDF_BINARY_ASSETS = {
  cMapUrl: indexPdfAssets(PDF_CMAP_ASSETS),
  standardFontDataUrl: indexPdfAssets(PDF_STANDARD_FONT_ASSETS),
};

class BundledPdfBinaryDataFactory {
  async fetch(input: {
    kind: 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';
    filename: string;
  }): Promise<Uint8Array> {
    const group =
      input.kind === 'cMapUrl'
        ? PDF_BINARY_ASSETS.cMapUrl
        : input.kind === 'standardFontDataUrl'
          ? PDF_BINARY_ASSETS.standardFontDataUrl
          : null;
    const assetUrl = group?.[input.filename];
    if (!assetUrl) throw new Error(`Bundled PDF resource is unavailable: ${input.filename}`);
    const response = await fetch(assetUrl);
    if (!response.ok) throw new Error(`Bundled PDF resource failed to load: ${input.filename}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

type PdfRegionPicker = (props: {
  region?: { x: number; y: number; width: number; height: number };
  onRegion: (region: { x: number; y: number; width: number; height: number }) => void;
}) => React.JSX.Element;

type PdfViewerProps = {
  anchor: ArtifactAnchorDto;
  onAnchor: (anchor: ArtifactAnchorDto) => void;
} & ({ url: string; data?: never } | { data: Uint8Array; url?: never }) &
  (
    | { allowRegionMarking?: true; renderRegionPicker: PdfRegionPicker }
    | { allowRegionMarking: false; renderRegionPicker?: never }
  );

export function ArtifactPdfViewer(props: PdfViewerProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [marking, setMarking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestedPage = props.anchor.type === 'pdf' ? props.anchor.page : 1;
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, pageCount));
  const region =
    props.anchor.type === 'pdf' && props.anchor.page === page ? props.anchor.region : undefined;
  const allowRegionMarking = props.allowRegionMarking !== false;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = (): void => setStageWidth(stage.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDocument(null);
    setPageCount(0);
    setLoading(true);
    setError(null);
    const load = async (): Promise<void> => {
      try {
        if (!props.data && !props.url) throw new Error('No PDF source was provided.');
        const pdfjs = await import('pdfjs-dist');
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          ...(props.data ? { data: props.data } : { url: props.url }),
          useSystemFonts: true,
          cMapUrl: './pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: './pdfjs/standard-fonts/',
          useWorkerFetch: false,
          BinaryDataFactory: BundledPdfBinaryDataFactory,
        });
        const loaded = await loadingTask.promise;
        if (disposed) return;
        setDocument(loaded);
        setPageCount(loaded.numPages);
        setLoading(false);
      } catch (reason: unknown) {
        if (disposed) return;
        setLoading(false);
        setError(reason instanceof Error ? reason.message : 'The PDF could not be opened.');
      }
    };
    void load();
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [props.data, props.url]);

  useEffect(() => {
    if (!document || requestedPage === page) return;
    props.onAnchor({ type: 'pdf', page });
  }, [document, page, props, requestedPage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas || stageWidth <= 0) return;
    let disposed = false;
    renderTaskRef.current?.cancel();
    setRendering(true);
    setError(null);
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (disposed) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const scale = fitWidth
          ? Math.max(0.25, Math.min(3, (stageWidth - 48) / natural.width))
          : zoom;
        const viewport = pdfPage.getViewport({ scale });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas rendering is unavailable.');
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const task = pdfPage.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTaskRef.current = task;
        await task.promise;
        if (!disposed) setRendering(false);
      })
      .catch((reason: unknown) => {
        if (
          disposed ||
          (reason instanceof Error && reason.name === 'RenderingCancelledException')
        ) {
          return;
        }
        setRendering(false);
        setError(reason instanceof Error ? reason.message : 'The PDF page could not be rendered.');
      });
    return () => {
      disposed = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [document, fitWidth, page, stageWidth, zoom]);

  const setPage = (next: number): void => {
    const bounded = Math.min(Math.max(1, next), Math.max(1, pageCount));
    props.onAnchor({ type: 'pdf', page: bounded });
  };
  const changeZoom = (next: number): void => {
    setFitWidth(false);
    setZoom(Math.min(3, Math.max(0.4, next)));
  };

  return (
    <div className="artifact-pdf" data-testid="artifact-pdf-view">
      <div className="artifact-pdf-tools" aria-label="PDF controls">
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <label>
          Page
          <input
            type="number"
            min={1}
            max={Math.max(1, pageCount)}
            value={page}
            onChange={(event) => setPage(Number(event.target.value) || 1)}
          />
          <span>/ {pageCount || '-'}</span>
        </label>
        <button type="button" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
          Next
        </button>
        <span className="artifact-pdf-tool-spacer" />
        <button type="button" aria-label="Zoom out" onClick={() => changeZoom(zoom - 0.15)}>
          -
        </button>
        <button
          type="button"
          className={fitWidth ? 'active' : ''}
          onClick={() => setFitWidth(true)}
        >
          Fit width
        </button>
        <button type="button" aria-label="Zoom in" onClick={() => changeZoom(zoom + 0.15)}>
          +
        </button>
        {allowRegionMarking ? (
          <button
            type="button"
            className={marking ? 'active' : ''}
            onClick={() => setMarking((value) => !value)}
          >
            {marking ? 'Finish region' : 'Mark region'}
          </button>
        ) : null}
      </div>
      <div ref={stageRef} className="artifact-pdf-stage">
        {loading ? <div className="artifact-pdf-status">Loading PDF...</div> : null}
        {error ? (
          <div className="artifact-pdf-status error" data-testid="artifact-pdf-error">
            {error}
          </div>
        ) : null}
        <div className="artifact-pdf-page" aria-busy={rendering}>
          <canvas ref={canvasRef} />
          {allowRegionMarking && marking && document && props.renderRegionPicker
            ? props.renderRegionPicker({
                region,
                onRegion: (next) => props.onAnchor({ type: 'pdf', page, region: next }),
              })
            : null}
        </div>
      </div>
    </div>
  );
}
