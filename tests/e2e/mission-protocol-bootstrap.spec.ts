import { expect, test } from '@playwright/test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

function createMissionProtocolAgents(): {
  bin: string;
  leadProbe: string;
  codexProbe: string;
  kimiProbe: string;
} {
  const bin = mkdtempSync(join(tmpdir(), 'charter-mission-protocol-'));
  const leadProbe = join(bin, 'lead.log');
  const codexProbe = join(bin, 'codex.log');
  const kimiProbe = join(bin, 'kimi.log');
  const foundationDone = join(bin, 'foundation.done');
  const commandRunner = [
    "const { spawnSync } = require('node:child_process');",
    'function call(args) {',
    "  const result = spawnSync(process.env.CHARTER_COMMAND || 'charter', args, { encoding: 'utf8', timeout: 15000 });",
    "  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };",
    '}',
    'function append(probe, label, value) { fs.appendFileSync(probe, `${label}=${JSON.stringify(value)}\n`); }',
  ];
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      ...commandRunner,
      `const probe = ${JSON.stringify(leadProbe)};`,
      "append(probe, 'argv', process.argv.slice(2));",
      "let input = '';",
      'let started = false;',
      'async function lead() {',
      "  append(probe, 'inspectBeforePromotion', call(['orchestration', 'inspect', '--json']));",
      "  append(probe, 'help', call(['orchestration', 'promote', '--help', '--json']));",
      '  const batch = {',
      "    reason: 'The contract and consumer are independently verifiable and dependency ordered.',",
      '    children: [',
      "      { key: 'foundation', goal: 'Define the shared contract.', acceptanceCriteria: ['contract reported'], requestedRuntime: 'codex', workMode: 'shared-write', writeScope: ['src/core/**'], reason: 'foundation first', idempotencyKey: 'e2e-foundation' },",
      "      { key: 'consumer', dependsOn: ['foundation'], goal: 'Consume the shared contract.', acceptanceCriteria: ['consumer reported'], requestedRuntime: 'kimi', workMode: 'shared-write', writeScope: ['src/ui/**'], reason: 'must follow foundation', idempotencyKey: 'e2e-consumer' }",
      '    ]',
      '  };',
      "  append(probe, 'dryRun', call(['orchestration', 'promote', '--request-json', JSON.stringify(batch), '--dry-run', '--json']));",
      "  const ghost = { goal: 'Probe unavailable runtime', acceptanceCriteria: [], requestedRuntime: 'ghost', reason: 'preflight proof', idempotencyKey: 'e2e-ghost' };",
      "  append(probe, 'ghost', call(['orchestration', 'promote', '--request-json', JSON.stringify({ reason: 'Invalid runtime preflight.', children: [ghost] }), '--json']));",
      "  append(probe, 'promote', call(['orchestration', 'promote', '--request-json', JSON.stringify(batch), '--json']));",
      "  append(probe, 'inspect', call(['orchestration', 'inspect', '--json']));",
      '}',
      "process.stdin.on('data', (chunk) => {",
      '  input += chunk.toString();',
      '  fs.appendFileSync(probe, `prompt=${JSON.stringify(chunk.toString())}\n`);',
      "  if (!started && input.includes('请使用 Mission 模式')) { started = true; void lead(); }",
      '});',
      "console.log('mission-protocol-claude-ready');",
      "process.stdout.write('\\u001b[?2004h');",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      ...commandRunner,
      `const probe = ${JSON.stringify(codexProbe)};`,
      `const foundationDone = ${JSON.stringify(foundationDone)};`,
      "const argv = process.argv.slice(2).join(' ');",
      "append(probe, 'argv', argv);",
      "let input = '';",
      'let started = false;',
      "process.stdin.on('data', (chunk) => {",
      '  input += chunk.toString();',
      "  append(probe, 'prompt', chunk.toString());",
      "  if (!started && input.includes('请使用 Mission 模式')) {",
      '    started = true;',
      "    const plan = { reason: 'Independent inspection is a bounded verifiable workstream.', children: [{ key: 'inspection', goal: 'Perform the requested read-only inspection.', acceptanceCriteria: ['Report the result.'], requestedRuntime: 'claude', workMode: 'read-only', reason: 'Independent execution.', idempotencyKey: 'e2e-codex-lead-inspection' }], integration: { mode: 'none' } };",
      "    append(probe, 'leadPromote', call(['orchestration', 'promote', '--request-json', JSON.stringify(plan), '--json']));",
      '  }',
      "  if (!started && input.includes('You are Assignment')) {",
      '    started = true;',
      "    append(probe, 'inspect', call(['orchestration', 'inspect', '--json']));",
      "    const result = { outcome: 'success', summary: 'Foundation contract complete.', verification: [{ label: 'foundation', state: 'passed' }] };",
      "    append(probe, 'complete', call(['orchestration', 'complete', '--request-json', JSON.stringify(result), '--json']));",
      '    fs.writeFileSync(foundationDone, new Date().toISOString());',
      '  }',
      '});',
      "console.log('mission-protocol-codex-ready · OpenAI Codex · /model to change');",
      "process.stdout.write('\\u001b[?2004h');",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'kimi'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      ...commandRunner,
      `const probe = ${JSON.stringify(kimiProbe)};`,
      `const foundationDone = ${JSON.stringify(foundationDone)};`,
      "let input = '';",
      'let started = false;',
      'let composerReady = false;',
      "process.stdin.on('data', (chunk) => {",
      "  if (!composerReady && chunk.toString().includes('You are Assignment')) append(probe, 'promptBeforeComposerReady', true);",
      '  input += chunk.toString();',
      "  if (!started && input.includes('You are Assignment')) {",
      '    started = true;',
      "    append(probe, 'foundationDoneAtStart', fs.existsSync(foundationDone));",
      "    append(probe, 'inspect', call(['orchestration', 'inspect', '--json']));",
      "    const result = { outcome: 'success', summary: 'Consumer work complete.', verification: [{ label: 'consumer', state: 'passed' }] };",
      "    append(probe, 'complete', call(['orchestration', 'complete', '--request-json', JSON.stringify(result), '--json']));",
      '  }',
      '});',
      "console.log('mission-protocol-kimi-ready');",
      "setTimeout(() => { composerReady = true; process.stdout.write('\\u001b[?2004h'); }, 1200);",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 60000);',
      '',
    ].join('\n'),
  );
  for (const agent of ['claude', 'codex', 'kimi']) chmodSync(join(bin, agent), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return { bin, leadProbe, codexProbe, kimiProbe };
}

