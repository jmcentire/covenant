// Covenant registry. Process-local; lookups by contract id.

import { ContractAlreadyRegisteredError } from './errors.js';
import type { Contract } from './types.js';

const contractRegistry = new Map<string, Contract<unknown, unknown>>();

export function registerContract<TIn, TOut>(contract: Contract<TIn, TOut>): void {
  if (contractRegistry.has(contract.id)) {
    throw new ContractAlreadyRegisteredError(contract.id);
  }
  contractRegistry.set(contract.id, contract as Contract<unknown, unknown>);
}

export function lookupContract(id: string): Contract<unknown, unknown> | undefined {
  return contractRegistry.get(id);
}

export function listContracts(): readonly Contract<unknown, unknown>[] {
  return Array.from(contractRegistry.values());
}

export function __test_clearContractRegistry(): void {
  contractRegistry.clear();
}
