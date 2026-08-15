import React, { useEffect, useRef, useState } from 'react';
import type { AgentPresenceExplain } from '@pi-ide/ipc-contracts';
import { agentPresencePresentation, useAgentPresenceStore } from '../store/agentPresenceStore.js';

export function AgentPresenceBadge({
  terminalId,
  explainable = false,
}: {
  terminalId: string;
  explainable?: boolean;
}): React.JSX.Element | null {
  const presence = useAgentPresenceStore((state) => state.byTerminal[terminalId]);
  const [open, setOpen] = useState(false);
  const [explain, setExplain] = useState<AgentPresenceExplain | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => useAgentPresenceStore.getState().init(), []);
  useEffect(() => {
    setOpen(false);
    setExplain(null);
  }, [terminalId]);
  if (!presence) return null;

  const presentation = agentPresencePresentation(presence);
  const toggleExplain = (): void => {
    if (!explainable) return;
    const next = !open;
    setOpen(next);
    if (next) {
      void useAgentPresenceStore
        .getState()
        .explain(terminalId)
        .then((value) => setExplain(value));
    }
  };

  return (
    <span
      ref={rootRef}
      className="agent-presence-wrap"
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={`agent-presence-badge tone-${presentation.tone}`}
        data-testid={`agent-presence-${terminalId}`}
        data-lifecycle={presence.lifecycle}
        data-attention={presence.attention}
        title={
          explainable
            ? `${presentation.detail}. Click for detection evidence.`
            : presentation.detail
        }
        aria-label={`${presentation.label}: ${presentation.detail}`}
        aria-expanded={explainable ? open : undefined}
        disabled={!explainable}
        onClick={(event) => {
          event.stopPropagation();
          toggleExplain();
        }}
      >
        <i /> {presentation.label}
      </button>
      {open ? (
        <span className="agent-presence-popover" role="status" data-testid="agent-presence-explain">
          <strong>Why {presentation.label}?</strong>
          {explain ? (
            <>
              <span>
                {explain.matchedRule
                  ? `Rule ${explain.matchedRule.id} matched ${explain.matchedRule.region}.`
                  : (explain.fallbackReason ?? 'No rule evidence is available.')}
              </span>
              <code>
                {presence.source} · seq {presence.stateChangeSeq} · manifest{' '}
                {presence.manifestVersion ?? 'none'}
              </code>
              {explain.oscTitle ? <small>OSC title: {explain.oscTitle}</small> : null}
            </>
          ) : (
            <span>Reading current terminal evidence…</span>
          )}
        </span>
      ) : null}
    </span>
  );
}
