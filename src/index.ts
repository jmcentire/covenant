// covenant — slice 4 of the production-stability roadmap, extracted
// to a stack-shared component 2026-05-06.
//
// Library-only: contract validation runtime with per-environment policy
// and sliding-window violation budget. Sim-vetted V1 (Zod-backed,
// non-throwing validate, log+emit always, action precedence).
//
// Quickstart:
//   import { z } from 'zod';
//   import {
//     registerContract,
//     setViolationStore,
//     validate,
//     InMemoryViolationStore,
//   } from '@stack/covenant';
//
//   setViolationStore(new InMemoryViolationStore());
//   registerContract({
//     id: 'my.api.shape',
//     request: z.object({ name: z.string() }),
//     policy: {
//       dev: { in: 'strict-reject', out: 'log-only' },
//       test: { in: 'strict-reject', out: 'log-only' },
//       staging: { in: 'log-and-emit', out: 'log-only' },
//       prod: { in: 'log-only', out: 'log-only' },
//     },
//   });
//
//   const r = await validate({
//     contractId: 'my.api.shape',
//     direction: 'in',
//     value: req.body,
//   });

export type {
  Contract,
  CovenantLogger,
  Environment,
  ValidationResult,
  ViolationAction,
  ViolationBudget,
  ViolationContext,
  ViolationStore,
} from './types.js';
export {
  ContractAlreadyRegisteredError,
  ContractNotRegisteredError,
  CovenantError,
  ViolationStoreNotConfiguredError,
} from './errors.js';
export {
  __test_clearContractRegistry,
  listContracts,
  lookupContract,
  registerContract,
} from './registry.js';
export {
  __test_resetStore,
  getLogger,
  getViolationStore,
  InMemoryViolationStore,
  setLogger,
  setViolationStore,
} from './store.js';
export { __test_setEnv, validate } from './validate.js';
