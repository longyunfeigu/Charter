import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TaskDto,
  TerminalReplayAnalysisDto,
  TerminalReplaySegmentDto,
  TerminalReplaySessionDto,
} from '@pi-ide/ipc-contracts';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { rpcResult } from '../bridge.js';
import { useAppStore } from '../store/appStore.js';
import { useTaskStore } from '../store/taskStore.js';
import { applyTerminalAppearance, terminalAppearance } from './TerminalPanel.js';
import {
  installTerminalUnicode,
  syncTerminalRenderer,
  syncTerminalUnicode,
} from './terminal-renderer.js';
import {
  buildTerminalReplayTimeline,
  formatTerminalReplayDuration,
  formatTerminalReplayTime,
  rebaseTerminalReplayTime,
  type TerminalReplayMarker,
  type TerminalReplayRawEvent,
} from './terminal-replay-model.js';

type TimingPreset = 'smart-30' | 'smart-60' | 'smart-90' | 'smart-120' | 'original';
type ExportFormat = 'mp4' | 'webm';
type ExportStatus = 'choose' | 'recording' | 'saving' | 'canceling' | 'error';

interface ExportState {
  status: ExportStatus;
  format: ExportFormat;
  progress: number;
  error: string | null;
}

const INITIAL_EXPORT_STATE: ExportState = {
  status: 'choose',
  format: 'mp4',
  progress: 0,
  error: null,
};

const PRESET_TARGETS: Record<TimingPreset, number | null> = {
  'smart-30': 30_000,
  'smart-60': 60_000,
  'smart-90': 90_000,
  'smart-120': 120_000,
  original: null,
};

interface ReplayLoadState {
  session: TerminalReplaySessionDto | null;
  events: TerminalReplayRawEvent[];
  loading: boolean;
  error: string | null;
}

interface ReplayAnalysisState {
  analysis: TerminalReplayAnalysisDto | null;
  loading: boolean;
}

function segmentReset(segment: TerminalReplaySegmentDto): TerminalReplayRawEvent {
  return {
    atMs: segment.timelineStartMs,
    code: 'reset',
    data: '',
    cols: segment.cols,
    rows: segment.rows,
  };
}

function useTerminalReplay(task: TaskDto): ReplayLoadState {
  const [state, setState] = useState<ReplayLoadState>({
    session: null,
    events: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let refreshQueued = false;
    const cursors = new Map<string, number>();
    const knownSegments = new Set<string>();
    let collected: TerminalReplayRawEvent[] = [];

    const refresh = async (): Promise<void> => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        const sessionResult = await rpcResult('task.terminalReplaySession', { taskId: task.id });
        if (disposed) return;
        if (!sessionResult.ok) {
          setState((current) => ({
            ...current,
            loading: false,
            error: sessionResult.error.userMessage,
          }));
          return;
        }
        const session = sessionResult.data.session;
        let changed = false;
        for (const segment of session.segments) {
          if (!knownSegments.has(segment.id)) {
            knownSegments.add(segment.id);
            cursors.set(segment.id, 0);
            collected.push(segmentReset(segment));
            changed = true;
          }
          let cursor = cursors.get(segment.id) ?? 0;
          for (;;) {
            const page = await rpcResult('task.terminalReplayEvents', {
              taskId: task.id,
              segmentId: segment.id,
              cursor,
              limit: 500,
            });
            if (disposed) return;
            if (!page.ok) {
              setState((current) => ({
                ...current,
                loading: false,
                error: page.error.userMessage,
              }));
              return;
            }
            if (page.data.events.length > 0) {
              collected.push(...page.data.events);
              changed = true;
            }
            const nextCursor = page.data.cursor;
            cursors.set(segment.id, nextCursor);
            if (page.data.atEnd || nextCursor <= cursor) break;
            cursor = nextCursor;
          }
        }
        if (changed) collected = [...collected];
        setState({
          session,
          events: collected,
          loading: false,
          error: null,
        });
      } finally {
        refreshing = false;
        if (refreshQueued && !disposed) {
          refreshQueued = false;
          void refresh();
        }
      }
    };

    void refresh();
    const interval =
      task.external?.status === 'active' ? setInterval(() => void refresh(), 1_000) : null;
    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
    };
  }, [task.id, task.external?.status]);

  return state;
}

