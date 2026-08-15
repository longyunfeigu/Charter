import { create } from 'zustand';
import type {
  AgentAdapterDiagnostic,
  AgentCatalogDto,
  AgentPackDto,
  DetectedAgentDto,
} from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';

interface AgentCatalogStore {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  agents: DetectedAgentDto[];
  scannedAt: string | null;
  engineVersion: number;
  overrideEnabled: boolean;
  diagnostics: AgentAdapterDiagnostic[];
  packs: AgentPackDto[];
  packBusy: string | null;
  init(): void;
  refresh(force?: boolean): Promise<void>;
  loadPacks(): Promise<void>;
  installPack(): Promise<void>;
  setPackEnabled(id: string, enabled: boolean): Promise<void>;
  rollbackPack(id: string): Promise<void>;
  removePack(id: string): Promise<void>;
}

const EMPTY_CATALOG: AgentCatalogDto = {
  agents: [],
  scannedAt: new Date(0).toISOString(),
  engineVersion: 1,
  overrideEnabled: false,
  diagnostics: [],
};

export const useAgentCatalogStore = create<AgentCatalogStore>((set, get) => ({
  initialized: false,
  loading: false,
  error: null,
  agents: EMPTY_CATALOG.agents,
  scannedAt: null,
  engineVersion: EMPTY_CATALOG.engineVersion,
  overrideEnabled: EMPTY_CATALOG.overrideEnabled,
  diagnostics: EMPTY_CATALOG.diagnostics,
  packs: [],
  packBusy: null,

  init() {
    if (get().initialized || get().loading) return;
    set({ initialized: true });
    void get().refresh(false);
    void get().loadPacks();
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
      engineVersion: result.data.engineVersion,
      overrideEnabled: result.data.overrideEnabled,
      diagnostics: result.data.diagnostics,
    });
  },

  async loadPacks() {
    const result = await rpcResult('agents.packs.list', {});
    if (!result.ok) {
      set({ error: result.error.userMessage });
      return;
    }
    set({ packs: result.data.packs });
  },

  async installPack() {
    if (get().packBusy) return;
    set({ packBusy: 'install', error: null });
    const result = await rpcResult('agents.packs.install', {});
    if (!result.ok) {
      set({ packBusy: null, error: result.error.userMessage });
      return;
    }
    set({ packBusy: null, packs: result.data.catalog.packs });
    if (result.data.changed) await get().refresh(true);
  },

  async setPackEnabled(id, enabled) {
    if (get().packBusy) return;
    set({ packBusy: id, error: null });
    const result = await rpcResult('agents.packs.setEnabled', { id, enabled });
    if (!result.ok) {
      set({ packBusy: null, error: result.error.userMessage });
      return;
    }
    set({ packBusy: null, packs: result.data.catalog.packs });
    await get().refresh(true);
  },

  async rollbackPack(id) {
    if (get().packBusy) return;
    set({ packBusy: id, error: null });
    const result = await rpcResult('agents.packs.rollback', { id });
    if (!result.ok) {
      set({ packBusy: null, error: result.error.userMessage });
      return;
    }
    set({ packBusy: null, packs: result.data.catalog.packs });
    await get().refresh(true);
  },

  async removePack(id) {
    if (get().packBusy) return;
    set({ packBusy: id, error: null });
    const result = await rpcResult('agents.packs.remove', { id });
    if (!result.ok) {
      set({ packBusy: null, error: result.error.userMessage });
      return;
    }
    set({ packBusy: null, packs: result.data.catalog.packs });
    await get().refresh(true);
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
