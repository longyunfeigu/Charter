import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ReplayFactDto, ReplayProjection, TaskDto } from '@pi-ide/ipc-contracts';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import { useTaskStore } from '../../store/taskStore.js';
import type { ReplayController } from './replay-controller.js';
import { ArtifactStage } from './ArtifactStage.js';
import { EvidenceDrawer } from './EvidenceDrawer.js';
import {
  KIND_ICON,
  LEVEL_LABEL,
  REVERSIBILITY_BADGE,
  formatDurationShort,
  formatReplayTime,
} from './replay-model.js';

const CONTEXT_RADIUS = 28;
const FOLD_SAMPLE = 3;

/**
 * Depth 1 — semantic session playback (V3.1). Conversation-first story on the
 * left (full recorded prose, fold placeholders between kept nodes, pivot
 * cards), result-first summary on the right (quoted conclusion, outward
 * actions, pinned irreversible attention, return-to-room line). Private model
 * reasoning is never shown; every narrative element is quoted and cited.
 */
export function RecapDepth({
  controller,
  projection,
  task,
}: {
  controller: ReplayController;
  projection: ReplayProjection;
  task: TaskDto;
}): React.JSX.Element {
  const { session, facts } = projection;
  const fact = controller.currentFact ?? facts.at(-1)!;
  const [showContext, setShowContext] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const factIndex = useMemo(() => new Map(facts.map((item, index) => [item.id, index])), [facts]);
  const factById = useMemo(() => new Map(facts.map((item) => [item.id, item])), [facts]);

  const storyFacts = useMemo(() => {
    const keep = new Set(session.chapters.map((chapter) => chapter.factId));
    session.summary.changed.forEach((line) => keep.add(line.factId));
    session.summary.attention.forEach((line) => keep.add(line.factId));
    session.summary.outward.slice(0, 3).forEach((line) => keep.add(line.factId));
    facts.forEach((item) => {
      // Conversation and recorded pivots are the story's first-class citizens.
      if (item.actor.kind === 'user' || item.kind === 'message' || item.kind === 'report') {
        keep.add(item.id);
      }
      if (item.pivot) keep.add(item.id);
    });
    const last = facts.at(-1);
    if (last) keep.add(last.id);
    keep.add(fact.id);

    if (showContext) {
      const current = Math.max(0, facts.indexOf(fact));
      facts
        .slice(Math.max(0, current - CONTEXT_RADIUS), current + CONTEXT_RADIUS + 1)
        .forEach((item) => keep.add(item.id));
    }
    return facts.filter((item) => keep.has(item.id));
  }, [facts, fact, session, showContext]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center' });
  }, [fact.id, showContext]);

  const selectFact = (factId: string, revealDetails = false) => {
    controller.selectFact(factId);
    if (revealDetails) setDetailsOpen(true);
  };

  const foldedCount = facts.length - storyFacts.length;
  const outwardIds = useMemo(
    () => new Set(session.summary.outward.map((line) => line.factId)),
    [session.summary.outward],
  );
  const hasChanged = session.summary.changed.length > 0;
  const hasOutward = session.summary.outward.length > 0;
  const conclusion = session.summary.conclusion;
  const citeChips = useMemo(
    () =>
      session.summary.citations
        .map((id) => factById.get(id))
        .filter((item): item is ReplayFactDto => Boolean(item))
        .slice(0, 3),
    [session.summary.citations, factById],
  );

  return (
    <main className="rp-recap rp-playback rp-v31">
      <aside className="rp-story-panel" aria-label="对话与操作">
        <header className="rp-story-head">
          <strong>对话与操作</strong>
          <button
            data-testid="replay-show-context"
            className={showContext ? 'active' : ''}
            onClick={() => setShowContext((shown) => !shown)}
            aria-pressed={showContext}
            title="仅显示已记录的上下文；不声称展示模型私有推理"
          >
            <Ic name="map" size={15} />
            {showContext ? '收起上下文' : '显示全部上下文'}
          </button>
        </header>
        <div className="rp-story-list" data-testid="replay-story-list">
          {storyFacts.map((item, index) => {
            const previous = storyFacts[index - 1];
            const from = previous ? (factIndex.get(previous.id) ?? 0) + 1 : 0;
            const to = factIndex.get(item.id) ?? 0;
            const hidden = previous ? facts.slice(from, to) : [];
            return (
              <React.Fragment key={item.id}>
                {hidden.length > 0 ? (
                  <FoldGap
                    hidden={hidden}
                    onSelect={(id) => selectFact(id)}
                    onExplore={() => controller.setDepth('explore')}
                  />
                ) : null}
                <StoryEvent
                  fact={item}
                  active={item.id === fact.id}
                  ref={item.id === fact.id ? activeRef : undefined}
                  onSelect={() => selectFact(item.id)}
                  onSelectRef={(id) => selectFact(id, true)}
                  factById={factById}
                />
              </React.Fragment>
            );
          })}
        </div>
        <footer className="rp-story-foot">
          <span>{storyFacts.length} 个语义节点</span>
          <small>
            {showContext
              ? `当前附近最多 ${CONTEXT_RADIUS * 2 + 1} 条记录`
              : foldedCount > 0
                ? `已折叠 ${foldedCount} 条低影响记录 · 节点间可展开`
                : '全部记录都已显示'}
          </small>
        </footer>
      </aside>

      <section className="rp-now-panel">
        <section className="rp-summary rp-playback-summary" data-testid="replay-summary">
          <div className="rp-result-line">
            <h1>{session.outcomeLabel}</h1>
            <span className="rp-result-facts">{session.summary.result}</span>
          </div>

          {conclusion ? (
            <div className="rp-conclusion" data-testid="replay-conclusion">
              <span className="rp-level rp-level-inferred">引自最终报告</span>
              <p>{conclusion.text}</p>
              <span className="rp-conclusion-cites">
                {citeChips.map((cite, index) => (
                  <button
                    key={cite.id}
                    className="rp-cite-chip"
                    onClick={() => selectFact(cite.id, true)}
                    title={cite.action}
                  >
                    {'①②③'[index]} {shortAction(cite)} {clockTime(cite.startedAt)}
                  </button>
                ))}
              </span>
            </div>
          ) : null}

          <div className="rp-to-room" data-testid="replay-to-room">
            <button onClick={() => useTaskStore.getState().closeReplay()}>
              Esc 关闭回放 ·{' '}
              {task.state === 'REVIEW_READY' ? '回到房间的审阅栏处理这些改动' : '回到任务房间'} →
            </button>
            <small>审阅、接受与回滚只在房间进行 — 回放保持只读</small>
          </div>

          <div className="rp-summary-duo">
            <div className="rp-summary-changed">
              <span>{hasChanged ? '重要变化' : hasOutward ? '产出与对外动作' : '重要变化'}</span>
              {!hasChanged && !hasOutward ? (
                <p className="rp-empty-note">未记录文件级变化或对外动作。</p>
              ) : (
                <ul>
                  {session.summary.changed.slice(0, 3).map((line) => (
                    <li key={line.factId + line.label}>
                      <button onClick={() => selectFact(line.factId, true)}>
                        <Ic name="pencil" size={13} />
                        <span className="mono">{line.label}</span>
                      </button>
                    </li>
                  ))}
                  {session.summary.outward.slice(0, hasChanged ? 2 : 4).map((line) => (
                    <li key={line.factId + line.label}>
                      <button
                        className="rp-outward-row"
                        data-testid="replay-outward"
                        onClick={() => selectFact(line.factId, true)}
                      >
                        <Ic name="external" size={13} />
                        <span>
                          {line.label}
                          {line.app ? <small> · {line.app}</small> : null}
                        </span>
                        <em className={`rp-rev rp-rev-${line.reversibility}`}>
                          {REVERSIBILITY_BADGE[line.reversibility]}
                        </em>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rp-summary-attention">
              <span>需要注意</span>
              {session.summary.attention.length === 0 ? (
                <p className="rp-ok-note">
                  <Ic name="check" size={13} /> 没有未解决的关键问题
                </p>
              ) : (
                <ul>
                  {session.summary.attention.slice(0, 3).map((line) => {
                    const target = factById.get(line.factId);
                    const pinned =
                      target?.outward === true &&
                      (target.reversibility === 'irreversible' || target.risk === 'high');
                    return (
                      <li key={line.factId + line.label}>
                        <button
                          className={pinned ? 'rp-attn-pinned' : ''}
                          onClick={() => selectFact(line.factId, true)}
                        >
                          {pinned ? (
                            <em className="rp-attn-badge">
                              {target?.reversibility === 'irreversible' ? '不可逆' : '高风险'}
                            </em>
                          ) : (
                            <Ic name="alert" size={13} />
                          )}
                          {line.label}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </section>

        <div className="rp-stage-wrap">
          <ArtifactStage fact={fact} taskId={task.id} />
          {fact.diffstat ? (
            <footer className="rp-write-summary">
              <Ic name="pencil" size={15} />
              已写入 <b>{fact.diffstat.additions}</b> 行，删除 <em>{fact.diffstat.deletions}</em> 行
              {outwardIds.has(fact.id) ? <small> · 对外动作</small> : null}
            </footer>
          ) : null}
          <footer className="rp-stage-actions">
            <button data-testid="replay-step-details" onClick={() => setDetailsOpen(true)}>
              查看这一步的详情
              <Ic name="external" size={14} />
            </button>
            <button className="rp-stage-verify" onClick={() => controller.setDepth('verify')}>
              在核验层追溯证据 →
            </button>
          </footer>
        </div>

        {detailsOpen ? (
          <div className="rp-detail-layer" data-testid="replay-detail-layer">
            <button
              className="rp-detail-scrim"
              aria-label="关闭步骤详情"
              onClick={() => setDetailsOpen(false)}
            />
            <div className="rp-detail-sheet">
              <button
                className="rp-detail-close"
                aria-label="关闭步骤详情"
                onClick={() => setDetailsOpen(false)}
              >
                <Ic name="x" size={16} />
              </button>
              <EvidenceDrawer
                fact={fact}
                projection={projection}
                expanded
                onSelectFact={controller.selectFact}
                onVerify={() => controller.setDepth('verify')}
              />
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

/** Fold placeholder between two kept story nodes (V3.1): the story keeps no
 * silent holes — what was folded is countable, sampled and expandable. */
function FoldGap({
  hidden,
  onSelect,
  onExplore,
}: {
  hidden: ReplayFactDto[];
  onSelect(factId: string): void;
  onExplore(): void;
}): React.JSX.Element {
  const stats = useMemo(() => {
    const byKind = new Map<string, number>();
    for (const item of hidden) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    const NAMES: Record<string, string> = {
      read: '读取',
      search: '搜索',
      command: '命令',
      write: '写入',
      state: '状态',
      system: '系统',
    };
    return [...byKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([kind, count]) => `${count} 次${NAMES[kind] ?? kind}`)
      .join('、');
  }, [hidden]);
  const spanMs = Math.max(0, (hidden.at(-1)?.actualEndMs ?? 0) - (hidden[0]?.actualStartMs ?? 0));

  return (
    <details className="rp-fold" data-testid="replay-fold">
      <summary>
        <i className="rp-fold-line" aria-hidden />
        <span className="rp-fold-label">
          折叠了 {hidden.length} 条{stats ? `：${stats}` : ''}
          {spanMs >= 1000 ? ` · ${formatDurationShort(spanMs)}` : ''}
        </span>
        <em>展开样例</em>
        <i className="rp-fold-line" aria-hidden />
      </summary>
      <div className="rp-fold-sample">
        {hidden.slice(0, FOLD_SAMPLE).map((item) => (
          <button key={item.id} onClick={() => onSelect(item.id)}>
            <Ic name={KIND_ICON[item.kind] ?? 'info'} size={13} />
            <span>{item.action}</span>
            <time>{clockTime(item.startedAt)}</time>
          </button>
        ))}
        {hidden.length > FOLD_SAMPLE ? (
          <button className="rp-fold-more" onClick={onExplore}>
            在探究层查看全部 {hidden.length} 条 →
          </button>
        ) : null}
      </div>
    </details>
  );
}

const StoryEvent = React.forwardRef<
  HTMLButtonElement,
  {
    fact: ReplayFactDto;
    active: boolean;
    onSelect(): void;
    onSelectRef(factId: string): void;
    factById: Map<string, ReplayFactDto>;
  }
>(function StoryEvent({ fact, active, onSelect, onSelectRef, factById }, ref) {
  const conversational = fact.actor.kind === 'user' || fact.actor.kind === 'agent';
  const provider = providerFor(fact);

  // Recorded pivot: a plan revision card with its cited grounds. The refs are
  // separate buttons, so the card itself is a div carrying the story classes.
  if (fact.pivot) {
    return (
      <div
        className={`rp-story-event action pivot ${active ? 'active' : ''} status-${fact.status}`}
        data-fact-id={fact.id}
        data-kind={fact.kind}
        data-testid="replay-pivot"
      >
        <button
          ref={ref}
          className="rp-pivot-main"
          onClick={onSelect}
          aria-current={active ? 'step' : undefined}
        >
          <span className="rp-pivot-tag">
            <i aria-hidden>↷</i> 转折 · 计划修订
            <span className="rp-level rp-level-inferred">{LEVEL_LABEL.inferred}</span>
            <time>{clockTime(fact.startedAt)}</time>
          </span>
          <strong>{fact.action}</strong>
          {fact.pivot.reason ? (
            <p>{fact.pivot.reason}</p>
          ) : (
            <p className="rp-pivot-none">计划已修订；未记录修订原因说明。</p>
          )}
        </button>
        {fact.pivot.refFactIds.length > 0 ? (
          <span className="rp-pivot-refs">
            {fact.pivot.refFactIds.slice(0, 3).map((refId) => {
              const target = factById.get(refId);
              return target ? (
                <button key={refId} className="rp-cite-chip" onClick={() => onSelectRef(refId)}>
                  依据 · {shortAction(target)}
                </button>
              ) : null;
            })}
          </span>
        ) : null}
      </div>
    );
  }

  // Conversation bubble: the recorded prose itself, not just the action line.
  if (
    conversational &&
    (fact.kind === 'user' ||
      fact.kind === 'answer' ||
      fact.kind === 'message' ||
      fact.kind === 'question' ||
      fact.kind === 'report')
  ) {
    const isUser = fact.actor.kind === 'user';
    return (
      <button
        ref={ref}
        className={`rp-story-event message ${isUser ? 'from-user' : 'from-agent'} ${active ? 'active' : ''} status-${fact.status}`}
        data-fact-id={fact.id}
        data-kind={fact.kind}
        onClick={onSelect}
        aria-current={active ? 'step' : undefined}
      >
        <span className={`rp-msg-ava ${isUser ? 'user' : 'agent'}`} aria-hidden>
          {isUser ? (
            '你'
          ) : provider ? (
            <ProviderMark provider={provider} size={15} />
          ) : (
            <Ic name="bot" size={14} />
          )}
        </span>
        <span className="rp-msg-body">
          <span className="rp-msg-who">
            <strong>{isUser ? 'YOU' : 'AGENT'}</strong>
            <time>{clockTime(fact.startedAt)}</time>
            {fact.kind === 'report' ? <em>· 最终报告</em> : null}
            {fact.kind === 'question' ? <em>· 提问</em> : null}
          </span>
          <span className="rp-msg-text">{fact.detail ?? fact.action}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      ref={ref}
      className={`rp-story-event action ${active ? 'active' : ''} status-${fact.status}`}
      data-fact-id={fact.id}
      data-kind={fact.kind}
      onClick={onSelect}
      aria-current={active ? 'step' : undefined}
    >
      <span className="rp-story-node" aria-hidden>
        <Ic name={KIND_ICON[fact.kind] ?? 'info'} size={16} />
      </span>
      <span className="rp-story-copy">
        <span className="rp-story-action">
          <strong>{fact.action}</strong>
          {fact.detail ? ` · ${fact.detail.slice(0, 120)}` : null}
          {fact.outward ? <small className="rp-outward-mark"> · 对外</small> : null}
          {fact.diffstat ? (
            <small>
              · <b>+{fact.diffstat.additions}</b> <em>−{fact.diffstat.deletions}</em>
            </small>
          ) : null}
        </span>
        <span className="rp-story-meta">
          <span className={`rp-level rp-level-${fact.level}`}>{LEVEL_LABEL[fact.level]}</span>
          <time>{clockTime(fact.startedAt)}</time>
        </span>
      </span>
    </button>
  );
});

function providerFor(fact: ReplayFactDto): ProviderMarkKind | null {
  if (fact.actor.kind !== 'agent') return null;
  if (fact.source === 'claude') return 'claude';
  if (fact.source === 'codex') return 'codex';
  if (fact.source === 'pi') return 'pi';
  return 'shell';
}

function shortAction(fact: ReplayFactDto): string {
  const oneLine = fact.action.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 18 ? oneLine : `${oneLine.slice(0, 17)}…`;
}

function clockTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? formatReplayTime(0)
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
