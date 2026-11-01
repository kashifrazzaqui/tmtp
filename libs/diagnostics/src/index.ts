import { DiagnosticsError } from "./errors.js";
import { capabilities, liveness, readiness } from "./health.js";
import { validateQuery } from "./pages.js";
import { produceSnapshot } from "./snapshot.js";
import { debugStream, validateStreamSignal } from "./stream.js";
import type { Diagnostics, DiagnosticsOptions, DebugStreamOptions, DebugWindowQuery } from "./types.js";

export { DiagnosticsError } from "./errors.js";
export type { DiagnosticsErrorCode } from "./errors.js";
export type * from "./types.js";

export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  if (options === null || typeof options !== "object" || options.store === null || typeof options.store !== "object" ||
    options.jobs === null || typeof options.jobs !== "object" || options.clock === null || typeof options.clock !== "object" ||
    typeof options.clock.now !== "function" || typeof options.clock.monotonicNowMs !== "function" || typeof options.sleep !== "function" ||
    options.debug === null || typeof options.debug !== "object" || typeof options.debug.enabled !== "boolean" ||
    typeof options.debug.includeLlmPayloads !== "boolean" || !Number.isInteger(options.debug.streamIntervalMs) ||
    options.debug.streamIntervalMs < 250 || options.debug.streamIntervalMs > 60_000 ||
    (options.debug.includeLlmPayloads && !options.debug.enabled) ||
    (options.secretValues === undefined) === (options.secretValuesProvider === undefined) ||
    (options.secretValuesProvider !== undefined && typeof options.secretValuesProvider !== "function") ||
    (options.secretValues !== undefined && (!Array.isArray(options.secretValues) || options.secretValues.some((value) => typeof value !== "string")))) {
    throw new DiagnosticsError("invalid-configuration");
  }
  const secretValues = options.secretValues === undefined ? [] : [...options.secretValues].filter((value) => value.length > 0);
  const secretValuesProvider = options.secretValuesProvider;
  const debug = Object.freeze({ ...options.debug });
  const snapshotDependencies = {
    store: options.store, jobs: options.jobs, clock: options.clock, includeLlmPayloads: debug.includeLlmPayloads,
    secretValues, ...(secretValuesProvider === undefined ? {} : { secretValuesProvider }),
  };
  const assertEnabled = (): void => { if (!debug.enabled) throw new DiagnosticsError("debug-disabled"); };
  return {
    liveness: () => liveness(options.clock),
    readiness: (input) => readiness(options.clock, input),
    capabilities: (input) => capabilities(options.clock, input),
    debugSnapshot(query?: DebugWindowQuery) {
      assertEnabled();
      const plans = validateQuery(query);
      return produceSnapshot(snapshotDependencies, plans);
    },
    debugStream(streamOptions?: DebugStreamOptions) {
      assertEnabled();
      if (streamOptions !== undefined && (streamOptions === null || typeof streamOptions !== "object" || Array.isArray(streamOptions))) {
        throw new DiagnosticsError("invalid-input");
      }
      validateStreamSignal(streamOptions?.signal);
      const plans = validateQuery(streamOptions?.query, true);
      return debugStream({
        clock: options.clock, sleep: options.sleep, intervalMs: debug.streamIntervalMs, plans,
        snapshot: (current) => produceSnapshot(snapshotDependencies, current),
        ...(streamOptions?.signal === undefined ? {} : { signal: streamOptions.signal }),
      });
    },
  };
}
