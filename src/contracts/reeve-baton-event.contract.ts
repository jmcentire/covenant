// First canonical contract: Reeve's Baton egress event shape.
//
// Originally lived at reeve/src/observability/baton/contract.ts +
// reeve/src/observability/baton/types.ts (the BatonEventSchema).
// Relocated here 2026-05-06 as part of the covenant extraction.
//
// Reeve continues to own the Baton emission code; this module owns the
// Zod schema + the policy + the budget. Reeve will import the schema
// + register helper from here once Wave 3 lands.
//
// covenant-export reads this file to emit
//   ~/Code/covenant/contracts/reeve.baton.event.shape.json
//   ~/Code/covenant/contracts/reeve.baton.event.shape.policy.yaml

import { z } from 'zod';
import { registerContract } from '../registry.js';
import type { Contract, ViolationBudget } from '../types.js';

// Latest schema version this codebase emits + understands. Bump when
// adding non-backward-compatible fields. Recovery code reads
// payload.schema_version BEFORE attempting to parse the event body.
export const CURRENT_BATON_SCHEMA_VERSION = 1 as const;

// Zod schema covenant uses to validate events before emit. Keep in sync
// with the BatonEvent type below.
export const BatonEventSchema = z.object({
  event_id: z.string().uuid('event_id must be a UUID').min(1, 'event_id is required'),
  schema_version: z.number().int().min(1),
  event_type: z
    .string()
    .min(1, 'event_type is required')
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'event_type must be dotted lowercase'),
  occurred_at: z
    .string()
    .datetime({ offset: true, message: 'occurred_at must be an ISO 8601 timestamp' }),
  payload: z.record(z.unknown()),
});

export type BatonEvent = z.infer<typeof BatonEventSchema>;

export const BATON_EVENT_CONTRACT_ID = 'reeve.baton.event.shape';

// Per-env policy. Egress contract: a malformed BatonEvent is always
// our bug, so strict-reject in every env.
const POLICY: Contract['policy'] = {
  dev: { in: 'strict-reject', out: 'log-only' },
  test: { in: 'strict-reject', out: 'log-only' },
  staging: { in: 'strict-reject', out: 'log-only' },
  prod: { in: 'strict-reject', out: 'log-only' },
};

// 10 emit-shape violations in 5 minutes pages someone — that's a bug
// the covenant_main DB should escalate visibly.
const BUDGET: ViolationBudget = {
  windowMs: 5 * 60_000,
  maxViolations: 10,
  onExhaust: { kind: 'page-operator' },
};

// Public exports the export CLI consumes. Keeping these as plain
// constants (not factory calls) means `covenant-export` can introspect
// them without invoking side-effects.
export const contract: Contract = {
  id: BATON_EVENT_CONTRACT_ID,
  request: BatonEventSchema,
  policy: POLICY,
  budget: BUDGET,
};

let registered = false;

// Register the BatonEvent contract once. Safe to invoke multiple
// times — second call is a no-op.
export function registerBatonEventContract(): void {
  if (registered) return;
  registerContract(contract);
  registered = true;
}

// Test-only: clear registration so each test can re-register.
export function __test_resetBatonEventContractRegistration(): void {
  registered = false;
}
