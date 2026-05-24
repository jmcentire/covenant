# ADR-001: covenant extraction architecture

**Status:** Accepted (2026-05-06; Claude/Codex collaboration)
**Source spec:** `~/Code/covenant/SPEC.md`

## Context

covenant is the contract validation runtime: declarative per-env
policy, sliding-window violation budget, schema enforcement at every
trust boundary. First implementation lives at `reeve/src/covenant/`
with 9 contract tests passing. Reeve uses Zod schemas in-code today.

The extraction question: which language hosts the canonical contract,
and what's the validator generation pipeline?

## Decision

**Zod (TypeScript) is the canonical contract source. covenant exports
JSON Schema via `zod-to-json-schema` on each contract change. Python
consumers (Pydantic) read the exported JSON Schema. Per-environment
policy lives in YAML alongside the schema.**

### Decision history (sim-corrected)

The first draft of this ADR (Codex/Claude collaboration) made JSON
Schema canonical with a 500+ LoC `covenant-gen` codegen tool emitting
both Zod and Pydantic. **Sim reversed the call:**

- That codegen drifts to 1500+ LoC handling Zod ↔ JSON Schema ↔
  Pydantic impedance (oneOf / allOf / conditional schemas, custom
  formats, nullable-vs-optional-vs-undefined, custom validators).
  "Schema compiler" is not the product.
- `zod-to-json-schema` is a solved-problem library (8k stars,
  maintained). Pydantic v2 consumes JSON Schema natively via
  `pydantic.GenerateJsonSchema`.
- TS IS the privileged language because frontend contracts live there.
  Privileging the side that defines the API boundary is correct.

### Pipeline (no bespoke codegen)

```
Zod schemas (TypeScript, in-code; covenant authors here)
   │
   │ `zod-to-json-schema` (existing library)
   ▼
JSON Schema (Draft 2020-12)              ← committed to repo;
                                            single source of truth
                                            for non-TS consumers
   │
   │ pydantic.GenerateJsonSchema (built into pydantic v2)
   ▼
Pydantic models (Python; consumed by Baton, Sentinel, Ledger, etc.)
```

CI gate: a Zod-schema change runs `covenant-export`; if the committed
JSON Schema differs from the export, PR fails. No bespoke codegen
TS→Python; everyone consumes the same JSON Schema artifact.

### Reeve migration cost

Approximately zero. Reeve's `src/covenant/` Zod schemas relocate to
`~/Code/covenant/ts/src/contracts/` unchanged. JSON Schema export is
new (one CI step). Pydantic models for Python consumers are added as
those consumers wire up.

### Repo layout

```
~/Code/covenant/
├── SPEC.md
├── ADR-001-extraction.md  # this file
├── contracts/                       # canonical JSON Schema + policy
│   ├── _common.schema.json          # shared types
│   └── examples/                    # for tests
│       └── ping.contract.yaml
├── covenant-gen/                    # codegen CLI
│   ├── package.json                 # TS-authored
│   ├── src/
│   │   ├── load-contract.ts         # parse contract.yaml
│   │   ├── emit-zod.ts              # Zod codegen
│   │   ├── emit-pydantic.ts         # Pydantic codegen
│   │   ├── emit-policy.ts           # per-env policy + budget output
│   │   └── cli.ts
│   └── tests/
├── ts/                              # runtime validator (TS)
│   ├── package.json                 # covenant
│   ├── src/
│   │   ├── types.ts
│   │   ├── validate.ts              # Zod-backed validator
│   │   ├── registry.ts
│   │   └── index.ts
│   └── tests/
├── py/                              # runtime validator (Python)
│   ├── pyproject.toml
│   ├── src/covenant/
│   │   ├── types.py
│   │   ├── validate.py              # Pydantic-backed validator
│   │   ├── registry.py
│   │   └── __init__.py
│   └── tests/
└── vectors/                         # golden cross-language tests
    └── policy-cases.json
```

### Per-env policy + budget format

```yaml
# baton-event.contract.yaml
id: reeve.baton.event.shape
schema:
  $schema: https://json-schema.org/draft/2020-12/schema
  type: object
  required: [event_id, schema_version, event_type, occurred_at, payload]
  properties:
    event_id:
      type: string
      format: uuid
    schema_version:
      type: integer
      minimum: 1
    event_type:
      type: string
      pattern: '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
    occurred_at:
      type: string
      format: date-time
    payload:
      type: object
policy:
  dev:     { in: strict-reject, out: log-only }
  test:    { in: strict-reject, out: log-only }
  staging: { in: strict-reject, out: log-only }
  prod:    { in: strict-reject, out: log-only }
budget:
  windowMs: 300000
  maxViolations: 10
  onExhaust:
    kind: page-operator
```

### contract_violations storage

Long-term: covenant_main DB (separate Postgres, owned by covenant).
Reeve's existing `contract_violations` table at
`reeve/db/migrations/20260506051358_contract_violations.sql` is the
V1 substrate. covenant's extraction includes:

1. Init covenant_main DB (Neon project or shared cluster, TBD with
   user).
2. Copy schema + rows from Reeve's table to covenant_main.
3. Reeve switches to covenant's HTTP API for writes.
4. Future Python consumers (Baton, Sentinel) write through the same
   API.

V1 (until extraction lands): Reeve's table stays. Other consumers
log-only on contract violations; they don't write to Reeve's DB
across components.

### covenant-gen as the migration tool

The first run of `covenant-gen` against Reeve's existing contracts:

1. Read Reeve's `src/covenant/` Zod schemas via `zod-to-json-schema`.
2. Emit `contracts/<id>.contract.yaml` files with JSON Schema +
   per-env policy + budget.
3. Re-emit Zod from the JSON Schema (round-trip verification).
4. Commit both the JSON Schema source AND the regenerated Zod.
5. Reeve updates imports to consume the regenerated Zod.

This is a one-time step, after which JSON Schema is canonical.

## Consequences

**Positive**
- Symmetric: TS and Python consumers both consume generated
  validators; neither owns the canonical format.
- Future-proof: new languages get validators via codegen.
- Drift detection: CI gate on `covenant-gen --check` catches schema
  edits that didn't regenerate.
- Reeve migration: short import-path edit + schema-as-yaml
  conversion. Behavior unchanged.

**Negative**
- covenant-gen is real engineering: ~500 LoC + tests + CLI surface.
- Generated code is committed; reviewers see two diffs (source +
  generated) per contract change.
- JSON Schema is more verbose than Zod for complex types. Some
  contracts might be cleaner in Zod; the team eats this cost.

## Migration plan (after this ADR)

1. Init `~/Code/covenant/` per layout.
2. Build `covenant-gen` against a single example contract first.
3. Author `ts/src/validate.ts` consuming generated Zod.
4. Author `py/src/covenant/validate.py` consuming generated Pydantic.
5. Author `vectors/policy-cases.json` (covers strict-reject /
   log-and-emit / log-only / budget exhaustion across both
   languages).
6. Run covenant-gen against Reeve's existing covenant contracts to
   produce the first batch of `*.contract.yaml`.
7. Reeve PR: replace
   `import {...} from '../covenant/index.js'` with
   `import {...} from 'covenant'`; verify tests stay green.
8. covenant_main DB extraction is a separate ADR (ADR-002).

## Open questions for next ADR

- covenant_main DB hosting: separate Neon project, or schema in
  Reeve's existing DB with API gating? Decide in ADR-002.
- Per-env policy override mechanism: env-var? Config file? Admin
  endpoint? V1 is config-file-only (the YAML); admin override is V2.
