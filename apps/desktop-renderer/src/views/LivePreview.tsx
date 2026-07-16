import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PreviewPortDto, PreviewRectDto, TaskDto } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { useTaskStore, RUNNING_TASK_STATES } from '../store/taskStore.js';
import { useAppStore } from '../store/appStore.js';
import { useDraftStore, type PreviewFeedbackRef } from '../store/draftStore.js';
import {
  formatConsoleSteer,
  isWriteToolName,
  mergeEntry,
  shouldAutoForward,
  type AutoForwardState,
  type ConsoleEntry,
} from './preview-console.js';
import { Ic } from './home-icons.js';

/**
 * The task's live window (ADR-0022 am.2): the SAME preview surface serves the
 * Room's persistent right rail and the acceptance gate's Preview tab. The
 * task's own dev server renders in a sandboxed iframe; feedback is "point at
 * the thing, say a word" — element pick (S, injected picker with marquee
 * fallback) or region draw (R). In the rail, the selection lands in the Room
 * composer as an attachment chip (Lovable/Windsurf pattern — one input, one
 * conversation); in the gate, the existing note popover sends directly.
 * Console errors are relayed zero-injection and, per policy, steered back to
 * the agent when they land right after its own write.
 */

const POLL_MS = 4000;

type FeedbackMode = 'interact' | 'pick' | 'draw';

interface Marquee {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizedRect(a: { x: number; y: number }, b: { x: number; y: number }): Marquee {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** Burn the selection rectangle into the captured PNG. Returns raw base64. */
async function compositeSelection(
  pngBase64: string,
  capturedCssSize: { width: number; height: number },
  selection: Marquee,
): Promise<{ dataBase64: string; thumbDataUrl: string }> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('screenshot decode failed'));
    img.src = `data:image/png;base64,${pngBase64}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataBase64: pngBase64, thumbDataUrl: '' };
  ctx.drawImage(img, 0, 0);
  const sx = img.naturalWidth / Math.max(1, capturedCssSize.width);
  const sy = img.naturalHeight / Math.max(1, capturedCssSize.height);
  ctx.save();
  ctx.fillStyle = 'rgba(214, 60, 50, 0.10)';
  ctx.fillRect(selection.x * sx, selection.y * sy, selection.width * sx, selection.height * sy);
  ctx.strokeStyle = '#d63c32';
  ctx.lineWidth = Math.max(2, 2 * sx);
  ctx.setLineDash([8 * sx, 5 * sx]);
  ctx.strokeRect(selection.x * sx, selection.y * sy, selection.width * sx, selection.height * sy);
  ctx.restore();
  const dataUrl = canvas.toDataURL('image/png');
  // Small chip thumbnail from the same canvas.
  const thumb = document.createElement('canvas');
  const scale = 140 / canvas.width;
  thumb.width = 140;
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return {
    dataBase64: dataUrl.slice('data:image/png;base64,'.length),
    thumbDataUrl: thumb.toDataURL('image/png'),
  };
}

/** The structured message the agent receives with a preview attachment. */
export function buildPreviewFeedbackText(
  ref: Pick<PreviewFeedbackRef, 'pageUrl' | 'rect' | 'selector'>,
  note: string,
): string {
  return [
    `Preview feedback on ${ref.pageUrl} (live preview of this task's own tree):`,
    ref.selector
      ? `- Element: \`${ref.selector}\` at x=${ref.rect.x}, y=${ref.rect.y}, width=${ref.rect.width}, height=${ref.rect.height} (CSS px, page viewport)`
      : `- Selected region: x=${ref.rect.x}, y=${ref.rect.y}, width=${ref.rect.width}, height=${ref.rect.height} (CSS px, page viewport)`,
    ...(note.trim() ? [`- Note: ${note.trim()}`] : []),
    'The attached screenshot shows the rendered page with the selection outlined in red.',
  ].join('\n');
}

