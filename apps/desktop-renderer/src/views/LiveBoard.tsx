import React, { useEffect, useState } from 'react';
import { useActivityStore } from '../store/activityStore.js';
import { tilesForTask, writesPerMinute, WRITING_MS } from './live-board.js';
import { Ic } from './home-icons.js';

const TILE_CAP = 6;

/** True while the window is focused — animations and ticking pause otherwise. */
function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(
    typeof document !== 'undefined' ? document.hasFocus() : true,
  );
  useEffect(() => {
    const on = (): void => setFocused(true);
    const off = (): void => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => {
      window.removeEventListener('focus', on);
      window.removeEventListener('blur', off);
    };
  }, []);
  return focused;
}

/**
 * Live Board (ADR-0008, PIVOT-025): per-running-task file tiles driven by the
 * recorded write pulses (never fs polling). Ripple on write, heat with ~60s
 * decay, rhythm bars, and a "writing" beacon; a tile opens the read-only
 * diff-so-far lens. Ticks once a second for decay — only while focused.
 */
export function LiveBoard(props: {
  taskId: string;
  onOpenLens: (path: string) => void;
}): React.JSX.Element | null {
  const pulses = useActivityStore((s) => s.pulses);
  const focused = useWindowFocus();
  const [, setTick] = useState(0);

  const hasRecent = pulses.some((p) => p.taskId === props.taskId);
  useEffect(() => {
    if (!focused || !hasRecent) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [focused, hasRecent]);

  const now = Date.now();
  const tiles = tilesForTask(pulses, props.taskId, now);
  if (tiles.length === 0) return null;
  const rate = writesPerMinute(pulses, props.taskId, now);

  return (
    <div
      className={`hm-board ${focused ? '' : 'paused'}`}
      data-testid={`live-board-${props.taskId}`}
    >
      <div className="hm-board-head">
        <span className="hm-board-beacon" />
        <span>Working right now</span>
        <span className="hm-board-rate">{rate} writes/min</span>
      </div>
      <div className="hm-tiles">
        {tiles.slice(0, TILE_CAP).map((tile) => {
          const slash = tile.path.lastIndexOf('/');
          const name = slash >= 0 ? tile.path.slice(slash + 1) : tile.path;
          const dir = slash >= 0 ? tile.path.slice(0, slash + 1) : './';
          return (
            <button
              key={tile.path}
              className={`hm-tile ${tile.heat}`}
              data-testid={`live-tile-${tile.path}`}
              data-heat={tile.heat}
              title={`${tile.path} — open the diff so far (read-only)`}
              onClick={() => props.onOpenLens(tile.path)}
            >
              <span className="hm-tile-f">{name}</span>
              <span className="hm-tile-dir">{dir}</span>
              <span className="hm-tile-spark" aria-hidden>
                {tile.rhythm.map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(2, Math.round(v * 13))}px` }} />
                ))}
              </span>
              {tile.writing && now - tile.lastWriteAt <= WRITING_MS ? (
                <span className="hm-tile-writing">
                  <i />
                  writing
                </span>
              ) : null}
            </button>
          );
        })}
        {tiles.length > TILE_CAP ? (
          <div className="hm-tile more">
            <Ic name="plus" size={12} /> {tiles.length - TILE_CAP} more files
          </div>
        ) : null}
      </div>
    </div>
  );
}
