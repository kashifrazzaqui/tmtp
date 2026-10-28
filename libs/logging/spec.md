# Logging Library Spec

## Purpose and responsibility

Provide structured, leveled JSON logs with inherited correlation fields, mandatory secret redaction, and safe error serialization without exposing Pino to feature libraries. The package is a narrow synchronous stdout sink for one Node process. It is not a transport framework, payload-capture system, audit store, metrics system, or mutable global logger.

## Public interface / API surface

The package entry point exports exactly these contracts; no Pino logger, options, destination, serializer, or level type escapes:

```ts
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
  secretValues: readonly string[];
}

export function createLogger(options: CreateLoggerOptions): Logger;
export const noopLogger: Logger;
```

`trace` is part of the interface because it is an allowed configured level. There is intentionally no `fatal`, `silent`, mutable `level`, interpolation API, `flush`, `close`, transport, or raw Pino escape hatch.

## Construction and error behavior

- `level` is required. The `logging.level` configuration schema applies the default `info`; the factory does not hide a second default.
- `service` is trimmed and must be non-empty. The trimmed, redacted value is bound to every record.
- `secretValues` is required so every caller explicitly chooses its secret-redaction set. The service passes every loaded access token, HN session cookie, LLM API key, and comparable raw secret; library tests and compositions with no secrets pass `[]`.
- The factory copies `secretValues`. Empty strings are ignored because replacing an empty string is meaningless; all other strings, including whitespace, are treated literally. Later mutation of the caller's array does not change the logger or its children.
- At runtime, an unknown level, blank/non-string service, or non-array/non-string-secret input throws `TypeError` with a fixed message that does not include the supplied option or a secret. The messages are respectively `Invalid log level.`, `Invalid service name.`, and `Invalid secret values.`
- Pino/Node destination construction failures propagate. The factory does not write a startup record and does not log its options.

## Log records and level filtering

Each accepted call writes one newline-delimited JSON object to file descriptor 1. Every record has:

- `level`: the Pino numeric level — `trace=10`, `debug=20`, `info=30`, `warn=40`, `error=50`.
- `time`: integer Unix epoch milliseconds supplied by Pino at call time.
- `service`: the root service binding.
- `msg`: the message after secret-value redaction. Percent signs have no interpolation meaning because the public API accepts no interpolation arguments.
- Inherited child bindings and per-call fields as additional top-level properties.

`pid` and `hostname` are not added. Newline delimiters are `\n`. No pretty printer, file rotation, worker transport, asynchronous buffer, or secondary destination is configured.

The configured level is a minimum threshold: `error` emits only error, `warn` adds warn, `info` adds info, `debug` adds debug, and `trace` emits every public level. A suppressed call returns without writing and without traversing or serializing its fields. The level is fixed for the life of the root and all children.

The wrapper owns the reserved record keys `level`, `time`, `service`, `msg`, and the Pino control keys `serializers`, `formatters`, and `customLevels`. Reserved keys in per-call fields or child bindings are omitted, preventing callers from forging metadata or changing child behavior. Other keys are preserved subject to redaction and serialization. For an unreserved duplicate correlation key, a child binding overrides its ancestors and a per-call field overrides bindings; wrapper-owned metadata still wins.

Correlation fields use stable camelCase names, including `runId`, `jobId`, `storyId`, `profileId`, and `requestId`. Producers add them through `child` when they apply to an operation and through per-call fields for one event. The logging package does not generate IDs or infer ambient context.

## Redaction and secret safety

Redaction applies to messages, root service text, enumerable field names, child bindings, per-call fields, nested arrays/objects, and serialized errors at every enabled level. The replacement is always the literal string `[Redacted]`.

### Sensitive-key redaction

Before serializing a value, the wrapper compares each object key case-insensitively after removing `_` and `-`. A key whose normalized form is in the following fixed set has its entire value replaced, without traversing that value:

```text
authorization proxyauthorization cookie cookies setcookie xapikey
apikey token authtoken accesstoken refreshtoken sessiontoken csrftoken
secret clientsecret password passwd sessioncookie csrfsecret
sessionid opaquesession credential credentials secretvalues secretfilecontents
```

