// covenant types. Slice 4 of Reeve's production-stability roadmap;
// extracted to covenant 2026-05-06.
//
// Sim-vetted V1.

import type { ZodSchema } from 'zod';

export type Environment = 'dev' | 'test' | 'staging' | 'prod';

// Per-environment violation policy. The shape sim-corrected:
//   strict-reject:    every violation is an error to the caller
//   log-and-emit:     log + Baton event; caller continues with the value as-is
//   log-only:         log only (no Baton event); caller continues
// Plus the consequence budget below sums violations for budget actions.
export type ViolationAction = 'log-only' | 'log-and-emit' | 'strict-reject';

// Sliding-window violation budget. When count(violations of this
// contract in this env in `windowMs`) exceeds `maxViolations`, the
// action fires AT THE NEXT VIOLATION (not retroactively).
export type ViolationBudget = {
  readonly windowMs: number;
  readonly maxViolations: number;
  // What happens on budget exhaustion (separate from the per-violation
  // action above).
  readonly onExhaust:
    | { kind: 'rollback' } // emit a Baton event suggesting rollback
    | { kind: 'pause-vendor' } // mark a vendor circuit-broken
    | { kind: 'page-operator' }; // surface to witness
};

export type Contract<TIn = unknown, TOut = unknown> = {
  // Stable id; doubles as the partition key for the violation budget.
  readonly id: string;
  // Schemas — Zod for V1 (sim chose this; single source of truth, no
  // build step, useful error messages).
  readonly request?: ZodSchema<TIn>;
  readonly response?: ZodSchema<TOut>;
  // Per-environment per-direction policy. Required: every contract
  // declares its policy in every environment so deploy gates can
  // assert "no contract is policy-undefined".
  //
  // Direction keys ('in'/'out') match the validate(direction) param
  // and the contract_violations table's CHECK constraint.
  readonly policy: Readonly<{
    [E in Environment]: {
      readonly in: ViolationAction;
      readonly out: ViolationAction;
    };
  }>;
  readonly budget?: ViolationBudget;
};

export type ViolationContext = {
  readonly tenantId?: string;
  readonly correlationId?: string;
};

// Outcome the validate() function returns. Sim-corrected: validate
// does NOT throw on violation — predictable shape for callers. Throw
// is the application's job after seeing 'rejected'.
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly violation: {
        readonly contractId: string;
        readonly direction: 'in' | 'out';
        readonly reason: string;
        readonly action: ViolationAction;
        // Set when the violation triggered budget exhaustion this call.
        readonly budgetExhausted: boolean;
        readonly env: Environment;
      };
    };

// Persistence adapter. Reeve plugs in its Postgres-backed
// `contract_violations` table. Other consumers (Baton, Sentinel)
// swap in their own substrates. covenant ships an in-memory default
// for tests.
export type ViolationStore = {
  insert(record: {
    contractId: string;
    environment: Environment;
    direction: 'in' | 'out';
    reason: string;
    tenantId?: string;
    correlationId?: string;
  }): Promise<void>;
  countRecent(args: {
    contractId: string;
    environment: Environment;
    windowMs: number;
  }): Promise<number>;
};

// Logger adapter. Anything implementing `warn` and `error` with a
// pino-shaped (obj, msg) signature works.
export type CovenantLogger = {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
};
