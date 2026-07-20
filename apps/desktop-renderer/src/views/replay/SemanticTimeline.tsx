import React, { useMemo } from 'react';
import type { ReplayChapterDto, ReplayFactDto, ReplayProjection } from '@pi-ide/ipc-contracts';
import { Ic } from '../home-icons.js';
import type { ReplayController } from './replay-controller.js';
import { CHAPTER_LABEL, formatReplayTime } from './replay-model.js';

const MAX_VISIBLE_MOMENTS = 9;

/** A single semantic axis: transport, meaningful moments and capture coverage. */
export function SemanticTimeline({
  controller,
  projection,
}: {
  controller: ReplayController;
  projection: ReplayProjection;
}): React.JSX.Element {
  const { facts, session } = projection;
  const { timeMode, playheadMs, durationMs, currentIndex } = controller;
  const moments = useMemo(
    () => visibleMoments(session.chapters, facts, controller.currentFact),
    [session.chapters, facts, controller.currentFact],
  );
  const coverageTotal = timeMode === 'story' ? session.storyDurationMs : session.actualDurationMs;
  const rawPercent =
    durationMs > 0 ? Math.min(100, Math.max(0, (playheadMs / durationMs) * 100)) : 0;
  // The markers form a semantic chapter axis, not a histogram. Equal spacing
  // keeps short real-time sessions legible while each label still exposes its
  // recorded wall-clock time. The selected chapter owns the visual playhead.
  const momentPositions = useMemo(() => semanticPositions(moments.length), [moments.length]);
  const selectedMoment = moments.findIndex(({ fact }) => fact.id === controller.currentFact?.id);
  const percent =
    selectedMoment >= 0 ? (momentPositions[selectedMoment] ?? rawPercent) : rawPercent;

  return (
    <footer className="rp-timeline" data-testid="replay-timeline">
      <div className="rp-transport">
        <button
          className="rp-skip"
          data-testid="replay-prev"
          disabled={currentIndex === 0}
          onClick={() => controller.stepBy(-1)}
          aria-label="上一个事件"
        >
          <Ic name="chevron" size={15} className="rp-previous-icon" />
        </button>
        <button className="rp-play" data-testid="replay-play" onClick={controller.togglePlay}>
          <Ic name={controller.playing ? 'pause' : 'play'} size={16} />
          <span className="rp-sr-only">{controller.playing ? 'Pause' : 'Replay'}</span>
        </button>
        <button
          className="rp-skip"
          data-testid="replay-next"
          disabled={currentIndex >= facts.length - 1}
          onClick={() => controller.stepBy(1)}
          aria-label="下一个事件"
        >
          <Ic name="chevron" size={15} className="rp-next-icon" />
        </button>
        <time>
          {formatReplayTime(playheadMs)} / {formatReplayTime(durationMs)}
        </time>
        <select
          value={controller.speed}
          onChange={(event) => controller.setSpeed(Number(event.target.value))}
          aria-label="播放速度"
        >
          {[1, 2, 4, 8, 16].map((value) => (
            <option key={value} value={value}>
              {value}×
            </option>
          ))}
        </select>
        <button
          className={`rp-idle-toggle ${timeMode === 'story' ? 'active' : ''}`}
          data-testid="replay-skip-idle"
          onClick={() => controller.setTimeMode(timeMode === 'story' ? 'actual' : 'story')}
          aria-pressed={timeMode === 'story'}
        >
          跳过等待
          <i aria-hidden>
            <b />
          </i>
        </button>
        {controller.live ? (
          <button
            className={`rp-live-follow ${controller.liveFollow ? 'active' : ''}`}
            data-testid="replay-live-follow"
            onClick={() => controller.setLiveFollow(!controller.liveFollow)}
          >
            <i aria-hidden />
            {controller.liveFollow ? '跟随中' : '跟随最新'}
          </button>
        ) : null}
        <span className="rp-count" data-testid="replay-count">
          step {currentIndex + 1} / {facts.length}
        </span>
      </div>

      <div className="rp-semantic-axis">
        <div className="rp-axis-line" aria-hidden />
        {moments.map(({ chapter, fact }, index) => {
          const left = momentPositions[index] ?? 50;
          const active = fact.id === controller.currentFact?.id;
          return (
            <button
              key={chapter.id}
              className={`rp-semantic-moment ${active ? 'active' : ''} status-${fact.status}`}
              data-category={chapter.category}
              style={{ left: `${left}%` }}
              onClick={() => controller.selectFact(fact.id)}
              title={fact.action}
            >
              <span>
                <strong>{CHAPTER_LABEL[chapter.category]}</strong>
                <small>{clockTime(fact.startedAt)}</small>
              </span>
              <i aria-hidden>
                <Ic name={momentIcon(fact)} size={10} />
              </i>
            </button>
          );
        })}
        <div className="rp-axis-playhead" style={{ left: `${percent}%` }} aria-hidden>
          <i />
        </div>
        <input
          className="rp-range"
          type="range"
          data-testid="replay-scrubber"
          min={0}
          max={Math.max(1, durationMs)}
          step={Math.max(1, Math.floor(durationMs / 5000))}
          value={Math.min(playheadMs, durationMs)}
          onChange={(event) => controller.seek(Number(event.target.value))}
          aria-label="回放时间轴"
        />
      </div>

      <div className="rp-axis-footer">
        <time>00:00</time>
        <div className="rp-coverage-band" data-testid="replay-coverage" aria-label="逐段证据覆盖">
          {session.coverage.map((segment, index) => {
            const start = timeMode === 'story' ? segment.storyStartMs : segment.actualStartMs;
            const end = timeMode === 'story' ? segment.storyEndMs : segment.actualEndMs;
            const width = coverageTotal > 0 ? ((end - start) / coverageTotal) * 100 : 0;
            return width > 0 ? (
              <i
                key={`${segment.level}-${index}`}
                className={`rp-cov-${segment.level}`}
                style={{ width: `${width}%` }}
                title={segment.level}
              />
            ) : null;
          })}
        </div>
        <span>
          <Ic name="clock" size={12} />
          {timeMode === 'story' ? '已压缩等待与重复读取' : '正在显示真实时间'}
        </span>
        <time>{formatReplayTime(durationMs)}</time>
      </div>
    </footer>
  );
}

