import { createInternalLogger } from "./internal.js";
import type { CreateLoggerOptions, Logger } from "./types.js";

export type { CreateLoggerOptions, LogFields, Logger, LogLevel } from "./types.js";

export function createLogger(options: CreateLoggerOptions): Logger {
  return createInternalLogger(options);
}

export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};
