// covenant runtime errors.
//
// validate() does NOT throw on contract violation (predictable shape
// for hot-path callers). It DOES throw on programmer errors —
// unregistered contract id, duplicate registration, or store-not-set.

export class CovenantError extends Error {
  override readonly name: string = 'CovenantError';
  constructor(message: string) {
    super(message);
  }
}

export class ContractAlreadyRegisteredError extends CovenantError {
  override readonly name = 'ContractAlreadyRegisteredError';
  readonly contractId: string;
  constructor(contractId: string) {
    super(
      `covenant: contract id=${contractId} already registered. Each id registers exactly once.`,
    );
    this.contractId = contractId;
  }
}

export class ContractNotRegisteredError extends CovenantError {
  override readonly name = 'ContractNotRegisteredError';
  readonly contractId: string;
  constructor(contractId: string) {
    super(`covenant: contract id=${contractId} not registered. Call registerContract() first.`);
    this.contractId = contractId;
  }
}

export class ViolationStoreNotConfiguredError extends CovenantError {
  override readonly name = 'ViolationStoreNotConfiguredError';
  constructor() {
    super(
      'covenant: violation store not configured. Call setViolationStore() before validate().',
    );
  }
}
