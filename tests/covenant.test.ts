// Ported from reeve/tests/integration/observability/covenant.test.ts.
//
// Reeve runs these against a real Postgres-backed contract_violations
// table. covenant ships an InMemoryViolationStore that satisfies the
// same ViolationStore interface; tests run against the in-memory
// store. Reeve continues to run its Postgres-backed integration test
// against its own adapter.
//
// Forced failures at every contract boundary:
//   1. registerContract throws on duplicate id.
//   2. validate throws when contract id is unknown.
//   3. validate returns ok=true for a value that matches the schema.
//   4. validate returns ok=false with structured violation for invalid.
//   5. Per-environment policy: strict-reject in dev → action='strict-reject';
//      log-only in prod → action='log-only' (same shape input).
//   6. Violation is persisted to the store.
//   7. Sliding-window budget: violation count > maxViolations
//      flips budgetExhausted=true.
//   8. Different env yields independent budget counts (windowed by env).
//   9. Contract without response schema returns ok=true on response validation.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  __test_clearContractRegistry,
  __test_resetStore,
  __test_setEnv,
  ContractAlreadyRegisteredError,
  ContractNotRegisteredError,
  InMemoryViolationStore,
  registerContract,
  setViolationStore,
  validate,
} from '../src/index.ts';

let store: InMemoryViolationStore;

beforeEach(() => {
  __test_resetStore();
  __test_clearContractRegistry();
  __test_setEnv('test');
  store = new InMemoryViolationStore();
  setViolationStore(store);
});

afterAll(() => {
  __test_setEnv(undefined);
  __test_resetStore();
});

const fooContract = {
  id: 'test.foo',
  request: z.object({ name: z.string().min(1), count: z.number().int().min(0) }),
  policy: {
    dev: { in: 'strict-reject' as const, out: 'log-only' as const },
    test: { in: 'strict-reject' as const, out: 'log-only' as const },
    staging: { in: 'log-and-emit' as const, out: 'log-only' as const },
    prod: { in: 'log-only' as const, out: 'log-only' as const },
  },
};

describe('registerContract', () => {
  it('refuses duplicate id', () => {
    registerContract(fooContract);
    expect(() => registerContract(fooContract)).toThrow(ContractAlreadyRegisteredError);
    expect(() => registerContract(fooContract)).toThrow(/already registered/);
  });
});

describe('validate — unknown contract id', () => {
  it('throws ContractNotRegisteredError when no contract is registered', async () => {
    const result = await validate({
      contractId: 'never.registered',
      direction: 'in',
      value: {},
    }).catch((e: Error) => e);
    expect(result).toBeInstanceOf(ContractNotRegisteredError);
    expect((result as Error).message).toMatch(/not registered/);
  });
});

describe('validate — happy path', () => {
  it('returns ok=true for matching shape', async () => {
    registerContract(fooContract);
    const r = await validate({
      contractId: 'test.foo',
      direction: 'in',
      value: { name: 'hello', count: 3 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ name: 'hello', count: 3 });
    }
  });
});

describe('validate — schema violation', () => {
  it('returns ok=false with structured violation', async () => {
    registerContract(fooContract);
    const r = await validate({
      contractId: 'test.foo',
      direction: 'in',
      value: { name: '', count: -1 }, // empty name + negative count
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.violation.contractId).toBe('test.foo');
      expect(r.violation.direction).toBe('in');
      expect(r.violation.action).toBe('strict-reject'); // env=test
      expect(r.violation.budgetExhausted).toBe(false);
      expect(r.violation.reason).toMatch(/name/);
    }
  });
});

