# Config Library Spec

## Purpose and responsibility

Validate one centralized, already-loaded configuration value and return a complete typed view with schema-owned defaults and transforms applied. The library is a synchronous, product-agnostic adapter over Zod. It does not load environment variables, files, flags, or secret files; it does not watch files, retain a current configuration, or perform reloads.

The service composition root supplies the complete schema. Component contracts own their key names, shapes, requiredness, defaults, and field-level constraints. The service owns composition-only deployment rules. `@tmtp/config` must not import feature libraries or become a registry of product keys.

Supported schemas use static object property names and numeric array indices in issue paths. Dynamic-key records/maps, symbol path segments, and custom refinements that place input-derived values in issue paths are outside the contract. Product schemas must not use them; this restriction is necessary for the non-echoing key guarantee below.

## Public interface / API surface

The package entry point exports exactly these public contracts. It re-exports Zod's `z` value so services can construct schemas through the existing declared Zod dependency; Zod types are accepted at the parser boundary:

```ts
export { z } from "zod";

export interface ConfigIssue {
  key: string;
  code: "required" | "invalid" | "inconsistent";
  message: string;
}

export interface ConfigResult<T> {
  value?: T;
  issues: ConfigIssue[];
}

export class ConfigValidationError extends Error {
  readonly name: "ConfigValidationError";
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]);
}

export function parseConfig<T>(
  schema: import("zod").ZodType<T>,
  loaded: unknown,
): ConfigResult<T>;

export function assertValidConfig<T>(result: ConfigResult<T>): T;
```

The `z` re-export is for schema construction only. No product schema, default, product configuration type, loader, registry, or singleton is exported.

## Result and error contract

### `parseConfig`

- Calls the supplied schema's synchronous safe-parse operation exactly once and never uses throwing `parse` for ordinary validation failures.
- On success returns `{ value, issues: [] }`. The own `value` property is present even when the schema legitimately returns `undefined`; its value is the schema output, including defaults and transforms, not the original input.
- On validation failure returns `{ issues }` with no own `value` property and at least one issue. Every top-level issue reported by Zod is mapped in Zod's original order; issues are not sorted, deduplicated, or flattened from nested union errors.
- A failed parse returns no partial configuration. A schema `.catch()` or default that Zod considers successful follows the success path.
- Does not mutate the loaded value or add unknown-key stripping, coercion, defaults, or strictness beyond what the supplied schema declares. Component schemas used by the service must be pure and must not mutate their input.
- Supports synchronous schemas only. An async refinement/transform, a thrown application exception from schema code, or another non-validation exception is not converted into a safe issue or swallowed; it propagates to the caller. Product schemas must not perform I/O.
- Each call returns fresh result and issue containers. There is no module-level parse cache or shared mutable result.

### Issue mapping

Within the supported static-path schema contract, `ConfigIssue.key` is a schema-owned configuration path, not a supplied value. String segments use dot notation and numeric segments use bracket notation: `["http", "retry", "max_attempts"]` becomes `http.retry.max_attempts`, and `["ingestion", "feeds", 0]` becomes `ingestion.feeds[0]`. An empty path becomes `$`. Product configuration property names use simple ASCII identifiers so paths are unambiguous.

| Zod condition | `ConfigIssue.code` | Fixed `ConfigIssue.message` |
|---|---|---|
| `invalid_type` whose reported input is `undefined` | `required` | `Required configuration value is missing.` |
| `custom` | `inconsistent` | `Configuration values are inconsistent.` |
| Every other validation issue | `invalid` | `Configuration value is invalid.` |

Component schemas reserve custom refinements for cross-field or cross-record consistency checks so this mapping remains meaningful. Field type, enum, format, range, and unknown-key failures use Zod's built-in checks and map to `invalid`. A defensive failure with no Zod issues maps to one `invalid` issue at `$`.

The formatter may inspect Zod issue code, path, expected type, and reported input only to classify the issue. It never copies Zod's human-readable message, expected/received values, unrecognized-key lists, union details, custom params, or raw error object into `ConfigIssue`. This is a deliberate secret-safety boundary; a custom schema message or an unknown input property name containing a secret must not leak it.

### `assertValidConfig`

- For a result with no issues and an own `value` property, returns that value, including `undefined`.
- For a result with one or more issues, throws `ConfigValidationError`, even if a caller malformed the result by also adding `value`.
- For a result with no issues and no own `value` property, throws `TypeError` with the fixed message `Malformed ConfigResult: success must contain a value property.`
- Does not re-run the schema or mutate the result.

`ConfigValidationError` defensively copies the issue array and issue objects. Its `issues` retains their original order and is read-only to consumers. Constructing it with an empty issue array throws `TypeError` with the fixed message `ConfigValidationError requires at least one issue.` Its `name` is `ConfigValidationError`; its `message` is `Invalid configuration: ` followed by `key: message` entries joined with `; `. It has no `cause` and does not retain a `ZodError` or loaded input. Direct construction or assertion of a caller-built result copies caller-supplied issue text without sanitizing it; the non-echo guarantee applies to issues produced by `parseConfig` under the supported schema contract.

## Schema composition and product rules

The service supplies one synchronous root object schema assembled from component-owned schema fragments. Product objects are strict so misspelled or unsupported keys fail instead of being silently discarded. Required keys have no defaults. Optional defaults are declared by the owning component contract and are applied before cross-field refinements that need a complete view.

