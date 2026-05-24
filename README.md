# covenant

Contract validation runtime. Per-environment violation policy +
sliding-window violation budget. Twin TypeScript / Python siblings,
both consuming the same JSON Schema artifact.

Part of the [Exemplar stack](https://github.com/jmcentire/exemplar-stack)
(open-source toolkit, MIT). Originally extracted from
[Reeve](https://github.com/jmcentire/reeve)'s slice-4 contract layer.

## Charter

Validate preconditions before execution and postconditions after.
Enforce per-environment violation policy with a consequence budget.
Every call that crosses a trust boundary — HTTP request, vendor API
response, plugin handler, MCP server response — goes through covenant;
covenant either accepts the data or applies the declared policy.

## Architecture (ADR-001)

**Zod (TypeScript) is the canonical contract source.** covenant exports
JSON Schema via `zod-to-json-schema` on each contract change. Python
consumers (Pydantic v2 via `jsonschema`) read the exported JSON Schema.
Per-environment policy lives in YAML alongside the schema.

```
Zod schemas (TypeScript, in-code; covenant authors here)
   |
   |  zod-to-json-schema (existing library; no bespoke codegen)
   v
JSON Schema (Draft 2020-12)              <- committed to repo;
                                            single source of truth
                                            for non-TS consumers
   |
   |  jsonschema.Draft202012Validator (Python)
   v
Pydantic / asyncpg consumers (Baton, Sentinel, Ledger, ...)
```

CI gate: `covenant-export --check` fails if Zod schemas changed but the
committed JSON Schema artifact wasn't re-exported.

See [ADR-001](./ADR-001-extraction.md) for the full decision record,
including why sim REVERSED an earlier draft that proposed bespoke
TS->Python codegen.

## Repo layout

```
covenant/
  SPEC.md
  ADR-001-extraction.md
  contracts/                       # canonical JSON Schema + policy YAML
    reeve.baton.event.shape.json   # emitted by covenant-export
    reeve.baton.event.shape.policy.yaml
  package.json                     # covenant (TS package, root-level)
  tsconfig.json
  tsconfig.build.json              # used by `prepare` to emit dist/
  src/
    types.ts
    errors.ts
    registry.ts
    store.ts                       # ViolationStore + InMemoryViolationStore
    validate.ts
    contracts/
      reeve-baton-event.contract.ts
    index.ts
  bin/
    covenant-export.ts             # CLI: emit/check JSON Schema artifacts
  tests/
    covenant.test.ts               # ported from Reeve
    golden-vectors.test.ts         # consumes vectors/policy-cases.json
  py/                              # covenant (Python)
    src/covenant/
      __init__.py
      types.py
      errors.py
      loader.py                    # JSON Schema + policy YAML -> Contract
      runtime.py                   # Covenant + validate()
      store.py                     # InMemory + AsyncpgViolationStore
    tests/
      test_covenant.py
      test_golden_vectors.py
  vectors/
    policy-cases.json              # cross-language golden tests
  pyproject.toml                   # py package, root-level
```

## TypeScript usage

Install from the GitHub repo. The package's `prepare` script runs
`tsc → dist/` at install time, so you get a fully built package
with `.d.ts` files.

```json
{
  "dependencies": {
    "covenant": "git+https://github.com/jmcentire/covenant.git#v0.1.1",
    "zod": "^3.23.0"
  }
}
```

Wire a store and register your contracts:

```typescript
import { z } from 'zod';
import {
  registerContract,
  setViolationStore,
  validate,
  InMemoryViolationStore,
} from 'covenant';

setViolationStore(new InMemoryViolationStore());

registerContract({
  id: 'my.api.create-order',
  request: z.object({
    customer_id: z.string().uuid(),
    items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })),
  }),
  policy: {
    dev:     { in: 'strict-reject', out: 'log-only' },
    test:    { in: 'strict-reject', out: 'log-only' },
    staging: { in: 'log-and-emit',  out: 'log-only' },
    prod:    { in: 'log-only',      out: 'log-only' },
  },
  budget: {
    windowMs: 5 * 60_000,
    maxViolations: 10,
    onExhaust: { kind: 'page-operator' },
  },
});

const r = await validate({
  contractId: 'my.api.create-order',
  direction: 'in',
  value: req.body,
});
if (!r.ok) {
  if (r.violation.action === 'strict-reject') {
    return res.status(400).json({ error: r.violation.reason });
  }
  // log-and-emit / log-only: covenant already logged; continue.
}
```

`validate()` never throws on contract violations — it returns a
discriminated `ValidationResult<T>`. Programmer errors (unknown
contract id, store-not-configured) DO throw — those aren't violations.

### Authoring a contract for export

Drop a `*.contract.ts` file under `src/contracts/` that exports a
`contract: Contract` const:

```typescript
// ts/src/contracts/my-api-create-order.contract.ts
import { z } from 'zod';
import type { Contract } from '../types.ts';

export const schema = z.object({ ... });

export const contract: Contract = {
  id: 'my.api.create-order',
  request: schema,
  policy: { ... },
  budget: { ... },
};
```

Then run `npm run export` (root) or `npx covenant-export` (in `ts/`).
Two artifacts are emitted under `contracts/`:

- `<id>.json` — covenant envelope wrapping JSON Schema 2019-09
  (`zod-to-json-schema`'s 2019-09 target is the closest forward-
  compatible match for Draft 2020-12).
- `<id>.policy.yaml` — per-env policy + optional budget.

CI runs `covenant-export --check`; if Zod source changed without a
matching artifact bump the build fails with a list of out-of-sync
files.

## Python usage

```bash
pip install covenant   # once published
# or for asyncpg-backed store:
pip install covenant[asyncpg]
```

```python
from pathlib import Path
from covenant import (
    Covenant,
    InMemoryViolationStore,
    load_contracts_from_dir,
)

cov = Covenant(store=InMemoryViolationStore())
cov.load_contracts(load_contracts_from_dir(Path("/path/to/covenant/contracts")))

result = await cov.validate(
    contract_id="reeve.baton.event.shape",
    direction="in",
    value=event_payload,
)
if not result.ok:
    if result.violation.action == "strict-reject":
        raise ValueError(result.violation.reason)
```

Python consumers wire their own store. covenant ships:

- `InMemoryViolationStore` — process-local; budgets reset on restart.
  Useful for tests or single-process deployments.
- `AsyncpgViolationStore` — reference impl that targets the same
  `contract_violations` table Reeve uses today (see
  [ADR-001](./ADR-001-extraction.md) for the schema).

Subclass `ViolationStore` (it's a `typing.Protocol`) to plug in a
SQLAlchemy / SQLModel / DynamoDB / wherever store; the runtime only
needs `insert(...)` and `count_recent(...)`.

## contract_violations storage — V1 vs V2

This is an explicit open question; consumers should plan for it.

**V1 (today):**

- Reeve owns the `contract_violations` Postgres table; Reeve uses
  `AsyncpgViolationStore` (or its own TS-side adapter) writing to that
  table.
- Other consumers (Baton, Sentinel, Ledger) wire their OWN
  `ViolationStore` — typically `InMemoryViolationStore` for now, since
  no shared substrate exists yet.
- This means budget windows are per-process for those consumers in V1.

**V2 (planned in ADR-002):**

- A `covenant_main` Postgres database (separate Neon project, or schema
  in a shared cluster — TBD) owns the table.
- covenant ships an HTTP API; consumers write violations through it
  rather than touching the DB directly.
- Cross-component budget enforcement becomes possible (10 violations
  in 5 minutes across Baton+Sentinel+Reeve all dock against the same
  budget).

Consumers migrating to V2: swap the `ViolationStore` adapter
(`HttpViolationStore` will exist), no other code changes.

## Running tests locally

```bash
# TS — Reeve's ported tests + golden vectors
cd ts && npm install && npm test

# Python — same vectors, Pydantic-side runtime
pip install -e .[test]
pytest

# Idempotency check on the export pipeline
cd ts && npm run export:check
```

## Open questions

- HTTP API for cross-component violation writes — V2.
- Per-env policy admin override (env var? config? UI?) — V2.
- `covenant_main` DB hosting decision — defer to ADR-002.
- Pydantic BaseModel generation from JSON Schema — currently we
  validate via `jsonschema.Draft202012Validator`; if consumers want
  typed Python models, ADR-003 covers the BaseModel codegen story.

## Provenance

Spec'd 2026-05-05 (sim's NASA-bar review). ADR-001 locked 2026-05-06
after sim REVERSED a JSON-Schema-canonical-with-bespoke-codegen draft
in favor of Zod-canonical with `zod-to-json-schema`. Extracted from
Reeve's `src/covenant/` 2026-05-06 (Wave 1 of the Exemplar-stack
extraction). 9 contract tests inherited from Reeve; +1 round-trip
test against the canonical Baton-event contract; +11 golden vector
cases shared TS/Python.
