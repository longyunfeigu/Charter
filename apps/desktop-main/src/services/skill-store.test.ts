import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '@pi-ide/foundation';
import { SkillStore, parseSkillFrontmatter, skillSlug } from './skill-store.js';

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function makeSkillFolder(
  base: string,
  name: string,
  options: {
    description?: string;
    explicitOnly?: boolean;
    extraFiles?: Record<string, string>;
  } = {},
): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${options.description ?? `Do ${name} things.`}`,
      ...(options.explicitOnly ? ['disable-model-invocation: true'] : []),
      '---',
      `Instructions for ${name}.`,
      '',
    ].join('\n'),
  );
  for (const [rel, content] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe('SkillStore (ADR-0015)', () => {
  let root: string;
  let src: string;
  let store: SkillStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-store-'));
    src = mkdtempSync(join(tmpdir(), 'skills-src-'));
    store = new SkillStore(root, logger);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  it('parses frontmatter incl. disable-model-invocation', () => {
    const fm = parseSkillFrontmatter(
      '---\nname: pdf-fill\ndescription: "Fill PDF forms."\ndisable-model-invocation: true\n---\nBody',
      'fallback',
    );
    expect(fm).toEqual({ name: 'pdf-fill', description: 'Fill PDF forms.', explicitOnly: true });
    // Missing frontmatter → fallback name, model invocation allowed.
    expect(parseSkillFrontmatter('just a body', 'fb')).toEqual({
      name: 'fb',
      description: '',
      explicitOnly: false,
    });
  });

  it('slugs names for ids and /skill: matching', () => {
    expect(skillSlug('PDF Fill!')).toBe('pdf-fill');
    expect(skillSlug('---')).toBe('skill');
  });

  it('imports a SKILL.md folder (copy), defaults to enabled', () => {
    const dir = makeSkillFolder(src, 'pdf-fill', {
      extraFiles: { 'scripts/fill.py': 'print(1)', 'references/schema.md': '# schema' },
    });
    const dto = store.import(dir);
    expect(dto.id).toBe('pdf-fill');
    expect(dto.enabled).toBe(true);
    expect(dto.explicitOnly).toBe(false);
    expect(dto.scriptCount).toBe(1);
    expect(dto.files).toContain('SKILL.md');
    expect(dto.files).toContain('scripts/fill.py');
    // The source folder still exists — import copies.
    expect(store.list()).toHaveLength(1);
  });

  it('rejects folders without SKILL.md and store-internal sources', () => {
    const empty = join(src, 'not-a-skill');
    mkdirSync(empty);
    expect(() => store.import(empty)).toThrowError(/SKILL\.md/);
    expect(() => store.import(root)).toThrowError(/managed skills store/);
  });

  it('suffixes colliding slugs', () => {
    store.import(makeSkillFolder(src, 'dup'));
    const second = store.import(makeSkillFolder(join(src, 'other'), 'dup'));
    expect(second.id).toBe('dup-2');
    expect(store.list().map((s) => s.id)).toEqual(['dup', 'dup-2']);
  });

  it('setEnabled(false) removes the skill from every agent surface', () => {
    store.import(makeSkillFolder(src, 'alpha'));
    store.import(makeSkillFolder(join(src, 'b'), 'beta', { explicitOnly: true }));
    expect(store.enabledSkills().map((s) => s.name)).toEqual(['alpha', 'beta']);
    // Preamble lists only model-invocable skills (beta is explicit-only).
    expect(store.preambleBlock()).toContain('<name>alpha</name>');
    expect(store.preambleBlock()).not.toContain('<name>beta</name>');

    store.setEnabled('alpha', false);
    expect(store.enabledSkills().map((s) => s.name)).toEqual(['beta']);
    expect(store.preambleBlock()).toBe('');
    // Re-enable round-trips.
    expect(store.setEnabled('alpha', true).enabled).toBe(true);
  });

  it('expands a leading /skill:name into the instruction body', () => {
    store.import(makeSkillFolder(src, 'alpha', { description: 'Alpha skill.' }));
    const expanded = store.expandCommand('/skill:alpha do the thing');
    expect(expanded).toContain('<skill name="alpha">');
    expect(expanded).toContain('Instructions for alpha.');
    expect(expanded.endsWith('do the thing')).toBe(true);
    // Args may follow on their own lines (acceptance criteria block).
    expect(store.expandCommand('/skill:alpha\n\nmore context')).toContain('more context');
    // Unknown, disabled and mid-text commands pass through unchanged.
    expect(store.expandCommand('/skill:nope hi')).toBe('/skill:nope hi');
    store.setEnabled('alpha', false);
    expect(store.expandCommand('/skill:alpha hi')).toBe('/skill:alpha hi');
    expect(store.expandCommand('use /skill:alpha')).toBe('use /skill:alpha');
  });

  it('explicit-only skills expand via /skill: even though they never enter the preamble', () => {
    store.import(makeSkillFolder(src, 'deploy', { explicitOnly: true }));
    expect(store.preambleBlock()).toBe('');
    expect(store.expandCommand('/skill:deploy')).toContain('Instructions for deploy.');
  });

  it('readFile guards traversal and flags binaries', () => {
    store.import(makeSkillFolder(src, 'alpha', { extraFiles: { 'refs/a.md': 'ref body' } }));
    expect(store.readFile('alpha').content).toContain('Instructions for alpha.');
    expect(store.readFile('alpha', 'refs/a.md').content).toBe('ref body');
    expect(() => store.readFile('alpha', '../../settings.json')).toThrowError(/outside/);
    expect(() => store.readFile('alpha', 'missing.md')).toThrowError(/does not exist/);
    writeFileSync(join(root, 'alpha', 'blob.bin'), Buffer.from([0, 1, 2]));
    expect(store.readFile('alpha', 'blob.bin').binary).toBe(true);
  });

  it('remove deletes the folder and its state', () => {
    store.import(makeSkillFolder(src, 'alpha'));
    expect(store.remove('alpha')).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.remove('alpha')).toBe(false);
  });
});