The composed product schema must enforce these existing rules without moving them into this package:

- `auth.access_token_path` is required in every deployment mode; loopback is not an authentication bypass.
- `hn.username` and `hn.session_cookie_path` are either both absent/null or both configured. A one-sided configuration produces an `inconsistent` issue at the missing counterpart key. Optional HN integration never makes the core configuration invalid when both are absent.
- A non-loopback `server.host` requires an HTTPS `server.public_base_url` for the service's cookie/origin policy. Independently, a configured public origin whose own host is non-loopback must be HTTPS even when the bind host is loopback. A missing required value or a non-HTTPS non-loopback public origin produces an `inconsistent` issue at `server.public_base_url`. Bind/public-host classification and this deployment refinement belong to the service composition root.
- Component-owned relations remain in their fragments, including `jobs.backoff_max_ms >= jobs.backoff_base_ms` and `debug.include_llm_payloads=true` requiring `debug.enabled=true`.

`parseConfig` executes these checks only because they are present in the supplied schema. It has no built-in knowledge of HN, HTTP, hostnames, authentication, jobs, or diagnostics.

## Secret and diagnostic safety

- Secret files contain only secret values. The centralized object contains their paths and non-secret policy, never their loaded contents.
- This library performs no file reads and therefore cannot validate token entropy, cookie validity, API-key validity, path readability, or external connectivity. Those checks belong to the service and owning adapters.
- For supported static-path schemas, issues returned by `parseConfig` and errors asserted from those results may identify paths such as `llm.api_key_path`, but never include the path's value, unknown input property names, the loaded object, supplied secret values, raw Zod messages, or schema custom messages. Schemas outside that contract and caller-built issue objects do not have the path non-echo guarantee.
- Callers log individual safe issues, not the loaded object, a raw `ZodError`, or an arbitrary exception from custom schema code. Invalid configuration prevents startup before dependent resources are opened.

## Lifecycle, reload, and concurrency

Parsing and assertion are synchronous and stateless. Independent calls may run on any Node turn without shared-state interference, provided the caller's schema is also pure. There are no timers, listeners, open handles, background tasks, or shutdown methods.

If the service adds a controlled reload lifecycle, reload remains a service operation: load a fresh candidate, parse it with the same complete schema, call `assertValidConfig`, and only then atomically replace the service's active configuration and rebuild affected dependencies. A failed candidate must leave the previous active configuration untouched. Secret files would be re-read by the service when its reload policy requires it, never by this package. The library does not provide a reload trigger or coordinate concurrent reloads and dependency draining.

## Invariants

1. A successful result has one complete schema output and zero issues; a failed result has no value and at least one safe issue.
2. Defaults, transforms, unknown-key policy, and validation semantics come only from the caller's schema.
3. Within the supported static-path schema contract, validation diagnostics identify keys through stable codes and fixed messages without echoing input values, unknown input keys, or secrets.
4. The package has no product-key registry, component imports, I/O, global configuration, or asynchronous lifecycle.
5. Configuration ownership and the existing dependency graph remain unchanged: service/components supply schemas; `config` supplies parsing and safe diagnostics.

## Acceptance-focused test expectations

- Construct a strict nested schema through the exported `z` and parse it through `parseConfig`; assert nested static paths and secret-safe issues for invalid values and secret-shaped unknown keys.
- Parse a nested schema with required fields, optional defaults, and a transform; assert the complete output, empty issues, presence of `value`, and unchanged input.
- Cover missing required values, wrong types, invalid enum/range/format values, unknown keys under a strict schema, array indices, and root-level failures; assert exact keys, codes, fixed messages, and absence of `value`.
- Assert custom refinements map to `inconsistent`, multiple issues retain schema order, and no partial value is returned.
- Put secret sentinels in input values, deliberately unsafe custom Zod messages, and unknown property names under a strict object. Assert the sentinels do not occur in the serialized result, `ConfigValidationError.message`, or its issues.
- Assert `assertValidConfig` returns successful values, including an explicit `undefined`; rejects malformed success results; and throws a copied, ordered `ConfigValidationError` for failures without a raw cause.
- Verify direct error construction rejects an empty issue list and that later mutation of a source issue array does not change the error.
- Verify exceptions from schema application code and async-only schemas propagate rather than being mislabeled as validation issues.
- Exercise independent repeated parses and a failed-then-successful candidate sequence to prove there is no cached value or stale issue state.
- At the service composition boundary, cover both HN settings absent, both present, each one-sided case, loopback without a public URL, non-loopback with missing, HTTP, and HTTPS public URLs, and loopback bind hosts with non-loopback HTTP versus HTTPS public origins. These tests use the composed schema; the tier-0 package does not import the service to run them.

## Internal subcomponents

- Synchronous Zod safe-parse adapter.
- Safe issue classifier, path formatter, and fixed-message formatter.
- `ConfigValidationError` construction and success assertion.

## Dependencies on other libs

None. The only runtime dependency is Zod `4.6.7`. Component schemas are supplied by the service composition root, avoiding dependencies from primitives back to `config` or from `config` to components.

## New build or OSS wrapper

New narrow build wrapping Zod `4.6.7`; no configuration loader or general validation framework.

## Hosted by

`services/personal-reader` during startup. It can also support controlled reload checks if the service adds that lifecycle; this package supplies no reload trigger or active-configuration store.

## Configuration

None of its own. Every owned key and default is documented by the corresponding component and aggregated in `docs/architecture.md`.
