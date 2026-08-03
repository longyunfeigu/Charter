import { create } from 'zustand';
import type { AgentCatalogDto, DetectedAgentDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';

interface AgentCatalogStore {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  agents: DetectedAgentDto[];
  scannedAt: string | null;
  init(): void;
  refresh(force?: boolean): Promise<void>;
}

const EMPTY_CATALOG: AgentCatalogDto = { agents: [], scannedAt: new Date(0).toISOString() };

export const useAgentCatalogStore = create<AgentCatalogStore>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  agents: EMPTY_CATALOG.agents,
  scannedAt: null,

  init() {
    if (get().initialized || get().loading) return;
    set({ initialized: true });
    void get().refresh(false);
  },

  async refresh(force = true) {
    if (get().loading) return;
    set({ loading: true, error: null });
    const result = await rpcResult('agents.list', { refresh: force });
    if (!result.ok) {
      set({ loading: false, error: result.error.userMessage });
      return;
    }
    set({
      loading: false,
      agents: result.data.agents,
      scannedAt: result.data.scannedAt,
    });
  },
}));

export function detectedAgent(agentId: string): DetectedAgentDto | null {
  return useAgentCatalogStore.getState().agents.find((agent) => agent.id === agentId) ?? null;
}

export function agentDisplayName(agentId: string, compact = false): string {
  if (agentId === 'pi' || agentId === 'managed') return compact ? 'Charter' : 'Charter Agent';
  if (agentId === 'shell') return compact ? 'Shell' : 'Shell Agent';
  const agent = detectedAgent(agentId);
  if (agent) return compact ? agent.shortName : agent.displayName;
  return agentId
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function installedTerminalAgents(): DetectedAgentDto[] {
  return useAgentCatalogStore
    .getState()
    .agents.filter((agent) => agent.installed && agent.capabilities.terminal);
}

export function installedRuntimeAgents(): DetectedAgentDto[] {
  return useAgentCatalogStore
    .getState()
    .agents.filter(
      (agent) => agent.installed && (agent.capabilities.acp || agent.capabilities.terminal),
    );
}
