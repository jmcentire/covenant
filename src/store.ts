// Process-local registration of the violation store and logger
// adapters. Consumers wire these once at boot:
//
//   import { setViolationStore, setLogger } from '@stack/covenant';
//   setViolationStore({ insert, countRecent });
//   setLogger(myPinoChild);
//
// covenant ships an in-memory default ViolationStore for tests; if
// the consumer never sets one, validate() throws on first violation.

import type { CovenantLogger, ViolationStore } from './types.js';

let store: ViolationStore | undefined;
let logger: CovenantLogger | undefined;

export function setViolationStore(s: ViolationStore): void {
  store = s;
}

export function getViolationStore(): ViolationStore | undefined {
  return store;
}

export function setLogger(l: CovenantLogger): void {
  logger = l;
}

export function getLogger(): CovenantLogger {
  if (logger) return logger;
  // Default logger writes to stderr in a pino-compatible shape so the
  // library never silently drops events when the consumer forgot to
  // wire one up.
  return defaultLogger;
}

const defaultLogger: CovenantLogger = {
  warn(obj, msg) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', msg, ...obj })}\n`);
  },
  error(obj, msg) {
    process.stderr.write(`${JSON.stringify({ level: 'error', msg, ...obj })}\n`);
  },
};

// In-memory store — shipped as a default for tests and for consumers
// who explicitly want non-durable budget enforcement (single-process
// only; budgets reset on restart).
export class InMemoryViolationStore implements ViolationStore {
  private readonly rows: {
    contractId: string;
    environment: string;
    direction: 'in' | 'out';
    reason: string;
    tenantId?: string;
    correlationId?: string;
    observedAt: number;
  }[] = [];

  async insert(record: {
    contractId: string;
    environment: 'dev' | 'test' | 'staging' | 'prod';
    direction: 'in' | 'out';
    reason: string;
    tenantId?: string;
    correlationId?: string;
  }): Promise<void> {
    this.rows.push({
      contractId: record.contractId,
      environment: record.environment,
      direction: record.direction,
      reason: record.reason,
      ...(record.tenantId !== undefined ? { tenantId: record.tenantId } : {}),
      ...(record.correlationId !== undefined ? { correlationId: record.correlationId } : {}),
      observedAt: Date.now(),
    });
  }

  async countRecent(args: {
    contractId: string;
    environment: 'dev' | 'test' | 'staging' | 'prod';
    windowMs: number;
  }): Promise<number> {
    const cutoff = Date.now() - args.windowMs;
    let count = 0;
    for (const row of this.rows) {
      if (
        row.contractId === args.contractId &&
        row.environment === args.environment &&
        row.observedAt > cutoff
      ) {
        count++;
      }
    }
    return count;
  }

  __test_clear(): void {
    this.rows.length = 0;
  }

  __test_size(): number {
    return this.rows.length;
  }
}

// Test-only — clear the store + logger so tests can assert clean
// state.
export function __test_resetStore(): void {
  store = undefined;
  logger = undefined;
}
