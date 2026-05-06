// Golden vectors. Both TS and Python runtimes must produce identical
// outcomes for every case in vectors/policy-cases.json.
//
// Cases share a contract id when they're testing budget evolution;
// register each contract once per file load and walk the cases in
// order.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  __test_clearContractRegistry,
  __test_resetStore,
  __test_setEnv,
  type Environment,
  InMemoryViolationStore,
  registerContract,
  setViolationStore,
  validate,
  type ViolationAction,
} from '../src/index.ts';

type VectorContract = {
  id: string;
  schema: Record<string, unknown>;
  policy: Record<Environment, { in: ViolationAction; out: ViolationAction }>;
  budget?: {
    windowMs: number;
    maxViolations: number;
    onExhaust: { kind: 'rollback' | 'pause-vendor' | 'page-operator' };
  };
};

type VectorCase = {
  name: string;
  contractId: string;
  env: Environment;
  direction: 'in' | 'out';
  value: unknown;
  expect:
    | { ok: true }
    | { ok: false; action: ViolationAction; budgetExhausted: boolean };
};

type VectorFile = {
  contracts: VectorContract[];
  cases: VectorCase[];
};

const vectorsPath = resolve(import.meta.dirname, '..', 'vectors', 'policy-cases.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as VectorFile;

// Convert a JSON Schema to a Zod schema. We support the narrow subset
// our vectors use: object with required string/integer/const fields,
// minLength, minimum, additionalProperties.
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if (schema.type === 'object') {
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const props = (schema.properties as Record<string, Record<string, unknown>>) ?? {};
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      let s = propertySchemaToZod(propSchema);
      if (!required.has(key)) s = s.optional();
      shape[key] = s;
    }
    let obj: z.ZodObject<z.ZodRawShape> = z.object(shape);
    if (schema.additionalProperties === false) obj = obj.strict();
    return obj;
  }
  return propertySchemaToZod(schema);
}

function propertySchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  if ('const' in schema) {
    return z.literal(schema.const as string | number | boolean | null);
  }
  switch (schema.type) {
    case 'string': {
      let s = z.string();
      if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
      return s;
    }
    case 'integer': {
      let s = z.number().int();
      if (typeof schema.minimum === 'number') s = s.min(schema.minimum);
      return s;
    }
    case 'number': {
      let s = z.number();
      if (typeof schema.minimum === 'number') s = s.min(schema.minimum);
      return s;
    }
    case 'boolean':
      return z.boolean();
    case 'object':
      return jsonSchemaToZod(schema);
    default:
      return z.unknown();
  }
}

let store: InMemoryViolationStore;

beforeAll(() => {
  __test_resetStore();
  __test_clearContractRegistry();
  store = new InMemoryViolationStore();
  setViolationStore(store);
  for (const c of vectors.contracts) {
    registerContract({
      id: c.id,
      request: jsonSchemaToZod(c.schema),
      policy: c.policy,
      ...(c.budget ? { budget: c.budget } : {}),
    });
  }
});

afterAll(() => {
  __test_setEnv(undefined);
  __test_resetStore();
  __test_clearContractRegistry();
});

describe('golden vectors — policy-cases.json', () => {
  for (const c of vectors.cases) {
    it(c.name, async () => {
      const r = await validate({
        contractId: c.contractId,
        direction: c.direction,
        value: c.value,
        env: c.env,
      });
      if (c.expect.ok) {
        expect(r.ok).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.violation.action).toBe(c.expect.action);
          expect(r.violation.budgetExhausted).toBe(c.expect.budgetExhausted);
        }
      }
    });
  }
});
