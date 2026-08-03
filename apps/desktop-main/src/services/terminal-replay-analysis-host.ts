import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { TerminalReplayAnalysisDto } from '@pi-ide/ipc-contracts';
import type { Logger } from '@pi-ide/foundation';
import type {
  TerminalReplayAnalysisOutbound,
  TerminalReplayAnalysisRequest,
} from './terminal-replay-analysis-protocol.js';

interface PendingRequest {
  resolve: (analysis: TerminalReplayAnalysisDto) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Lazily supervises the isolated VT-screen analysis process. */
export class TerminalReplayAnalysisHost {
  private worker: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private initialized = false;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(private readonly logger: Logger) {}

  async analyze(
    request: Omit<TerminalReplayAnalysisRequest, 'type' | 'reqId'>,
  ): Promise<TerminalReplayAnalysisDto> {
    await this.ensure();
    const worker = this.worker;
    if (!worker) throw new Error('Terminal Replay analyzer is unavailable.');
    const reqId = randomUUID();
    return await new Promise<TerminalReplayAnalysisDto>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(reqId)) return;
        reject(new Error('Terminal Replay analysis timed out.'));
      }, 60_000);
      this.pending.set(reqId, { resolve, reject, timeout });
      worker.postMessage({ type: 'analyze', reqId, ...request });
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    this.ready = null;
    this.initialized = false;
    for (const [reqId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Terminal Replay analyzer is shutting down.'));
      this.pending.delete(reqId);
    }
    if (!worker) return;
    try {
      worker.postMessage({ type: 'shutdown' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      worker.kill();
    } catch {
      // Already exited.
    }
  }

  private async ensure(): Promise<void> {
    if (this.disposed) throw new Error('Terminal Replay analyzer is shutting down.');
    if (this.worker && this.initialized) return;
    if (this.ready) return await this.ready;
    if (this.worker) {
      try {
        this.worker.kill();
      } catch {
        // A failed handshake may already have exited.
      }
      this.worker = null;
    }
    this.ready = this.spawn().finally(() => {
      this.ready = null;
    });
    return await this.ready;
  }

  private async spawn(): Promise<void> {
    const workerPath = join(
      app.getAppPath(),
      'apps/desktop-main/dist/terminal-replay-analysis-worker.cjs',
    );
    const worker = utilityProcess.fork(workerPath, [], {
      serviceName: 'charter-terminal-replay-analysis',
      stdio: 'pipe',
    });
    this.worker = worker;
    this.initialized = false;
    worker.stdout?.on('data', (chunk: Buffer) =>
      this.logger.debug(`analysis worker stdout: ${chunk.toString().slice(0, 400)}`),
    );
    worker.stderr?.on('data', (chunk: Buffer) =>
      this.logger.warn(`analysis worker stderr: ${chunk.toString().slice(0, 400)}`),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Terminal Replay analyzer did not start in time.')),
        15_000,
      );
      const onMessage = (raw: unknown) => {
        const message = raw as TerminalReplayAnalysisOutbound;
        if (message.type === 'ready') {
          clearTimeout(timeout);
          resolve();
          return;
        }
        this.onMessage(message);
      };
      worker.on('message', onMessage);
      worker.once('exit', (code) => {
        clearTimeout(timeout);
        if (this.worker === worker) {
          this.worker = null;
          this.initialized = false;
        }
        const error = new Error(`Terminal Replay analyzer exited (${code ?? 'unknown'}).`);
        for (const [reqId, pending] of this.pending) {
          clearTimeout(pending.timeout);
          pending.reject(error);
          this.pending.delete(reqId);
        }
        reject(error);
      });
    }).catch((error) => {
      if (this.worker === worker) this.worker = null;
      this.initialized = false;
      try {
        worker.kill();
      } catch {
        // Already exited.
      }
      throw error;
    });
    this.initialized = true;
    this.logger.info('terminal replay analysis worker ready', { pid: worker.pid });
  }

  private onMessage(message: TerminalReplayAnalysisOutbound): void {
    if (message.type === 'log') {
      this.logger[message.level](`analysis worker: ${message.message}`);
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.reqId);
    if (!pending) return;
    this.pending.delete(message.reqId);
    clearTimeout(pending.timeout);
    if (message.ok) pending.resolve(message.analysis);
    else pending.reject(new Error(message.error));
  }
}
