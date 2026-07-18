import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * `npm run test:security` (§16.4, §17.1, M11-01) — the security matrix in one
 * command. Two kinds of members:
 *  - security-bearing suites that also run in the normal test run (path
 *    traversal / symlink / risk-tier / secret-store cases live next to their
 *    services — listed explicitly so this entry point always covers them);
 *  - `tests/security/unit`, cases that exist only for this suite (policy pins,
 *    fuse plan, preview boundary, secret scanning).
 * The Playwright half (`tests/security/playwright.config.ts`) runs the
 * renderer-level CSP/navigation matrix against the real Electron shell.
 */
export default defineConfig({
  resolve: base.resolve,
  test: {
    ...base.test,
    include: [
      'tests/security/unit/**/*.test.ts',
      // tool gateway: risk tiers, command classification, R4 refusal, path escapes
      'packages/tool-gateway/src/security-matrix.test.ts',
      'packages/tool-gateway/src/command-classifier.test.ts',
      'packages/tool-gateway/src/permission-engine.test.ts',
      'packages/tool-gateway/src/gateway.test.ts',
      'packages/tool-gateway/src/tools-command.test.ts',
      'packages/tool-gateway/src/tools-write.test.ts',
      'packages/tool-gateway/src/tools-skill.test.ts',
      // main process: CSP pin, skill-root containment, attachment path escapes,
      // permission persistence
      'apps/desktop-main/src/csp.test.ts',
      'apps/desktop-main/src/services/skill-store.test.ts',
      'apps/desktop-main/src/services/permission-store.test.ts',
      'apps/desktop-main/src/ipc/context-attachment-handlers.test.ts',
    ],
  },
});
