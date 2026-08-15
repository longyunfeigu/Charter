import { create } from 'zustand';
import type { AgentPresenceExplain, AgentPresenceSnapshot } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';

interface AgentPresenceStore {
  initialized: boolean;
  byTerminal: Record<string, AgentPresenceSnapshot>;
  init(): void;
  explain(terminalId: string): Promise<AgentPresenceExplain | null>;
  markSeen(
    terminalId: string,
    surface: 'session-rail' | 'session-header' | 'terminal-header',
  ): Promise<void>;
}

let eventsAttached = false;

function mergePresence(
  current: Record<string, AgentPresenceSnapshot>,
  incoming: AgentPresenceSnapshot,
): Record<string, AgentPresenceSnapshot> {
  const previous = current[incoming.terminalId];
  if (previous && previous.stateChangeSeq > incoming.stateChangeSeq) return current;
  return { ...current, [incoming.terminalId]: incoming };
}

export const useAgentPresenceStore = create<AgentPresenceStore>((set, get) => ({
  initialized: false,
  byTerminal: {},

  init() {
    if (!eventsAttached) {
      eventsAttached = true;
      onEvent('agentPresence.changed', (presence) => {
        set((state) => ({ byTerminal: mergePresence(state.byTerminal, presence) }));
      });
    }
    if (get().initialized) return;
    set({ initialized: true });
    void rpcResult('agentPresence.list', {}).then((result) => {
      if (!result.ok) return;
      set((state) => ({
        byTerminal: result.data.presences.reduce(mergePresence, state.byTerminal),
      }));
    });
  },

  async explain(terminalId) {
    const result = await rpcResult('agentPresence.explain', { terminalId });
    return result.ok ? result.data.explain : null;
  },

  async markSeen(terminalId, surface) {
    const result = await rpcResult('agentPresence.markSeen', { terminalId, surface });
    if (!result.ok || !result.data.presence) return;
    set((state) => ({
      byTerminal: mergePresence(state.byTerminal, result.data.presence!),
    }));
  },
}));

export type AgentPresenceTone = 'active' | 'attention' | 'success' | 'neutral';

export function agentPresencePresentation(presence: AgentPresenceSnapshot): {
  label: string;
  detail: string;
  tone: AgentPresenceTone;
} {
  if (presence.processState === 'exited') {
    return { label: 'Ended', detail: 'Agent process exited', tone: 'neutral' };
  }
  if (presence.lifecycle === 'blocked') {
    return { label: 'Needs you', detail: 'Agent is waiting for your input', tone: 'attention' };
  }
  if (presence.lifecycle === 'working') {
    return { label: 'Working', detail: 'Agent is working', tone: 'active' };
  }
  if (presence.lifecycle === 'idle' && presence.attention === 'done') {
    return { label: 'Done', detail: 'Latest reply is ready', tone: 'success' };
  }
  if (presence.lifecycle === 'idle') {
    return { label: 'Ready', detail: 'Agent is ready for input', tone: 'success' };
  }
  return {
    label: 'Starting',
    detail: 'Waiting for reliable Agent state evidence',
    tone: 'neutral',
  };
}
