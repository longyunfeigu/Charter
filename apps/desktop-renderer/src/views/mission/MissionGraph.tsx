import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MissionSnapshotDto } from '@pi-ide/ipc-contracts';
import { Ic, ProviderMark, type ProviderMarkKind } from '../home-icons.js';
import {
  buildMissionGraph,
  missionGraphTimeline,
  MISSION_GRAPH_NODE_HEIGHT,
  MISSION_GRAPH_NODE_WIDTH,
  type MissionGraphEdge,
  type MissionGraphFilter,
  type MissionGraphNode,
} from './mission-graph-model.js';

export type MissionGraphSelection =
  | { kind: 'task'; taskId: string }
  | { kind: 'communication'; edgeId: string }
  | { kind: 'human' }
  | null;

interface Point {
  x: number;
  y: number;
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

function providerMark(provider: string | null, kind: string | undefined): ProviderMarkKind {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'shell' || kind === 'shell_agent') return 'shell';
  return 'pi';
}

function stateIcon(node: MissionGraphNode): string {
  if (node.state.tone === 'success') return 'checkCircle';
  if (node.state.tone === 'attention') return 'xCircle';
  if (node.state.tone === 'active') return 'zap';
  if (node.state.tone === 'waiting') return 'clock';
  return 'circle';
}

function workModeIcon(mode: MissionGraphNode['task']['workMode']): string {
  if (mode === 'read-only') return 'shield';
  if (mode === 'isolated-write') return 'branch';
  return 'pencil';
}

