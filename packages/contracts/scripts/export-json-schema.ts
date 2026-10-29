/**
 * Writes a JSON Schema (draft-07, input shape: defaults optional) file for every public contract into
 * packages/contracts/schema/, plus index.json listing names and sha256 hashes.
 * Run: pnpm --filter @harvest/contracts export-schema
 * Refinements (superRefine/refine) are NOT representable in JSON Schema; Python
 * consumers must treat the exported schema as structural validation only and
 * re-check documented invariants (see index.json `refinementsNotExported`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PUBLIC_CONTRACTS, SCHEMA_VERSION } from '../src/index';

export function buildJsonSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, schema] of Object.entries(PUBLIC_CONTRACTS)) {
    const json = z.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'throw',
      cycles: 'ref',
      reused: 'inline',
    }) as Record<string, unknown>;
    json['$id'] = `https://harvest-outlook.local/schema/${SCHEMA_VERSION}/${name}.json`;
    json['x-schemaVersion'] = SCHEMA_VERSION;
    out[`${name}.json`] = JSON.stringify(json, null, 2) + '\n';
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generator: 'zod/v4 z.toJSONSchema (draft-7, io=input)',
    refinementsNotExported:
      'Cross-field invariants (e.g. ValueRecord null=>missingReason, quantile ordering, rule value types, job/fact status coupling) are enforced by Zod only; Python must re-validate these.',
    files: Object.fromEntries(
      Object.entries(out)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, c]) => [f, createHash('sha256').update(c).digest('hex')]),
    ),
  };
  out['index.json'] = JSON.stringify(index, null, 2) + '\n';
  return out;
}

export function writeJsonSchemas(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
  const files = buildJsonSchemas();
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return Object.keys(files).sort();
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
  const written = writeJsonSchemas(dir);
  console.log(`wrote ${written.length} files to ${dir}`);
}
