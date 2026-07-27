import { startTerminalDaemonFromArgs } from './services/terminal-daemon-server.js';

// This bundle is launched with ELECTRON_RUN_AS_NODE so it has no Electron app
// lifecycle and can keep PTYs alive after the Charter window and main process exit.
process.stderr.on('error', () => undefined);

void startTerminalDaemonFromArgs().catch((error) => {
  console.error('[terminal-daemon] startup failed', error);
  process.exit(1);
});
