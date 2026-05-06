// covenant.validate — slice 4 hot-path validator.
//
// Sim-vetted contract:
//   - Returns ValidationResult<T>; never throws on contract violation
//     (callers decide what to do based on .ok and .violation.action).
//   - Records violation in the configured ViolationStore ALWAYS (so the
//     budget query is accurate across instances).
//   - Action precedence (sim's correction):
//       1. log (always — even if rejecting)
//       2. emit Baton event (when action is log-and-emit OR strict-reject)
//          — covenant surfaces the action; the consumer wires emit
//       3. budget check — if exhausted this call, the contract's
//          onExhaust handler fires (rollback / pause-vendor / page-operator)
//   - The CALLER decides whether to throw on rejected (covenant doesn't
//     throw — keeps the shape predictable for hot-path callers).

import { ContractNotRegisteredError, ViolationStoreNotConfiguredError } from './errors.ts';
import { lookupContract } from './registry.ts';
import { getLogger, getViolationStore } from './store.ts';
import type {
  Contract,
  Environment,
  ValidationResult,
  ViolationAction,
  ViolationContext,
} from './types.ts';

let cachedEnv: Environment | undefined;
function getEnv(): Environment {
  if (cachedEnv) return cachedEnv;
  // NODE_ENV mapping kept identical to Reeve's behavior.
  const node = process.env.NODE_ENV;
  cachedEnv =
    node === 'production'
      ? 'prod'
      : node === 'staging'
        ? 'staging'
        : node === 'test'
          ? 'test'
          : 'dev';
  return cachedEnv;
}

// Test-only override.
export function __test_setEnv(env: Environment | undefined): void {
  cachedEnv = env;
}

export async function validate<T>(args: {
  contractId: string;
  direction: 'in' | 'out';
  value: unknown;
  context?: ViolationContext;
  // Override the environment (tests; otherwise read from NODE_ENV).
  env?: Environment;
}): Promise<ValidationResult<T>> {
  const contract = lookupContract(args.contractId) as Contract<T, T> | undefined;
  if (!contract) {
    throw new ContractNotRegisteredError(args.contractId);
  }
  const env = args.env ?? getEnv();
  const action: ViolationAction = contract.policy[env][args.direction];
  const schema = args.direction === 'in' ? contract.request : contract.response;
  if (!schema) {
    // No schema declared for this direction in this contract — pass.
    return { ok: true, value: args.value as T };
  }

  const parsed = schema.safeParse(args.value);
  if (parsed.success) {
    return { ok: true, value: parsed.data as T };
  }

  const reason = formatZodError(parsed.error);

  // 1. Log (always).
  getLogger().warn(
    {
      contractId: args.contractId,
      direction: args.direction,
      env,
      action,
      reason,
      tenantId: args.context?.tenantId,
      correlationId: args.context?.correlationId,
    },
    'covenant.violation',
  );

  // Record in the store so the budget query sees this violation.
  const store = getViolationStore();
  if (!store) {
    throw new ViolationStoreNotConfiguredError();
  }
  await store.insert({
    contractId: args.contractId,
    environment: env,
    direction: args.direction,
    reason,
    ...(args.context?.tenantId !== undefined ? { tenantId: args.context.tenantId } : {}),
    ...(args.context?.correlationId !== undefined
      ? { correlationId: args.context.correlationId }
      : {}),
  });

  // 2. Budget check — if we just exceeded the threshold, fire onExhaust.
  let budgetExhausted = false;
  if (contract.budget) {
    const recentCount = await store.countRecent({
      contractId: args.contractId,
      environment: env,
      windowMs: contract.budget.windowMs,
    });
    if (recentCount > contract.budget.maxViolations) {
      budgetExhausted = true;
      getLogger().error(
        {
          contractId: args.contractId,
          env,
          recentCount,
          windowMs: contract.budget.windowMs,
          maxViolations: contract.budget.maxViolations,
          onExhaust: contract.budget.onExhaust.kind,
        },
        'covenant.budget_exhausted',
      );
      // The onExhaust action itself is dispatched by the caller — covenant
      // surfaces the budgetExhausted flag and lets the caller decide
      // whether to invoke Baton/witness/etc. This keeps covenant decoupled
      // from the specific consumer; the violation log is the authoritative
      // record either way.
    }
  }

  return {
    ok: false,
    violation: {
      contractId: args.contractId,
      direction: args.direction,
      reason,
      action,
      budgetExhausted,
      env,
    },
  };
}

function formatZodError(err: unknown): string {
  type ZodIssue = { path: readonly (string | number)[]; message: string };
  const issues = (err as { issues?: readonly ZodIssue[] }).issues ?? [];
  if (issues.length === 0) return 'unknown validation failure';
  return issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '<root>';
      return `${path}: ${i.message}`;
    })
    .join('; ')
    .slice(0, 4000);
}
