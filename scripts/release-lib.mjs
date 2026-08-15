import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { root } from './build-lib.mjs';

const INSTALLABLE_SUFFIXES = [
  '.dmg',
  '.zip',
  '.exe',
  '.msi',
  '.appimage',
  '.deb',
  '.rpm',
  '.tar.gz',
  '.blockmap',
  '.yml',
];

export function readProductPackage(projectRoot = root) {
  return JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
}

export function releaseChannel(version) {
  const prerelease = version.split('-', 2)[1]?.toLowerCase() ?? '';
  if (!prerelease) return 'stable';
  if (prerelease.startsWith('beta')) return 'beta';
  if (prerelease.startsWith('rc')) return 'rc';
  if (prerelease.startsWith('nightly')) return 'nightly';
  return 'preview';
}

export function validateReleasePolicy({ version, tag, signingMode = 'unsigned' }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`package version is not valid SemVer: ${version}`);
  }
  if (tag && tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match package version v${version}`);
  }

  const channel = releaseChannel(version);
  if (channel === 'stable' && signingMode !== 'signed') {
    throw new Error(
      'unsigned Stable releases are forbidden; use a SemVer prerelease or provide signed artifacts',
    );
  }
  if (!['unsigned', 'signed'].includes(signingMode)) {
    throw new Error(`unknown signing mode: ${signingMode}`);
  }
  return { channel, prerelease: channel !== 'stable', signed: signingMode === 'signed' };
}

export function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

export function collectReleaseArtifacts(assetsDir) {
  return walk(resolve(assetsDir))
    .filter((file) => {
      const lower = file.toLowerCase();
      return INSTALLABLE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
    })
    .sort((a, b) => a.localeCompare(b));
}

function dependencyName(lockPath, record) {
  if (record.name) return record.name;
  const normalized = lockPath.split(sep).join('/');
  const marker = 'node_modules/';
  const at = normalized.lastIndexOf(marker);
  return at >= 0 ? normalized.slice(at + marker.length) : normalized;
}

function dependencyLicense(projectRoot, lockPath, record) {
  if (typeof record.license === 'string') return record.license;
  const packageJson = join(projectRoot, lockPath, 'package.json');
  if (!existsSync(packageJson)) return 'UNKNOWN';
  try {
    const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
    if (typeof pkg.license === 'string') return pkg.license;
    if (Array.isArray(pkg.licenses)) {
      const values = pkg.licenses
        .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
        .filter(Boolean);
      if (values.length > 0) return values.join(' OR ');
    }
  } catch {
    // An unreadable dependency manifest is represented honestly as UNKNOWN.
  }
  return 'UNKNOWN';
}

export function dependencyInventory(projectRoot = root) {
  const lock = JSON.parse(readFileSync(join(projectRoot, 'package-lock.json'), 'utf8'));
  const unique = new Map();
  for (const [lockPath, record] of Object.entries(lock.packages ?? {})) {
    if (!lockPath.includes('node_modules/') || !record?.version) continue;
    const name = dependencyName(lockPath, record);
    const item = {
      name,
      version: record.version,
      license: dependencyLicense(projectRoot, lockPath, record),
      developmentOnly: Boolean(record.dev),
      optional: Boolean(record.optional),
      source: typeof record.resolved === 'string' ? record.resolved : null,
    };
    unique.set(`${item.name}@${item.version}`, item);
  }
  return [...unique.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}

export function workflowGateReport({ version, tag, commit, runUrl, signingMode }) {
  return [
    `# Charter ${version} release workflow gate report`,
    '',
    '- Result: PASS',
    `- Tag: \`${tag}\``,
    `- Commit: \`${commit}\``,
    `- Signing: ${signingMode}`,
    `- Workflow: ${runUrl}`,
    '',
    'The publish job is reachable only after all required release jobs pass:',
    '',
    '- static, unit/integration, performance, full Electron E2E, security and 50-task soak gates;',
    '- installed dependency resolution checks and the production High/Critical dependency audit;',
    '- native packaging plus clean install/launch/uninstall smoke tests on macOS, Windows and Linux.',
    '',
    'This report records an unsigned prerelease qualification. It is not evidence of Apple Developer ID, notarization, Windows Authenticode or Stable-release approval.',
    '',
  ].join('\n');
}

function generatedAt() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

