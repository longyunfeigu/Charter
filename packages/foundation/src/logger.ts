import { redactObject } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: string;
  level: LogLevel;
  component: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(subComponent: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  minLevel?: LogLevel;
  /** Content redaction is on by default; only diagnostics with explicit user consent may disable it. */
  redact?: boolean;
}

export function createLogger(component: string, sink: LogSink, opts: LoggerOptions = {}): Logger {
  const minLevel = LEVEL_ORDER[opts.minLevel ?? 'info'];
  const shouldRedact = opts.redact !== false;
  const log = (level: LogLevel, message: string, context?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < minLevel) return;
    const entry: LogEntry = {
      at: new Date().toISOString(),
      level,
      component,
      message,
      ...(context
        ? { context: (shouldRedact ? redactObject(context) : context) as Record<string, unknown> }
        : {}),
    };
    sink.write(entry);
  };
  return {
    debug: (m, c) => log('debug', m, c),
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
    child: (sub) => createLogger(`${component}.${sub}`, sink, opts),
  };
}

export function memorySink(): LogSink & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    write(entry) {
      entries.push(entry);
    },
  };
}

export function consoleSink(): LogSink {
  return {
    write(entry) {
      const line = `[${entry.at}] ${entry.level.toUpperCase()} ${entry.component}: ${entry.message}`;
      if (entry.level === 'error') console.error(line, entry.context ?? '');
      else if (entry.level === 'warn') console.warn(line, entry.context ?? '');
      else console.log(line, entry.context ?? '');
    },
  };
}
