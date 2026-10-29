import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLIC_CONTRACTS } from '../src/index';
import { buildJsonSchemas, writeJsonSchemas } from './export-json-schema';

describe('JSON Schema export', () => {
  it('writes one file per public contract plus index.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harvest-schema-'));
    const written = writeJsonSchemas(dir);
    expect(written).toHaveLength(Object.keys(PUBLIC_CONTRACTS).length + 1);
    const files = readdirSync(dir);
    expect(files).toContain('ValueRecord.json');
    expect(files).toContain('CropRule.json');
    expect(files).toContain('tool.calculate_scenarios.input.json');
    const vr = JSON.parse(readFileSync(join(dir, 'ValueRecord.json'), 'utf8'));
    expect(vr['$schema']).toBe('http://json-schema.org/draft-07/schema#');
    expect(vr['x-schemaVersion']).toBe('1.0');
  });
  it('committed schema/ matches the current contracts (no drift)', () => {
    const committed = resolve(import.meta.dirname, '..', 'schema');
    const built = buildJsonSchemas();
    expect(readdirSync(committed).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(built).sort());
    for (const [f, c] of Object.entries(built)) expect(readFileSync(join(committed, f), 'utf8'), f).toBe(c);
  });
});
