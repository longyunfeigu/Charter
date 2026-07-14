import { create } from 'zustand';
import type { SkillDto } from '@pi-ide/ipc-contracts';
import { rpcResult } from '../bridge.js';
import { useAppStore } from './appStore.js';

/**
 * Skills manager state (ADR-0015): the managed store as Settings and the
 * composer "/" picker see it. `refresh()` is cheap — callers pull on mount.
 */
interface SkillsStore {
  skills: SkillDto[];
  loaded: boolean;
  refresh(): Promise<void>;
  importSkill(dir?: string): Promise<SkillDto | null>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  read(id: string, relPath?: string): Promise<{ path: string; content: string } | null>;
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  skills: [],
  loaded: false,

  async refresh() {
    const res = await rpcResult('skills.list', {});
    if (res.ok) set({ skills: res.data.skills, loaded: true });
  },

  async importSkill(dir) {
    const res = await rpcResult('skills.import', dir ? { dir } : {});
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return null;
    }
    if (res.data.skill) {
      await get().refresh();
      useAppStore.getState().pushToast('success', `Skill "${res.data.skill.name}" imported.`);
    }
    return res.data.skill;
  },

  async remove(id) {
    const res = await rpcResult('skills.remove', { id });
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return;
    }
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
    if (!res.ok) {
      useAppStore.getState().pushToast('error', res.error.userMessage);
      return null;
    }
    if (res.data.binary) return { path: res.data.path, content: '(binary file)' };
    return { path: res.data.path, content: res.data.content };
  },
}));

/** Enabled skills for the composer "/" picker (Off skills never appear). */
export function enabledSkills(skills: SkillDto[]): SkillDto[] {
  return skills.filter((s) => s.enabled);
}
