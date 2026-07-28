import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReplayDepth,
  ReplayFactDto,
  ReplayProjection,
  ReplayRequest,
  TaskDto,
} from '@pi-ide/ipc-contracts';
import { factIndexAtTime } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../../bridge.js';

/**
 * The one replay controller (Replay V3 §6.2). All three depths share this
 * state: switching depth never resets the playhead, and switching between
 * story/real time keeps the same selected fact.
 */

export type ReplayTimeMode = 'story' | 'actual';

const RUNNING_STATES = new Set([
  'READY',
  'EXPLORING',
  'PLANNING',
  'AWAITING_PLAN_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_USER',
  'AWAITING_PERMISSION',
  'VERIFYING',
]);

function taskIsLive(task: TaskDto | null): boolean {
  if (!task) return false;
  if (task.external) return task.external.status === 'active';
  return RUNNING_STATES.has(task.state);
}

export interface ReplayController {
  task: TaskDto | null;
  projection: ReplayProjection | null;
  loading: boolean;
  depth: ReplayDepth;
  setDepth(depth: ReplayDepth): void;
  timeMode: ReplayTimeMode;
  setTimeMode(mode: ReplayTimeMode): void;
  playheadMs: number;
  durationMs: number;
  playing: boolean;
  speed: number;
  setSpeed(speed: number): void;
  live: boolean;
  liveFollow: boolean;
  setLiveFollow(follow: boolean): void;
  currentIndex: number;
  currentFact: ReplayFactDto | null;
  selectFact(factId: string): void;
  selectIndex(index: number): void;
  seek(ms: number): void;
  togglePlay(): void;
  stepBy(delta: number): void;
  selectedEvidenceRef: string | null;
  selectEvidence(ref: string | null): void;
}