function formatMoment(value: number): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function edgePath(
  edge: MissionGraphEdge,
  positions: ReadonlyMap<string, Point>,
  humanPosition: Point,
): { path: string; labelX: number; labelY: number } | null {
  const source = positions.get(edge.sourceId);
  const target = edge.targetId === 'mission-human' ? humanPosition : positions.get(edge.targetId);
  if (!source || !target) return null;

  const sourceWidth = MISSION_GRAPH_NODE_WIDTH;
  const targetWidth = edge.targetId === 'mission-human' ? 162 : MISSION_GRAPH_NODE_WIDTH;
  const sourceHeight = MISSION_GRAPH_NODE_HEIGHT;
  const targetHeight = edge.targetId === 'mission-human' ? 74 : MISSION_GRAPH_NODE_HEIGHT;
  const forward = target.x >= source.x;
  const startX = forward ? source.x + sourceWidth : source.x;
  const endX = forward ? target.x : target.x + targetWidth;
  const startY =
    source.y + sourceHeight / 2 + (edge.kind === 'communication' ? (forward ? 18 : -18) : 0);
  const endY =
    target.y + targetHeight / 2 + (edge.kind === 'communication' ? (forward ? -18 : 18) : 0);
  const bend = Math.max(46, Math.abs(endX - startX) * 0.42);
  const controlA = forward ? startX + bend : startX - bend;
  const controlB = forward ? endX - bend : endX + bend;
  return {
    path: `M ${startX} ${startY} C ${controlA} ${startY}, ${controlB} ${endY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2 - (edge.kind === 'communication' ? 8 : 5),
  };
}

export function MissionGraph({
  snapshot,
  selection,
  replayAt,
  detailOpen = false,
  onSelection,
  onReplayAt,
}: {
  snapshot: MissionSnapshotDto;
  selection: MissionGraphSelection;
  replayAt: number | null;
  detailOpen?: boolean;
  onSelection: (selection: MissionGraphSelection) => void;
  onReplayAt: (at: number | null) => void;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 24, y: 24, scale: 1 });
  const [manualPositions, setManualPositions] = useState<Map<string, Point>>(new Map());
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MissionGraphFilter>('all');
  const [showDependencies, setShowDependencies] = useState(true);
  const [showDelegation, setShowDelegation] = useState(true);
  const [showAllCommunication, setShowAllCommunication] = useState(false);
  const [showCritical, setShowCritical] = useState(false);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const [collapsedTaskIds, setCollapsedTaskIds] = useState<Set<string>>(new Set());
  const panRef = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const nodeDragRef = useRef<{
    id: string;
    x: number;
    y: number;
    origin: Point;
  } | null>(null);

  const events = useMemo(() => missionGraphTimeline(snapshot), [snapshot]);
  const replayIndex = useMemo(() => {
    if (replayAt === null || events.length === 0) return Math.max(0, events.length - 1);
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    events.forEach((event, index) => {
      const next = Math.abs(event.at - replayAt);
      if (next < distance) {
        distance = next;
        closest = index;
      }
    });
    return closest;
  }, [events, replayAt]);
  const projection = useMemo(
    () =>
      buildMissionGraph(snapshot, {
        at: replayAt,
        search,
        filter,
        focusTaskId,
        collapsedTaskIds,
      }),
    [collapsedTaskIds, filter, focusTaskId, replayAt, search, snapshot],
  );

  const positions = useMemo(() => {
    const result = new Map<string, Point>();
    for (const node of projection.nodes) {
      result.set(node.id, manualPositions.get(node.id) ?? { x: node.x, y: node.y });
    }
    return result;
  }, [manualPositions, projection.nodes]);
  const humanPosition = useMemo(
    () => ({ x: projection.humanX, y: projection.humanY }),
    [projection.humanX, projection.humanY],
  );

  const visibleEdges = useMemo(
    () =>
      projection.edges.filter((edge) => {
        if (edge.kind === 'dependency') return showDependencies;
        if (edge.kind === 'delegation') return showDelegation;
        if (edge.kind === 'communication') {
          return showAllCommunication || edge.pending || edge.failed || edge.urgent;
        }
        return true;
      }),
    [projection.edges, showAllCommunication, showDelegation, showDependencies],
  );

  const fit = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const detailInset =
      detailOpen && bounds.width > 1050
        ? Math.min(820, Math.max(620, bounds.width * 0.48)) + 18
        : 0;
    const availableWidth = Math.max(320, bounds.width - detailInset);
    const scale = Math.min(
      1.12,
      Math.max(
        0.35,
        Math.min(
          (availableWidth - 42) / projection.width,
          (bounds.height - 42) / projection.height,
        ),
      ),
    );
    setViewport({
      x: Math.max(18, (availableWidth - projection.width * scale) / 2),
      y: Math.max(18, (bounds.height - projection.height * scale) / 2),
      scale,
    });
  }, [detailOpen, projection.height, projection.width]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [fit, snapshot.mission.id]);

  useEffect(() => {
    setManualPositions((previous) => {
      const next = new Map<string, Point>();
      for (const [id, point] of previous) {
        if (projection.visibleTaskIds.has(id)) next.set(id, point);
      }
      return next;
    });
  }, [projection.visibleTaskIds]);

  const updateViewportScale = (nextScale: number, anchor?: Point) => {
    setViewport((current) => {
      const scale = Math.min(1.8, Math.max(0.3, nextScale));
      if (!anchor) return { ...current, scale };
      const worldX = (anchor.x - current.x) / current.scale;
      const worldY = (anchor.y - current.y) / current.scale;
      return {
        scale,
        x: anchor.x - worldX * scale,
        y: anchor.y - worldY * scale,
      };
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (nodeDragRef.current) {
      const drag = nodeDragRef.current;
      const dx = (event.clientX - drag.x) / viewport.scale;
      const dy = (event.clientY - drag.y) / viewport.scale;
      setManualPositions((previous) => {
        const next = new Map(previous);
        next.set(drag.id, { x: drag.origin.x + dx, y: drag.origin.y + dy });
        return next;
      });
      return;
    }
    if (!panRef.current) return;
    const pan = panRef.current;
    setViewport({
      ...pan.viewport,
      x: pan.viewport.x + event.clientX - pan.x,
      y: pan.viewport.y + event.clientY - pan.y,
    });
  };

  const endPointerGesture = () => {
    panRef.current = null;
    nodeDragRef.current = null;
  };

  const selectedTaskId = selection?.kind === 'task' ? selection.taskId : null;
  return (
    <section className="mission-graph-shell" data-testid="mission-work-map">
      <header className="mission-graph-toolbar">
        <div className="mission-graph-search">
          <Ic name="search" size={12} />
          <input
            aria-label="Search Mission work"
            value={search}
            placeholder="Find task or Agent"
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <select
          aria-label="Filter Mission work"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value as MissionGraphFilter)}
        >
          <option value="all">All work</option>
          <option value="active">Running only</option>
          <option value="attention">Needs attention</option>
        </select>
        <span className="mission-graph-layers" aria-label="Graph layers">
          <button
            className={showDependencies ? 'active dependency' : ''}
            onClick={() => setShowDependencies((value) => !value)}
          >
            <i /> Dependencies
          </button>
          <button
            className={showDelegation ? 'active delegation' : ''}
            onClick={() => setShowDelegation((value) => !value)}
          >
            <i /> Delegation
          </button>
          <button
            className={showAllCommunication ? 'active communication' : 'communication has-active'}
            title="Important unresolved communication is always visible"
            onClick={() => setShowAllCommunication((value) => !value)}
          >
            <i /> {showAllCommunication ? 'All communication' : 'Active communication'}
          </button>
          <button
            className={showCritical ? 'active critical' : ''}
            onClick={() => setShowCritical((value) => !value)}
          >
            <Ic name="zap" size={10} /> Critical path
          </button>
        </span>
      </header>

      <div
        ref={viewportRef}
        className={`mission-graph-viewport ${panRef.current ? 'panning' : ''}`}
        data-replay={projection.isReplay ? 'true' : 'false'}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.target !== event.currentTarget) return;
          panRef.current = { x: event.clientX, y: event.clientY, viewport };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endPointerGesture}
        onPointerCancel={endPointerGesture}
        onWheel={(event) => {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          updateViewportScale(viewport.scale * (event.deltaY > 0 ? 0.9 : 1.1), {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          });
        }}
      >
        {projection.nodes.length === 0 ? (
          <div className="mission-graph-empty">
            <Ic name="search" size={22} />
            <strong>No matching work</strong>
            <span>Clear the search, filter, focus, or replay position.</span>
          </div>
        ) : null}
        <div
          className="mission-graph-scene"
          style={{
            width: projection.width,
            height: projection.height,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          <svg
            className="mission-graph-edges"
            width={projection.width}
            height={projection.height}
            aria-hidden="true"
          >
            <defs>
              {(['dependency', 'delegation', 'communication', 'human'] as const).map((kind) => (
                <marker
                  key={kind}
                  id={`mission-arrow-${kind}`}
                  markerWidth="8"
                  markerHeight="8"
                  refX="7"
                  refY="4"
                  orient="auto-start-reverse"
                >
                  <path className={`mission-arrow-head ${kind}`} d="M 0 0 L 8 4 L 0 8 z" />
                </marker>
              ))}
            </defs>
            {visibleEdges.map((edge) => {
              const geometry = edgePath(edge, positions, humanPosition);
              if (!geometry) return null;
              const selected = selection?.kind === 'communication' && selection.edgeId === edge.id;
              const pathClass = [
                'mission-graph-edge',
                edge.kind,
                edge.pending ? 'pending' : '',
                edge.failed ? 'failed' : '',
                edge.urgent ? 'urgent' : '',
                selected ? 'selected' : '',
                showCritical &&
                edge.kind === 'dependency' &&
                projection.nodes.find((node) => node.id === edge.sourceId)?.critical &&
                projection.nodes.find((node) => node.id === edge.targetId)?.critical
                  ? 'critical'
                  : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <g
                  key={edge.id}
                  className={pathClass}
                  data-testid={`mission-graph-edge-${edge.kind}-${edge.id}`}
                  onClick={(event) => {
                    if (edge.kind !== 'communication' && edge.kind !== 'human') return;
                    event.stopPropagation();
                    onSelection(
                      edge.kind === 'human'
                        ? { kind: 'human' }
                        : { kind: 'communication', edgeId: edge.id },
                    );
                  }}
                >
                  <path className="hit" d={geometry.path} />
                  <path
                    className="line"
                    d={geometry.path}
                    markerEnd={`url(#mission-arrow-${edge.kind})`}
                    markerStart={
                      edge.kind === 'communication' && edge.bidirectional
                        ? `url(#mission-arrow-${edge.kind})`
                        : undefined
                    }
                  />
                  {(edge.kind === 'communication' || edge.kind === 'human') && edge.count > 0 ? (
                    <g className="mission-edge-count">
                      <rect
                        x={geometry.labelX - 11}
                        y={geometry.labelY - 8}
                        width="22"
                        height="16"
                        rx="8"
                      />
                      <text x={geometry.labelX} y={geometry.labelY + 3}>
                        {edge.count}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {projection.nodes.map((node) => {
            const position = positions.get(node.id) ?? { x: node.x, y: node.y };
            const selected = selectedTaskId === node.id;
            const collapsed = collapsedTaskIds.has(node.id);
            return (
              <button
                type="button"
                key={node.id}
                className={[
                  'mission-graph-node',
                  `tone-${node.state.tone}`,
                  `coverage-${node.coverage}`,
                  selected ? 'selected' : '',
                  showCritical && node.critical ? 'critical' : '',
                  node.blockedByFailure ? 'blocked-by-failure' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{ left: position.x, top: position.y }}
                data-testid={`mission-graph-node-${node.id}`}
                onClick={() => onSelection({ kind: 'task', taskId: node.id })}
                onDoubleClick={() =>
                  setFocusTaskId((current) => (current === node.id ? null : node.id))
                }
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.stopPropagation();
                  nodeDragRef.current = {
                    id: node.id,
                    x: event.clientX,
                    y: event.clientY,
                    origin: position,
                  };
                  // Capture on the node itself. Capturing on the viewport retargets
                  // pointerup away from this button, so the browser never emits its
                  // click and the inspector remains on the previously selected task.
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                title={`${node.task.goal}\nDouble-click to focus this branch`}
              >
                <span className={`mission-graph-node-state tone-${node.state.tone}`}>
                  <Ic name={stateIcon(node)} size={13} />
                </span>
                <span className="mission-graph-node-main">
                  <span className="mission-graph-node-title">
                    <strong>{node.task.title}</strong>
                    {node.blockedByFailure ? (
                      <em title="Blocked by a failed dependency">!</em>
                    ) : null}
                  </span>
                  <span className="mission-graph-node-owner">
                    <ProviderMark
                      provider={providerMark(
                        node.principal?.provider ?? null,
                        node.principal?.kind,
                      )}
                      size={13}
                    />
                    <b>{node.principal?.displayName ?? 'Waiting for an Agent'}</b>
                    {node.assignment?.id === snapshot.mission.leadAssignmentId ? (
                      <em>Lead</em>
                    ) : null}
                  </span>
                  <span className="mission-graph-node-meta">
                    <span>
                      <Ic name={workModeIcon(node.task.workMode)} size={10} />
                      {node.task.workMode.replaceAll('-', ' ')}
                    </span>
                    <span>{node.duration}</span>
                    {node.attemptCount > 0 ? <span>Attempt {node.attemptCount}</span> : null}
                  </span>
                  <span className="mission-graph-node-foot">
                    <span className={`mission-state-pill tone-${node.state.tone}`}>
                      {node.state.label}
                    </span>
                    {node.artifactCount > 0 ? (
                      <span title={`${node.artifactCount} evidence items`}>
                        <Ic name="clipboard" size={10} /> {node.artifactCount}
                      </span>
                    ) : null}
                    {node.blockedCount > 0 ? <span>Blocks {node.blockedCount}</span> : null}
                    <span className={`coverage ${node.coverage}`}>{node.coverage}</span>
                  </span>
                </span>
                {node.delegatedCount > 0 ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="mission-graph-collapse"
                    title={collapsed ? 'Show delegated work' : 'Collapse delegated work'}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCollapsedTaskIds((previous) => {
                        const next = new Set(previous);
                        if (next.has(node.id)) next.delete(node.id);
                        else next.add(node.id);
                        return next;
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.currentTarget.click();
                    }}
                  >
                    <Ic name="chevron" size={10} />
                    {node.delegatedCount}
                  </span>
                ) : null}
              </button>
            );
          })}

          {projection.showHuman ? (
            <button
              type="button"
              className={`mission-graph-human ${selection?.kind === 'human' ? 'selected' : ''}`}
              style={{ left: humanPosition.x, top: humanPosition.y }}
              data-testid="mission-graph-human"
              onClick={() => onSelection({ kind: 'human' })}
            >
              <span>
                <Ic name="user" size={16} />
              </span>
              <strong>You</strong>
              <small>{projection.humanAttention} for you</small>
              <b>{projection.humanAttention}</b>
            </button>
          ) : null}
        </div>

        <div className="mission-graph-zoom" aria-label="Graph zoom controls">
          <button title="Zoom in" onClick={() => updateViewportScale(viewport.scale * 1.15)}>
            <Ic name="plus" size={12} />
          </button>
          <button title="Zoom out" onClick={() => updateViewportScale(viewport.scale / 1.15)}>
            <span>−</span>
          </button>
          <button title="Fit graph" onClick={fit}>
            <Ic name="layout" size={12} />
          </button>
          <button
            title="Reset manually moved nodes"
            onClick={() => {
              setManualPositions(new Map());
              setFocusTaskId(null);
              requestAnimationFrame(fit);
            }}
          >
            <Ic name="refresh" size={12} />
          </button>
        </div>
        <div className="mission-graph-minimap" aria-hidden="true">
          <svg viewBox={`0 0 ${projection.width} ${projection.height}`}>
            {projection.nodes.map((node) => {
              const position = positions.get(node.id) ?? { x: node.x, y: node.y };
              return (
                <rect
                  key={node.id}
                  className={`tone-${node.state.tone}`}
                  x={position.x}
                  y={position.y}
                  width={MISSION_GRAPH_NODE_WIDTH}
                  height={MISSION_GRAPH_NODE_HEIGHT}
                  rx="8"
                />
              );
            })}
            {projection.showHuman ? (
              <rect x={humanPosition.x} y={humanPosition.y} width="162" height="74" rx="12" />
            ) : null}
          </svg>
        </div>
      </div>

      <footer className="mission-graph-timeline" data-testid="mission-graph-timeline">
        <span className={replayAt === null ? 'live' : 'replay'}>
          <i />
          {replayAt === null ? 'Live' : 'Replay'}
        </span>
        <input
          aria-label="Mission history"
          type="range"
          min="0"
          max={Math.max(0, events.length - 1)}
          value={replayIndex}
          disabled={events.length < 2}
          onChange={(event) => {
            const index = Number(event.currentTarget.value);
            const selected = events[index];
            if (!selected || index === events.length - 1) onReplayAt(null);
            else {
              onReplayAt(selected.at);
              if (selected.taskId) onSelection({ kind: 'task', taskId: selected.taskId });
            }
          }}
        />
        <span className="mission-graph-timeline-event">
          <strong>
            {replayAt === null
              ? 'Current state'
              : (events[replayIndex]?.label ?? 'Mission history')}
          </strong>
          <small>
            {replayAt === null
              ? `${events.length} recorded events`
              : `${formatMoment(events[replayIndex]?.at ?? replayAt)} · reconstructed`}
          </small>
        </span>
        {replayAt !== null ? (
          <button onClick={() => onReplayAt(null)}>
            <Ic name="zap" size={11} /> Return live
          </button>
        ) : null}
      </footer>
    </section>
  );
}
