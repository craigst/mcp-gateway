import type { LogLevel } from './config.js';

export interface LogRecord {
  ts: string;
  level: Exclude<LogLevel, 'silent'>;
  module: string;
  message: string;
  context: Record<string, unknown> | undefined;
}

export type LogSink = (record: LogRecord) => void;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const sinks: LogSink[] = [];

/** Register an additional sink (used by the Web UI live log stream). */
export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    const index = sinks.indexOf(sink);
    if (index >= 0) sinks.splice(index, 1);
  };
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
  readonly module: string;
}

/** Structured JSON logger with level filtering and composable child context. */
export function createLogger(module: string, level: LogLevel = 'info'): Logger {
  return makeLogger(module, level, {});
}

function makeLogger(module: string, level: LogLevel, context: Record<string, unknown>): Logger {
  const log = (lvl: Exclude<LogLevel, 'silent'>, message: string, extra?: Record<string, unknown>): void => {
    if (LEVEL_WEIGHT[lvl] < LEVEL_WEIGHT[level]) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level: lvl,
      module,
      message,
      context: { ...context, ...extra },
    };

    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // A broken sink must never break request handling.
      }
    }

    const line = JSON.stringify({
      ts: record.ts,
      level: record.level,
      module: record.module,
      msg: record.message,
      ...(record.context ?? {}),
    });
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    module,
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
    child: (childContext) => makeLogger(module, level, { ...context, ...childContext }),
  };
}
