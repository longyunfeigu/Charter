import { expect, type Locator, type Page } from '@playwright/test';

export interface E2ETerminalInfo {
  id: string;
  pid: number;
  cwd: string;
  launch: 'shell' | 'claude' | 'codex';
  persistence: 'daemon' | 'process' | 'remote';
}

interface TerminalListPayload {
  items: E2ETerminalInfo[];
  restoredIds: string[];
  sequences: Record<string, number>;
  recentData: Record<string, string>;
}

/**
 * Read the host-owned PTY tail. This contract is independent of xterm's DOM
 * renderer, so business-flow assertions keep working when WebGL paints rows
 * into a canvas. Renderer-specific visual tests remain separate.
 */
export async function terminalPtySnapshot(page: Page): Promise<TerminalListPayload> {
  return await page.evaluate(async () => {
    const result = (await window.product.rpc['terminal.list']!({})) as
      { ok: true; data: TerminalListPayload } | { ok: false; error?: { userMessage?: string } };
    if (!result.ok) {
      throw new Error(result.error?.userMessage ?? 'terminal.list failed');
    }
    return result.data;
  });
}

export async function terminalPtyOutput(page: Page, terminalId?: string): Promise<string> {
  const snapshot = await terminalPtySnapshot(page);
  if (terminalId) return snapshot.recentData[terminalId] ?? '';
  return snapshot.items.map((item) => snapshot.recentData[item.id] ?? '').join('\n');
}

export async function waitForTerminalOutput(
  page: Page,
  expected: string | RegExp,
  options: { terminalId?: string; timeout?: number } = {},
): Promise<void> {
  const output = () => terminalPtyOutput(page, options.terminalId);
  if (typeof expected === 'string') {
    await expect.poll(output, { timeout: options.timeout ?? 15_000 }).toContain(expected);
    return;
  }
  await expect.poll(output, { timeout: options.timeout ?? 15_000 }).toMatch(expected);
}

export async function typeTerminalCommand(
  page: Page,
  command: string,
  options: { terminalId: string; xterm?: Locator; timeout?: number },
): Promise<void> {
  await waitForTerminalOutput(page, /[%$#]/, {
    terminalId: options.terminalId,
    timeout: options.timeout,
  });

  const xterm = options.xterm ?? page.locator('.xterm').last();
  await xterm.click();
  await expect(xterm.locator('.xterm-helper-textarea')).toBeFocused();

  // A PTY can exist just before the shell finishes its first prompt redraw.
  // Clear any bytes buffered during that boundary before typing the command.
  await page.keyboard.press('Control+u');
  await page.keyboard.type(command, { delay: 1 });
  await page.keyboard.press('Enter');
}
