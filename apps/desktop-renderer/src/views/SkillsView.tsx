import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SkillDto } from '@pi-ide/ipc-contracts';
import { useAppStore } from '../store/appStore.js';
import { useAgentCatalogStore } from '../store/agentCatalogStore.js';
import { useSkillsStore } from '../store/skillsStore.js';
import { useSkillsViewStore } from '../store/skillsViewStore.js';
import { Ic, ProviderMark } from './home-icons.js';
import {
  filterSkillGroups,
  groupSkills,
  isAgentEnabled,
  availableSkillAgents,
  scopeSkillGroups,
  skillAgent,
  skillAgentInfo,
  skillGroupCounts,
  skillNeedsReview,
  skillReviewReasons,
  type SkillAgent,
  type SkillAgentFilter,
  type SkillGroup,
} from './skills-model.js';
import { lastUsedLabel } from './skills-insight.js';
import '../styles/skills-main.css';

type DrawerScope = 'all' | SkillAgent | 'custom';

// Twelve rows cover a normal desktop viewport without mounting off-screen
// copies. Search and counters still operate over the complete catalog.
const INITIAL_VISIBLE_SKILL_GROUPS = 12;
const SKILL_GROUP_PAGE_SIZE = 24;
const USAGE_REFRESH_MAX_AGE_MS = 30_000;

interface ReviewTooltipState {
  id: string;
  label: string;
  left: number;
  top: number;
  maxWidth: number;
}

function useReviewTooltip(): {
  triggerProps: (
    label: string,
    id: string,
  ) => {
    'aria-describedby': string | undefined;
    onMouseEnter: React.MouseEventHandler<HTMLSpanElement>;
    onMouseLeave: React.MouseEventHandler<HTMLSpanElement>;
    onFocus: React.FocusEventHandler<HTMLSpanElement>;
    onBlur: React.FocusEventHandler<HTMLSpanElement>;
  };
  tooltip: React.ReactNode;
} {
  const [state, setState] = useState<ReviewTooltipState | null>(null);
  const hide = (): void => setState(null);
  const show = (target: HTMLSpanElement, label: string, id: string): void => {
    const rect = target.getBoundingClientRect();
    const maxWidth = Math.min(360, window.innerWidth - 16);
    const estimatedWidth = Math.min(maxWidth, Math.max(190, Math.ceil(label.length * 5.8) + 20));
    const rightSide = rect.right + 8;
    const left =
      rightSide + estimatedWidth <= window.innerWidth - 8
        ? rightSide
        : Math.max(8, rect.left - estimatedWidth - 8);
    setState({
      id,
      label,
      left,
      top: Math.max(8, Math.min(rect.top - 3, window.innerHeight - 120)),
      maxWidth,
    });
  };

  return {
    triggerProps: (label, id) => ({
      'aria-describedby': state?.id === id ? id : undefined,
      onMouseEnter: (event) => show(event.currentTarget, label, id),
      onMouseLeave: hide,
      onFocus: (event) => show(event.currentTarget, label, id),
      onBlur: hide,
    }),
    tooltip: state
      ? createPortal(
          <div
            id={state.id}
            className="skills-review-tooltip"
            role="tooltip"
            style={{ left: state.left, top: state.top, maxWidth: state.maxWidth }}
          >
            {state.label}
          </div>,
          document.body,
        )
      : null,
  };
}

function agentCopies(group: SkillGroup, agent: SkillAgent): SkillDto[] {
  return group.copies.filter((copy) => skillAgent(copy) === agent);
}

function initialDrawerCopies(group: SkillGroup, agent: SkillAgentFilter): SkillDto[] {
  return agent === 'all' ? group.copies : agentCopies(group, agent);
}

function groupReviewSummary(group: SkillGroup): string {
  const catalog = useAgentCatalogStore.getState().agents;
  const reviewed = group.copies.filter(skillNeedsReview);
  return reviewed
    .flatMap((copy) => {
      const agent = skillAgentInfo(skillAgent(copy), catalog);
      const prefix = reviewed.length > 1 ? `${agent.label}: ` : '';
      return skillReviewReasons(copy).map((reason) => `${prefix}${reason}`);
    })
    .join('\n');
}