function visibleMoments(
  chapters: ReplayChapterDto[],
  facts: ReplayFactDto[],
  current: ReplayFactDto | null,
): Array<{ chapter: ReplayChapterDto; fact: ReplayFactDto }> {
  const candidates = chapters
    .map((chapter) => ({ chapter, fact: facts.find((fact) => fact.id === chapter.factId) }))
    .filter((entry): entry is { chapter: ReplayChapterDto; fact: ReplayFactDto } =>
      Boolean(entry.fact),
    );
  if (candidates.length <= MAX_VISIBLE_MOMENTS) return candidates;

  const chosen = new Map<string, { chapter: ReplayChapterDto; fact: ReplayFactDto }>();
  const stride = (candidates.length - 1) / (MAX_VISIBLE_MOMENTS - 1);
  for (let index = 0; index < MAX_VISIBLE_MOMENTS; index += 1) {
    const entry = candidates[Math.round(index * stride)];
    if (entry) chosen.set(entry.chapter.id, entry);
  }
  const active = candidates.find((entry) => entry.fact.id === current?.id);
  if (active) chosen.set(active.chapter.id, active);
  return [...chosen.values()].sort((a, b) => a.chapter.storyStartMs - b.chapter.storyStartMs);
}

function semanticPositions(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [50];
  return Array.from({ length: count }, (_, index) => 4 + (index * 92) / (count - 1));
}

function momentIcon(fact: ReplayFactDto): string {
  if (fact.status === 'error' || fact.status === 'denied') return 'alert';
  if (fact.pivot) return 'map';
  if (fact.kind === 'verification') return fact.status === 'ok' ? 'check' : 'alert';
  if (fact.actor.kind === 'user') return 'user';
  if (fact.actor.kind === 'agent') return 'bot';
  if (fact.kind === 'write') return 'pencil';
  return 'circle';
}

function clockTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? '00:00'
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
