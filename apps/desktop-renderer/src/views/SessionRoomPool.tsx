import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TaskRoomView } from './TaskRoomView.js';
import { useTaskStore } from '../store/taskStore.js';

/**
 * Kept-alive Session rooms (ADR-0055), modeled on ORCA's worktree surfaces
 * and this codebase's own mountTerminal pattern: each visited room renders
 * through a portal into a stable container element the pool owns; switching
 * re-parents the active container into the visible host and DETACHES the
 * rest from the document entirely. React state, fibers and DOM survive — a
 * revisit is a reattach, not a rebuild — while detached rooms cost zero
 * layout/compositing, are invisible to global DOM queries (test selectors,
 * a11y tree) and cannot collide with the active room's landmarks.
 *
 * A hidden room is frozen by construction: every live-data subscription
 * inside TaskRoomView/RoomTimeline pins to a constant unless the room is
 * active, so the visible session's streaming and events never re-render
 * hidden ones. The pool is bounded; the cap (not a clock) is the evictor.
 */
export const ROOM_POOL_LIMIT = 3;

export const SessionRoomPool = React.memo(function SessionRoomPool({
  activeTaskId,
}: {
  /** The routed room's task id, or null while another surface owns the pane. */
  activeTaskId: string | null;
}): React.JSX.Element | null {
  const [mru, setMru] = useState<string[]>([]);
  // Prune signal, not the catalog: this selector only changes when a POOLED
  // task disappears, so ordinary task-state churn (which replaces the tasks
  // array) never re-renders the pool or its rooms (ADR-0055 freeze contract).
  const deadPooledIds = useTaskStore((s) =>
    mru.filter((id) => !s.tasks.some((task) => task.id === id)).join(','),
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const containers = useRef(new Map<string, HTMLDivElement>());

  // The render below must include the freshly routed room before the effect
  // commits it, so the entry list is derived, not read from state.
  const entries = activeTaskId
    ? [activeTaskId, ...mru.filter((id) => id !== activeTaskId)].slice(0, ROOM_POOL_LIMIT)
    : mru;

  for (const id of entries) {
    if (!containers.current.has(id)) {
      const el = document.createElement('div');
      el.className = 'room-pool-surface';
      containers.current.set(id, el);
    }
  }

  useEffect(() => {
    if (!activeTaskId) return;
    setMru((previous) => {
      const next = [activeTaskId, ...previous.filter((id) => id !== activeTaskId)].slice(
        0,
        ROOM_POOL_LIMIT,
      );
      return next.length === previous.length && next.every((id, index) => id === previous[index])
        ? previous
        : next;
    });
  }, [activeTaskId]);

  // Deleted/archived Sessions leave the catalog — drop their rooms instead of
  // keeping dead trees alive.
  useEffect(() => {
    if (deadPooledIds === '') return;
    const dead = new Set(deadPooledIds.split(','));
    setMru((previous) => previous.filter((id) => !dead.has(id)));
  }, [deadPooledIds]);

  // Evicted entries: their portals unmounted in this commit; release the
  // container elements afterwards so the DOM can be collected.
  useEffect(() => {
    for (const id of [...containers.current.keys()]) {
      if (!entries.includes(id)) containers.current.delete(id);
    }
  });

  // Re-parent before paint: the active room's container attaches into the
  // visible host; everything else leaves the document (kept in memory).
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const surface = activeTaskId ? containers.current.get(activeTaskId) : undefined;
    if (surface) {
      if (surface.parentElement !== host) host.replaceChildren(surface);
    } else {
      host.replaceChildren();
    }
  });

  if (entries.length === 0 && !activeTaskId) return null;
  return (
    <>
      <div
        ref={hostRef}
        className={`room-pool ${activeTaskId ? '' : 'room-pool-idle'}`}
        data-testid="room-pool"
      />
      {entries.map((id) =>
        createPortal(
          <TaskRoomView taskId={id} active={id === activeTaskId} />,
          containers.current.get(id)!,
          id,
        ),
      )}
    </>
  );
});
