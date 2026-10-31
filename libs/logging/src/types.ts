export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  service: string;
  secretValues?: readonly string[];
  secretValuesProvider?: () => readonly string[];
}
