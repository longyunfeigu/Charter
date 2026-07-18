import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/appStore.js';

const MIN_MAIN = 380;
const MIN_TOOLS = 360;
const DEFAULT_PCT = 56;
const EXPANDED_PCT = 38;

/**
 * The conversation/tool boundary as a real grip (design mock A,
 * docs/design/session-split-mockups/a-free-drag.html): drag to any ratio,
 * double-click to reset 56/44, ←/→ nudge 2%, ratio remembered per Session.
 * Per-frame drag updates write the `--session-split` var straight into the
 * container so they never fight React renders of the busy room around it;
 * the committed value lives in the app store (and localStorage).
 */
export function SessionSplitHandle({
  taskId,
  containerRef,
}: {
  taskId: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const manual = useAppStore((s) => s.sessionSplit[taskId]);
  const expanded = useAppStore((s) => s.sessionToolExpanded);
  const dragging = useAppStore((s) => s.sessionSplitDragging);
  const livePct = useRef<number | null>(null);
  const moved = useRef(false);
  const [chip, setChip] = useState<{ main: number; px: number } | null>(null);
  const [atLimit, setAtLimit] = useState(false);
  const chipTimer = useRef(0);
  const limitTimer = useRef(0);

  const effective = manual ?? (expanded ? EXPANDED_PCT : DEFAULT_PCT);

  // The resting `--session-split` value is synced by TaskRoomView, which owns
  // the container ref (a child layout effect would run before that ref is
  // attached on mount). This handle only writes the live value mid-drag.

  useEffect(
    () => () => {
      window.clearTimeout(chipTimer.current);
      window.clearTimeout(limitTimer.current);
    },
    [],
  );

  const clampPct = useCallback(
    (raw: number): number => {
      const width = containerRef.current?.clientWidth ?? 0;
      if (width <= MIN_MAIN + MIN_TOOLS) return raw;
      const min = (MIN_MAIN / width) * 100;
      const max = 100 - (MIN_TOOLS / width) * 100;
      const pct = Math.min(Math.max(raw, min), max);
      if (pct !== raw) {
        setAtLimit(true);
        window.clearTimeout(limitTimer.current);
        limitTimer.current = window.setTimeout(() => setAtLimit(false), 360);
      }
      return pct;
    },
    [containerRef],
  );

  const showChip = useCallback(
    (pct: number, transient: boolean): void => {
      const width = containerRef.current?.clientWidth ?? 0;
      setChip({ main: pct, px: Math.round((width * pct) / 100) });
      window.clearTimeout(chipTimer.current);
      if (transient) chipTimer.current = window.setTimeout(() => setChip(null), 900);
    },
    [containerRef],
  );

  const app = useAppStore.getState;

  // One idempotent end for every way a drag can stop: pointerup, pointercancel
  // and silent capture loss (lostpointercapture fires WITHOUT a pointerup when
  // e.g. a screenshot or window change steals the capture — without this the
  // handle would stay stuck in its dragging state). A plain click (no
  // movement) must not convert the stop model into a manual ratio — only a
  // real drag claims the width.
  const endDrag = (): void => {
    const pct = livePct.current;
    if (pct === null) return;
    livePct.current = null;
    setChip(null);
    app().setSessionSplitDragging(false);
    if (moved.current) app().setSessionSplit(taskId, pct);
  };

  return (
    <div
      className={`session-split-handle ${dragging ? 'dragging' : ''} ${atLimit ? 'at-limit' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="调整对话与工具面板宽度"
      aria-valuenow={Math.round(effective)}
      aria-valuemin={20}
      aria-valuemax={80}
      tabIndex={0}
      title="拖动调整 · 双击复位"
      data-testid="session-split-handle"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        livePct.current = effective;
        moved.current = false;
        containerRef.current?.style.setProperty('--session-split', `${effective}%`);
        app().setSessionSplitDragging(true);
        showChip(effective, false);
      }}
      onPointerMove={(e) => {
        if (livePct.current === null) return;
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const pct = clampPct(((e.clientX - rect.left) / rect.width) * 100);
        livePct.current = pct;
        moved.current = true;
        container.style.setProperty('--session-split', `${pct}%`);
        showChip(pct, false);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        endDrag();
      }}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => {
        app().setSessionSplit(taskId, null);
        app().setSessionToolExpanded(false);
        showChip(DEFAULT_PCT, true);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = clampPct(effective + (e.key === 'ArrowLeft' ? -2 : 2));
        app().setSessionSplit(taskId, next);
        showChip(next, true);
      }}
    >
      <span className="session-split-grip" aria-hidden />
      {chip ? (
        <div className="session-split-chip" data-testid="session-split-chip">
          <span>
            对话 {Math.round(chip.main)}% · 工具 {Math.round(100 - chip.main)}%
          </span>
          <b>{chip.px}px</b>
        </div>
      ) : null}
    </div>
  );
}