export function LivePreview({
  task,
  variant,
}: {
  task: TaskDto;
  variant: 'gate' | 'rail';
}): React.JSX.Element {
  const store = useTaskStore();
  const app = useAppStore();
  const settings = useAppStore((s) => s.settings);
  const frameBoxRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [ports, setPorts] = useState<PreviewPortDto[] | null>(null);
  const [root, setRoot] = useState('');
  const [selectedPort, setSelectedPort] = useState<number | null>(null);
  const [path, setPath] = useState('/');
  const [frameSeq, setFrameSeq] = useState(0);
  const [mode, setMode] = useState<FeedbackMode>('interact');
  const [drag, setDrag] = useState<{ start: { x: number; y: number }; rect: Marquee } | null>(null);
  // Gate-only note popover (the rail sends through the Room composer instead).
  const [note, setNote] = useState<{ rect: Marquee; selector: string | null; text: string } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [devCommand, setDevCommand] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  // am.2: the background terminal we started the dev server in (if any), so
  // "Dev log" can reveal exactly it on demand.
  const [devTerminalId, setDevTerminalId] = useState<string | null>(null);
  const portCountRef = useRef(0);
  // Console (am.2)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [hadErrors, setHadErrors] = useState(false);
  const autoRef = useRef<AutoForwardState>({
    lastWriteAt: null,
    sentForWriteAt: null,
    sentThisRun: 0,
  });
  const pendingAutoRef = useRef<ConsoleEntry[]>([]);
  const autoTimerRef = useRef<number | null>(null);

  const running = RUNNING_TASK_STATES.has(task.state);
  const consoleSetting = settings?.preview.consoleToAgent ?? 'auto';

  const refresh = useCallback(async () => {
    const res = await rpcResult('task.previewPorts', { taskId: task.id });
    if (!res.ok) return;
    setRoot(res.data.root);
    setPorts(res.data.ports);
    portCountRef.current = res.data.ports.length;
    setDevCommand(res.data.devCommand);
    setSelectedPort((current) => {
      if (current !== null && res.data.ports.some((p) => p.port === current)) return current;
      return res.data.ports[0]?.port ?? null;
    });
  }, [task.id]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const active = ports?.find((p) => p.port === selectedPort) ?? null;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const frameUrl = active ? `http://localhost:${active.port}${cleanPath}` : null;

  // A genuine navigation (URL change) resets the page's console + load state.
  // Not tied to the iframe onLoad — that fires for the FIRST load too and would
  // drop errors emitted during it (the very ones worth keeping).
  const prevUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevUrlRef.current !== null && prevUrlRef.current !== frameUrl) {
      setConsoleEntries([]);
      setFrameLoaded(false);
    }
    prevUrlRef.current = frameUrl;
  }, [frameUrl]);

  // ── am.1/am.2: one-click dev start, in a BACKGROUND task terminal ─────────
  // The industry (Replit Console, Bolt, v0) never yanks you elsewhere to start
  // a server: it's a managed background process with logs a click away. We
  // keep TERM-005 (the server runs in a real, stoppable terminal) but create
  // it with reveal:false so the surface never flips — you stay in the Room and
  // the preview appears in place. The log is reachable via "Dev log", an
  // explicit action.
  const startDevServer = async (): Promise<void> => {
    if (!devCommand || starting) return;
    setStarting(true);
    const { useTerminalStore } = await import('./TerminalPanel.js');
    const id = await useTerminalStore.getState().create({ taskId: task.id, reveal: false });
    if (!id) {
      setStarting(false);
      return;
    }
    setDevTerminalId(id);
    window.setTimeout(() => {
      void rpcResult('terminal.write', { id, data: `${devCommand}\n` });
    }, 700);
    app.pushToast(
      'info',
      `Running \`${devCommand}\` in a background terminal — the preview appears here when the port is up.`,
    );
    window.setTimeout(() => {
      setStarting(false);
      if (portCountRef.current === 0) {
        app.pushToast('info', 'No port yet — open “Dev log” to see the dev command output.');
      }
    }, 20000);
  };

  // Explicit "show me the log": only NOW do we reveal the Editor terminal —
  // never as a side effect of starting the server.
  const openDevLog = async (): Promise<void> => {
    if (!devTerminalId) return;
    const { useTerminalStore } = await import('./TerminalPanel.js');
    useTerminalStore.getState().setActive(devTerminalId);
    app.showBottomTab('terminal');
  };

  // ── feedback: shared capture → (rail) composer chip | (gate) note popover ─
  const captureSelection = useCallback(
    async (rect: Marquee, selector: string | null): Promise<PreviewFeedbackRef | null> => {
      if (!frameUrl || !frameBoxRef.current) return null;
      const box = frameBoxRef.current.getBoundingClientRect();
      const captured = await rpcResult('task.capturePreview', {
        taskId: task.id,
        rect: {
          x: Math.max(0, Math.round(box.left)),
          y: Math.max(0, Math.round(box.top)),
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height)),
        },
      });
      if (!captured.ok) {
        app.pushToast('info', 'Screenshot capture failed — feedback will carry text only.');
        return {
          id: `pv_${Date.now().toString(36)}`,
          dataBase64: null,
          thumbDataUrl: '',
          pageUrl: frameUrl,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(1, Math.round(rect.width)),
            height: Math.max(1, Math.round(rect.height)),
          },
          selector,
        };
      }
      const composed = await compositeSelection(
        captured.data.dataBase64,
        { width: box.width, height: box.height },
        rect,
      );
      return {
        id: `pv_${Date.now().toString(36)}`,
        dataBase64: composed.dataBase64,
        thumbDataUrl: composed.thumbDataUrl,
        pageUrl: frameUrl,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        },
        selector,
      };
    },
    [app, frameUrl, task.id],
  );

  const toComposer = useCallback(
    async (rect: Marquee, selector: string | null): Promise<void> => {
      const ref = await captureSelection(rect, selector);
      if (!ref) return;
      useDraftStore.getState().setPreviewRef(task.id, ref);
      app.focusComposer();
      app.pushToast(
        'success',
        selector
          ? `Attached \`${selector}\` — describe the change and send.`
          : 'Selection attached — describe the change and send.',
      );
    },
    [app, captureSelection, task.id],
  );

  const sendFromGate = async (): Promise<void> => {
    if (!note || sending) return;
    setSending(true);
    try {
      const ref = await captureSelection(note.rect, note.selector);
      if (!ref) return;
      const text = buildPreviewFeedbackText(ref, note.text);
      let delivered: boolean;
      if (ref.dataBase64) {
        delivered = await store.sendPreviewFeedback(text, {
          dataBase64: ref.dataBase64,
          mimeType: 'image/png',
          pageUrl: ref.pageUrl,
          rect: ref.rect,
          ...(ref.selector ? { selector: ref.selector } : {}),
          ...(note.text.trim() ? { note: note.text.trim() } : {}),
        });
      } else {
        await store.send(`${text}\n(Screenshot capture failed — none attached.)`, 'steer');
        delivered = true;
      }
      if (delivered) {
        setNote(null);
        setMode('interact');
        store.closeReview();
        app.openTaskRoom(task.id);
        app.pushToast('success', 'Feedback sent — the agent continues with your selection.');
      }
    } finally {
      setSending(false);
    }
  };

  // ── element pick (S): injected picker with marquee fallback ──────────────
  const armPick = useCallback(async (): Promise<void> => {
    if (!active) return;
    const res = await rpcResult('task.previewPick', {
      taskId: task.id,
      port: active.port,
      action: 'start',
    });
    if (!res.ok || !res.data.injected) {
      app.pushToast('info', 'Element pick is unavailable on this page — draw a region instead.');
      setMode('draw');
      return;
    }
    setMode('pick');
  }, [active, app, task.id]);

  const disarmPick = useCallback((): void => {
    if (active) {
      void rpcResult('task.previewPick', { taskId: task.id, port: active.port, action: 'cancel' });
    }
  }, [active, task.id]);

  useEffect(() => {
    if (mode !== 'pick' || !active) return;
    const origins = new Set([`http://localhost:${active.port}`, `http://127.0.0.1:${active.port}`]);
    const onMessage = (event: MessageEvent): void => {
      if (!origins.has(event.origin)) return;
      const data = event.data as
        | { __charterPick?: { selector?: unknown; rect?: Marquee; text?: unknown } }
        | { __charterPickCancel?: boolean }
        | null;
      if (data && '__charterPickCancel' in data && data.__charterPickCancel) {
        setMode('interact');
        return;
      }
      const pick = data && '__charterPick' in data ? data.__charterPick : null;
      if (!pick || !pick.rect) return;
      const selector = typeof pick.selector === 'string' ? pick.selector.slice(0, 500) : null;
      const rect = pick.rect;
      setMode('interact');
      if (variant === 'rail') {
        void toComposer(rect, selector);
      } else {
        setNote({ rect, selector, text: '' });
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [mode, active, variant, toComposer]);

  // Leaving pick mode (any path) cleans the injected picker up.
  const prevModeRef = useRef<FeedbackMode>('interact');
  useEffect(() => {
    if (prevModeRef.current === 'pick' && mode !== 'pick') disarmPick();
    prevModeRef.current = mode;
    return () => {
      if (prevModeRef.current === 'pick') disarmPick();
    };
  }, [mode, disarmPick]);

  // ── keyboard: S / R / Esc (ignored while typing) ─────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing =
        t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (mode !== 'interact' || drag || note) {
          e.stopPropagation();
          setDrag(null);
          setNote(null);
          setMode('interact');
        }
        return;
      }
      if (typing || !active) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        void armPick();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setMode('draw');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mode, drag, note, active, armPick]);

  useEffect(() => {
    if (note) noteRef.current?.focus();
  }, [note]);

  // ── console relay + self-heal policy (am.2) ──────────────────────────────
  const lastWriteAt = useMemo(() => {
    let latest: number | null = null;
    for (const event of store.timeline) {
      if (event.type !== 'tool.call') continue;
      const payload = event.payload as { name?: unknown } | null;
      if (!payload || !isWriteToolName(payload.name)) continue;
      const at = Date.parse(event.at);
      if (Number.isFinite(at)) latest = latest === null ? at : Math.max(latest, at);
    }
    return latest;
  }, [store.timeline]);
  useEffect(() => {
    autoRef.current.lastWriteAt = lastWriteAt;
  }, [lastWriteAt]);
  useEffect(() => {
    if (running) autoRef.current.sentThisRun = 0;
  }, [running]);

  useEffect(() => {
    const off = onEvent('preview.console', (payload) => {
      if (!ports?.some((p) => p.port === payload.port)) return;
      const now = Date.now();
      setConsoleEntries((list) => {
        const merged = mergeEntry(
          list,
          {
            level: payload.level,
            message: payload.message,
            sourceId: payload.sourceId,
            line: payload.line,
          },
          now,
        );
        if (payload.level === 'error') {
          setHadErrors(true);
          // Auto-forward is the RAIL's job (the gate may be mounted above the
          // same room — one policy owner prevents double sends).
          if (variant === 'rail' && merged.isNew) {
            pendingAutoRef.current.push({ ...merged.list[merged.list.length - 1]! });
            if (autoTimerRef.current === null) {
              autoTimerRef.current = window.setTimeout(() => {
                autoTimerRef.current = null;
                const batch = pendingAutoRef.current;
                pendingAutoRef.current = [];
                if (
                  batch.length > 0 &&
                  frameUrl &&
                  shouldAutoForward({
                    setting: consoleSetting,
                    taskRunning: RUNNING_TASK_STATES.has(
                      useTaskStore.getState().tasks.find((t) => t.id === task.id)?.state ?? '',
                    ),
                    state: autoRef.current,
                    now: Date.now(),
                  })
                ) {
                  autoRef.current.sentForWriteAt = autoRef.current.lastWriteAt;
                  autoRef.current.sentThisRun += 1;
                  void store.send(formatConsoleSteer(batch, frameUrl), 'steer');
                  app.pushToast('info', 'Preview console errors were sent back to the agent.');
                }
              }, 800);
            }
          }
        }
        return merged.list;
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, variant, consoleSetting, frameUrl, task.id]);

  const errorCount = consoleEntries.filter((e) => e.level === 'error').length;
  const manualSendConsole = async (): Promise<void> => {
    const errors = consoleEntries.filter((e) => e.level === 'error');
    if (errors.length === 0 || !frameUrl) return;
    await store.send(formatConsoleSteer(errors, frameUrl), 'steer');
    setConsoleOpen(false);
    app.pushToast('success', 'Console errors sent to the agent.');
  };

  const overlayPoint = (e: React.PointerEvent): { x: number; y: number } => {
    const box = frameBoxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - box.left), box.width),
      y: Math.min(Math.max(0, e.clientY - box.top), box.height),
    };
  };

  // ── render ────────────────────────────────────────────────────────────────
  if (ports === null) {
    return (
      <div className="pv-pane" data-testid="preview-pane">
        <div className="pv-note">Scanning this task’s tree for dev servers…</div>
      </div>
    );
  }

  if (!active) {
    return (
      <div className="pv-pane" data-testid="preview-pane">
        <div className="pv-empty empty-state" data-testid="preview-empty">
          <div className="es-title">No dev server running in this task’s tree</div>
          <div className="pv-empty-body">
            The gate watches for processes listening on localhost from inside
            <span className="mono pv-root"> {root || task.worktree?.path || task.projectPath}</span>
            . It never owns the process — the server runs in a background terminal you can inspect
            and stop; you stay right here.
          </div>
          <div className="pv-empty-row">
            {devCommand ? (
              <button
                className="btn primary"
                data-testid="preview-start-dev"
                disabled={starting}
                onClick={() => void startDevServer()}
              >
                <Ic name="play" size={12} />{' '}
                {starting ? 'Starting — watching for the port…' : `Run ${devCommand} here`}
              </button>
            ) : null}
            {devTerminalId ? (
              <button
                className="btn"
                data-testid="preview-dev-log"
                title="Show the dev server's terminal output (opens the terminal panel)"
                onClick={() => void openDevLog()}
              >
                <Ic name="terminal" size={12} /> Dev log
              </button>
            ) : null}
            <button className="btn" data-testid="preview-refresh" onClick={() => void refresh()}>
              <Ic name="refresh" size={12} /> Refresh
            </button>
          </div>
          {!devCommand ? (
            <div className="pv-empty-body">
              No dev/serve/preview/start script in this tree’s package.json — start your server by
              hand in a task terminal and it will appear here.
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="pv-pane" data-testid="preview-pane">
      <div className="pv-toolbar">
        {ports.map((p) => (
          <button
            key={p.port}
            className={`pv-port ${p.port === selectedPort ? 'active' : ''}`}
            data-testid={`preview-port-${p.port}`}
            title={`${p.command} (pid ${p.pid})`}
            onClick={() => setSelectedPort(p.port)}
          >
            :{p.port} <span className="pv-port-cmd">{p.command}</span>
          </button>
        ))}
        <input
          className="pv-path mono"
          data-testid="preview-path"
          value={path}
          placeholder="/"
          spellCheck={false}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setFrameSeq((s) => s + 1);
          }}
        />
        <button
          className="btn"
          data-testid="preview-reload"
          title="Reload the preview"
          onClick={() => setFrameSeq((s) => s + 1)}
        >
          <Ic name="refresh" size={12} />
        </button>
        <button
          className="btn"
          data-testid="preview-open-external"
          title="Open in your browser (same port — real DevTools live there)"
          onClick={() =>
            void rpcResult('task.previewOpenExternal', {
              taskId: task.id,
              port: active.port,
              path: cleanPath,
            }).then((res) => {
              if (!res.ok) app.pushToast('error', res.error.userMessage);
            })
          }
        >
          <Ic name="external" size={12} />
        </button>
        {devTerminalId ? (
          <button
            className="btn"
            data-testid="preview-dev-log"
            title="Show the dev server's terminal output (opens the terminal panel)"
            onClick={() => void openDevLog()}
          >
            <Ic name="terminal" size={12} /> Dev log
          </button>
        ) : null}
        {errorCount > 0 || hadErrors ? (
          <button
            className={`pv-errchip ${errorCount > 0 ? 'bad' : 'ok'}`}
            data-testid="preview-console-chip"
            title={errorCount > 0 ? 'Console errors from the preview page' : 'Console is clean'}
            onClick={() => setConsoleOpen((o) => !o)}
          >
            {errorCount > 0 ? `⚠ ${errorCount}` : '✓ 0'}
          </button>
        ) : null}
        <span className="pv-sp" />
        <span className="pv-modes" role="radiogroup" aria-label="Preview mode">
          <button
            className={`pv-mode ${mode === 'interact' ? 'on' : ''}`}
            data-testid="preview-mode-interact"
            title="Use the page normally"
            onClick={() => setMode('interact')}
          >
            Interact
          </button>
          <button
            className={`pv-mode ${mode === 'pick' ? 'on' : ''}`}
            data-testid="preview-mode-pick"
            title="Point at an element — it attaches to your reply (S)"
            onClick={() => void armPick()}
          >
            Pick <kbd>S</kbd>
          </button>
          <button
            className={`pv-mode ${mode === 'draw' ? 'on' : ''}`}
            data-testid="preview-mode-draw"
            title="Drag a region — it attaches to your reply (R)"
            onClick={() => setMode('draw')}
          >
            Draw <kbd>R</kbd>
          </button>
        </span>
      </div>

      {consoleOpen ? (
        <div className="pv-console" data-testid="preview-console">
          {consoleEntries.length === 0 ? (
            <div className="pv-console-empty">No console messages from this page yet.</div>
          ) : (
            consoleEntries
              .slice(-8)
              .reverse()
              .map((entry) => (
                <div key={entryLineKey(entry)} className={`pv-console-row ${entry.level}`}>
                  <span className="pv-console-level">{entry.level}</span>
                  <span className="pv-console-msg mono">
                    {entry.message.slice(0, 200)}
                    {entry.count > 1 ? ` ×${entry.count}` : ''}
                  </span>
                </div>
              ))
          )}
          <div className="pv-console-foot">
            <button className="btn" onClick={() => setConsoleEntries([])}>
              Clear
            </button>
            <button
              className="btn primary"
              data-testid="preview-console-send"
              disabled={errorCount === 0}
              onClick={() => void manualSendConsole()}
            >
              Send errors to agent
            </button>
          </div>
        </div>
      ) : null}

      <div className="pv-framebox" ref={frameBoxRef}>
        <iframe
          key={`${frameUrl}#${frameSeq}`}
          className="pv-frame"
          data-testid="preview-frame"
          src={frameUrl ?? undefined}
          sandbox="allow-scripts allow-same-origin allow-forms"
          title="Task preview"
          onLoad={() => setFrameLoaded(true)}
        />
        <span className="pv-badge" data-testid="preview-badge">
          {task.worktree ? 'task worktree · isolated' : 'task tree'}
        </span>
        {mode === 'pick' ? (
          <div className="pv-pickhint" data-testid="preview-pick-hint">
            Point at the element — click to attach, Esc cancels
          </div>
        ) : null}
        {mode === 'draw' ? (
          <div
            className="pv-overlay"
            data-testid="preview-overlay"
            onPointerDown={(e) => {
              if (note) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const start = overlayPoint(e);
              setDrag({ start, rect: { ...start, width: 0, height: 0 } });
            }}
            onPointerMove={(e) => {
              if (!drag || note) return;
              setDrag({ start: drag.start, rect: normalizedRect(drag.start, overlayPoint(e)) });
            }}
            onPointerUp={() => {
              if (!drag || note) return;
              const rect = drag.rect;
              setDrag(null);
              if (rect.width < 8 || rect.height < 8) return;
              if (variant === 'rail') {
                setMode('interact');
                void toComposer(rect, null);
              } else {
                setNote({ rect, selector: null, text: '' });
              }
            }}
          >
            {!drag && !note ? (
              <div className="pv-overlay-hint">Drag to select the problem area — Esc cancels</div>
            ) : null}
            {drag ? (
              <div
                className="pv-marquee"
                style={{
                  left: drag.rect.x,
                  top: drag.rect.y,
                  width: drag.rect.width,
                  height: drag.rect.height,
                }}
              />
            ) : null}
            {note && variant === 'gate' ? (
              <GateNoteCard
                note={note}
                noteRef={noteRef}
                sending={sending}
                frameBox={frameBoxRef.current}
                onChange={(text) => setNote({ ...note, text })}
                onCancel={() => {
                  setNote(null);
                  setMode('interact');
                }}
                onSend={() => void sendFromGate()}
              />
            ) : null}
          </div>
        ) : null}
        {note && variant === 'gate' && mode !== 'draw' ? (
          <div className="pv-overlay" data-testid="preview-overlay">
            <div
              className="pv-marquee"
              style={{
                left: note.rect.x,
                top: note.rect.y,
                width: note.rect.width,
                height: note.rect.height,
              }}
            />
            <GateNoteCard
              note={note}
              noteRef={noteRef}
              sending={sending}
              frameBox={frameBoxRef.current}
              onChange={(text) => setNote({ ...note, text })}
              onCancel={() => setNote(null)}
              onSend={() => void sendFromGate()}
            />
          </div>
        ) : null}
      </div>
      <div className="pv-foot">
        Serving from this task’s {task.worktree ? 'worktree' : 'project tree'}
        <span className="mono pv-root"> {root}</span> — the gate never owns servers; feedback lands
        in {variant === 'rail' ? 'your reply below' : 'the note card'}.
      </div>
    </div>
  );
}

function entryLineKey(e: ConsoleEntry): string {
  return `${e.message}|${e.sourceId}|${e.line ?? ''}`;
}

function GateNoteCard({
  note,
  noteRef,
  sending,
  frameBox,
  onChange,
  onCancel,
  onSend,
}: {
  note: { rect: Marquee; selector: string | null; text: string };
  noteRef: React.RefObject<HTMLTextAreaElement | null>;
  sending: boolean;
  frameBox: HTMLDivElement | null;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSend: () => void;
}): React.JSX.Element {
  return (
    <div
      className="pv-notecard"
      style={{
        left: Math.min(note.rect.x + note.rect.width + 10, (frameBox?.clientWidth ?? 600) - 270),
        top: Math.min(note.rect.y, Math.max(8, (frameBox?.clientHeight ?? 400) - 150)),
      }}
    >
      {note.selector ? <div className="pv-notecard-sel mono">{note.selector}</div> : null}
      <textarea
        ref={noteRef}
        data-testid="preview-note-input"
        rows={3}
        placeholder="What's wrong here? (sent with the screenshot + selection)"
        value={note.text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <div className="pv-notecard-row">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn primary"
          data-testid="preview-note-send"
          disabled={sending}
          onClick={onSend}
        >
          {sending ? 'Sending…' : 'Send to agent'}
        </button>
      </div>
    </div>
  );
}
