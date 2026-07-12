import { describe, expect, it } from 'vitest';
// eslint-disable-next-line -- importing an .mjs module with a .d.ts is intentional here
import { checkBoundaries } from '../../scripts/boundaries-core.mjs';

describe('dependency boundary rules', () => {
  it('blocks Pi imports outside packages/agent-runtime-pi', () => {
    const violations = checkBoundaries([
      {
        path: 'apps/desktop-renderer/src/bad.ts',
        content: "import { AgentSession } from '@earendil-works/pi-coding-agent';",
      },
      {
        path: 'packages/agent-runtime-pi/src/ok.ts',
        content: "import { AgentSession } from '@earendil-works/pi-coding-agent';",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.path).toContain('desktop-renderer');
    expect(violations[0]!.rule).toBe('pi-only-in-adapter');
  });

  it('blocks electron and node builtins in the renderer', () => {
    const violations = checkBoundaries([
      {
        path: 'apps/desktop-renderer/src/a.ts',
        content: "import { ipcRenderer } from 'electron';",
      },
      { path: 'apps/desktop-renderer/src/b.ts', content: "import fs from 'node:fs';" },
      { path: 'apps/desktop-main/src/ok.ts', content: "import { app } from 'electron';" },
    ]);
    const rules = violations.map((v) => v.rule).sort();
    expect(violations).toHaveLength(2);
    expect(rules).toEqual(['renderer-no-electron', 'renderer-no-node']);
  });

  it('keeps contract packages platform-pure', () => {
    const violations = checkBoundaries([
      { path: 'packages/ipc-contracts/src/x.ts', content: "import fs from 'node:fs';" },
      { path: 'packages/agent-contract/src/y.ts', content: "import { app } from 'electron';" },
      { path: 'packages/foundation/src/z.ts', content: "import React from 'react';" },
      { path: 'packages/change-service/src/ok.ts', content: "import fs from 'node:fs';" },
    ]);
    expect(violations).toHaveLength(3);
  });

  it('blocks renderer imports of server-side domain packages', () => {
    const violations = checkBoundaries([
      {
        path: 'apps/desktop-renderer/src/a.ts',
        content: "import { ChangeService } from '@pi-ide/change-service';",
      },
      {
        path: 'apps/desktop-renderer/src/ok.ts',
        content: "import { CHANNELS } from '@pi-ide/ipc-contracts';",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.rule).toBe('renderer-allowed-packages');
  });
});