This covers authorization and proxy-authorization headers, cookies, access/session/CSRF tokens, API keys, passwords, opaque sessions, and secret-file contents at arbitrary nesting depths. Matching is exact after normalization rather than a broad substring match. In particular, `auth.access_token_path`, `llm.api_key_path`, `hn.session_cookie_path`, and other `*_path` keys are not secret values and are not removed merely because they name a secret location.

### Registered-value redaction

After sensitive-key handling, every retained string key and string value is scanned for every non-empty registered secret. Replacement is case-sensitive, literal, global within the string, and performed in one pass with the longest match winning at a given position. Replacement output is not scanned again. This hides a secret whether it appears in a property name, alone in a value, inside a longer message, inside an error stack, or in overlapping secret sets.

Object keys are redacted before insertion into the copied record. If two source keys produce the same sanitized key, the later property in JavaScript enumeration order wins. Reserved-key checks apply to the sanitized top-level key as well, so redaction cannot create a metadata override.

Registration covers exact values only. URL-encoding, base64 encoding, hashing, or other transformations do not derive additional redaction entries. A secret that was not registered and appears under an innocuous key cannot be detected reliably. Therefore producers must never intentionally log raw secrets, must register every loaded secret with the root logger, and must use allowlisted non-secret request/response metadata rather than raw headers, credential-bearing URLs, or query strings. Paths to secret files are safe; their contents are not.

`debug.include_llm_payloads` does not relax logger redaction or authorize raw prompt/article logging. That option belongs to explicit diagnostics capture. Normal logs contain event and correlation metadata, not prompt bodies, profile payloads, article content, cookies, tokens, API keys, or secret-file values.

### Safe value and error serialization

The wrapper converts fields into JSON-safe values before Pino sees them:

- Strings are redacted; booleans, finite numbers, and `null` remain unchanged. Non-finite numbers become `null`; bigints become decimal strings.
- Valid `Date` objects become ISO-8601 strings; invalid dates become `null`.
- Arrays and plain objects are copied recursively. Only enumerable string keys are retained, and those keys are secret-redacted. Accessor properties are not invoked and become `[Unserializable]`; other unsupported class instances also become `[Unserializable]`. Custom `toJSON` methods are not invoked.
- `undefined`, functions, and symbols are omitted from object properties and become `null` in arrays. Symbol-keyed properties are omitted.
- A circular reference becomes `[Circular]`; repeated non-circular references are serialized independently.
- An `Error` becomes an object containing only `name`, `message`, optional `stack`, optional string/number `code`, and optional `cause`. Strings are secret-redacted and `cause` is serialized recursively. Other own error properties are omitted so an error cannot smuggle arbitrary credential fields into output. Pino's default `err` serializer is replaced with an identity serializer so it cannot reshape this safe object.

For supported non-Proxy inputs, serialization does not call arbitrary user code. Data-property descriptors are used instead of accessors, including for allowlisted error fields and their prototype chains; an accessor-valued error field is omitted, with missing `name`/`message` falling back to `Error` and the empty string. Date conversion uses intrinsic Date methods. Cycles, unsupported class instances, and accessor properties do not throw. Fields are copied rather than mutated.

Proxy inputs are outside the serialization contract because even inspecting a Proxy can invoke its traps. Their trap side effects and exceptions are not suppressed. A destination write failure throws through the logging call; it is never swallowed or reported as a successful log write.

If a destination failure occurs after a partial write, the destination may contain a partial final line. The call still throws and must not be treated as having emitted a complete record.

## Child loggers and `noopLogger`

`child(fields)` sanitizes and binds a copy of `fields`, returns a logger with the same destination, fixed level, service, and secret set, and emits no record of its own. Child creation does not mutate the parent or sibling loggers. Children may be created from children; normal field precedence follows the record rules above.

`noopLogger` implements every method, including `trace`, as a no-op. It performs no serialization or I/O, and `child` returns `noopLogger` itself. It is suitable for optional logging and isolated unit tests, but it cannot substitute for real-output redaction tests.

## Lifecycle and concurrency