function useTerminalReplayAnalysis(task: TaskDto): ReplayAnalysisState {
  const [state, setState] = useState<ReplayAnalysisState>({ analysis: null, loading: true });

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    let queued = false;
    setState({ analysis: null, loading: true });

    const refresh = async (): Promise<void> => {
      if (refreshing) {
        queued = true;
        return;
      }
      refreshing = true;
      try {
        const result = await rpcResult('task.terminalReplayAnalysis', { taskId: task.id });
        if (disposed) return;
        if (result.ok) setState({ analysis: result.data.analysis, loading: false });
        else setState({ analysis: null, loading: false });
      } finally {
        refreshing = false;
        if (queued && !disposed) {
          queued = false;
          void refresh();
        }
      }
    };

    void refresh();
    const interval =
      task.external?.status === 'active' ? setInterval(() => void refresh(), 2_000) : null;
    return () => {
      disposed = true;
      if (interval) clearInterval(interval);
    };
  }, [task.id, task.external?.status]);

  return state;
}

function PlayIcon({ playing }: { playing: boolean }): React.JSX.Element {
  return playing ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4.8 19 12 7 19.2Z" />
    </svg>
  );
}

function BackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function DownloadIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" />
    </svg>
  );
}

function terminalSourceLabel(segment: TerminalReplaySegmentDto | undefined): string {
  if (!segment) return 'Terminal';
  if (segment.source === 'remote') return segment.hostLabel ?? 'SSH Terminal';
  return segment.title || 'Local Terminal';
}

function cwdName(value: string): string {
  const normalized = value.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || value || 'Terminal';
}