export function useReplayController(
  request: ReplayRequest,
  task: TaskDto | null,
): ReplayController {
  const [projection, setProjection] = useState<ReplayProjection | null>(null);
  const [depth, setDepth] = useState<ReplayDepth>(request.depth ?? 'recap');
  const [timeMode, setTimeMode] = useState<ReplayTimeMode>('story');
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [selectedEvidenceRef, selectEvidence] = useState<string | null>(null);
  const live = taskIsLive(task);
  const [liveFollow, setLiveFollow] = useState(request.liveFollow ?? false);
  const anchored = useRef(false);

  // -- data: main-side ReplayService via versioned IPC. One session read plus
  // paginated fact pages (≤500 each); the ledger event broadcast triggers a
  // debounced incremental refresh — never a fixed-interval full poll (am.8).
  useEffect(() => {
    let disposed = false;
    let loading = false;
    let pendingRefresh = false;
    let knownLatest = -1;
    const taskId = request.taskId;

    const load = async () => {
      if (loading) {
        pendingRefresh = true;
        return;
      }
      loading = true;
      try {
        const sessionResult = await rpcResult('task.replaySession', { taskId });
        if (disposed || !sessionResult.ok) return;
        if (sessionResult.data.latestSequence === knownLatest) return;
        const facts: ReplayFactDto[] = [];
        let afterSequence = 0;
        for (;;) {
          const page = await rpcResult('task.replayEvents', {
            taskId,
            afterSequence,
            limit: 500,
          });
          if (disposed || !page.ok) return;
          facts.push(...page.data.facts);
          if (page.data.nextAfterSequence === null) break;
          afterSequence = page.data.nextAfterSequence;
        }
        if (disposed) return;
        knownLatest = sessionResult.data.latestSequence;
        setProjection({ session: sessionResult.data.session, facts });
      } finally {
        loading = false;
        if (pendingRefresh && !disposed) {
          pendingRefresh = false;
          void load();
        }
      }
    };

    setProjection(null);
    anchored.current = false;
    void load();

    // New ledger rows (any consumer of this task) refresh the projection.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void load(), 900);
    };
    const offEvent = onEvent('task.event', (payload) => {
      if (payload.taskId === taskId) scheduleRefresh();
    });
    const offState = onEvent('task.stateChanged', (payload) => {
      if (payload.taskId === taskId) scheduleRefresh();
    });
    return () => {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      offEvent();
      offState();
    };
  }, [request.taskId]);

  const facts = projection?.facts ?? [];
  const durationMs =
    timeMode === 'story'
      ? (projection?.session.storyDurationMs ?? 0)
      : (projection?.session.actualDurationMs ?? 0);

  const currentIndex = useMemo(
    () => factIndexAtTime(facts, playheadMs, timeMode),
    [facts, playheadMs, timeMode],
  );
  const currentFact = facts[currentIndex] ?? null;

  const startOf = useCallback(
    (fact: ReplayFactDto) => (timeMode === 'story' ? fact.storyStartMs : fact.actualStartMs),
    [timeMode],
  );

  // -- entry anchor: result-first, never autoplay (§1.2) --
  useEffect(() => {
    if (anchored.current || !projection || projection.facts.length === 0) return;
    anchored.current = true;
    const all = projection.facts;
    let target: ReplayFactDto | undefined;
    const anchor = request.anchor ?? { type: 'result' };
    if (anchor.type === 'fact') {
      target = all.find((f) => f.id === anchor.id);
    } else if (anchor.type === 'change') {
      target = all.find((f) => f.changeIds?.includes(anchor.id));
    } else if (anchor.type === 'path') {
      target =
        all.find((f) => (f.changeIds?.length ?? 0) > 0 && f.paths.includes(anchor.path)) ??
        all.find((f) => f.paths.includes(anchor.path));
    } else if (anchor.type === 'actual-time') {
      target = all[factIndexAtTime(all, anchor.ms, 'actual')];
    } else {
      // result frame: the final report if present, else the last fact.
      target = [...all].reverse().find((f) => f.kind === 'report') ?? all.at(-1);
    }
    const fact = target ?? all.at(-1)!;
    setPlayheadMs(timeMode === 'story' ? fact.storyStartMs : fact.actualStartMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projection, request]);

  // -- live follow: keep the playhead pinned to the newest fact --
  useEffect(() => {
    if (!liveFollow || !projection) return;
    const last = projection.facts.at(-1);
    if (last) setPlayheadMs(startOf(last));
  }, [liveFollow, projection, startOf]);

  // -- playback clock --
  useEffect(() => {
    if (!playing || durationMs <= 0) return;
    let frameId = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = Math.max(0, now - previous);
      previous = now;
      setPlayheadMs((value) => {
        const next = Math.min(durationMs, value + delta * speed);
        if (next >= durationMs) setPlaying(false);
        return next;
      });
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [playing, speed, durationMs]);

  // -- time-mode switch keeps the same fact (§6.2) --
  const changeTimeMode = useCallback(
    (mode: ReplayTimeMode) => {
      if (mode === timeMode) return;
      const fact = facts[currentIndex];
      setTimeMode(mode);
      if (fact) setPlayheadMs(mode === 'story' ? fact.storyStartMs : fact.actualStartMs);
    },
    [timeMode, facts, currentIndex],
  );

  const seek = useCallback(
    (ms: number) => {
      setPlaying(false);
      setLiveFollow(false);
      setPlayheadMs(Math.max(0, Math.min(durationMs, ms)));
    },
    [durationMs],
  );

  const selectIndex = useCallback(
    (index: number) => {
      const fact = facts[Math.max(0, Math.min(facts.length - 1, index))];
      if (!fact) return;
      setPlaying(false);
      setLiveFollow(false);
      setPlayheadMs(startOf(fact));
      selectEvidence(null);
    },
    [facts, startOf],
  );

  const selectFact = useCallback(
    (factId: string) => {
      const index = facts.findIndex((f) => f.id === factId);
      if (index >= 0) selectIndex(index);
    },
    [facts, selectIndex],
  );

  const togglePlay = useCallback(() => {
    setLiveFollow(false);
    setPlaying((value) => {
      if (!value && playheadMs >= durationMs) setPlayheadMs(0);
      return !value;
    });
  }, [playheadMs, durationMs]);

  const stepBy = useCallback(
    (delta: number) => selectIndex(currentIndex + delta),
    [selectIndex, currentIndex],
  );

  return {
    task,
    projection,
    loading: projection === null,
    depth,
    setDepth,
    timeMode,
    setTimeMode: changeTimeMode,
    playheadMs,
    durationMs,
    playing,
    speed,
    setSpeed,
    live,
    liveFollow,
    setLiveFollow,
    currentIndex,
    currentFact,
    selectFact,
    selectIndex,
    seek,
    togglePlay,
    stepBy,
    selectedEvidenceRef,
    selectEvidence,
  };
}