A root logger passes Pino an internal synchronous stdout stream. Its `write` loops over `fs.writeSync(1, buffer)` until the complete UTF-8 record is written and propagates all errors, including `EPIPE`. Once an enabled method returns normally, the complete record has been written; no asynchronous flush remains. The library opens no file descriptor and owns no timer, worker, or close operation. The process owns stdout, and the logging package never closes it. The service's synchronous-log shutdown step therefore has no buffered transport to drain.

Children share the root destination and immutable policy. Calls on the Node event loop emit whole NDJSON lines in call order. The package provides no ordering or atomicity guarantee across multiple Node workers or processes and no backpressure queue beyond the synchronous destination's behavior.

If the service adds configuration reload, it creates a new root with the new level and complete new secret set, then replaces logger-dependent composition atomically. Old roots and children retain their old immutable policy until discarded; reload does not mutate them. The service must stop using old children after the swap so retired secrets and new secrets cannot receive the wrong policy. This package does not itself provide or schedule that lifecycle.

## Invariants

1. Every enabled call that returns normally has emitted one complete valid single-line JSON record with wrapper-owned level, time, service, and message metadata; a level-suppressed call emits nothing, and failed writes may leave a partial final line but never report success.
2. No Pino type or object is required by consumers, and no caller can disable or replace the fixed redaction policy.
3. Sensitive keys and registered secrets in field names or values are redacted from every enabled record, including children and errors; filtered calls do no field work.
4. Child context is additive and immutable from the parent's perspective; correlation keys retain their documented names.
5. Real logging is synchronous stdout with no asynchronous shutdown state; `noopLogger` has no side effects.
6. Redaction is defense in depth, not permission to log secrets or payloads. Producers remain responsible for allowlisted metadata and complete secret registration.

## Acceptance-focused test expectations

- Exercise the complete level matrix, including `trace`, and assert numeric levels, threshold filtering, required metadata, literal percent signs, and valid NDJSON. Prove suppressed calls do not invoke accessors or serialization.
- Assert trimmed service binding, epoch time, no default pid/hostname, omission of every reserved/control key, and parent/child/per-call precedence for correlation fields.
- Cover every sensitive-key spelling family at root and in nested objects, arrays, and HTTP-style headers. Assert the whole value becomes `[Redacted]` while `*_path` fields and correlation IDs remain visible.
- Register multiple secret sentinels, including overlapping values and values containing JSON-significant characters. Assert none occurs in raw output from messages, service text, field names, field values, children, errors, causes, or stacks; assert exact placeholder behavior, deterministic collisions between redacted keys, and no replacement of the empty string.
- Verify copied secret options, fixed safe construction errors, propagation of destination failures, and that invalid options never echo the supplied secret.
- Serialize errors under the exact key `err` and other keys, in per-call fields and child bindings, with nested causes, safe codes, custom secret-bearing properties, cycles, bigints, non-finite numbers, dates, unsupported class instances, accessors, and custom `toJSON`; assert the complete emitted error object has only the documented safe shape and inputs are unchanged.
- Prove child loggers retain parent context without mutating siblings, share redaction and level policy, and produce independent complete lines during interleaved calls.
- Assert every `noopLogger` method is silent and `child` returns the singleton.
- Use a real capture destination for integration assertions and read it immediately after each synchronous call; do not rely only on mocks of the public logger.
- Run a subprocess with a closed stdout pipe and assert the production stdout path surfaces `EPIPE` instead of silently discarding the record or returning success.

## Internal subcomponents

- Narrow `Logger` façade and immutable child-context propagation.
- Level gate and Pino NDJSON/stdout adapter.
- Fixed sensitive-key and registered-value redaction policy.
- Safe recursive value copier and allowlisted error serializer.

## Dependencies on other libs

None. The only runtime dependency is Pino `10.4.0` and its bundled runtime dependencies.

## New build or OSS wrapper

New narrow wrapper around Pino `10.4.0`; no external transport or formatting package.

## Hosted by

`services/personal-reader` and all in-process compositions. `http-client`, `scheduler`, and other consumers accept only the structural `Logger` interface.

## Configuration

- `logging.level` — **optional**, default `info`; one of `error`, `warn`, `info`, `debug`, `trace`. The component-owned configuration schema applies the default and validates the enum before calling `createLogger`.
