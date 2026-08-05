import { expect, test } from '@playwright/test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MissionSnapshotDto, TaskDto } from '@pi-ide/ipc-contracts';
import { CHARTER_ORCHESTRATION_SKILL } from '../../apps/desktop-main/src/services/orchestration-manual';
import { CHARTER_TERMINAL_SKILL } from '../../apps/desktop-main/src/services/terminal-control-manual';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';

function createMissionClaude(): { bin: string; probe: string; promotionGate: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-mission-intent-'));
  const probe = join(bin, 'prompt.log');
  const promotionGate = join(bin, 'allow-promotion');
  writeFileSync(
    join(bin, 'claude'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      `const probe = ${JSON.stringify(probe)};`,
      `const promotionGate = ${JSON.stringify(promotionGate)};`,
      'let promoted = false;',
      "console.log('mission-intent-claude-ready');",
      "process.stdout.write('\\u001b[?2004h');",
      "process.stdin.on('data', (chunk) => {",
      '  const input = chunk.toString();',
      '  fs.appendFileSync(probe, input);',
      "  if (promoted || !input.includes('请 Mission 调度')) return;",
      '  promoted = true;',
      '  const gateTimer = setInterval(() => {',
      '    if (!fs.existsSync(promotionGate)) return;',
      '    clearInterval(gateTimer);',
      '    const plan = {',
      "      reason: 'The requested independent role needs its own verifiable Assignment.',",
      '      children: [{',
      "        key: 'review',",
      "        title: 'Independent review',",
      "        goal: 'Review the Lead result independently.',",
      "        acceptanceCriteria: ['Report concrete findings.'],",
      "        requestedRuntime: 'claude',",
      "        workMode: 'read-only',",
      "        reason: 'Independent verification materially improves confidence.',",
      "        idempotencyKey: 'e2e-session-promotion-review'",
      '      }],',
      "      integration: { mode: 'none' }",
      '    };',
      "    const result = spawnSync(process.env.CHARTER_COMMAND || 'charter', ['orchestration', 'promote', '--request-json', JSON.stringify(plan), '--json'], { encoding: 'utf8', timeout: 15000 });",
      '    fs.appendFileSync(probe, `\\npromote=${JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr })}\\n`);',
      '  }, 50);',
      '});',
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return { bin, probe, promotionGate };
}

function createComposerCodex(): { bin: string; probe: string } {
  const bin = mkdtempSync(join(tmpdir(), 'charter-session-intent-'));
  const probe = join(bin, 'prompt.log');
  writeFileSync(
    join(bin, 'codex'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const probe = ${JSON.stringify(probe)};`,
      'fs.appendFileSync(probe, `argv=${JSON.stringify(process.argv.slice(2))}\\n`);',
      "console.log('OpenAI Codex · /model to change');",
      "process.stdout.write('\\u001b[?2004h');",
      "process.stdin.on('data', (chunk) => fs.appendFileSync(probe, `prompt=${JSON.stringify(chunk.toString())}\\n`));",
      'process.stdin.resume();',
      'setTimeout(() => process.exit(0), 30000);',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(
    join(bin, '.zshenv'),
    `export PATH=${JSON.stringify(`${bin}:${process.env.PATH ?? ''}`)}\n`,
  );
  return { bin, probe };
}

test('startup refreshes Charter Mission routing Skills before a new Agent Session', async () => {
  const agentHome = mkdtempSync(join(tmpdir(), 'charter-agent-skills-'));
  const staleCodex = join(agentHome, '.codex', 'skills', 'charter-terminal');
  writeFileSync(join(agentHome, '.agent-home-marker'), 'isolated');
  mkdirSync(staleCodex, { recursive: true });
  writeFileSync(join(staleCodex, 'SKILL.md'), '# stale terminal-only routing\n');

  const { app } = await launchApp({
    env: {
      PI_IDE_AGENT_HOME: agentHome,
      PI_IDE_SKILLS_HOME: agentHome,
    },
    home: 'keep',
  });

  try {
    for (const provider of ['claude', 'codex']) {
      expect(
        readFileSync(
          join(agentHome, `.${provider}`, 'skills', 'charter-terminal', 'SKILL.md'),
          'utf8',
        ),
      ).toBe(CHARTER_TERMINAL_SKILL);
      expect(
        readFileSync(
          join(agentHome, `.${provider}`, 'skills', 'charter-orchestration', 'SKILL.md'),
          'utf8',
        ),
      ).toBe(CHARTER_ORCHESTRATION_SKILL);
    }
  } finally {
    await app.close();
  }
});

test('an Agent promotes its ordinary Session only after understanding the task', async () => {
  const fixture = createGitFixture();
  const { bin, probe, promotionGate } = createMissionClaude();
  const prompt = '请 Mission 调度 Kimi、Claude Code 和 Codex 共同完成';
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'claude',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
  });

  try {
    const terminalId = await page.evaluate(async (initialPrompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'claude',
        initialPrompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, prompt);

    await expect
      .poll(
        async () =>
          await page.evaluate(async (id) => {
            const result = (await window.product.rpc['task.list']!({
              filter: 'all',
              includeArchived: false,
              scope: 'all',
            })) as
              | { ok: true; data: { tasks: TaskDto[] } }
              | { ok: false; error?: { userMessage?: string } };
            if (!result.ok) throw new Error(result.error?.userMessage ?? 'task.list failed');
            return (
              result.data.tasks.find((candidate) => candidate.external?.terminalId === id) ?? null
            );
          }, terminalId),
        { timeout: 20_000 },
      )
      .not.toBeNull();

    const taskId = (await page.evaluate(async (id) => {
      const result = (await window.product.rpc['task.list']!({
        filter: 'all',
        includeArchived: false,
        scope: 'all',
      })) as { ok: true; data: { tasks: TaskDto[] } };
      return result.data.tasks.find((candidate) => candidate.external?.terminalId === id)!.id;
    }, terminalId)) as string;

    const beforePromotion = await page.evaluate(async (originTaskId) => {
      const result = (await window.product.rpc['mission.forConversation']!({
        taskId: originTaskId,
      })) as { ok: true; data: { snapshot: MissionSnapshotDto | null } };
      return result.data.snapshot;
    }, taskId);
    expect(beforePromotion).toBeNull();
    const leadSession = page.getByTestId(`home-task-${taskId}`);
    await expect(leadSession).toBeVisible();
    await leadSession.click();
    await expect(page.getByTestId('mission-status-strip')).toHaveCount(0);
    writeFileSync(promotionGate, 'go');

    await expect
      .poll(
        () => {
          try {
            return readFileSync(probe, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain('promote=');

    await expect
      .poll(
        async () =>
          await page.evaluate(async (originTaskId) => {
            const result = (await window.product.rpc['mission.forConversation']!({
              taskId: originTaskId,
            })) as
              | { ok: true; data: { snapshot: MissionSnapshotDto | null } }
              | { ok: false; error?: { userMessage?: string } };
            if (!result.ok)
              throw new Error(result.error?.userMessage ?? 'mission.forConversation failed');
            return result.data.snapshot;
          }, taskId),
        { timeout: 20_000 },
      )
      .not.toBeNull();

    const snapshot = await page.evaluate(async (originTaskId) => {
      const result = (await window.product.rpc['mission.forConversation']!({
        taskId: originTaskId,
      })) as { ok: true; data: { snapshot: MissionSnapshotDto | null } };
      return result.data.snapshot;
    }, taskId);
    expect(snapshot?.mission.originConversationTaskId).toBe(taskId);
    expect(snapshot?.tasks[0]?.goal).toBe(prompt);
    expect(snapshot?.assignments).toHaveLength(2);
    await expect(page.getByTestId('mission-status-strip')).toBeVisible();

    await expect
      .poll(
        () => {
          try {
            return readFileSync(probe, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain(prompt);
    expect(readFileSync(probe, 'utf8')).not.toContain('[Charter Mission launch]');
    expect(readFileSync(probe, 'utf8')).not.toContain('Do not use `terminal_create`');
  } finally {
    await app.close();
  }
});

test('an ordinary Codex Session receives only the original prompt after its composer is ready', async () => {
  const fixture = createGitFixture();
  const { bin, probe } = createComposerCodex();
  const prompt = '只检查当前仓库状态，不要使用 Mission 模式';
  const { app, page } = await launchApp({
    env: {
      PI_IDE_OPEN_WORKSPACE: fixture,
      PI_IDE_EXTERNAL_CLIS: 'codex',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ZDOTDIR: bin,
    },
  });

  try {
    const terminalId = await page.evaluate(async (initialPrompt) => {
      const result = (await window.product.rpc['terminal.create']!({
        context: { kind: 'focused' },
        launch: 'codex',
        initialPrompt,
      })) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      return result.data.id;
    }, prompt);

    await expect
      .poll(
        () => {
          try {
            return readFileSync(probe, 'utf8');
          } catch {
            return '';
          }
        },
        { timeout: 20_000 },
      )
      .toContain(prompt);

    const taskId = await page.evaluate(async (id) => {
      const result = (await window.product.rpc['task.list']!({
        filter: 'all',
        includeArchived: false,
        scope: 'all',
      })) as { ok: true; data: { tasks: TaskDto[] } };
      return (
        result.data.tasks.find((candidate) => candidate.external?.terminalId === id)?.id ?? null
      );
    }, terminalId);
    expect(taskId).not.toBeNull();
    const mission = await page.evaluate(async (originTaskId) => {
      const result = (await window.product.rpc['mission.forConversation']!({
        taskId: originTaskId,
      })) as { ok: true; data: { snapshot: MissionSnapshotDto | null } };
      return result.data.snapshot;
    }, taskId!);
    expect(mission).toBeNull();

    const transcript = readFileSync(probe, 'utf8');
    const argvLine = transcript.split('\n').find((line) => line.startsWith('argv=')) ?? '';
    expect(argvLine).not.toContain(prompt);
    expect(transcript).not.toContain('[Charter Mission launch]');
  } finally {
    await app.close();
  }
});