function gitCommit(projectRoot) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function npmExecutable() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function generateReleaseMetadata({
  projectRoot = root,
  assetsDir,
  outputDir = assetsDir,
  signingMode = process.env.CHARTER_SIGNING_MODE ?? 'unsigned',
  requireArtifacts = true,
  workflowRun = null,
}) {
  const pkg = readProductPackage(projectRoot);
  const policy = validateReleasePolicy({ version: pkg.version, signingMode });
  const artifacts = collectReleaseArtifacts(assetsDir);
  if (requireArtifacts && artifacts.length === 0) {
    throw new Error(`no release artifacts found under ${resolve(assetsDir)}`);
  }
  mkdirSync(outputDir, { recursive: true });

  const inventory = dependencyInventory(projectRoot);
  const licensesJson = join(outputDir, 'third-party-licenses.json');
  const licensesMd = join(outputDir, 'THIRD_PARTY_NOTICES.md');
  const sourceAdaptationNoticesPath = join(projectRoot, 'THIRD_PARTY_NOTICES.md');
  const sourceAdaptationNotices = existsSync(sourceAdaptationNoticesPath)
    ? readFileSync(sourceAdaptationNoticesPath, 'utf8')
        .replace(/^# Third-party notices\s*/u, '')
        .trim()
    : 'No separately adapted source is declared.';
  writeFileSync(licensesJson, `${JSON.stringify(inventory, null, 2)}\n`);
  const licenseLines = [
    '# Charter third-party notices',
    '',
    `Generated from package-lock.json for Charter ${pkg.version}.`,
    '',
    "The entries below are an inventory, not a replacement for each dependency's license text.",
    'The corresponding package sources and installed package manifests remain authoritative.',
    '',
    '| Package | Version | License | Scope |',
    '| --- | --- | --- | --- |',
    ...inventory.map(
      (item) =>
        `| ${item.name.replaceAll('|', '\\|')} | ${item.version} | ${item.license.replaceAll('|', '\\|')} | ${item.developmentOnly ? 'development' : 'runtime'}${item.optional ? ', optional' : ''} |`,
    ),
    '',
    '## Bundled source adaptations',
    '',
    sourceAdaptationNotices,
    '',
  ];
  writeFileSync(licensesMd, `${licenseLines.join('\n')}\n`);

  const sbom = execFileSync(
    npmExecutable(),
    ['sbom', '--package-lock-only', '--sbom-format', 'spdx', '--sbom-type', 'application'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const sbomFile = join(outputDir, `charter-${pkg.version}.spdx.json`);
  writeFileSync(sbomFile, `${JSON.stringify(JSON.parse(sbom), null, 2)}\n`);

  const manifest = {
    schemaVersion: 1,
    product: 'Charter',
    version: pkg.version,
    channel: policy.channel,
    prerelease: policy.prerelease,
    signed: policy.signed,
    generatedAt: generatedAt(),
    commit: gitCommit(projectRoot),
    artifacts: artifacts.map((file) => ({
      name: basename(file),
      path: relative(resolve(assetsDir), file).split(sep).join('/'),
      bytes: statSync(file).size,
      sha256: sha256File(file),
    })),
  };
  const manifestFile = join(outputDir, 'release-manifest.json');
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  let gateReportFile = null;
  if (workflowRun) {
    gateReportFile = join(outputDir, 'GATE_REPORT.md');
    writeFileSync(
      gateReportFile,
      workflowGateReport({
        version: pkg.version,
        tag: workflowRun.tag,
        commit: workflowRun.commit,
        runUrl: workflowRun.runUrl,
        signingMode,
      }),
    );
  }

  const checksumFiles = [
    ...artifacts,
    licensesJson,
    licensesMd,
    sbomFile,
    manifestFile,
    ...(gateReportFile ? [gateReportFile] : []),
  ];
  const checksums = checksumFiles
    .map((file) => `${sha256File(file)}  ${relative(outputDir, file).split(sep).join('/')}`)
    .sort()
    .join('\n');
  const checksumFile = join(outputDir, 'SHA256SUMS.txt');
  writeFileSync(checksumFile, `${checksums}\n`);

  return {
    manifest,
    files: {
      licensesJson,
      licensesMd,
      sbomFile,
      manifestFile,
      checksumFile,
      ...(gateReportFile ? { gateReportFile } : {}),
    },
  };
}
