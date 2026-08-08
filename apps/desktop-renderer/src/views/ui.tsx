import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ModelDescriptorDto } from '@pi-ide/ipc-contracts';
import { Ic } from './home-icons.js';
import { THINKING_LEVELS, type ThinkingLevelId, clampThinkingLevelTo } from './labels.js';

function visiblePopoverTop(trigger: HTMLElement): number {
  const titlebarBottom =
    document.querySelector<HTMLElement>('.titlebar')?.getBoundingClientRect().bottom ?? 0;
  let top = Math.max(0, titlebarBottom);
  for (let parent = trigger.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowY === 'hidden' ||
      overflowY === 'clip'
    ) {
      top = Math.max(top, parent.getBoundingClientRect().top);
    }
  }
  return top;
}

/**
 * Two-step destructive action (ADR-0008 §3): first click arms the button,
 * the confirm step is explicit and reversible, and it disarms on blur/timeout.
 * E2E: `${testid}` arms, `${testid}-confirm` fires, `${testid}-cancel` disarms.
 */
export function ConfirmDangerButton(props: {
  label: string;
  confirmLabel?: string;
  confirmDescription?: React.ReactNode;
  testid: string;
  disabled?: boolean;
  quiet?: boolean;
  icon?: string;
  title?: string;
  onConfirm: () => void;
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), 8000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [armed]);

  if (!armed) {
    return (
      <button
        className={props.quiet ? 'btn quiet-danger' : 'btn danger'}
        data-testid={props.testid}
        disabled={props.disabled === true}
        {...(props.title ? { title: props.title } : {})}
        onClick={() => setArmed(true)}
      >
        {props.icon ? <Ic name={props.icon} size={14} /> : null}
        {props.label}
      </button>
    );
  }
  return (
    <span
      className={`confirm-danger-inline${props.confirmDescription ? ' with-description' : ''}`}
      role="group"
      aria-label={`Confirm ${props.label.replace(/…$/, '')}`}
    >
      {props.confirmDescription ? (
        <span className="confirm-danger-copy" data-testid={`${props.testid}-description`}>
          {props.confirmDescription}
        </span>
      ) : null}
      <span className="confirm-danger-actions">
        <button
          className="btn danger"
          data-testid={`${props.testid}-confirm`}
          onClick={() => {
            setArmed(false);
            props.onConfirm();
          }}
        >
          {props.confirmLabel ?? `Confirm — ${props.label.replace(/…$/, '')}`}
        </button>
        <button
          className="btn"
          data-testid={`${props.testid}-cancel`}
          onClick={() => setArmed(false)}
        >
          Keep
        </button>
      </span>
    </span>
  );
}

/**
 * Two-step icon-sized destructive action for dense rows (same arm/confirm
 * contract as ConfirmDangerButton, sized for list hover affordances).
 * First click arms it (turns red, tooltip flips), second click fires;
 * it disarms on mouse leave or after 8s (same window as ConfirmDangerButton).
 */
export function ArmedIconButton(props: {
  icon: string;
  iconSize?: number;
  title: string;
  armedTitle: string;
  testid: string;
  className?: string;
  disabled?: boolean;
  tooltipProps?: Pick<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    'aria-describedby' | 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'
  >;
  onInteract?: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!armed) return;
    timer.current = setTimeout(() => setArmed(false), 8000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [armed]);

  const tooltipProps = props.tooltipProps;

  return (
    <button
      {...tooltipProps}
      className={`${props.className ?? ''} ${armed ? 'armed' : ''}`}
      data-testid={props.testid}
      title={tooltipProps ? undefined : armed ? props.armedTitle : props.title}
      aria-label={armed ? props.armedTitle : props.title}
      disabled={props.disabled}
      onMouseLeave={(event) => {
        setArmed(false);
        tooltipProps?.onMouseLeave?.(event);
      }}
      onBlur={(event) => {
        setArmed(false);
        tooltipProps?.onBlur?.(event);
      }}
      onClick={(e) => {
        e.stopPropagation();
        props.onInteract?.();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.onConfirm();
      }}
    >
      <Ic name={armed ? 'check' : props.icon} size={props.iconSize ?? 12} strokeWidth={2} />
    </button>
  );
}

/**
 * Merged model + reasoning-effort control (shared by the Home composer and the
 * Task Room follow-up). One pill — "✦ Model · effort ⌄" — opens a popover with
 * the configured models (grouped per provider) and an effort segment scoped to
 * the *selected* model's supported levels, so an effort choice always reads
 * against its model. Switching model clamps the effort to the nearest supported
 * level (mirrors the runtime's own clamp). Replaces the two free-floating
 * `<select>`s where the effort could drift away from the model it applies to.
 *
 * The trigger keeps `data-testid="${testid}-model"` and renders the model's
 * display name, so existing readiness assertions still find it.
 */