function afterAnimationFrames(count = 1): Promise<void> {
  return new Promise((resolve) => {
    const next = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => next(remaining - 1));
    };
    next(count);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCompressedDuration(milliseconds: number): string {
  if (milliseconds < 10_000) {
    const seconds = Math.max(0.1, Math.round(milliseconds / 100) / 10);
    return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`;
  }
  return formatTerminalReplayDuration(milliseconds);
}

function findWebglCanvas(root: HTMLElement): HTMLCanvasElement | null {
  const canvases = [...root.querySelectorAll<HTMLCanvasElement>('canvas')];
  const webgl = canvases.find((canvas) => {
    try {
      return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch {
      return false;
    }
  });
  return webgl ?? canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
}

function colorLuminance(value: string | undefined): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(value?.trim() ?? '');
  if (!match) return 0.2;
  const color = Number.parseInt(match[1]!, 16);
  return (
    (0.299 * ((color >> 16) & 255) + 0.587 * ((color >> 8) & 255) + 0.114 * (color & 255)) / 255
  );
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function mediaRecorderMime(): string {
  return (
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((candidate) =>
      MediaRecorder.isTypeSupported(candidate),
    ) ?? 'video/webm'
  );
}

export function TerminalReplayPlayer({ task }: { task: TaskDto }): React.JSX.Element {
  const closeReplay = useTaskStore((store) => store.closeReplay);
  const load = useTerminalReplay(task);
  const analysisLoad = useTerminalReplayAnalysis(task);
  const [preset, setPreset] = useState<TimingPreset>('smart-60');
  const [idleCapMs, setIdleCapMs] = useState(1_000);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [expandedSpanIds, setExpandedSpanIds] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [exportState, setExportState] = useState<ExportState>(INITIAL_EXPORT_STATE);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const cursorRef = useRef(0);
  const renderedTimeRef = useRef(0);
  const wallStartRef = useRef(0);
  const initializedTermRef = useRef<Terminal | null>(null);
  const exportAbortRef = useRef(false);
  const pendingMarkerSeekRef = useRef<string | null>(null);

  useEffect(() => setExpandedSpanIds(new Set()), [task.id]);

  const timing = useMemo(
    () => ({
      idleCapMs: preset === 'original' ? null : idleCapMs,
      // A live stream must remain append-stable. The final target-duration
      // transform is applied once the recording stops changing.
      targetMs: load.session?.live ? null : PRESET_TARGETS[preset],
      speed,
      compressionSpans: preset === 'original' ? [] : (analysisLoad.analysis?.spans ?? []),
      expandedSpanIds,
    }),
    [analysisLoad.analysis?.spans, expandedSpanIds, idleCapMs, load.session?.live, preset, speed],
  );
  const timeline = useMemo(
    () => buildTerminalReplayTimeline(load.events, timing),
    [load.events, timing],
  );
  const firstSegment = load.session?.segments[0];
  const firstSegmentId = firstSegment?.id;
  const userTimingKey = `${preset}:${idleCapMs}:${speed}`;
  const firstSegmentRef = useRef(firstSegment);
  const timelineRef = useRef(timeline);
  const liveRef = useRef(Boolean(load.session?.live));
  const previousTimelineRef = useRef<{
    timeline: typeof timeline;
    timingKey: string;
  } | null>(null);
  const previousUserTimingKeyRef = useRef(userTimingKey);
  firstSegmentRef.current = firstSegment;
  timelineRef.current = timeline;
  liveRef.current = Boolean(load.session?.live);

  const rescale = useCallback(() => {
    const stage = stageRef.current;
    const host = terminalHostRef.current;
    const term = termRef.current;
    const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!stage || !host || !screen) return;
    host.style.transform = 'none';
    const naturalWidth = Math.max(1, screen.offsetWidth + 32);
    const naturalHeight = Math.max(1, screen.offsetHeight + 32);
    host.style.width = `${naturalWidth}px`;
    host.style.height = `${naturalHeight}px`;
    const scale = Math.max(
      0.1,
      Math.min((stage.clientWidth - 56) / naturalWidth, (stage.clientHeight - 56) / naturalHeight),
    );
    host.style.transform = `scale(${scale})`;
  }, []);

  useEffect(() => {
    const host = terminalHostRef.current;
    const initialSegment = firstSegmentRef.current;
    if (!host || !initialSegment || termRef.current) return;
    const appearance = terminalAppearance();
    const term = new Terminal({
      cols: initialSegment.cols,
      rows: initialSegment.rows,
      allowProposedApi: true,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      disableStdin: true,
      scrollback: 0,
      convertEol: false,
      theme: appearance.theme,
    });
    installTerminalUnicode(term);
    applyTerminalAppearance({ term }, 'normal');
    term.options.scrollback = 0;
    term.options.disableStdin = true;
    host.replaceChildren();
    term.open(host);
    applyTerminalAppearance({ term }, 'normal');
    term.options.scrollback = 0;
    term.options.disableStdin = true;
    const terminalSettings = useAppStore.getState().settings?.terminal;
    syncTerminalUnicode(term, terminalSettings?.unicodeVersion ?? '11');
    syncTerminalRenderer(term, terminalSettings?.renderer ?? 'auto');
    termRef.current = term;
    const observer = new ResizeObserver(() => rescale());
    if (stageRef.current) observer.observe(stageRef.current);
    requestAnimationFrame(() => requestAnimationFrame(rescale));
    return () => {
      observer.disconnect();
      if (termRef.current === term) termRef.current = null;
      if (initializedTermRef.current === term) initializedTermRef.current = null;
      term.dispose();
    };
  }, [firstSegmentId, rescale]);

  const renderAt = useCallback(
    (requestedMs: number, forceReset = false) => {
      const term = termRef.current;
      if (!term) return;
      const currentTimeline = timelineRef.current;
      const initialSegment = firstSegmentRef.current;
      const timeMs = Math.max(0, Math.min(currentTimeline.durationMs, requestedMs));
      if (forceReset || timeMs < renderedTimeRef.current) {
        term.reset();
        if (initialSegment) term.resize(initialSegment.cols, initialSegment.rows);
        cursorRef.current = 0;
      }
      let output = '';
      let resized = false;
      const flush = () => {
        if (!output) return;
        term.write(output);
        output = '';
      };
      while (
        cursorRef.current < currentTimeline.events.length &&
        currentTimeline.events[cursorRef.current]!.playAtMs <= timeMs
      ) {
        const event = currentTimeline.events[cursorRef.current]!;
        cursorRef.current += 1;
        if (event.code === 'o') {
          output += event.data;
          continue;
        }
        flush();
        if (event.code === 'reset') {
          term.reset();
          term.resize(
            event.cols ?? initialSegment?.cols ?? 80,
            event.rows ?? initialSegment?.rows ?? 24,
          );
          resized = true;
          continue;
        }
        const match = /^(\d+)x(\d+)$/.exec(event.data);
        if (match) {
          const cols = Number(match[1]);
          const rows = Number(match[2]);
          if (cols >= 2 && rows >= 1) {
            term.resize(cols, rows);
            resized = true;
          }
        }
      }
      flush();
      renderedTimeRef.current = timeMs;
      setPlayheadMs(timeMs);
      if (resized) requestAnimationFrame(rescale);
    },
    [rescale],
  );

  useEffect(() => {
    const term = termRef.current;
    if (!term || timelineRef.current.events.length === 0 || initializedTermRef.current === term) {
      return;
    }
    initializedTermRef.current = term;
    setPlaying(false);
    renderAt(0, true);
    const timer = setTimeout(() => {
      wallStartRef.current = performance.now();
      setPlaying(true);
    }, 400);
    return () => clearTimeout(timer);
  }, [firstSegmentId, renderAt, timeline.events.length > 0, userTimingKey]);

  useEffect(() => {
    const changed = previousUserTimingKeyRef.current !== userTimingKey;
    previousUserTimingKeyRef.current = userTimingKey;
    if (!changed || !termRef.current || timelineRef.current.events.length === 0) return;
    setPlaying(false);
    renderAt(0, true);
  }, [renderAt, userTimingKey]);

  useEffect(() => {
    const previous = previousTimelineRef.current;
    previousTimelineRef.current = { timeline, timingKey: userTimingKey };
    if (
      !previous ||
      previous.timeline === timeline ||
      previous.timingKey !== userTimingKey ||
      !termRef.current ||
      initializedTermRef.current !== termRef.current
    ) {
      return;
    }

    const rebasedMs = rebaseTerminalReplayTime(
      previous.timeline,
      timeline,
      cursorRef.current,
      renderedTimeRef.current,
    );
    const previousEvent = previous.timeline.events[Math.max(0, cursorRef.current - 1)];
    const nextEvent = timeline.events[Math.max(0, cursorRef.current - 1)];
    const mappingChanged =
      Boolean(previousEvent) &&
      Boolean(nextEvent) &&
      previousEvent!.playAtMs !== nextEvent!.playAtMs;
    if (mappingChanged) renderAt(rebasedMs, true);
  }, [renderAt, timeline, userTimingKey]);

  useEffect(() => {
    if (!playing) return;
    wallStartRef.current = performance.now() - renderedTimeRef.current;
    let frame = 0;
    const tick = (now: number) => {
      const currentDurationMs = timelineRef.current.durationMs;
      const next = Math.min(currentDurationMs, now - wallStartRef.current);
      renderAt(next);
      if (next >= currentDurationMs && !liveRef.current) {
        setPlaying(false);
        return;
      }
      if (next >= currentDurationMs) {
        // Wait at the live edge without accumulating hidden wall-clock time;
        // newly appended output then plays instead of being skipped.
        wallStartRef.current = now - currentDurationMs;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, renderAt]);

  const togglePlay = useCallback(() => {
    const currentTimeline = timelineRef.current;
    if (currentTimeline.durationMs <= 0 && !liveRef.current) return;
    setPlaying((current) => {
      if (!current && !liveRef.current && renderedTimeRef.current >= currentTimeline.durationMs) {
        renderAt(0, true);
      }
      return !current;
    });
  }, [renderAt]);

  const seek = useCallback(
    (nextMs: number) => {
      setPlaying(false);
      renderAt(nextMs, nextMs < renderedTimeRef.current);
    },
    [renderAt],
  );

  const setMarkerExpanded = useCallback((marker: TerminalReplayMarker, expanded: boolean) => {
    setPlaying(false);
    pendingMarkerSeekRef.current = marker.id;
    setExpandedSpanIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(marker.id);
      else next.delete(marker.id);
      return next;
    });
  }, []);

  useEffect(() => {
    const markerId = pendingMarkerSeekRef.current;
    if (!markerId) return;
    const marker = timeline.markers.find((candidate) => candidate.id === markerId);
    if (!marker) return;
    pendingMarkerSeekRef.current = null;
    setPlaying(false);
    renderAt(marker.playStartMs, true);
    const timer = setTimeout(() => setPlaying(true), 80);
    return () => clearTimeout(timer);
  }, [renderAt, timeline]);

  const exportBusy = ['recording', 'saving', 'canceling'].includes(exportState.status);

  const requestExportClose = useCallback(() => {
    if (exportBusy) {
      exportAbortRef.current = true;
      setExportState((current) => ({ ...current, status: 'canceling' }));
      return;
    }
    setExportOpen(false);
    setExportState(INITIAL_EXPORT_STATE);
  }, [exportBusy]);

  const exportReplay = useCallback(
    async (format: ExportFormat) => {
      const term = termRef.current;
      const element = term?.element;
      if (
        !term ||
        !element ||
        timeline.events.length === 0 ||
        typeof MediaRecorder === 'undefined'
      ) {
        setExportState({
          status: 'error',
          format,
          progress: 0,
          error: 'This terminal cannot be captured in the current renderer.',
        });
        return;
      }

      exportAbortRef.current = false;
      setPlaying(false);
      setExportState({ status: 'recording', format, progress: 0, error: null });

      const terminalSettings = useAppStore.getState().settings?.terminal;
      const previousRenderer = terminalSettings?.renderer ?? 'auto';
      let sourceStream: MediaStream | null = null;
      let composedStream: MediaStream | null = null;
      let sourceVideo: HTMLVideoElement | null = null;
      let recorder: MediaRecorder | null = null;
      let framePump = 0;

      try {
        const renderer = syncTerminalRenderer(term, 'auto');
        term.refresh(0, term.rows - 1);
        await afterAnimationFrames(2);
        if (renderer !== 'webgl') {
          throw new Error('Video export needs WebGL terminal rendering, which is unavailable.');
        }

        const sourceCanvas = findWebglCanvas(element);
        if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
          throw new Error('The terminal video surface is unavailable.');
        }

        sourceStream = sourceCanvas.captureStream(30);
        sourceVideo = document.createElement('video');
        sourceVideo.muted = true;
        sourceVideo.playsInline = true;
        sourceVideo.srcObject = sourceStream;

        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const scale = Math.max(0.6, width / 900);
        const titleHeight = Math.round(40 * scale);
        const padding = Math.round(44 * scale);
        const radius = Math.round(11 * scale);
        const composed = document.createElement('canvas');
        composed.width = width + padding * 2;
        composed.height = height + titleHeight + padding * 2;
        const context = composed.getContext('2d');
        if (!context) throw new Error('The video compositor could not be initialized.');

        const appearance = terminalAppearance();
        const terminalBackground = appearance.theme.background ?? '#0b0c0a';
        const terminalForeground = appearance.theme.foreground ?? '#cccccc';
        const light = colorLuminance(terminalBackground) > 0.5;
        const backdrop = light ? '#d6d0c4' : '#16181c';
        const title = cwdName(firstSegment?.cwd ?? '') || 'Terminal Replay';
        const font =
          getComputedStyle(document.documentElement).getPropertyValue('--font-display').trim() ||
          'sans-serif';

        const drawFrame = () => {
          if (!sourceVideo) return;
          context.fillStyle = backdrop;
          context.fillRect(0, 0, composed.width, composed.height);
          context.save();
          context.shadowColor = 'rgba(0, 0, 0, 0.30)';
          context.shadowBlur = 30 * scale;
          context.shadowOffsetY = 12 * scale;
          context.fillStyle = terminalBackground;
          roundedRect(context, padding, padding, width, titleHeight + height, radius);
          context.fill();
          context.restore();

          context.save();
          roundedRect(context, padding, padding, width, titleHeight + height, radius);
          context.clip();
          context.fillStyle = light ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.06)';
          context.fillRect(padding, padding, width, titleHeight);
          const centerY = padding + titleHeight / 2;
          const dotRadius = Math.round(6 * scale);
          let dotX = padding + Math.round(22 * scale);
          for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
            context.beginPath();
            context.fillStyle = color;
            context.arc(dotX, centerY, dotRadius, 0, Math.PI * 2);
            context.fill();
            dotX += Math.round(20 * scale);
          }
          context.fillStyle = terminalForeground;
          context.globalAlpha = 0.68;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.font = `${Math.round(15 * scale)}px ${font}`;
          context.fillText(title.slice(0, 80), padding + width / 2, centerY + 1);
          context.globalAlpha = 1;
          try {
            context.drawImage(sourceVideo, padding, padding + titleHeight, width, height);
          } catch {
            // The capture video can be one frame behind while WebGL warms up.
          }
          context.restore();
        };

        const pump = () => {
          drawFrame();
          framePump = requestAnimationFrame(pump);
        };

        composedStream = composed.captureStream(30);
        const mime = mediaRecorderMime();
        const chunks: Blob[] = [];
        recorder = new MediaRecorder(composedStream, {
          mimeType: mime,
          videoBitsPerSecond: 10_000_000,
        });
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        const stopped = new Promise<void>((resolve, reject) => {
          if (!recorder) {
            reject(new Error('The video recorder was not initialized.'));
            return;
          }
          recorder.onstop = () => resolve();
          recorder.onerror = () => reject(new Error('The video recorder stopped unexpectedly.'));
        });

        renderAt(0, true);
        try {
          await sourceVideo.play();
        } catch {
          // Muted canvas video normally autoplays; a later frame can still start it.
        }
        await afterAnimationFrames(2);
        pump();
        recorder.start(100);

        const captureDurationMs = Math.max(800, timeline.durationMs);
        const startedAt = performance.now();
        let lastProgressAt = 0;
        await new Promise<void>((resolve) => {
          const tick = (now: number) => {
            if (exportAbortRef.current) {
              resolve();
              return;
            }
            const elapsed = Math.min(captureDurationMs, now - startedAt);
            renderAt(Math.min(timeline.durationMs, elapsed));
            if (now - lastProgressAt >= 100 || elapsed >= captureDurationMs) {
              lastProgressAt = now;
              setExportState({
                status: 'recording',
                format,
                progress: Math.min(100, Math.round((elapsed / captureDurationMs) * 100)),
                error: null,
              });
            }
            if (elapsed >= captureDurationMs) {
              resolve();
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });

        if (exportAbortRef.current) return;
        await delay(500);
        if (recorder.state !== 'inactive') recorder.stop();
        await stopped;
        if (chunks.length === 0) throw new Error('No video frames were captured.');

        setExportState({ status: 'saving', format, progress: 100, error: null });
        const blob = new Blob(chunks, { type: mime });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const result = await rpcResult('task.terminalReplayExport', {
          taskId: task.id,
          title: task.title,
          format,
          bytes,
        });
        if (!result.ok) throw new Error(result.error.userMessage);
        if (!result.data.saved) {
          setExportOpen(false);
          setExportState(INITIAL_EXPORT_STATE);
          return;
        }
        const message = result.data.fallback
          ? `Replay saved as WebM. ${result.data.fallback}`
          : `Replay exported as ${result.data.format?.toUpperCase() ?? format.toUpperCase()}.`;
        useAppStore.getState().pushToast(result.data.fallback ? 'warning' : 'success', message);
        setExportOpen(false);
        setExportState(INITIAL_EXPORT_STATE);
      } catch (error) {
        if (exportAbortRef.current) return;
        setExportState({
          status: 'error',
          format,
          progress: 0,
          error: error instanceof Error ? error.message : 'Replay export failed.',
        });
      } finally {
        if (framePump) cancelAnimationFrame(framePump);
        if (recorder?.state !== 'inactive') {
          try {
            recorder?.stop();
          } catch {
            // The recorder may already be tearing down after an error.
          }
        }
        composedStream?.getTracks().forEach((track) => track.stop());
        sourceStream?.getTracks().forEach((track) => track.stop());
        if (sourceVideo) {
          sourceVideo.pause();
          sourceVideo.srcObject = null;
        }
        syncTerminalRenderer(term, previousRenderer);
        if (exportAbortRef.current) {
          exportAbortRef.current = false;
          setExportOpen(false);
          setExportState(INITIAL_EXPORT_STATE);
        }
      }
    },
    [firstSegment?.cwd, renderAt, task.id, task.title, timeline.durationMs, timeline.events.length],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const editable = ['INPUT', 'SELECT', 'TEXTAREA'].includes(
        document.activeElement?.tagName ?? '',
      );
      if (event.key === 'Escape') {
        event.preventDefault();
        if (exportOpen) requestExportClose();
        else closeReplay();
        return;
      }
      if (editable) return;
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        seek(renderedTimeRef.current - 5_000);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        seek(renderedTimeRef.current + 5_000);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeReplay, exportOpen, requestExportClose, seek, togglePlay]);

  const applyPreset = (next: TimingPreset) => {
    setPlaying(false);
    setPreset(next);
  };

  const applySpeed = (next: number) => {
    setPlaying(false);
    setSpeed(next);
  };

  const progress = timeline.durationMs > 0 ? (playheadMs / timeline.durationMs) * 100 : 0;
  const visibleEvents = load.events.filter((event) => event.code === 'o').length;
  const terminalLabel = terminalSourceLabel(firstSegment);
  const activeMarker = timeline.markers.find(
    (marker) =>
      playheadMs >= marker.playStartMs &&
      playheadMs <= Math.max(marker.playEndMs, marker.playStartMs + 180),
  );
  const smartSpanCount = analysisLoad.analysis?.spans.length ?? 0;
  const smartSavedMs = analysisLoad.analysis?.collapsibleDurationMs ?? 0;

  return (
    <div
      className="trp-root"
      data-testid="replay-view"
      data-analysis-status={
        analysisLoad.analysis?.status ?? (analysisLoad.loading ? 'loading' : 'none')
      }
      data-analysis-spans={smartSpanCount}
      role="dialog"
      aria-label={`Terminal Replay: ${task.title}`}
    >
      <header className="trp-header">
        <button
          type="button"
          className="trp-back"
          onClick={closeReplay}
          aria-label="Back to Session"
          data-testid="replay-close"
        >
          <BackIcon />
          <span>Session</span>
        </button>
        <div className="trp-identity">
          <span className="trp-eyebrow">Terminal Replay</span>
          <strong>{task.title}</strong>
        </div>
        <div className="trp-header-meta">
          {load.session?.live ? (
            <span className="trp-recording">
              <i />
              Recording
            </span>
          ) : load.session?.available ? (
            <span className="trp-recorded">
              <i />
              Recorded
            </span>
          ) : null}
          <span className="trp-duration-meta">
            <small>Original</small>
            <strong>{formatTerminalReplayDuration(load.session?.originalDurationMs ?? 0)}</strong>
          </span>
          <span className="trp-duration-meta">
            <small>Playback</small>
            <strong>{formatTerminalReplayDuration(timeline.durationMs)}</strong>
          </span>
          {analysisLoad.loading ? (
            <span className="trp-analysis-status" data-testid="terminal-replay-analysis-status">
              <i /> Analyzing motion
            </span>
          ) : smartSpanCount > 0 ? (
            <span
              className="trp-analysis-status ready"
              data-testid="terminal-replay-analysis-status"
            >
              <i /> {smartSpanCount} smart {smartSpanCount === 1 ? 'cut' : 'cuts'}
            </span>
          ) : null}
          <button
            type="button"
            className="trp-export"
            data-testid="terminal-replay-export"
            onClick={() => {
              setExportState(INITIAL_EXPORT_STATE);
              setExportOpen(true);
            }}
            disabled={!load.session?.available || timeline.events.length === 0}
          >
            <DownloadIcon />
            Export
          </button>
        </div>
      </header>

      <main className="trp-main">
        {load.loading ? (
          <div className="trp-empty" data-testid="terminal-replay-loading">
            <span className="trp-loader" />
            <strong>Opening the black box…</strong>
            <p>Reading the original terminal event stream.</p>
          </div>
        ) : load.error ? (
          <div className="trp-empty error">
            <strong>Replay could not be opened</strong>
            <p>{load.error}</p>
          </div>
        ) : !load.session?.available ? (
          <div className="trp-empty" data-testid="terminal-replay-empty">
            <span className="trp-empty-glyph">›_</span>
            <strong>No terminal recording</strong>
            <p>{load.session?.reason}</p>
            <small>New Claude, Codex and SSH terminal Sessions are recorded automatically.</small>
          </div>
        ) : (
          <section className="trp-stage-shell" data-testid="terminal-replay-player">
            <div className="trp-window-bar">
              <span className="trp-traffic">
                <i />
                <i />
                <i />
              </span>
              <div className="trp-window-title">
                <strong>{cwdName(firstSegment?.cwd ?? '')}</strong>
                <span>{terminalLabel}</span>
              </div>
              <span className="trp-grid-size">
                {firstSegment?.cols ?? 80} × {firstSegment?.rows ?? 24}
              </span>
            </div>
            <div className="trp-stage" ref={stageRef}>
              <div
                className="trp-terminal-host"
                ref={terminalHostRef}
                aria-label="Recorded terminal output"
              />
              {visibleEvents === 0 ? (
                <span className="trp-awaiting-output">Waiting for visible terminal output…</span>
              ) : null}
              {activeMarker && preset !== 'original' ? (
                <aside
                  className={`trp-smart-chip ${activeMarker.kind}`}
                  data-testid="terminal-replay-smart-chip"
                >
                  <span className="trp-smart-glyph">∿</span>
                  <span className="trp-smart-copy">
                    <strong>{activeMarker.label}</strong>
                    <small>
                      {formatTerminalReplayDuration(activeMarker.originalDurationMs)} →{' '}
                      {activeMarker.expanded
                        ? 'original timing'
                        : formatCompressedDuration(activeMarker.playDurationMs)}
                    </small>
                  </span>
                  <button
                    type="button"
                    data-testid="terminal-replay-play-original"
                    onClick={() => setMarkerExpanded(activeMarker, !activeMarker.expanded)}
                  >
                    {activeMarker.expanded ? 'Compress again' : 'Play original'}
                  </button>
                </aside>
              ) : null}
            </div>
          </section>
        )}
      </main>

      <footer className="trp-transport" data-testid="terminal-replay-controls">
        <div
          className="trp-scrub-wrap"
          style={{ '--trp-progress': `${progress}%` } as React.CSSProperties}
        >
          <div className="trp-smart-markers" aria-label="Smart timing regions">
            {timeline.markers.map((marker) => {
              const left =
                timeline.durationMs > 0 ? (marker.playStartMs / timeline.durationMs) * 100 : 0;
              const width =
                timeline.durationMs > 0 ? (marker.playDurationMs / timeline.durationMs) * 100 : 0;
              return (
                <button
                  key={marker.id}
                  type="button"
                  className={`${marker.kind}${marker.expanded ? ' expanded' : ''}`}
                  style={
                    {
                      '--trp-marker-left': `${left}%`,
                      '--trp-marker-width': `${width}%`,
                    } as React.CSSProperties
                  }
                  data-testid="terminal-replay-marker"
                  data-kind={marker.kind}
                  data-expanded={marker.expanded ? 'true' : 'false'}
                  data-original-duration={marker.originalDurationMs}
                  data-play-duration={marker.playDurationMs}
                  title={`${marker.label} · ${formatTerminalReplayDuration(marker.originalDurationMs)}${marker.expanded ? ' at original timing' : ' compressed'}`}
                  aria-label={`${marker.label}. ${marker.expanded ? 'Replay from start' : 'Play at original timing'}.`}
                  onClick={() =>
                    marker.expanded
                      ? (() => {
                          seek(marker.playStartMs);
                          setPlaying(true);
                        })()
                      : setMarkerExpanded(marker, true)
                  }
                />
              );
            })}
          </div>
          <input
            data-testid="terminal-replay-seek"
            type="range"
            min={0}
            max={Math.max(1, timeline.durationMs)}
            step={10}
            value={Math.min(playheadMs, Math.max(1, timeline.durationMs))}
            onChange={(event) => seek(Number(event.currentTarget.value))}
            disabled={timeline.durationMs <= 0}
            aria-label="Replay position"
          />
        </div>
        <div className="trp-control-row">
          <div className="trp-primary-controls">
            <button
              type="button"
              className="trp-play"
              onClick={togglePlay}
              disabled={timeline.durationMs <= 0}
              aria-label={playing ? 'Pause replay' : 'Play replay'}
              data-testid="terminal-replay-play"
            >
              <PlayIcon playing={playing} />
            </button>
            <span className="trp-time" data-testid="terminal-replay-time">
              <strong>{formatTerminalReplayTime(playheadMs)}</strong>
              <i>/</i>
              <span>{formatTerminalReplayTime(timeline.durationMs)}</span>
            </span>
            <span className="trp-compression-note">
              {preset === 'original'
                ? 'Real wall-clock timing'
                : smartSpanCount > 0
                  ? `Every frame included · ${formatTerminalReplayDuration(smartSavedMs)} of waiting and motion compressed`
                  : 'Every frame included · idle time compressed'}
            </span>
          </div>
          <div className="trp-playback-options">
            <label>
              <span>Playback</span>
              <select
                value={preset}
                onChange={(event) => applyPreset(event.currentTarget.value as TimingPreset)}
                data-testid="terminal-replay-preset"
              >
                <option value="smart-30">Smart · 30s</option>
                <option value="smart-60">Smart · 60s</option>
                <option value="smart-90">Smart · 90s</option>
                <option value="smart-120">Smart · 2min</option>
                <option value="original">Original time</option>
              </select>
            </label>
            {preset !== 'original' ? (
              <label>
                <span>Max idle</span>
                <select
                  value={idleCapMs}
                  onChange={(event) => setIdleCapMs(Number(event.currentTarget.value))}
                >
                  <option value={300}>0.3s</option>
                  <option value={600}>0.6s</option>
                  <option value={1000}>1s</option>
                  <option value={2000}>2s</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>Speed</span>
              <select
                value={speed}
                onChange={(event) => applySpeed(Number(event.currentTarget.value))}
                data-testid="terminal-replay-speed"
              >
                <option value={1}>1×</option>
                <option value={1.5}>1.5×</option>
                <option value={2}>2×</option>
                <option value={3}>3×</option>
                <option value={4}>4×</option>
              </select>
            </label>
          </div>
        </div>
      </footer>

      {exportOpen ? (
        <div
          className="trp-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) requestExportClose();
          }}
        >
          <section
            className="trp-export-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Export Terminal Replay"
          >
            <span className="trp-dialog-icon">
              <DownloadIcon />
            </span>
            <div className="trp-export-copy">
              <span className="trp-eyebrow">Export replay</span>
              <h2>
                {exportState.status === 'choose' || exportState.status === 'error'
                  ? 'Save what you just watched'
                  : exportState.status === 'saving'
                    ? 'Preparing your file…'
                    : exportState.status === 'canceling'
                      ? 'Stopping export…'
                      : 'Recording the playback…'}
              </h2>
              <p>
                {exportState.status === 'recording'
                  ? `The player is running once in real time. About ${formatTerminalReplayDuration(timeline.durationMs)} total.`
                  : exportState.status === 'saving'
                    ? exportState.format === 'webm'
                      ? 'Opening the save dialog…'
                      : 'Converting locally, then opening the save dialog…'
                    : exportState.status === 'canceling'
                      ? 'Keeping the original terminal recording untouched.'
                      : 'Every visible terminal frame is included. Smart timing accelerates waiting and repetitive motion without changing the original recording.'}
              </p>
            </div>
            {exportState.status === 'choose' || exportState.status === 'error' ? (
              <div className="trp-export-formats">
                <button
                  type="button"
                  onClick={() => void exportReplay('mp4')}
                  data-testid="terminal-replay-export-mp4"
                >
                  <strong>MP4</strong>
                  <span>Best for sharing</span>
                  <small>Uses local ffmpeg</small>
                </button>
                <button
                  type="button"
                  onClick={() => void exportReplay('webm')}
                  data-testid="terminal-replay-export-webm"
                >
                  <strong>WebM</strong>
                  <span>Fastest export</span>
                  <small>No conversion</small>
                </button>
              </div>
            ) : (
              <div
                className="trp-export-progress"
                style={
                  { '--trp-export-progress': `${exportState.progress}%` } as React.CSSProperties
                }
              >
                <span>
                  <i />
                </span>
                <strong>
                  {exportState.status === 'saving' ? '100%' : `${exportState.progress}%`}
                </strong>
              </div>
            )}
            {exportState.error ? <p className="trp-export-error">{exportState.error}</p> : null}
            <div className="trp-export-actions">
              <button
                type="button"
                onClick={requestExportClose}
                disabled={exportState.status === 'canceling'}
              >
                {exportBusy ? 'Cancel' : 'Close'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
