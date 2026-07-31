import { expect, test } from '@playwright/test';
import { createGitFixture } from './helpers/fixtures';
import { launchApp } from './helpers/launch';
import {
  terminalPtySnapshot,
  typeTerminalCommand,
  waitForTerminalOutput,
} from './helpers/terminal';

test.describe('terminal interactivity under sustained output', () => {
  test('keeps a foreground terminal responsive while another session floods output', async () => {
    const fixture = createGitFixture();
    const { app, page } = await launchApp({
      env: { PI_IDE_OPEN_WORKSPACE: fixture, ZDOTDIR: fixture },
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      await page.keyboard.press('Control+`');
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
      const first = (await terminalPtySnapshot(page)).items.at(-1)!;

      await page.evaluate(() => {
        const probe = {
          running: true,
          last: performance.now(),
          maxGap: 0,
          frames: 0,
        };
        (
          window as unknown as {
            __terminalInteractivityProbe: typeof probe;
          }
        ).__terminalInteractivityProbe = probe;
        const tick = (now: number): void => {
          probe.maxGap = Math.max(probe.maxGap, now - probe.last);
          probe.last = now;
          probe.frames += 1;
          if (probe.running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

      const flood =
        "(i=1; while [ $i -le 12000 ]; do printf 'FLOOD_%05d_abcdefghijklmnopqrstuvwxyz\\n' $i; " +
        "i=$((i+1)); [ $((i % 40)) -ne 0 ] || sleep 0.01; done; echo '__FLOOD_DONE__') &";
      await typeTerminalCommand(page, flood, {
        terminalId: first.id,
        xterm: page.locator('.xterm'),
      });
      await waitForTerminalOutput(page, 'FLOOD_00040_', { terminalId: first.id });

      await page.getByTestId('terminal-new').click();
      await expect
        .poll(async () => (await terminalPtySnapshot(page)).items.length)
        .toBeGreaterThanOrEqual(2);
      const second = (await terminalPtySnapshot(page)).items.at(-1)!;
      expect(second.id).not.toBe(first.id);
      await expect(page.getByTestId('terminal-host')).toHaveAttribute(
        'data-terminal-id',
        second.id,
      );

      const startedAt = Date.now();
      await typeTerminalCommand(page, "printf '__FOREGROUND_INPUT_OK__\\n'", {
        terminalId: second.id,
        xterm: page.locator('.xterm'),
      });
      await waitForTerminalOutput(page, '__FOREGROUND_INPUT_OK__', {
        terminalId: second.id,
        timeout: 5_000,
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);

      await waitForTerminalOutput(page, '__FLOOD_DONE__', {
        terminalId: first.id,
        timeout: 30_000,
      });
      const probe = await page.evaluate(() => {
        const value = (
          window as unknown as {
            __terminalInteractivityProbe: {
              running: boolean;
              maxGap: number;
              frames: number;
            };
          }
        ).__terminalInteractivityProbe;
        value.running = false;
        return { maxGap: value.maxGap, frames: value.frames };
      });
      expect(probe.frames).toBeGreaterThan(10);
      expect(probe.maxGap).toBeLessThan(1_000);
      expect(pageErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
