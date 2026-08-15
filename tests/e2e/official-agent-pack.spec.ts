import { expect, test, type Page } from '@playwright/test';
import type { AgentCatalogDto, AgentPackCatalogDto } from '@pi-ide/ipc-contracts';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { launchApp } from './helpers/launch.js';
import { createGitFixture } from './helpers/fixtures.js';

const AGENTS = [
  {
    id: 'gemini',
    command: 'gemini',
    ready: 'Gemini CLI',
    working: 'esc to cancel',
    blocked: '│ Apply this change',
    workingRule: 'esc_cancel_working',
    blockedRule: 'apply_or_allow_change',
  },
  {
    id: 'opencode',
    command: 'opencode',
    ready: 'OpenCode',
    working: 'ctrl+c to interrupt',
    blocked: '△ Permission required',
    workingRule: 'interrupt_hint_working',
    blockedRule: 'permission_required',
  },
  {
    id: 'copilot',
    command: 'copilot',
    ready: 'GitHub Copilot',
    working: 'esc interrupt',
    blocked: 'esc cancel · enter to confirm',
    workingRule: 'working_cancel_hint',
    blockedRule: 'selection_blocker',
  },
  {
    id: 'cursor',
    command: 'cursor-agent',
    ready: 'Cursor Agent',
    working: 'ctrl+c to stop',
    blocked: 'waiting for approval · run this command? · run (once) (y)',
    workingRule: 'stop_hint_working',
    blockedRule: 'approval_prompt',
  },
  {
    id: 'aider',
    command: 'aider',
    ready: '> ',
    working: 'Waiting for fixture-model',
    blocked: 'Confirm? (Y)es/(N)o [Yes]:',
    workingRule: 'waiting_for_model',
    blockedRule: 'confirmation_prompt',
  },
] as const;

function officialFixture(): {
  home: string;
  bin: string;
  probe(agentId: string): string;
} {
  const root = mkdtempSync(join(tmpdir(), 'charter-official-pack-e2e-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const probes = join(root, 'probes');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(probes, { recursive: true });

  for (const agent of AGENTS) {
    const probe = join(probes, `${agent.id}.log`);
    const executable = join(bin, agent.command);
    writeFileSync(
      executable,
      [
        '#!/usr/bin/env node',
        "const fs = require('node:fs');",
        `const probe = ${JSON.stringify(probe)};`,
        `const working = ${JSON.stringify(agent.working)};`,
        `const blocked = ${JSON.stringify(agent.blocked)};`,
        "fs.appendFileSync(probe, JSON.stringify({ kind: 'argv', value: process.argv.slice(2) }) + '\\n');",
        `process.stdout.write('\\x1b[?2004h${agent.ready.replaceAll("'", "\\'")}\\r\\n');`,
        'process.stdin.setRawMode?.(true);',
        "process.stdin.on('data', chunk => {",
        "  const text = chunk.toString('utf8');",
        "  fs.appendFileSync(probe, JSON.stringify({ kind: 'stdin', value: text }) + '\\n');",
        "  if (text.includes('__STATUS_WORKING__')) process.stdout.write(working + '\\r\\n');",
        "  if (text.includes('__STATUS_BLOCKED__')) process.stdout.write(blocked + '\\r\\n');",
        '});',
        'process.stdin.resume();',
        'setTimeout(() => process.exit(0), 120000);',
        '',
      ].join('\n'),
    );
    chmodSync(executable, 0o755);
  }
  return {
    home,
    bin,
    probe: (agentId) => join(probes, `${agentId}.log`),
  };
}

function probeText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

async function presence(page: Page, terminalId: string) {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['agentPresence.get']!({ terminalId: id })) as {
      ok: boolean;
      data?: { presence: { lifecycle: string; matchedRuleId: string | null } | null };
    };
    return result.data?.presence ?? null;
  }, terminalId);
}

async function presenceExplain(page: Page, terminalId: string) {
  return await page.evaluate(async (id) => {
    const result = (await window.product.rpc['agentPresence.explain']!({ terminalId: id })) as {
      data?: {
        explain: {
          matchedRule: { id: string; state: string } | null;
          screenPreview: string;
        } | null;
      };
    };
    return result.data?.explain ?? null;
  }, terminalId);
}