describe('validate — per-env policy switches the action', () => {
  it('strict-reject in test, log-only in prod', async () => {
    registerContract(fooContract);
    const rTest = await validate({
      contractId: 'test.foo',
      direction: 'in',
      value: { wrong: true },
      env: 'test',
    });
    expect(rTest.ok).toBe(false);
    if (!rTest.ok) expect(rTest.violation.action).toBe('strict-reject');

    const rProd = await validate({
      contractId: 'test.foo',
      direction: 'in',
      value: { wrong: true },
      env: 'prod',
    });
    expect(rProd.ok).toBe(false);
    if (!rProd.ok) expect(rProd.violation.action).toBe('log-only');
  });
});

describe('validate — persists violation to store', () => {
  it('inserts a row in the configured ViolationStore', async () => {
    registerContract(fooContract);
    await validate({
      contractId: 'test.foo',
      direction: 'in',
      value: { wrong: true },
    });
    const c = await store.countRecent({
      contractId: 'test.foo',
      environment: 'test',
      windowMs: 60_000,
    });
    expect(c).toBe(1);
    expect(store.__test_size()).toBe(1);
  });
});

describe('validate — sliding-window budget', () => {
  it('budgetExhausted flips when count exceeds maxViolations', async () => {
    registerContract({
      id: 'test.budget',
      request: z.object({ ok: z.literal(true) }),
      policy: {
        dev: { in: 'strict-reject', out: 'log-only' },
        test: { in: 'strict-reject', out: 'log-only' },
        staging: { in: 'strict-reject', out: 'log-only' },
        prod: { in: 'strict-reject', out: 'log-only' },
      },
      budget: {
        windowMs: 60_000,
        maxViolations: 3,
        onExhaust: { kind: 'page-operator' },
      },
    });

    // Trip violations 1..3 — none should exhaust (count <= max).
    for (let i = 0; i < 3; i++) {
      const r = await validate({
        contractId: 'test.budget',
        direction: 'in',
        value: { wrong: true },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.violation.budgetExhausted).toBe(false);
    }

    // 4th violation tips count to 4 > maxViolations=3 → exhausted.
    const r4 = await validate({
      contractId: 'test.budget',
      direction: 'in',
      value: { wrong: true },
    });
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.violation.budgetExhausted).toBe(true);
  });

  it('different envs maintain independent budget counts', async () => {
    registerContract({
      id: 'test.env-budget',
      request: z.object({ ok: z.literal(true) }),
      policy: {
        dev: { in: 'strict-reject', out: 'log-only' },
        test: { in: 'strict-reject', out: 'log-only' },
        staging: { in: 'strict-reject', out: 'log-only' },
        prod: { in: 'strict-reject', out: 'log-only' },
      },
      budget: { windowMs: 60_000, maxViolations: 1, onExhaust: { kind: 'page-operator' } },
    });

    // Two test-env violations exhaust test budget.
    await validate({
      contractId: 'test.env-budget',
      direction: 'in',
      value: { wrong: true },
      env: 'test',
    });
    const rTest2 = await validate({
      contractId: 'test.env-budget',
      direction: 'in',
      value: { wrong: true },
      env: 'test',
    });
    if (!rTest2.ok) expect(rTest2.violation.budgetExhausted).toBe(true);

    // First prod-env violation does NOT see the test-env count.
    const rProd1 = await validate({
      contractId: 'test.env-budget',
      direction: 'in',
      value: { wrong: true },
      env: 'prod',
    });
    if (!rProd1.ok) expect(rProd1.violation.budgetExhausted).toBe(false);
  });
});

describe('validate — no schema for direction is a pass', () => {
  it('contract without response schema returns ok=true on response validation', async () => {
    registerContract({
      id: 'test.no-response-schema',
      request: z.object({ x: z.number() }),
      // no response schema
      policy: {
        dev: { in: 'strict-reject', out: 'log-only' },
        test: { in: 'strict-reject', out: 'log-only' },
        staging: { in: 'strict-reject', out: 'log-only' },
        prod: { in: 'strict-reject', out: 'log-only' },
      },
    });
    const r = await validate({
      contractId: 'test.no-response-schema',
      direction: 'out',
      value: 'whatever',
    });
    expect(r.ok).toBe(true);
  });
});
