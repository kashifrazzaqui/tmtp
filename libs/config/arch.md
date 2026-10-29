# Config Library Architecture

## Internal structure

The package has a small public barrel and three internal concerns:

- `parse`: invokes the caller's synchronous Zod schema and discriminates success from validation failure.
- `issues`: classifies Zod issues, formats stable paths, and emits the fixed safe messages in `spec.md`.
- `validation-error`: owns `ConfigValidationError`, defensive issue copies, aggregate formatting, and malformed-result protection in `assertValidConfig`.

The public barrel exposes `ConfigIssue`, `ConfigResult`, `ConfigValidationError`, `parseConfig`, `assertValidConfig`, and Zod's `z` value. The `z` re-export supports schema construction only; there is no product schema module, loader, registry, environment adapter, or singleton. Component and service schemas remain outside this tier-0 package.

## Control and data flow

```text
loaded unknown + caller schema
              |
              v
      Zod synchronous safeParse
       |                  |
       | success          | failure
       v                  v
schema output       top-level Zod issues
       |                  |
       |                  v
       |          classify + format path
       |          discard unsafe details
       |                  |
       v                  v
{ value, issues: [] }   { issues: [safe issues] }
                              |
                              v
                    assertValidConfig
                     |             |
                     v             v
                  value     ConfigValidationError
```

The parser uses `schema.safeParse(loaded, { reportInput: true })`. Zod 4 omits issue input by default; reporting it is necessary to distinguish a missing `invalid_type` input from a present value of the wrong type. Raw issues stay in the parse call's local scope. The mapper reads only the fields needed for code and path classification and never publishes the raw issue array.

Only static object paths and numeric array indices are supported. Zod record/map failures and input-derived custom paths can place a supplied property name in `issue.path`; those schemas are outside the contract because no generic formatter can distinguish such a key from a schema-owned safe name. For strict product objects, the mapper uses the parent issue path and discards `unrecognized_keys.keys`, so even a secret-shaped unknown property name is not echoed.

A successful Zod parse is returned directly as the typed value. The library does not clone, coerce, freeze, supplement, or post-process that output. A failed parse creates new plain `ConfigIssue` objects. `assertValidConfig` is deliberately separate so startup can collect and log all safe issues before deciding to throw.

## Zod use and schema ownership

Zod is the only runtime dependency and the source of parsing semantics. The public `z` re-export lets services construct schemas through `@tmtp/config` using that existing declared dependency, without adding dependency or manifest edges. Defaults, `.catch()`, strict objects, transforms, and refinements behave exactly as the supplied synchronous schema defines them. The library does not call `safeParseAsync`, catch application exceptions from schema code, or turn an async-schema error into a user configuration issue.

Custom Zod issues map to `inconsistent`; built-in checks map to `required` or `invalid`. This gives component schema authors one clear convention: built-ins validate fields, while custom refinements express relations between fields. The generic mapper does not inspect custom params or custom messages, so diagnostics cannot accidentally disclose secrets embedded by a refinement.

The service composes strict component fragments and its own deployment refinements. No import edge points from `config` to those fragments. This preserves the tier graph and prevents a primitive from accumulating every feature's configuration and dependencies.

## Error and secret-safety design

Fixed messages trade detailed Zod diagnostics for a small, testable safe surface. Zod messages, literal/enum values, union branches, custom params, raw inputs, and `ZodError` causes can contain supplied data, so none cross the public boundary. The safe key path plus code is sufficient for an operator to locate the setting; the owning schema documentation supplies the expected shape.

`ConfigValidationError` aggregates only already-sanitized issues and intentionally has no raw cause. This makes it safe to present through startup diagnostics and to serialize through the logging package's allowlisted error serializer. Schema programmer errors still propagate, but callers must not treat arbitrary thrown messages as safe configuration diagnostics.

Secret-file loading is deliberately upstream. Keeping file I/O out of parsing makes reload behavior explicit, keeps tests in memory, and prevents a validation library from turning secret paths into secret-bearing error objects.

## Lifecycle and concurrency design

All work is synchronous CPU work with no shared module state. A schema and its output belong to the caller; the package stores neither. Consequently, repeated startup checks and candidate reloads cannot observe stale results from earlier calls. Thread or worker safety is inherited from the caller's schema and output rather than provided by a lock.

If the service adds reloads, it owns any atomic active-config swap, version ordering for overlapping reloads, dependency reconstruction, and rollback to the last valid candidate. Those concerns are not hidden behind a watcher in this package, and the current library contract does not claim that the service already has such a lifecycle.

## Trade-offs

- Fixed generic messages sacrifice expected-versus-received detail, but make non-echoing diagnostics enforceable rather than dependent on every schema author's messages.
- `reportInput: true` temporarily attaches raw input to Zod issues, but is required for accurate `required` classification. The local-only mapper and no-cause error policy prevent that input from escaping.
- A result object plus explicit assertion supports aggregate diagnostics, but callers can construct malformed results in JavaScript. The own-property and non-empty-issue checks cover the meaningful malformed cases without adding a second result encoding.
- Synchronous-only schemas keep startup and reload deterministic. Async secret reads and connectivity probes remain separate service operations and cannot be smuggled into validation.
- Static schema paths make the non-echo guarantee enforceable, but exclude dynamic-key records/maps and input-derived custom paths. Product configuration uses fixed namespaces and therefore does not need those schema forms.
- Re-exporting `z` adds a small explicit runtime surface and avoids undeclared transitive Zod imports; consumers must use the same supported synchronous, static-path schema contract.
- Returning Zod's output avoids another clone and preserves transforms, but also means mutability and purity of custom schemas are part of the component contract.
- A generic parser avoids a central product registry, at the cost of requiring the composition root and component contracts to make schema ownership explicit.

## Testing seams

Caller-supplied in-memory Zod schemas are the primary seam; no Zod mock is needed. Table-driven schemas exercise defaults, transforms, strict keys, secret-shaped unknown property names, every issue classification, nested paths, malicious custom messages, async refinements, and thrown application exceptions through the public API.

The own-`value`-property rule allows success and failure assertions to distinguish valid `undefined` from failure without relying on truthiness. Direct `ConfigValidationError` construction tests defensive copying and empty-input rejection.

Product deployment refinements are tested at the service composition boundary with the real composed schema, not by adding service imports to tier-0 tests. Independent candidate tests use failed and successful values to prove that no parser state leaks between calls. A future service reload lifecycle needs separate integration tests for dependency replacement and draining; a parse-only test cannot establish those properties.
