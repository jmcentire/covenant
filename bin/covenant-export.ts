#!/usr/bin/env -S node --experimental-strip-types
// covenant-export — emit JSON Schema + policy YAML for every
// registered contract.
//
// Pipeline (per ADR-001):
//   Zod schemas (TypeScript, in-code; covenant authors here)
//      │
//      │ `zod-to-json-schema` (existing library, no bespoke codegen)
//      ▼
//   JSON Schema (Draft 2020-12)              ← committed to repo
//      │
//      │ pydantic.GenerateJsonSchema (built into pydantic v2)
//      ▼
//   Pydantic models (Python; consumed by other stack components)
//
// CLI:
//   covenant-export                  Emit/refresh contract artifacts.
//   covenant-export --check          Fail if a re-export would change
//                                    any committed file. CI gate.
//   covenant-export --contracts-dir <dir>
//                                    Override contract source dir
//                                    (default: ts/src/contracts).
//   covenant-export --out-dir <dir>  Override output dir
//                                    (default: contracts).

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Contract } from '../src/types.ts';

type Args = {
  check: boolean;
  contractsDir: string;
  outDir: string;
};

function parseArgs(argv: readonly string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..', '..');
  let check = false;
  let contractsDir = resolve(here, '..', 'src', 'contracts');
  let outDir = resolve(repoRoot, 'contracts');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--contracts-dir') {
      const next = argv[++i];
      if (!next) throw new Error('--contracts-dir requires a value');
      contractsDir = resolve(next);
    } else if (a === '--out-dir') {
      const next = argv[++i];
      if (!next) throw new Error('--out-dir requires a value');
      outDir = resolve(next);
    } else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`covenant-export: unknown arg: ${a}`);
    }
  }
  return { check, contractsDir, outDir };
}

function printHelp(): void {
  process.stdout.write(
    [
      'covenant-export — emit JSON Schema + policy for every contract.',
      '',
      'Usage:',
      '  covenant-export                Emit/refresh contract artifacts.',
      '  covenant-export --check        Fail if export would change committed files.',
      '  covenant-export --contracts-dir <dir>',
      '                                 Override contract source dir.',
      '  covenant-export --out-dir <dir>',
      '                                 Override output dir.',
      '',
    ].join('\n'),
  );
}

async function discoverContractFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith('.contract.ts')) {
      out.push(join(dir, name.name));
    }
  }
  return out.sort();
}

type ContractModule = {
  contract?: Contract;
};

async function loadContract(filePath: string): Promise<Contract> {
  const url = pathToFileURL(filePath).href;
  const mod = (await import(url)) as ContractModule;
  if (!mod.contract) {
    throw new Error(
      `covenant-export: ${filePath} does not export a 'contract' const. ` +
        'Each .contract.ts module must export `export const contract: Contract`.',
    );
  }
  return mod.contract;
}

type EmittedArtifact = {
  contractId: string;
  schemaPath: string;
  policyPath: string;
  schemaJson: string;
  policyYaml: string;
};

function emitContract(contract: Contract, outDir: string): EmittedArtifact {
  // JSON Schema. covenant emits Draft 2020-12. zod-to-json-schema
  // defaults to draft-07; we override via target.
  const requestSchema = contract.request
    ? zodToJsonSchema(contract.request, { target: 'jsonSchema2019-09' })
    : null;
  const responseSchema = contract.response
    ? zodToJsonSchema(contract.response, { target: 'jsonSchema2019-09' })
    : null;

  // Wrap in a covenant envelope so consumers don't have to decide
  // which JSON Schema is request vs response.
  const envelope: Record<string, unknown> = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    contract_id: contract.id,
  };
  if (requestSchema) envelope.request = requestSchema;
  if (responseSchema) envelope.response = responseSchema;

  const schemaJson = `${JSON.stringify(envelope, null, 2)}\n`;

  // Policy + budget — emit as YAML so reviewers can scan it.
  const policyYaml = renderPolicyYaml(contract);

  const schemaPath = join(outDir, `${contract.id}.json`);
  const policyPath = join(outDir, `${contract.id}.policy.yaml`);

  return { contractId: contract.id, schemaPath, policyPath, schemaJson, policyYaml };
}

function renderPolicyYaml(contract: Contract): string {
  const lines: string[] = [];
  lines.push(`id: ${contract.id}`);
  lines.push('policy:');
  for (const env of ['dev', 'test', 'staging', 'prod'] as const) {
    const p = contract.policy[env];
    lines.push(`  ${env}:`);
    lines.push(`    in: ${p.in}`);
    lines.push(`    out: ${p.out}`);
  }
  if (contract.budget) {
    lines.push('budget:');
    lines.push(`  windowMs: ${contract.budget.windowMs}`);
    lines.push(`  maxViolations: ${contract.budget.maxViolations}`);
    lines.push('  onExhaust:');
    lines.push(`    kind: ${contract.budget.onExhaust.kind}`);
  }
  return `${lines.join('\n')}\n`;
}

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Ensure no contracts are double-registered across runs.
  const { __test_clearContractRegistry } = await import('../src/registry.ts');
  __test_clearContractRegistry();

  const files = await discoverContractFiles(args.contractsDir);
  if (files.length === 0) {
    process.stderr.write(`covenant-export: no contracts found under ${args.contractsDir}\n`);
    process.exit(args.check ? 0 : 0);
  }

  if (!existsSync(args.outDir)) {
    mkdirSync(args.outDir, { recursive: true });
  }

  const artifacts: EmittedArtifact[] = [];
  const seenIds = new Set<string>();
  for (const file of files) {
    const contract = await loadContract(file);
    if (seenIds.has(contract.id)) {
      throw new Error(
        `covenant-export: duplicate contract id '${contract.id}' across modules. ` +
          'Each id must be unique repo-wide.',
      );
    }
    seenIds.add(contract.id);
    artifacts.push(emitContract(contract, args.outDir));
  }

  if (args.check) {
    const drifts: string[] = [];
    for (const a of artifacts) {
      const onDiskSchema = readIfExists(a.schemaPath);
      if (onDiskSchema !== a.schemaJson) {
        drifts.push(relative(process.cwd(), a.schemaPath));
      }
      const onDiskPolicy = readIfExists(a.policyPath);
      if (onDiskPolicy !== a.policyYaml) {
        drifts.push(relative(process.cwd(), a.policyPath));
      }
    }
    if (drifts.length > 0) {
      process.stderr.write(
        `covenant-export --check: ${drifts.length} file(s) out of sync:\n` +
          drifts.map((d) => `  - ${d}`).join('\n') +
          '\nRun `covenant-export` and commit the changes.\n',
      );
      process.exit(1);
    }
    process.stdout.write(
      `covenant-export --check: clean (${artifacts.length} contract(s) verified)\n`,
    );
    return;
  }

  let wrote = 0;
  for (const a of artifacts) {
    const beforeSchema = readIfExists(a.schemaPath);
    if (beforeSchema !== a.schemaJson) {
      writeFileSync(a.schemaPath, a.schemaJson);
      wrote++;
    }
    const beforePolicy = readIfExists(a.policyPath);
    if (beforePolicy !== a.policyYaml) {
      writeFileSync(a.policyPath, a.policyYaml);
      wrote++;
    }
  }
  process.stdout.write(
    `covenant-export: ${artifacts.length} contract(s) processed, ${wrote} file(s) written\n`,
  );
}

await main().catch((err: Error) => {
  process.stderr.write(`covenant-export: ${err.message}\n`);
  if (process.env.COVENANT_DEBUG === '1' && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  process.exit(1);
});