function SkillDrawer(props: {
  group: SkillGroup;
  initialAgent: SkillAgentFilter;
  onClose(): void;
}): React.JSX.Element {
  const catalog = useAgentCatalogStore((state) => state.agents);
  const skillAgents = useMemo(
    () => availableSkillAgents([props.group], catalog),
    [catalog, props.group],
  );
  const setAgentEnabled = useSkillsStore((state) => state.setAgentEnabled);
  const trash = useSkillsStore((state) => state.trash);
  const pushToast = useAppStore((state) => state.pushToast);
  const [scope, setScope] = useState<DrawerScope>(props.initialAgent);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () =>
      new Set(
        initialDrawerCopies(props.group, props.initialAgent)
          .filter((copy) => !copy.protected)
          .map((copy) => copy.id),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selected = props.group.copies.filter((copy) => !copy.protected && selectedIds.has(copy.id));
  const canEnable = selected.some((copy) => !isAgentEnabled(copy));
  const canDisable = selected.some(isAgentEnabled);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [props]);

  useEffect(() => {
    const selectable = new Set(
      props.group.copies.filter((copy) => !copy.protected).map((copy) => copy.id),
    );
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => selectable.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [props.group.copies]);

  const selectScope = (nextScope: Exclude<DrawerScope, 'custom'>): void => {
    const copies = nextScope === 'all' ? props.group.copies : agentCopies(props.group, nextScope);
    setScope(nextScope);
    setSelectedIds(new Set(copies.filter((copy) => !copy.protected).map((copy) => copy.id)));
    setConfirmDelete(false);
  };

  const toggleCopy = (copy: SkillDto): void => {
    if (copy.protected) return;
    setScope('custom');
    setConfirmDelete(false);
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(copy.id)) next.delete(copy.id);
      else next.add(copy.id);
      return next;
    });
  };

  const applyEnabled = async (enabled: boolean): Promise<void> => {
    const pending = selected.filter((copy) => isAgentEnabled(copy) !== enabled);
    if (pending.length === 0) return;
    setBusy(true);
    let changed = 0;
    for (const copy of pending) {
      if (await setAgentEnabled(copy.id, enabled)) changed += 1;
    }
    setBusy(false);
    if (changed > 0) {
      pushToast(
        'success',
        `${enabled ? 'Enabled' : 'Disabled'} ${changed} installed cop${changed === 1 ? 'y' : 'ies'}.`,
      );
    }
  };

  const moveToTrash = async (): Promise<void> => {
    if (selected.length === 0) return;
    setBusy(true);
    let removed = 0;
    for (const copy of selected) {
      if (await trash(copy.id)) removed += 1;
    }
    setBusy(false);
    if (removed > 0) {
      pushToast('success', `${removed} Skill cop${removed === 1 ? 'y' : 'ies'} moved to Trash.`);
      props.onClose();
    }
  };

  return (
    <>
      <button
        className="skills-drawer-scrim"
        aria-label="Close Skill manager"
        onClick={props.onClose}
      />
      <aside
        className="skills-drawer"
        role="dialog"
        aria-label={`Manage ${props.group.displayName}`}
      >
        <header>
          <div>
            <span>Manage Skill</span>
            <h2>{props.group.displayName}</h2>
            <p>{props.group.description || 'No description in SKILL.md.'}</p>
          </div>
          <button className="skills-icon-button" aria-label="Close" onClick={props.onClose}>
            <Ic name="x" size={15} />
          </button>
        </header>

        <section className="skills-drawer-section">
          <div className="skills-drawer-label">Apply to</div>
          <div className="skills-scope-tabs" role="group" aria-label="Agent scope">
            <button className={scope === 'all' ? 'on' : ''} onClick={() => selectScope('all')}>
              All agents · {props.group.copies.length}
            </button>
            {skillAgents
              .filter((agent) => props.group.agents.includes(agent.id))
              .map((agent) => (
                <button
                  key={agent.id}
                  className={scope === agent.id ? 'on' : ''}
                  onClick={() => selectScope(agent.id)}
                >
                  {agent.shortLabel} · {agentCopies(props.group, agent.id).length}
                </button>
              ))}
          </div>
          <p className="skills-scope-help">
            Use an Agent scope as a shortcut, or select exact copies below. Unselected Agent copies
            keep working.
          </p>
        </section>

        <section className="skills-drawer-section">
          <div className="skills-copy-heading">
            <div className="skills-drawer-label">Installed copies</div>
            <span>{selected.length} selected</span>
          </div>
          <div className="skills-copy-list">
            {props.group.copies.map((copy) => {
              const agent = skillAgentInfo(skillAgent(copy), catalog);
              const checked = selectedIds.has(copy.id);
              const reviewReasons = skillReviewReasons(copy);
              return (
                <label
                  key={copy.id}
                  className={`${checked ? 'selected' : ''} ${!isAgentEnabled(copy) ? 'off' : ''} ${copy.protected ? 'protected' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={copy.protected}
                    aria-label={`Select ${agent.label} copy`}
                    data-testid={`skills-copy-select-${copy.id}`}
                    onChange={() => toggleCopy(copy)}
                  />
                  <ProviderMark provider={agent.id} size={17} />
                  <div>
                    <strong>{agent.label}</strong>
                    <small title={copy.sourcePath}>{copy.sourcePath}</small>
                    {reviewReasons.length > 0 ? (
                      <small
                        className="skills-copy-review"
                        title={reviewReasons.join('\n')}
                        data-testid={`skills-copy-review-${copy.id}`}
                      >
                        Needs review · {reviewReasons.join(' ')}
                      </small>
                    ) : null}
                  </div>
                  <span className={copy.protected ? 'locked' : isAgentEnabled(copy) ? 'on' : 'off'}>
                    {copy.protected
                      ? 'Built-in · locked'
                      : isAgentEnabled(copy)
                        ? 'Enabled'
                        : 'Disabled'}
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="skills-drawer-section skills-drawer-actions">
          <button
            className="btn primary"
            data-testid="skills-drawer-enable"
            disabled={busy || !canEnable}
            onClick={() => void applyEnabled(true)}
          >
            <Ic name="checkCircle" size={13} />
            Enable selected
          </button>
          <button
            className="btn skills-disable-action"
            data-testid="skills-drawer-disable"
            disabled={busy || !canDisable}
            onClick={() => void applyEnabled(false)}
          >
            <Ic name="ban" size={13} />
            Disable selected
          </button>
          <button
            className="btn danger"
            data-testid="skills-drawer-delete"
            disabled={busy || selected.length === 0}
            onClick={() => setConfirmDelete(true)}
          >
            <Ic name="trash" size={13} />
            Delete selected…
          </button>
          {props.group.copies.some((copy) => copy.protected) ? (
            <span>
              {props.group.copies.filter((copy) => copy.protected).length} built-in cop
              {props.group.copies.filter((copy) => copy.protected).length === 1
                ? 'y is'
                : 'ies are'}{' '}
              locked and cannot be selected.
            </span>
          ) : null}
        </section>

        {confirmDelete ? (
          <section className="skills-delete-confirm" data-testid="skills-delete-confirm">
            <div>
              <strong>
                Move {selected.length} selected cop{selected.length === 1 ? 'y' : 'ies'} to Trash?
              </strong>
              <p>
                This removes only the selected Agent installations. The OS Trash remains
                recoverable.
              </p>
            </div>
            <button className="btn" disabled={busy} onClick={() => setConfirmDelete(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              data-testid="skills-delete-confirm-button"
              disabled={busy}
              onClick={() => void moveToTrash()}
            >
              Move to Trash
            </button>
          </section>
        ) : null}
      </aside>
    </>
  );
}

export function SkillsView(): React.JSX.Element {
  const catalog = useAgentCatalogStore((state) => state.agents);
  const skills = useSkillsStore((state) => state.skills);
  const usage = useSkillsStore((state) => state.usage);
  const usageWindowDays = useSkillsStore((state) => state.usageWindowDays);
  const usageLoaded = useSkillsStore((state) => state.usageLoaded);
  const usageRefreshedAt = useSkillsStore((state) => state.usageRefreshedAt);
  const loaded = useSkillsStore((state) => state.loaded);
  const init = useSkillsStore((state) => state.init);
  const refreshUsage = useSkillsStore((state) => state.refreshUsage);
  const rescan = useSkillsStore((state) => state.rescan);
  const status = useSkillsViewStore((state) => state.status);
  const agent = useSkillsViewStore((state) => state.agent);
  const query = useSkillsViewStore((state) => state.query);
  const sort = useSkillsViewStore((state) => state.sort);
  const setStatus = useSkillsViewStore((state) => state.setStatus);
  const setAgent = useSkillsViewStore((state) => state.setAgent);
  const setQuery = useSkillsViewStore((state) => state.setQuery);
  const setSort = useSkillsViewStore((state) => state.setSort);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_SKILL_GROUPS);
  const reviewTooltip = useReviewTooltip();

  useEffect(() => {
    init();
    // Transcript evidence can involve thousands of host files. Let the Skills
    // shell paint first, and reuse a recent snapshot when navigating away and
    // back instead of restarting that work on every click.
    if (usageRefreshedAt !== null && Date.now() - usageRefreshedAt < USAGE_REFRESH_MAX_AGE_MS) {
      return;
    }
    const idleId = window.requestIdleCallback(() => void refreshUsage(), { timeout: 1_000 });
    return () => window.cancelIdleCallback(idleId);
  }, [init, refreshUsage, usageRefreshedAt]);

  const groups = useMemo(
    () => groupSkills(skills, usage, usageLoaded),
    [skills, usage, usageLoaded],
  );
  const skillAgents = useMemo(() => availableSkillAgents(groups, catalog), [catalog, groups]);
  const selected = selectedKey ? (groups.find((group) => group.key === selectedKey) ?? null) : null;
  const scopedGroups = useMemo(
    () => scopeSkillGroups(groups, agent, usageLoaded),
    [agent, groups, usageLoaded],
  );
  const counts = useMemo(() => skillGroupCounts(scopedGroups), [scopedGroups]);
  const visible = useMemo(
    () => filterSkillGroups(scopedGroups, { status, agent: 'all', query, sort }),
    [query, scopedGroups, sort, status],
  );
  const renderedGroups = useMemo(() => visible.slice(0, visibleLimit), [visible, visibleLimit]);
  useEffect(() => {
    setVisibleLimit(INITIAL_VISIBLE_SKILL_GROUPS);
  }, [agent, query, sort, status]);
  const selectedAgent =
    agent === 'all' ? null : (skillAgents.find((item) => item.id === agent) ?? null);
  const usageAgents = selectedAgent ? [selectedAgent] : skillAgents;
  const now = Date.now();
  return (
    <main className="skills-main" data-testid="skills-main-page">
      <div className="skills-main-inner">
        <header className="skills-page-head">
          <div>
            <h1>Skills</h1>
            <p>
              See what is installed, what has observable usage, and what needs a decision per Agent.
            </p>
          </div>
          <div className="skills-page-actions">
            <button className="btn" data-testid="skills-rescan" onClick={() => void rescan()}>
              <Ic name="refresh" size={13} /> Rescan
            </button>
          </div>
        </header>

        <div className="skills-controls">
          <div className="skills-status-tabs" role="group" aria-label="Skill status">
            <button className={status === 'all' ? 'on' : ''} onClick={() => setStatus('all')}>
              All {counts.all}
            </button>
            <button className={status === 'active' ? 'on' : ''} onClick={() => setStatus('active')}>
              Observed {usageLoaded ? counts.active : '—'}
            </button>
            <button className={status === 'review' ? 'on' : ''} onClick={() => setStatus('review')}>
              Review {usageLoaded ? counts.review : '—'}
            </button>
            <button
              className={status === 'disabled' ? 'on' : ''}
              onClick={() => setStatus('disabled')}
            >
              Disabled {counts.disabled}
            </button>
          </div>
          <div className="skills-agent-tabs" role="group" aria-label="Installed Agent">
            <button className={agent === 'all' ? 'on' : ''} onClick={() => setAgent('all')}>
              All agents
            </button>
            {skillAgents.map((item) => (
              <button
                key={item.id}
                className={agent === item.id ? 'on' : ''}
                onClick={() => setAgent(item.id)}
              >
                {item.shortLabel}
              </button>
            ))}
          </div>
          <label className="skills-search">
            <Ic name="search" size={13} />
            <input
              value={query}
              placeholder="Search Skills or sources"
              aria-label="Search Skills"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            value={sort}
            aria-label="Sort Skills"
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="uses">Most used</option>
            <option value="recent">Recently used</option>
            <option value="name">Name</option>
          </select>
        </div>

        <section className="skills-table-frame">
          <table>
            <colgroup>
              <col className="skills-col-name" />
              <col className="skills-col-installed" />
              <col className="skills-col-usage" />
              <col className="skills-col-last" />
              <col className="skills-col-manage" />
            </colgroup>
            <thead>
              <tr>
                <th>Skill</th>
                <th>{selectedAgent ? `${selectedAgent.label} installation` : 'Installed in'}</th>
                <th>
                  {selectedAgent ? `${selectedAgent.label} usage` : 'Observed usage'}
                  <span>{usageWindowDays}-day observation window</span>
                </th>
                <th className="numeric">Last used</th>
                <th aria-label="Manage" />
              </tr>
            </thead>
            <tbody>
              {renderedGroups.map((group) => {
                const last = lastUsedLabel(group.lastUsedAt, now);
                const allOff = group.copies.every((copy) => !isAgentEnabled(copy));
                const reviewSummary = groupReviewSummary(group);
                return (
                  <tr key={group.key} className={allOff ? 'is-off' : ''}>
                    <td>
                      <div className="skills-name-cell">
                        <div>
                          <strong>{group.displayName}</strong>
                          {group.copies.some((copy) => copy.explicitOnly) ? (
                            <span className="explicit">explicit</span>
                          ) : null}
                          {group.protectedOnly ? <span className="system">system</span> : null}
                          {group.needsTechnicalReview ? (
                            <span
                              {...reviewTooltip.triggerProps(
                                reviewSummary,
                                `skills-review-tooltip-${group.key.replace(/[^a-z0-9_-]/gi, '-')}`,
                              )}
                              className="review"
                              tabIndex={0}
                              aria-label={`Needs review: ${reviewSummary}`}
                            >
                              needs review
                            </span>
                          ) : null}
                          {group.noObservedUse ? (
                            <span className="unobserved">no observed use</span>
                          ) : null}
                        </div>
                        <small title={group.description}>
                          {group.description || 'No description in SKILL.md.'}
                        </small>
                      </div>
                    </td>
                    <td>
                      <div className="skills-install-pills">
                        {skillAgents
                          .filter((item) => group.agents.includes(item.id))
                          .map((item) => {
                            const copies = agentCopies(group, item.id);
                            const enabled = copies.some(isAgentEnabled);
                            const locked = copies.every((copy) => copy.protected);
                            return (
                              <span
                                key={item.id}
                                className={`${item.id} ${enabled ? '' : 'off'} ${locked ? 'locked' : ''}`}
                              >
                                <i />
                                {item.shortLabel}
                                {locked ? ' · built-in' : enabled ? '' : ' · off'}
                              </span>
                            );
                          })}
                      </div>
                    </td>
                    <td>
                      <div className="skills-usage-rollup">
                        {usageAgents.map((item) => (
                          <span
                            key={item.id}
                            className={item.id}
                            title={`${item.label} observed usage`}
                          >
                            <i />
                            <b>{!usageLoaded ? '—' : (group.usesByAgent[item.id] ?? 0)}</b>
                            {usageLoaded ? <small>×</small> : null}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className={`skills-metric ${last ? '' : 'never'}`}>
                      <strong>{usageLoaded ? (last ?? 'never') : '—'}</strong>
                      <small>{usageLoaded ? `${group.uses} observed` : 'loading…'}</small>
                    </td>
                    <td>
                      <div className="skills-decision">
                        <button
                          data-testid={`skills-manage-${group.key}`}
                          onClick={() => setSelectedKey(group.key)}
                        >
                          Manage
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {renderedGroups.length < visible.length ? (
            <button
              className="skills-show-more"
              data-testid="skills-show-more"
              onClick={() =>
                setVisibleLimit((current) =>
                  Math.min(visible.length, current + SKILL_GROUP_PAGE_SIZE),
                )
              }
            >
              <strong>
                Show {Math.min(SKILL_GROUP_PAGE_SIZE, visible.length - renderedGroups.length)} more
              </strong>
              <span>{visible.length - renderedGroups.length} remaining</span>
            </button>
          ) : null}
          {loaded && visible.length === 0 ? (
            <div className="skills-empty">
              <strong>No Skills in this view</strong>
              <span>Try another Agent, status, or search term.</span>
            </div>
          ) : null}
          {!loaded ? (
            <div className="skills-empty">
              <strong>Scanning Skills…</strong>
            </div>
          ) : null}
        </section>
      </div>
      {selected ? (
        <SkillDrawer
          key={`${selected.key}:${agent}`}
          group={selected}
          initialAgent={agent}
          onClose={() => setSelectedKey(null)}
        />
      ) : null}
      {reviewTooltip.tooltip}
    </main>
  );
}
