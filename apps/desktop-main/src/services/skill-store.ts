import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { productError, ProductFailure, type Logger } from '@pi-ide/foundation';
import type { SkillDto } from '@pi-ide/ipc-contracts';

/**
 * Managed skills store (ADR-0015). Skills are SKILL.md folders the user
 * explicitly imported; they live under appData/skills — the product NEVER
 * discovers skills inside project directories (AG-014 stays intact).
 *
 * Loading is auditable by construction: auto-invocation goes through the
 * `load_skill` gateway tool (recorded in the task timeline like every tool
 * call), and explicit `/skill:name` expansion is deterministic from this store.
 */

const SKILL_FILE = 'SKILL.md';
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const READ_CAP = 256 * 1024;
const SCRIPT_EXTS = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat',
]);

export interface SkillFrontmatter {
  name: string;
  description: string;
  explicitOnly: boolean;
}

/** Minimal YAML frontmatter parse — name/description/disable-model-invocation. */
export function parseSkillFrontmatter(content: string, fallbackName: string): SkillFrontmatter {
  let name = fallbackName;
  let description = '';
  let explicitOnly = false;
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const key = kv[1]!.toLowerCase();
      const value = kv[2]!.trim().replace(/^['"]|['"]$/g, '');
      if (key === 'name' && value) name = value;
      else if (key === 'description') description = value;
      else if (key === 'disable-model-invocation') explicitOnly = value === 'true';
    }
  }
  return { name, description, explicitOnly };
}

/** Slug = stable id + the `/skill:<slug>` command token. */
export function skillSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill'
  );
}

/** Strip the YAML frontmatter, keeping the instruction body. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (out.length >= MAX_FILES) return;
      if (name === '.DS_Store' || name === '.git') continue;
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(abs, relPath);
      else out.push(relPath);
    }
  };
  visit(root, '');
  return out;
}

function isScript(relPath: string): boolean {
  const dot = relPath.lastIndexOf('.');
  return dot >= 0 && SCRIPT_EXTS.has(relPath.slice(dot).toLowerCase());
}

/** One enabled skill as the gateway tool + prompts consume it. */
export interface SkillToolEntry {
  name: string;
  description: string;
  dir: string;
  explicitOnly: boolean;
}

interface StoreState {
  version: 1;
  /** Per-skill enabled flag; absent = enabled (imports default to Auto). */
  enabled: Record<string, boolean>;
}