export function ModelEffortControl(props: {
  models: ModelDescriptorDto[];
  modelKey: string;
  onModelKey: (key: string) => void;
  thinking: ThinkingLevelId;
  onThinking: (level: ThinkingLevelId) => void;
  onConfigureModels?: () => void;
  /** Prefix for data-testids: `${testid}-model` (trigger), `-model-opt-<key>`, `-effort-<level>`. */
  testid: string;
}): React.JSX.Element {
  const { models, modelKey, onModelKey, thinking, onThinking, onConfigureModels, testid } = props;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Group models by provider, preserving the catalogue order (PIVOT-033).
  const groups = useMemo(() => {
    const out: Array<{ providerId: string; providerName: string; models: ModelDescriptorDto[] }> =
      [];
    for (const m of models) {
      const last = out[out.length - 1];
      if (last && last.providerId === m.providerId) last.models.push(m);
      else out.push({ providerId: m.providerId, providerName: m.providerName, models: [m] });
    }
    return out;
  }, [models]);

  const selected = useMemo(
    () => models.find((m) => `${m.providerId}::${m.modelId}` === modelKey) ?? null,
    [models, modelKey],
  );
  const supported = useMemo<readonly ThinkingLevelId[]>(() => {
    const list = selected?.supportedThinkingLevels;
    if (!list || list.length === 0) return THINKING_LEVELS;
    return THINKING_LEVELS.filter((l) => list.includes(l));
  }, [selected]);
  const effortDisabled = supported.length === 1 && supported[0] === 'off';

  // Effort × model linkage: keep the current choice inside the model's set.
  useEffect(() => {
    const clamped = clampThinkingLevelTo(supported, thinking);
    if (clamped !== thinking) onThinking(clamped);
  }, [supported, thinking, onThinking]);

  // The pop opens upward. Its usable space begins below the title bar and the
  // nearest clipping/scrolling surface, not at window y=0. Measuring only the
  // viewport let long gateway model lists extend behind Home's clipped top.
  const [popMaxHeight, setPopMaxHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const triggerTop = trigger.getBoundingClientRect().top;
      // 8px is the CSS gap above the trigger; the second 8px keeps the card
      // visibly detached from the clipping edge.
      const availableAbove = Math.max(0, triggerTop - visiblePopoverTop(trigger) - 16);
      setPopMaxHeight(Math.floor(Math.min(availableAbove, window.innerHeight * 0.6)));
    };
    measure();
    const onScroll = (event: Event): void => {
      const target = event.target;
      // Scrolling the model rows does not move the anchor; avoid doing layout
      // reads on every wheel frame. Ancestor-page scrolls still remeasure.
      if (target instanceof Node && ref.current?.contains(target)) return;
      measure();
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Close on any outside interaction (it overlays the composer).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const hasModels = models.length > 0;
  const label = selected ? selected.displayName : hasModels ? 'Select a model' : 'No model';

  return (
    <div className="me" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="me-btn"
        data-testid={`${testid}-model`}
        data-model-key={modelKey}
        title={
          selected
            ? `${selected.displayName} · reasoning effort ${effortDisabled ? 'n/a' : thinking}`
            : 'No model — add a provider key in Settings'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ic name="zap" size={13} className="me-spark" strokeWidth={1.7} />
        <span className="me-name">{label}</span>
        {selected && !effortDisabled ? <span className="me-eff-lbl">{thinking}</span> : null}
        <Ic name="chevron" size={12} className="me-chev" />
      </button>
      {open ? (
        <div
          className="me-pop"
          data-testid={`${testid}-modeleffort-pop`}
          role="menu"
          style={popMaxHeight !== null ? { maxHeight: `${popMaxHeight}px` } : undefined}
        >
          <div className="me-cap">Model</div>
          {hasModels ? (
            <div className="me-list">
              {groups.map((g) => (
                <React.Fragment key={g.providerId}>
                  {groups.length > 1 ? <div className="me-prov">{g.providerName}</div> : null}
                  {g.models.map((m) => {
                    const key = `${m.providerId}::${m.modelId}`;
                    const on = key === modelKey;
                    return (
                      <button
                        type="button"
                        key={key}
                        className={`me-row ${on ? 'on' : ''}`}
                        data-testid={`${testid}-model-opt-${key}`}
                        role="menuitemradio"
                        aria-checked={on}
                        onClick={() => onModelKey(key)}
                      >
                        <Ic name="check" size={13} strokeWidth={2.2} className="ck" />
                        <span className="mname">{m.displayName}</span>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          ) : (
            <div className="me-empty">
              <div>No model — add a provider key in Settings.</div>
              {onConfigureModels ? (
                <button
                  type="button"
                  className="btn primary"
                  data-testid={`${testid}-model-settings`}
                  data-overlay-focus-return={`${testid}-model`}
                  onClick={() => {
                    setOpen(false);
                    onConfigureModels();
                  }}
                >
                  Open Model settings
                </button>
              ) : null}
            </div>
          )}
          {selected ? (
            <>
              <div className="me-div" />
              <div className="me-cap">Reasoning effort</div>
              <div className="me-eff">
                {THINKING_LEVELS.map((l) => {
                  const ok = supported.includes(l);
                  return (
                    <button
                      type="button"
                      key={l}
                      className={thinking === l ? 'on' : ''}
                      data-testid={`${testid}-effort-${l}`}
                      disabled={!ok}
                      title={
                        ok
                          ? l === 'off'
                            ? 'No reasoning'
                            : `Reasoning effort: ${l}`
                          : `${selected.displayName} does not support ${l}`
                      }
                      onClick={() => onThinking(l)}
                    >
                      {l}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
