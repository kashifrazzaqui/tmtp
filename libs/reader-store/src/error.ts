export type ReaderStoreErrorCode = "not-found" | "conflict" | "immutable-conflict" | "unknown-version" | "invalid-query";

const MESSAGES: Record<ReaderStoreErrorCode, string> = {
  "not-found": "Reader-store record was not found.",
  conflict: "Reader-store record conflicts with existing data.",
  "immutable-conflict": "Reader-store immutable record conflicts with existing data.",
  "unknown-version": "Reader-store version is unknown.",
  "invalid-query": "Reader-store query is invalid.",
};

export class ReaderStoreError extends Error {
  override readonly name = "ReaderStoreError" as const;
  override readonly cause?: unknown;
  constructor(readonly code: ReaderStoreErrorCode, cause?: unknown) {
    super(MESSAGES[code]);
    if (cause !== undefined) this.cause = cause;
  }
}

export function fail(code: ReaderStoreErrorCode, cause?: unknown): never {
  throw new ReaderStoreError(code, cause);
}