test('official Pack discovers and drives all five local Agents with truthful contracts', async () => {
  test.setTimeout(120_000);
  const fixture = officialFixture();
  const project = createGitFixture();
  const userDataDir = mkdtempSync(join(tmpdir(), 'charter-official-pack-user-'));
  const { app, page } = await launchApp({
    userDataDir,
    env: {
      PI_IDE_OPEN_WORKSPACE: project,
      PI_IDE_FORCE_MOCK: '1',
      PI_IDE_AGENT_HOME: fixture.home,
      PATH: `${fixture.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });

  try {
    const packCatalog = (await page.evaluate(async () =>
      window.product.rpc['agents.packs.list']!({}),
    )) as { ok: true; data: AgentPackCatalogDto };
    expect(packCatalog.ok).toBe(true);
    expect(
      packCatalog.data.packs.find((pack) => pack.id === 'charter-official-agents'),
    ).toMatchObject({
      bundled: true,
      enabled: true,
      trust: 'verified',
      adapterIds: ['gemini', 'opencode', 'copilot', 'cursor', 'aider'],
    });

    const catalogResult = (await page.evaluate(async () =>
      window.product.rpc['agents.list']!({ refresh: true }),
    )) as { ok: true; data: AgentCatalogDto };
    expect(catalogResult.ok).toBe(true);
    for (const agent of AGENTS) {
      expect(catalogResult.data.agents.find((item) => item.id === agent.id)).toMatchObject({
        installed: true,
        adapter: { source: 'pack' },
        capabilities: {
          terminal: true,
          exactResume: false,
          history: false,
          remote: true,
          lifecycle: 'observed',
        },
      });
    }
    expect(
      catalogResult.data.agents.find((item) => item.id === 'cursor')?.capabilities,
    ).toMatchObject({ images: false, acp: false, skills: false, instructions: true });
    expect(
      catalogResult.data.agents.find((item) => item.id === 'aider')?.capabilities,
    ).toMatchObject({ images: true, acp: false, skills: false, instructions: false });

    await page.getByTestId('home-settings').click();
    await page.getByTestId('settings-section-agent').click();
    const officialRow = page.getByTestId('agent-pack-charter-official-agents');
    await expect(officialRow).toContainText('official');
    await expect(officialRow).toContainText('verified');
    await expect(page.getByTestId('agent-pack-remove-charter-official-agents')).toHaveCount(0);
    for (const agent of AGENTS) {
      await expect(page.getByTestId(`agent-adapter-${agent.id}`)).toContainText('Installed');
    }
    await page.setViewportSize({ width: 900, height: 720 });
    const rowBox = await officialRow.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(900);
    await page.screenshot({ path: '/tmp/charter-official-agent-pack-narrow.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const terminalIds = new Map<string, string>();
    for (const agent of AGENTS) {
      const prompt = `official prompt ${agent.id}`;
      const result = (await page.evaluate(
        async ({ launch, initialPrompt }) =>
          window.product.rpc['terminal.create']!({
            context: { kind: 'focused' },
            launch,
            initialPrompt,
          }),
        { launch: agent.id, initialPrompt: prompt },
      )) as { ok: true; data: { id: string } } | { ok: false; error?: { userMessage?: string } };
      if (!result.ok) throw new Error(result.error?.userMessage ?? 'terminal.create failed');
      const terminalId = result.data.id;
      terminalIds.set(agent.id, terminalId);
      const path = fixture.probe(agent.id);
      await expect.poll(() => probeText(path), { timeout: 20_000 }).toContain('"kind":"argv"');
      if (agent.id === 'gemini') {
        await expect
          .poll(() => probeText(path))
          .toContain('"value":["--prompt-interactive","official prompt gemini"]');
      } else if (agent.id === 'opencode') {
        await expect
          .poll(() => probeText(path))
          .toContain('"value":["--prompt","official prompt opencode"]');
      } else if (agent.id === 'cursor') {
        await expect.poll(() => probeText(path)).toContain('"value":["official prompt cursor"]');
      } else {
        await expect.poll(() => probeText(path)).toContain('"value":[]');
        await expect.poll(() => probeText(path), { timeout: 20_000 }).toContain(prompt);
      }

      await page.evaluate(
        async ({ id }) =>
          window.product.rpc['terminal.write']!({
            id,
            data: '__STATUS_WORKING__\r',
            userInitiated: true,
          }),
        { id: terminalId },
      );
      await expect.poll(() => probeText(path)).toContain('__STATUS_WORKING__');
      await expect
        .poll(async () => await presenceExplain(page, terminalId), { timeout: 10_000 })
        .toMatchObject({ matchedRule: { id: agent.workingRule, state: 'working' } });
      await page.evaluate(
        async ({ id }) =>
          window.product.rpc['terminal.write']!({
            id,
            data: '__STATUS_BLOCKED__\r',
            userInitiated: true,
          }),
        { id: terminalId },
      );
      await expect.poll(() => probeText(path)).toContain('__STATUS_BLOCKED__');
      await expect
        .poll(async () => await presenceExplain(page, terminalId), { timeout: 10_000 })
        .toMatchObject({ matchedRule: { id: agent.blockedRule, state: 'blocked' } });
      await expect
        .poll(async () => await presence(page, terminalId), { timeout: 10_000 })
        .toMatchObject({ lifecycle: 'blocked', matchedRuleId: agent.blockedRule });
    }

    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await app.evaluate(({ clipboard, nativeImage }, data) => {
      clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, 'base64')));
    }, pngBase64);
    for (const id of ['gemini', 'opencode', 'copilot', 'aider']) {
      const result = await page.evaluate(
        async (terminalId) =>
          window.product.rpc['terminal.pasteClipboardImage']!({ id: terminalId }),
        terminalIds.get(id)!,
      );
      expect(result).toMatchObject({ ok: true, data: { pasted: true, remote: false } });
      await expect.poll(() => probeText(fixture.probe(id))).toMatch(/clipboard-.+\.png/);
    }
    const cursorImage = await page.evaluate(
      async (terminalId) => window.product.rpc['terminal.pasteClipboardImage']!({ id: terminalId }),
      terminalIds.get('cursor')!,
    );
    expect(cursorImage.ok).toBe(false);

    expect(
      existsSync(join(fixture.home, '.gemini', 'skills', 'charter-terminal', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(
        join(fixture.home, '.config', 'opencode', 'skills', 'charter-terminal', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(join(fixture.home, '.copilot', 'skills', 'charter-terminal', 'SKILL.md')),
    ).toBe(true);

    for (const terminalId of terminalIds.values()) {
      await page.evaluate(
        async (id) => window.product.rpc['terminal.kill']!({ id, force: true }),
        terminalId,
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