export class SkillStore {
  private readonly stateFile: string;

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, 'skills.json');
  }

  private loadState(): StoreState {
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as StoreState;
      if (parsed && typeof parsed === 'object' && parsed.enabled) return parsed;
    } catch {
      // first run / unreadable state → defaults
    }
    return { version: 1, enabled: {} };
  }

  private saveState(state: StoreState): void {
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    cpSync(tmp, this.stateFile);
    rmSync(tmp, { force: true });
  }

  private skillDir(id: string): string {
    // ids are slugs we created — but never trust them as path segments blindly.
    const safe = skillSlug(id);
    return join(this.dir, safe);
  }

  private readSkill(id: string, enabled: boolean): SkillDto | null {
    const root = this.skillDir(id);
    const skillFile = join(root, SKILL_FILE);
    if (!existsSync(skillFile)) return null;
    let content = '';
    try {
      content = readFileSync(skillFile, 'utf8');
    } catch {
      return null;
    }
    const fm = parseSkillFrontmatter(content, id);
    const files = walkFiles(root);
    let importedAt = new Date(0).toISOString();
    try {
      importedAt = statSync(root).birthtime.toISOString();
    } catch {
      // keep epoch fallback
    }
    return {
      id,
      name: skillSlug(fm.name),
      description: fm.description,
      enabled,
      explicitOnly: fm.explicitOnly,
      source: 'local',
      files,
      scriptCount: files.filter(isScript).length,
      importedAt,
    };
  }

  list(): SkillDto[] {
    const state = this.loadState();
    const out: SkillDto[] = [];
    let ids: string[] = [];
    try {
      ids = readdirSync(this.dir).filter((name) => {
        try {
          return statSync(join(this.dir, name)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return out;
    }
    for (const id of ids.sort()) {
      const dto = this.readSkill(id, state.enabled[id] ?? true);
      if (dto) out.push(dto);
    }
    return out;
  }

  /**
   * Import a SKILL.md folder into the managed store (copy — the source stays
   * untouched). Validates the folder before copying; oversized or script-bomb
   * folders are rejected with a clear error.
   */
  import(sourceDir: string): SkillDto {
    const src = resolve(sourceDir);
    if (src === resolve(this.dir) || src.startsWith(resolve(this.dir) + sep)) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', {
          userMessage: 'That folder is already inside the managed skills store.',
        }),
      );
    }
    const skillFile = join(src, SKILL_FILE);
    if (!existsSync(skillFile)) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', {
          userMessage: `The folder has no ${SKILL_FILE} — pick the skill's root folder.`,
        }),
      );
    }
    const files = walkFiles(src);
    if (files.length >= MAX_FILES) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_TOO_LARGE', {
          userMessage: `The folder has ${MAX_FILES}+ files — that does not look like a skill.`,
        }),
      );
    }
    let total = 0;
    for (const rel of files) {
      try {
        total += statSync(join(src, rel)).size;
      } catch {
        // unreadable entries are skipped by the copy too
      }
    }
    if (total > MAX_TOTAL_BYTES) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_TOO_LARGE', {
          userMessage: 'The folder is larger than 20 MB — that does not look like a skill.',
        }),
      );
    }
    const fm = parseSkillFrontmatter(readFileSync(skillFile, 'utf8'), basename(src));
    let id = skillSlug(fm.name);
    let suffix = 2;
    while (existsSync(this.skillDir(id))) {
      id = `${skillSlug(fm.name)}-${suffix}`;
      suffix += 1;
    }
    cpSync(src, this.skillDir(id), { recursive: true });
    this.logger.info('skill imported', { id, files: files.length, scripts: fm.explicitOnly });
    const dto = this.readSkill(id, true);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_IMPORT_INVALID', { userMessage: 'The skill could not be imported.' }),
      );
    }
    return dto;
  }

  remove(id: string): boolean {
    const root = this.skillDir(id);
    const existed = existsSync(join(root, SKILL_FILE));
    rmSync(root, { recursive: true, force: true });
    const state = this.loadState();
    delete state.enabled[skillSlug(id)];
    this.saveState(state);
    if (existed) this.logger.info('skill removed', { id });
    return existed;
  }

  setEnabled(id: string, enabled: boolean): SkillDto {
    const safe = skillSlug(id);
    const state = this.loadState();
    state.enabled[safe] = enabled;
    this.saveState(state);
    const dto = this.readSkill(safe, enabled);
    if (!dto) {
      throw new ProductFailure(
        productError('SKILL_NOT_FOUND', { userMessage: 'This skill no longer exists on disk.' }),
      );
    }
    this.logger.info('skill toggled', { id: safe, enabled });
    return dto;
  }

  /** Audit view / load_skill: read one bundled file, traversal-guarded. */
  readFile(id: string, relPath = SKILL_FILE): { path: string; content: string; binary: boolean } {
    const root = resolve(this.skillDir(id));
    const abs = resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new ProductFailure(
        productError('SKILL_PATH_OUTSIDE', {
          userMessage: 'That path is outside the skill folder.',
        }),
      );
    }
    let raw: Buffer;
    try {
      raw = readFileSync(abs);
    } catch {
      throw new ProductFailure(
        productError('SKILL_FILE_NOT_FOUND', {
          userMessage: `${relPath} does not exist in this skill.`,
        }),
      );
    }
    const head = raw.subarray(0, 8192);
    const binary = head.includes(0);
    return {
      path: relPath,
      content: binary ? '' : raw.subarray(0, READ_CAP).toString('utf8'),
      binary,
    };
  }

  /** Enabled skills for the gateway tool + preamble (dir = absolute store path). */
  enabledSkills(): SkillToolEntry[] {
    return this.list()
      .filter((s) => s.enabled)
      .map((s) => ({
        name: s.name,
        description: s.description,
        dir: this.skillDir(s.id),
        explicitOnly: s.explicitOnly,
      }));
  }

  /**
   * `<available_skills>` block for the session preamble. Lists enabled skills
   * the model may auto-invoke (explicit-only skills are excluded — SKILL.md
   * frontmatter `disable-model-invocation`, honored per the Agent Skills
   * standard). The model loads a skill through the `load_skill` gateway tool,
   * so every load is recorded in the task timeline (AG-014 auditability).
   */
  preambleBlock(): string {
    const visible = this.enabledSkills().filter((s) => !s.explicitOnly);
    if (visible.length === 0) return '';
    const lines = [
      'The following skills provide specialized instructions for specific tasks.',
      "When a task matches a skill's description, call the load_skill tool with its name to get its full instructions before proceeding. Load bundled reference files the instructions mention with load_skill too (name + file).",
      '<available_skills>',
    ];
    for (const skill of visible) {
      lines.push(
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        '  </skill>',
      );
    }
    lines.push('</available_skills>');
    return lines.join('\n');
  }

  /**
   * Explicit invocation: expand a leading `/skill:name [args…]` into the
   * skill's instruction body (mirrors the pi CLI's expansion format so skills
   * behave identically). Unknown/disabled skills pass through unchanged.
   */
  expandCommand(text: string): string {
    const match = /^\/skill:([A-Za-z0-9-_]+)[ \t]?/.exec(text);
    if (!match) return text;
    const skill = this.enabledSkills().find((s) => s.name === skillSlug(match[1]!));
    if (!skill) return text;
    let body: string;
    try {
      body = stripFrontmatter(readFileSync(join(skill.dir, SKILL_FILE), 'utf8')).trim();
    } catch {
      return text;
    }
    const args = text.slice(match[0].length).trim();
    const block = `<skill name="${skill.name}">\nLoad bundled files this skill references with the load_skill tool (name + file).\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
