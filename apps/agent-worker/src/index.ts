/**
 * Agent utility process (ADR-0002): hosts ONLY the AgentRuntime (pi adapter or
 * deterministic mock). No filesystem tools, no database, no secrets at rest —
 * every tool call is proxied to the main-process Tool Gateway over the port.
 */
import type {
  AgentRuntime,
  ToolExecutor,
  ToolResultPayload,
  WorkerInbound,
  WorkerOutbound,
} from '@pi-ide/agent-contract';
import { MockAgentRuntime } from '@pi-ide/agent-runtime-mock';
import { toProductError } from '@pi-ide/foundation';

const port = process.parentPort;
if (!port) {
  console.error('agent-worker must run as an Electron utility process');
  process.exit(1);
}

function send(message: WorkerOutbound): void {
  port.postMessage(message);
}

let runtime: AgentRuntime | null = null;
const pendingTools = new Map<string, (result: ToolResultPayload) => void>();
const sessionTaskById = new Map<string, string>();

const toolExecutor: ToolExecutor = (call, signal) =>
  new Promise<ToolResultPayload>((resolve) => {
    pendingTools.set(call.callId, resolve);
    send({ type: 'toolRequest', taskId: call.taskId, call });
    signal.addEventListener(
      'abort',
      () => {
        if (pendingTools.delete(call.callId)) {
          resolve({
            callId: call.callId,
            ok: false,
            code: 'CANCELLED',
            summary: 'The tool call was cancelled.',
            data: {},
          });
        }
      },
      { once: true },
    );
  });

async function handle(message: WorkerInbound): Promise<void> {
  switch (message.type) {
    case 'init': {
      try {
        if (message.runtimeKind === 'pi') {
          const { PiAgentRuntime } = await import('@pi-ide/agent-runtime-pi');
          runtime = new PiAgentRuntime({
            toolExecutor,
            credentials: message.credentials,
          });
        } else {
          runtime = new MockAgentRuntime({ toolExecutor, pacingMs: 12 });
        }
        const info = await runtime.initialize({
          runtimeDataDir: message.runtimeDataDir,
          appVersion: message.appVersion,
        });
        send({ type: 'response', reqId: message.reqId, ok: true, data: info });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_RUNTIME_INIT_FAILED'),
        });
      }
      break;
    }
    case 'createSession': {
      try {
        const ref = await runtime!.createSession(message.input);
        sessionTaskById.set(ref.sessionId, message.input.taskId);
        send({ type: 'response', reqId: message.reqId, ok: true, data: ref });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_SESSION_CREATE_FAILED'),
        });
      }
      break;
    }
    case 'resumeSession': {
      try {
        const ref = await runtime!.resumeSession(message.ref);
        send({ type: 'response', reqId: message.reqId, ok: true, data: ref });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_SESSION_RESUME_FAILED'),
        });
      }
      break;
    }
    case 'startRun': {
      const { taskId, input } = message;
      void (async () => {
        try {
          for await (const event of runtime!.startRun(input)) {
            send({ type: 'event', taskId, runId: input.runId, event });
          }
        } catch (e) {
          const error = toProductError(e, 'AG_RUN_STREAM_FAILED');
          send({
            type: 'event',
            taskId,
            runId: input.runId,
            event: {
              type: 'run.failed',
              sequence: Number.MAX_SAFE_INTEGER,
              at: new Date().toISOString(),
              runId: input.runId,
              schemaVersion: 1,
              error,
            },
          });
        } finally {
          send({ type: 'runEnded', taskId, runId: input.runId });
        }
      })();
      break;
    }
    case 'steer':
      await runtime?.steer(message.runId, message.text);
      break;
    case 'followUp':
      await runtime?.followUp(message.runId, message.text);
      break;
    case 'setSessionModel': {
      try {
        await runtime!.setSessionModel(message.sessionId, message.model);
        send({ type: 'response', reqId: message.reqId, ok: true, data: null });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_SET_MODEL_FAILED'),
        });
      }
      break;
    }
    case 'abort':
      await runtime?.abort(message.runId, message.reason);
      break;
    case 'listModels': {
      try {
        const models = await runtime!.listModels();
        send({ type: 'response', reqId: message.reqId, ok: true, data: models });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_LIST_MODELS_FAILED'),
        });
      }
      break;
    }
    case 'validateCredential': {
      try {
        const check = await runtime!.validateCredential(message.providerId);
        send({ type: 'response', reqId: message.reqId, ok: true, data: check });
      } catch (e) {
        send({
          type: 'response',
          reqId: message.reqId,
          ok: false,
          error: toProductError(e, 'AG_VALIDATE_FAILED'),
        });
      }
      break;
    }
    case 'toolResult': {
      const resolve = pendingTools.get(message.callId);
      if (resolve) {
        pendingTools.delete(message.callId);
        resolve(message.result);
      }
      break;
    }
    case 'shutdown': {
      await runtime?.dispose().catch(() => undefined);
      process.exit(0);
      break;
    }
  }
}

port.on('message', (event) => {
  const message = event.data as WorkerInbound;
  void handle(message).catch((e) => {
    send({ type: 'log', level: 'error', message: `worker handler failed: ${String(e)}` });
  });
});

// Orphan guards (M10/REL): if the main process dies — even by SIGKILL — this
// process must not linger. The port closes when the remote end disconnects;
// the ppid watchdog covers platforms/paths where 'close' never fires
// (an orphaned process is reparented, so ppid drops to 1/launchd).
// MessagePortMain emits 'close' when the remote end disconnects; Electron's
// parentPort typings only declare 'message', so widen for this one listener.
(port as unknown as NodeJS.EventEmitter).on('close', () => {
  void runtime?.dispose().catch(() => undefined);
  process.exit(0);
});
setInterval(() => {
  if (process.ppid === 1) {
    void runtime?.dispose().catch(() => undefined);
    process.exit(0);
  }
}, 5000).unref();

send({ type: 'ready', pid: process.pid, node: process.version });
