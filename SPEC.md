# covenant — Contract Validation Runtime

## Charter

Validate preconditions before execution and postconditions after. Enforce
per-environment violation policy with a consequence budget. Every call
that crosses a trust boundary (HTTP request, vendor API response, plugin
handler invocation, MCP server response) goes through covenant; covenant
either accepts the data or applies the declared violation policy.

covenant is the cross-stack home for what was originally drafted as
Reeve's slice-4 contract layer. It moves out of Reeve because Baton
validates adapter health-check responses, Sentinel validates PACT key
formats, and Ledger validates classification annotations — all need the
same runtime.

## Why a runtime, not a code generator

OpenAPI/JSON-Schema generators produce static type stubs. They don't
know that this environment is "staging" so vendor egress should
log-and-alarm rather than reject; or that this contract has burned
through its violation budget for the hour and the vendor should be
paused. The runtime owns the policy.

## Interface (proposed)

```typescript
export type EnvPolicy = 'strict-reject' | 'log-and-emit-alarm' | 'log-and-continue';

export type ViolationBudget = {
  windowMs: number;
  maxViolations: number;
  action: 'rollback' | 'pause-vendor' | 'page-operator';
};

export type ContractDeclaration<TIn, TOut> = {
  id: string;                    // unique stable id
  // Schema declarations — JSON Schema Draft 2020-12.
  request: SchemaObject;
  response: SchemaObject;
  // Per-environment policy. Required for EVERY environment the contract
  // is reachable in.
  policyByEnv: Record<'dev' | 'test' | 'staging' | 'prod', EnvPolicy>;
  // Optional violation budget. If absent, alarms fire but no automated
  // action is taken.
  violationBudget?: ViolationBudget;
};

export interface Covenant {
  register<TIn, TOut>(decl: ContractDeclaration<TIn, TOut>): RegisteredContract<TIn, TOut>;
  // Composable validator usable inside aegis-wrapped fns.
  validate<T>(contractId: string, direction: 'in' | 'out', value: unknown): Result<T, Violation>;
  // Pre-flight checklist composer (FRR primitive). Returns a checklist
  // that consults a set of registered contracts; witness can render it
  // for a human.
  asPreflightChecks(ids: readonly string[]): PreflightCheck[];
}
```

## Violation handling

When a value fails validation:

1. covenant constructs a `Violation` event with: contract id, direction,
   path of failure, expected vs received, environment, timestamp.
2. The per-env policy decides the disposition:
   - `strict-reject` — the call site receives a `Result.err(violation)`;
     covenant does NOT throw (predictable shape for callers).
   - `log-and-emit-alarm` — the call site receives `Result.ok(value)`,
     covenant emits an alarm via baton.
   - `log-and-continue` — same as above but no alarm. Reserved for
     vendor egress where vendor drift is expected and we're tolerating
     known divergence (auditable; bounded).
3. If `violationBudget` is set, covenant counts violations in a sliding
   window. On budget exhaustion, the `action` fires: rollback (baton
   reverts the most recent canary), pause-vendor (the wrapped vendor
   adapter goes into a circuit-broken state), page-operator (witness is
   invoked).

## Stack consumers

- **reeve** — every HTTP endpoint (request schema), every adapter call
  (response schema), every plugin manifest.
- **baton** — adapter health-check response validation.
- **sentinel** — PACT key format validation.
- **ledger** — field classification annotations.
- **apprentice** — skill input/output schemas.
- **chronicler** — event-correlation input shape.

## Pre-flight checklist composition (FRR primitive)

NASA's Flight Readiness Review pattern: before launch, every subsystem
reports status; if any is not "go", launch scrubs. covenant exposes
`asPreflightChecks(ids)` — given a list of contract ids, produce a
checklist where each check validates a synthetic value against the
contract. The result is consumable by `witness` for human sign-off.

This composes with witness for prod-deploy gates: covenant defines
"these 12 contracts must be valid"; witness presents the checklist and
captures the operator's go/no-go.

## Open questions

1. Schema format: JSON Schema Draft 2020-12 or OpenAPI 3.1 (which
   embeds JSON Schema)? Lean OpenAPI 3.1 — broader tooling.
2. Schema source: in-code `const` declarations, imported `.json`
   files, or generated from TypeScript types via `ts-json-schema-generator`?
   Lean: generated, with the generated artifact committed (so reviewers
   can see contract changes without running the generator).
3. Where do per-env policies live: in the declaration (more discoverable)
   or in a separate `covenant.policy.yaml` (more reviewable when policies
   shift)? Lean: in the declaration; bulk overrides via a separate file.

## Initial implementation plan

1. Spec lock: this doc + a TypeScript interface file.
2. First implementation lives at `reeve/src/contracts/covenant/` as a
   private module.
3. CI gate: every endpoint route file must import a registered
   contract. Lint rule rejects PRs adding routes without contracts.
4. Extract to `~/Code/covenant/` when the second stack component (likely
   baton) needs it.

## Provenance

Spec'd 2026-05-05 from sim's NASA-bar review. Source roadmap:
`reeve/docs/production-stability-roadmap.md`, slice 4 amendments.
