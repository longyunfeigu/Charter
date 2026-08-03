import { z } from 'zod';

/** A physical PTY recording may contribute one or more bounded pieces to a Session. */
export const TerminalReplaySegmentDtoSchema = z.object({
  id: z.string(),
  recordingId: z.string(),
  terminalId: z.string(),
  title: z.string(),
  cwd: z.string(),
  source: z.enum(['daemon', 'process', 'remote']),
  hostLabel: z.string().nullable(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(1000),
  /** Position of this piece on the Session's uncompressed wall-clock timeline. */
  timelineStartMs: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  live: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
});
export type TerminalReplaySegmentDto = z.infer<typeof TerminalReplaySegmentDtoSchema>;

export const TerminalReplaySessionDtoSchema = z.object({
  taskId: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
  startedAt: z.string(),
  originalDurationMs: z.number().int().nonnegative(),
  live: z.boolean(),
  segments: z.array(TerminalReplaySegmentDtoSchema),
});
export type TerminalReplaySessionDto = z.infer<typeof TerminalReplaySessionDtoSchema>;

/** asciinema-compatible event after it has been clipped to the owning Session. */
export const TerminalReplayEventDtoSchema = z.object({
  atMs: z.number().int().nonnegative(),
  code: z.enum(['o', 'r']),
  data: z.string(),
});
export type TerminalReplayEventDto = z.infer<typeof TerminalReplayEventDtoSchema>;

/**
 * A wall-clock interval whose terminal frames are repetitive enough to play
 * faster without dropping a single recorded PTY event.
 */
export const TerminalReplayCompressionSpanDtoSchema = z.object({
  id: z.string().min(1).max(240),
  startAtMs: z.number().int().nonnegative(),
  endAtMs: z.number().int().nonnegative(),
  kind: z.enum(['thinking', 'progress', 'idle', 'motion']),
  label: z.string().min(1).max(120),
  confidence: z.enum(['high', 'medium']),
  originalDurationMs: z.number().int().nonnegative(),
  suggestedDurationMs: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  /** True while the end of this interval may still move as the PTY appends. */
  live: z.boolean(),
});
export type TerminalReplayCompressionSpanDto = z.infer<
  typeof TerminalReplayCompressionSpanDtoSchema
>;

/** Lightweight cached index produced by the background VT-screen analyzer. */
export const TerminalReplayAnalysisDtoSchema = z.object({
  version: z.literal(1),
  status: z.enum(['ready', 'unavailable']),
  analyzedThroughMs: z.number().int().nonnegative(),
  totalEvents: z.number().int().nonnegative(),
  sampledFrames: z.number().int().nonnegative(),
  motionEvents: z.number().int().nonnegative(),
  collapsibleDurationMs: z.number().int().nonnegative(),
  spans: z.array(TerminalReplayCompressionSpanDtoSchema),
  cached: z.boolean(),
});
export type TerminalReplayAnalysisDto = z.infer<typeof TerminalReplayAnalysisDtoSchema>;
