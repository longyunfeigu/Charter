import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@pi-ide/foundation': r('../../packages/foundation/src/index.ts'),
      '@pi-ide/ipc-contracts': r('../../packages/ipc-contracts/src/index.ts'),
      '@pi-ide/agent-contract': r('../../packages/agent-contract/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 51730,
    strictPort: true,
  },
});
