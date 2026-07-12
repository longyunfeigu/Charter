import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@pi-ide/foundation': r('./packages/foundation/src/index.ts'),
      '@pi-ide/ipc-contracts': r('./packages/ipc-contracts/src/index.ts'),
      '@pi-ide/agent-contract': r('./packages/agent-contract/src/index.ts'),
      '@pi-ide/agent-runtime-mock': r('./packages/agent-runtime-mock/src/index.ts'),
      '@pi-ide/agent-runtime-pi': r('./packages/agent-runtime-pi/src/index.ts'),
      '@pi-ide/app-domain': r('./packages/app-domain/src/index.ts'),
      '@pi-ide/persistence': r('./packages/persistence/src/index.ts'),
      '@pi-ide/tool-gateway': r('./packages/tool-gateway/src/index.ts'),
      '@pi-ide/workspace-service': r('./packages/workspace-service/src/index.ts'),
      '@pi-ide/document-service': r('./packages/document-service/src/index.ts'),
      '@pi-ide/search-service': r('./packages/search-service/src/index.ts'),
      '@pi-ide/git-service': r('./packages/git-service/src/index.ts'),
      '@pi-ide/terminal-service': r('./packages/terminal-service/src/index.ts'),
      '@pi-ide/change-service': r('./packages/change-service/src/index.ts'),
      '@pi-ide/verification-service': r('./packages/verification-service/src/index.ts'),
      '@pi-ide/language-service': r('./packages/language-service/src/index.ts'),
      '@pi-ide/test-fixtures': r('./packages/test-fixtures/src/index.ts'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