function optionalText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('Mission bootstrap exposes catalog/help/dry-run and executes a dependency-ordered CLI batch', async () => {
  test.setTimeout(120_000);
  const fixture = createGitFixture();
  const agents = createMissionProtocolAgents();
  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex,kimi',
      PATH: `${agents.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: agents.bin,
    },
  });
  const prompt = '请使用 Mission 模式，由 Claude Code 调度 Codex 和 Kimi 完成有依赖的工作。';

  try {
    const terminalId = await launched.page.evaluate(async (initialPrompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, prompt);

    await expect
      .poll(() => optionalText(agents.leadProbe), { timeout: 30_000 })
      .toContain('promote=');
    await expect
      .poll(() => optionalText(agents.kimiProbe), { timeout: 45_000 })
      .toContain('complete=');

    const snapshot = await launched.page.evaluate(
      async ({ id, missionGoal }) => {
        const tasks = (await window.product.rpc['task.list']!({
          filter: 'all',
          includeArchived: false,
          scope: 'all',
        })) as { ok: true; data: { tasks: TaskDto[] } };
        const task = tasks.data.tasks.find((candidate) => candidate.external?.terminalId === id);
        if (!task) throw new Error('Lead task not found');
        const mission = (await window.product.rpc['mission.forConversation']!({
          taskId: task.id,
        })) as {
          ok: true;
          data: { snapshot: MissionSnapshotDto | null };
        };
        if (mission.data.snapshot?.mission.goal !== missionGoal)
          throw new Error('Mission not found');
        return mission.data.snapshot;
      },
      { id: terminalId, missionGoal: prompt },
    );

    expect(snapshot?.assignments).toHaveLength(3);
    expect(snapshot?.tasks.filter((task) => task.state === 'COMPLETED')).toHaveLength(2);
    expect(snapshot?.dependencies).toHaveLength(1);
    expect(snapshot?.attempts.filter((attempt) => attempt.state === 'SUCCEEDED')).toHaveLength(2);

    const leadLog = optionalText(agents.leadProbe);
    expect(leadLog).toContain('runtimeCatalog');
    expect(leadLog).toContain('inputSchema');
    expect(leadLog).toContain('normalizedInput');
    expect(leadLog).toContain('ORCHESTRATION_RUNTIME_UNKNOWN');
    expect(leadLog).toContain('--mcp-config=');
    expect(leadLog).not.toContain('[Charter Mission launch]');
    expect(optionalText(agents.codexProbe)).toContain('mcp_servers.charter.command');
    expect(optionalText(agents.kimiProbe)).toContain('foundationDoneAtStart=true');
    expect(optionalText(agents.kimiProbe)).not.toContain('promptBeforeComposerReady=true');
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(agents.bin, { recursive: true, force: true });
  }
});

test('a deferred-prompt Codex Session can promote on its first control call', async () => {
  test.setTimeout(60_000);
  const fixture = createGitFixture();
  const agents = createMissionProtocolAgents();
  const launched = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude,codex,kimi',
      PATH: `${agents.bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: agents.bin,
    },
  });

  try {
    await launched.page.evaluate(async () => {
      const result = await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'codex',
        initialPrompt: '请使用 Mission 模式调度 Codex 完成一次只读检查。',
      });
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
    });

    await expect
      .poll(() => optionalText(agents.codexProbe), { timeout: 30_000 })
      .toContain('leadPromote=');
    const line = optionalText(agents.codexProbe)
      .split('\n')
      .find((candidate) => candidate.startsWith('leadPromote='));
    if (!line) throw new Error('Codex Session promotion probe missing');
    const call = JSON.parse(line.slice('leadPromote='.length)) as {
      status: number | null;
      stdout: string;
    };
    expect(call.status).toBe(0);
    expect(JSON.parse(call.stdout)).toMatchObject({ ok: true });
    expect(optionalText(agents.codexProbe)).not.toContain('[Charter Mission launch]');
  } finally {
    await launched.app.close();
    rmSync(launched.userDataDir, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(agents.bin, { recursive: true, force: true });
  }
});
