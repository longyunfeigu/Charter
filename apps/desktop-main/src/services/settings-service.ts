import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveSettings, type ResolvedSettings } from '@pi-ide/app-domain';
import type { Settings } from '@pi-ide/ipc-contracts';
import { WORKSPACE_OVERRIDABLE_SECTIONS } from '@pi-ide/ipc-contracts';
import { errorMessage, productError, ProductFailure, type Logger } from '@pi-ide/foundation';

type PlainObject = Record<string, unknown>;

export interface SettingsState {
  effective: Settings;
  issues: string[];
  overrideKeys: string[];
}

/**
 * Global settings live in settings.json (non-sensitive only, spec §11.1);
 * workspace overrides are provided by the workspace layer (DB) via setWorkspaceOverride.
 */
export class SettingsService {
  private globalRaw: PlainObject = {};
  private workspaceOverride: PlainObject | null = null;
  private resolved: ResolvedSettings;
  private readonly listeners = new Set<(state: SettingsState) => void>();

  constructor(
    private readonly file: string,
    private readonly logger: Logger,
  ) {
    this.globalRaw = this.loadFile();
    this.resolved = resolveSettings(this.globalRaw, null);
    if (this.resolved.issues.length > 0) {
      this.logger.warn('settings issues on load', { issues: this.resolved.issues });
    }
  }

  private loadFile(): PlainObject {
    try {
      if (!existsSync(this.file)) return {};
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as PlainObject) : {};
    } catch (e) {
      this.logger.error('settings.json unreadable, using defaults', {
        error: errorMessage(e),
      });
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = join(dirname(this.file), `.settings.json.tmp-${process.pid}`);
    writeFileSync(tmp, JSON.stringify(this.globalRaw, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  get state(): SettingsState {
    return {
      effective: this.resolved.effective,
      issues: this.resolved.issues,
      overrideKeys: this.resolved.overrideKeys,
    };
  }

  get effective(): Settings {
    return this.resolved.effective;
  }

  onChange(listener: (state: SettingsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private recompute(): void {
    this.resolved = resolveSettings(this.globalRaw, this.workspaceOverride);
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  /** Deep-merge a patch into raw settings; validation happens in resolveSettings. */
  update(scope: 'global' | 'workspace', patch: PlainObject): SettingsState {
    if (scope === 'workspace') {
      for (const section of Object.keys(patch)) {
        if (!(WORKSPACE_OVERRIDABLE_SECTIONS as readonly string[]).includes(section)) {
          throw new ProductFailure(
            productError('SET_SECTION_NOT_OVERRIDABLE', {
              userMessage: `The "${section}" settings cannot be overridden per workspace.`,
            }),
          );
        }
      }
      this.workspaceOverride = deepMerge(this.workspaceOverride ?? {}, patch);
    } else {
      this.globalRaw = deepMerge(this.globalRaw, patch);
      this.persist();
    }
    this.recompute();
    return this.state;
  }

  reset(scope: 'global' | 'workspace'): SettingsState {
    if (scope === 'workspace') {
      this.workspaceOverride = null;
    } else {
      this.globalRaw = {};
      this.persist();
    }
    this.recompute();
    return this.state;
  }

  /** Called by the workspace layer when a workspace opens/closes (override from DB). */
  setWorkspaceOverride(override: PlainObject | null): SettingsState {
    this.workspaceOverride = override;
    this.recompute();
    return this.state;
  }

  get workspaceOverrideRaw(): PlainObject | null {
    return this.workspaceOverride;
  }
}

function deepMerge(base: PlainObject, patch: PlainObject): PlainObject {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof out[key] === 'object' &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key] as PlainObject, value as PlainObject);
    } else {
      out[key] = value;
    }
  }
  return out;
}
