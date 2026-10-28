# Logging Library Architecture

## Internal structure

The package is divided by safety responsibility rather than by log level:

- `logger`: implements the public `Logger` façade, immutable level/service policy, per-call fields, and child creation.
- `redaction`: owns normalized sensitive-key matching, the copied secret-value set, longest-match literal replacement, and reserved-key filtering.
- `serialization`: copies supported values, handles cycles and unsupported values, and converts errors to their allowlisted shape.
- `pino-adapter`: constructs the Pino 10 logger, applies fixed record/redaction options, checks enabled levels, and writes to the selected internal destination.
- `noop`: supplies the singleton no-op implementation.

The public barrel exposes only the types and functions in `spec.md`. Pino instances, destination streams, redaction configuration, and serializer helpers remain internal, so consumers cannot weaken policy or become coupled to Pino signatures.

## Control and data flow

```text
Logger.level(message, fields)
             |
             v
   Pino isLevelEnabled(level)?
       | no             | yes
       v                v
    return      omit reserved keys
                     |
                     v
     reserved/sensitive-key handling at any depth
                     |
                     v
  safe value/error copy + secret replacement in keys/strings
                     |
                     v
       Pino fixed-path redaction as backstop
                     |
                     v
       epoch time + numeric level + service/msg
                     |
                     v
          synchronous NDJSON write to stdout
```

The level check comes first so a disabled debug/trace call does not allocate sanitized copies or touch field accessors. The wrapper calls Pino with at most `(sanitizedFields, sanitizedMessage)`; it never forwards variadic interpolation arguments. Reserved fields are removed before Pino merges the object, and `base: { service }` replaces Pino's default pid/hostname bindings.

Child creation follows the same sanitization path for bindings and delegates to `pino.child` without child options. Omitting `level`, `serializers`, `formatters`, and `customLevels` is therefore security-relevant: Pino treats those binding keys specially or drops them. The wrapper retains the fixed level and immutable secret set itself and does not expose Pino's mutable level accessor.

## Pino configuration and lifecycle

Production construction uses:

- the configured standard level and Pino's standard numeric level labels;
- `base: { service }`, `messageKey: "msg"`, and `pino.stdTimeFunctions.epochTime`;
- an internal `DestinationStream` whose `write` loops over `fs.writeSync(1, buffer)` until all UTF-8 bytes are written;
- `serializers: { err: identity }`, preventing Pino's default error serializer from changing the wrapper's allowlisted error object;
- a fixed `redact` list for top-level secrets and common HTTP-header paths, with `[Redacted]` censorship as a backstop;
- no transport, multistream, pretty output, mixin, asynchronous destination, or custom level.

Pino's native redaction is path-based and case-sensitive, so it is not sufficient on its own for arbitrary nesting, normalized key variants, or raw secret values. The project-owned recursive pass provides those guarantees before Pino serializes the record. Pino's fixed paths remain useful defense in depth but are not the primary abstraction.

The direct stream avoids both asynchronous buffering and `pino.destination`'s broken-pipe handler. In the pinned Pino version, that handler converts `EPIPE` into no-op writes, which would violate the no-silent-loss contract. The internal stream instead handles partial writes and throws every `fs.writeSync` error, including `EPIPE`. Normal method return therefore means the write completed, with no buffered logger lifecycle to expose through `flush` or `close`. Stdout belongs to the process and is never closed by the library.

## Redaction and serialization design

Redaction and serialization are one recursive copy pipeline. Sensitive keys are handled before descending so a large credential object is neither traversed nor retained. Enumerable keys and string values receive literal secret replacement before JSON encoding, which handles quotes, backslashes, and newlines without regex-replacing the final JSON text. A single longest-match pass prevents one secret from partially overwriting another and never rescans `[Redacted]`. Sanitized-key collisions use JavaScript enumeration order with the later property winning; reserved-key checks run again after key sanitation.

Only plain objects, arrays, dates, errors, and supported primitives survive the copy. For supported non-Proxy inputs, data-property descriptors and intrinsic Date methods prevent accessors or custom `toJSON` methods from turning a log statement into arbitrary application work. Proxy values are outside the contract because inspection itself can invoke traps. Circular references use an ancestor stack rather than a global seen set, so repeated references remain valid data while true cycles become `[Circular]`.

Errors use an allowlist instead of Pino's general error shape. `name`, `message`, `stack`, safe `code`, and `cause` are useful diagnostics; arbitrary own properties are not. Standard fields are found through data-property descriptors along the prototype chain, never through accessors. The identity `err` serializer installed in Pino is essential: otherwise Pino's default serializer would add fields and flatten causes after the safe copy. Consumers must log safe structured details, such as configuration issues, separately rather than expecting every custom error property to appear.

Secret values are immutable per root and shared by its children. Exact-value matching cannot infer encoded or encrypted representations, so the adapter boundary remains important: HTTP clients and other producers must project allowlisted metadata instead of passing raw requests, responses, URLs with credentials/query strings, or secret-bearing payloads.

## Concurrency and root-replacement design

The root policy and each child's bindings are immutable after creation. Pino supplies destination sharing and whole-line writes; the wrapper adds no global logger, ambient correlation store, queue, or lock. Calls on one Node event loop have deterministic call order, while multi-process ordering is outside scope.

If the service adds reload, it constructs a new root rather than mutating level or secrets. This avoids races where an old child uses a partially updated secret set. The service would own dependency replacement and ensure old children are drained or discarded. No asynchronous logger drain is needed, but application work that continues after shutdown can still write if the service fails to stop it. No current service reload trigger is assumed by this package.

## Trade-offs

- Recursive copying and literal secret scans add CPU and allocation cost compared with native Pino redaction. They are necessary for arbitrary nested key variants and secret-file contents; level gating and a no-payload logging rule keep the work bounded by small operational fields.
- Direct synchronous stdout writes can block the event loop on a slow destination. They provide simple ordering, visible write errors, and shutdown semantics for a single-user service; high-volume payload logging or asynchronous transports would require a new lifecycle contract rather than a hidden option.
- Fixed redaction and no custom transports reduce flexibility, but prevent callers from accidentally disabling safety or introducing user-controlled Pino redaction paths.
- Exact registered-value redaction covers raw secrets inside larger strings but cannot recognize transformed secrets. Allowlisted producer metadata is therefore still mandatory.
- Allowlisted errors omit useful custom fields unless callers log them separately. That extra step is deliberate because arbitrary error properties are a common secret-leak path.
- Numeric levels and epoch milliseconds retain Pino's efficient standard record shape but require consumers to know the documented mapping.
- A no-op singleton makes isolated tests easy, while real destination-capture tests remain necessary to prove JSON shape and redaction.

## Testing seams

The internal Pino adapter accepts a destination stream at construction; production wiring supplies synchronous stdout, while tests can supply an in-memory `write(line)` sink. This seam is not part of the public package API. It permits exact NDJSON assertions without monkey-patching global stdout and still exercises the real Pino formatter and redactor.

`redaction` and `serialization` are pure internal units for table-driven edge cases. Public-façade tests still cover level gating, reserved fields, children, option copying, and no-op behavior so internal unit tests cannot hide integration mistakes.

A failing internal destination verifies ordinary write-error propagation, while a closed-pipe subprocess exercises the real stdout path and its `EPIPE` behavior. Exact `err` assertions prove Pino's identity serializer does not reshape errors. Interleaved parent/child calls verify complete-line behavior, and immediate sink reads verify the synchronous lifecycle. Consumer tests in Batch B can use a structural recording `Logger`, but each consumer's redacted-metadata integration tests must use the real logger and capture sink rather than `noopLogger`.
