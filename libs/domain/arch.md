# Domain Library Architecture

## Internal structure

The package is organized by record family rather than by infrastructure layer:

- `primitives`: identifiers, ISO timestamp schema, finite-number helpers, state unions, and versioned envelopes.
- `stories`: official HN item and stored story/article records.
- `activity`: immutable events and mutable reading-session projections.
- `personalization`: preferences, profiles, evidence, recommendations, and queue projections.
- `operations`: jobs, ingestion runs, LLM audits, and diagnostic records.
- `access`: hashed session records and HN action/account-state records.
- `schemas`: composed strict Zod schemas and cross-field refinements; the public barrel exports types and schemas together.

This is a module layout, not a requirement for separate packages. Record families import primitives only; no family imports a higher-level library.

## Design patterns and decisions

### Schema-first records

Zod schemas are the runtime source of truth and TypeScript types are inferred from them. Strict objects make accidental persisted fields visible during migration rather than silently dropping them. Schemas validate structural and cross-field invariants; repositories still own foreign keys and uniqueness.

### Envelopes without policy imports

Variable JSON is represented by parsed values plus schema versions. The domain validates common envelopes and record shapes. The owning library validates policy-specific payloads (`interests` for profiles, `job-queue` for job kinds, activity for event values). This avoids upward dependencies while ensuring no repository returns raw JSON text as a trusted record.

### Current state versus immutable evidence

Activity events, profiles, and recommendations are immutable. Reading sessions and queue entries are rebuildable projections. HN account states are current observations and HN action intents are durable attempt records. Keeping these shapes separate prevents reconciliation from being mistaken for historical activity.

### Opaque versions

The domain treats content, rules, activity, policy, builder, prompt, model, and rank versions as validated non-empty strings. Producers define canonicalization and hash algorithms. This keeps the domain free of crypto and policy dependencies while preserving exact version linkage.

## Trade-offs

- Strict schemas require deliberate migration when a field is added; silent forward compatibility is rejected in favor of explicit versions.
- Keeping `unknown` for variable payloads avoids fake universal payload types, but consumers must run their owning parser before use.
- Aliases such as `ProfileId = string` document intent but are not branded runtime types. Producers and repositories must not infer identity from string shape.

## Testing seams

Every schema has table-driven valid/invalid fixtures, including cross-field cases. Round-trip tests use repository-shaped values without importing repositories. Golden fixtures pin version-1 envelopes so later migrations cannot silently reinterpret old records.
