import { create } from 'zustand';
import type { SkillDto, SkillSourceDto } from '@pi-ide/ipc-contracts';
import { onEvent, rpcResult } from '../bridge.js';
import { okOrToast, useAppStore } from './appStore.js';

/**
 * Skills manager state (ADR-0015): the managed store as Settings and the
 * composer "/" picker see it. `refresh()` is cheap — callers pull on mount.
 */
interface SkillsStore {
  skills: SkillDto[];
  sources: SkillSourceDto[];
  loaded: boolean;
  initialized: boolean;
  init(): void;
  refresh(): Promise<void>;
  rescan(): Promise<void>;
  importSkill(dir?: string): Promise<SkillDto | null>;
  addSource(dir?: string): Promise<SkillSourceDto | null>;
  removeSource(id: string): Promise<void>;
  setSourcePolicy(id: string, patch: { trusted?: boolean; autoEnableNew?: boolean }): Promise<void>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  read(id: string, relPath?: string): Promise<{ path: string; content: string } | null>;
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: [],
  sources: [],
  loaded: false,
  initialized: false,

  init() {
    if (get().initialized) return;
    set({ initialized: true });
    onEvent('skills.changed', () => void get().refresh());
    void get().refresh();
  },

  async refresh() {
    const res = await rpcResult('skills.list', {});
    if (res.ok) set({ skills: res.data.skills, sources: res.data.sources, loaded: true });
  },

  async rescan() {
    const res = await rpcResult('skills.rescan', {});
    if (res.ok) {
      set({ skills: res.data.skills, sources: res.data.sources, loaded: true });
      useAppStore.getState().pushToast('success', 'Skill sources rescanned.');
    } else {
      useAppStore.getState().pushToast('error', res.error.userMessage);
    }
  },

  async importSkill(dir) {
    const res = await rpcResult('skills.import', dir ? { dir } : {});
    if (!okOrToast(res)) return null;
    if (res.data.skill) {
      await get().refresh();
      useAppStore.getState().pushToast('success', `Skill "${res.data.skill.name}" imported.`);
    }
    return res.data.skill;
  },

  async addSource(dir) {
    const res = await rpcResult('skills.addSource', dir ? { dir } : {});
    if (!okOrToast(res)) return null;
    if (res.data.source) {
      await get().refresh();
      useAppStore.getState().pushToast('success', `${res.data.source.label} connected.`);
    }
    return res.data.source;
  },

  async removeSource(id) {
    const res = await rpcResult('skills.removeSource', { id });
    if (!okOrToast(res)) return;
    await get().refresh();
  },

  async setSourcePolicy(id, patch) {
    const res = await rpcResult('skills.setSourcePolicy', { id, ...patch });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      await get().refresh();
      return;
    }
    await get().refresh();
  },

  async remove(id) {
    const res = await rpcResult('skills.remove', { id });
    if (!okOrToast(res)) return;
    await get().refresh();
  },

  async setEnabled(id, enabled) {
    // Optimistic — the toggle must feel instant; refresh reconciles.
    set({ skills: get().skills.map((s) => (s.id === id ? { ...s, enabled } : s)) });
    const res = await rpcResult('skills.setEnabled', { id, enabled });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      await get().refresh();
    }
  },

  async read(id, relPath) {
    const res = await rpcResult('skills.read', {
      id,
      ...(relPath !== undefined ? { relPath } : {}),
    });
    if (!okOrToast(res)) return null;
    if (res.data.binary) return { path: res.data.path, content: '(binary file)' };
    return { path: res.data.path, content: res.data.content };
  },
}));

/** Enabled skills for the composer "/" picker (Off skills never appear). */
export function enabledSkills(skills: SkillDto[]): SkillDto[] {
  return skills.filter((s) => s.enabled);
}
