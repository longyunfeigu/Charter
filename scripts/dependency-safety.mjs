#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rules = [
  {
    dependency: 'brace-expansion',
    expected: '5.0.8',
    requester: 'node_modules/@earendil-works/pi-coding-agent/node_modules/minimatch/package.json',
    shadow: 'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion',
  },
  {
    dependency: 'protobufjs',
    expected: '7.6.5',
    requester:
      'node_modules/@earendil-works/pi-coding-agent/node_modules/@google/genai/package.json',
    shadow: 'node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs',
  },
  {
    dependency: 'js-yaml',
    expected: '4.3.0',
    requester: 'node_modules/@mdxeditor/editor/package.json',
  },
  {
    dependency: 'dompurify',
    expected: '3.4.12',
    requester: 'node_modules/monaco-editor/package.json',
  },
];

function packageVersion(packageDir) {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
}

function resolveManifest(requireFromRequester, dependency) {
  try {
    return requireFromRequester.resolve(`${dependency}/package.json`);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    let directory = dirname(requireFromRequester.resolve(dependency));
    while (directory !== dirname(directory)) {
      const candidate = join(directory, 'package.json');
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
        if (manifest.name === dependency) return candidate;
      }
      directory = dirname(directory);
    }
    throw error;
  }
}

export function enforceDependencySafety(root = scriptRoot, { checkOnly = false } = {}) {
  for (const rule of rules) {
    const requester = join(root, rule.requester);
    if (!existsSync(requester)) {
      throw new Error(`dependency safety requester is missing: ${rule.requester}`);
    }

    if (rule.shadow) {
      const shadow = join(root, rule.shadow);
      if (existsSync(shadow) && packageVersion(shadow) !== rule.expected) {
        if (checkOnly) {
          throw new Error(
            `${rule.dependency} is shadowed by ${rule.shadow} at unsafe version ${packageVersion(shadow)}`,
          );
        }
        rmSync(shadow, { recursive: true, force: true });
        console.log(`dependency-safety: removed shadow copy ${rule.shadow}`);
      }
    }

    const requireFromRequester = createRequire(requester);
    const resolvedManifest = resolveManifest(requireFromRequester, rule.dependency);
    const actual = JSON.parse(readFileSync(resolvedManifest, 'utf8')).version;
    if (actual !== rule.expected) {
      throw new Error(
        `${rule.dependency} resolved to ${actual} from ${rule.requester}; expected ${rule.expected}`,
      );
    }
    console.log(
      `dependency-safety: ${rule.dependency}@${actual} (${resolvedManifest.slice(root.length + 1)})`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  enforceDependencySafety(scriptRoot, { checkOnly: process.argv.includes('--check') });
}
