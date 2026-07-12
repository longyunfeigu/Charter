/**
 * Agent utility process entry (spec §9.2). Hosts the Agent Runtime (Pi adapter or
 * mock) and nothing else: no direct filesystem tools, no secrets at rest, no DB.
 * Fleshed out in Milestone 6; the ready handshake exists from Milestone 1 so the
 * process supervisor and packaging can be exercised early.
 */

interface WorkerHello {
  type: 'worker.hello';
  pid: number;
  node: string;
}

const port = process.parentPort;
if (port) {
  const hello: WorkerHello = { type: 'worker.hello', pid: process.pid, node: process.version };
  port.postMessage(hello);
  port.on('message', (event) => {
    const message = event.data as { type?: string } | undefined;
    if (message?.type === 'worker.ping') {
      port.postMessage({ type: 'worker.pong', pid: process.pid });
    }
  });
} else {
  // Started outside Electron (tests); stay alive briefly for smoke checks.
  console.log('agent-worker started without parent port');
}
