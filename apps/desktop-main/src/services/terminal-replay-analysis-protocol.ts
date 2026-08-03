import type { TerminalReplayAnalysisDto } from '@pi-ide/ipc-contracts';

export interface TerminalReplayAnalysisSegmentInput {
  id: string;
  path: string;
  recordingStartedAtMs: number;
  clipStartMs: number;
  clipEndMs: number;
  timelineStartMs: number;
  durationMs: number;
  cols: number;
  rows: number;
  sizeBytes: number;
  live: boolean;
}

export interface TerminalReplayAnalysisRequest {
  type: 'analyze';
  reqId: string;
  taskId: string;
  cli: string | null;
  live: boolean;
  cacheDir: string;
  segments: TerminalReplayAnalysisSegmentInput[];
}

export interface TerminalReplayAnalysisShutdown {
  type: 'shutdown';
}

export type TerminalReplayAnalysisInbound =
  TerminalReplayAnalysisRequest | TerminalReplayAnalysisShutdown;

export type TerminalReplayAnalysisOutbound =
  | { type: 'ready'; pid: number }
  | { type: 'response'; reqId: string; ok: true; analysis: TerminalReplayAnalysisDto }
  | { type: 'response'; reqId: string; ok: false; error: string }
  | { type: 'log'; level: 'warn' | 'error'; message: string };
