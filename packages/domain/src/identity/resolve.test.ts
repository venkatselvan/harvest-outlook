import { CropIdentity, CropProduct } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { normalizeAlias, resolveCropIdentity } from './resolve';

// Synthetic catalogue: names are real words but IDs and mappings are fixtures.
const alias = (text: string, language: string, kind = 'common') => ({ text, language, kind, sourceIds: [] });
const crop = (id: string, names: ReturnType<typeof alias>[], productIds: string[], aliases: ReturnType<typeof alias>[] = []) =>
  CropIdentity.parse({ schemaVersion: '1.0', id, botanicalName: null, commonNames: names, aliases, varieties: [], productIds, sourceMappings: [], mode: 'synthetic' });
const product = (id: string, cropId: string, name: string, productBasis: string, aliases: ReturnType<typeof alias>[] = []) =>
  CropProduct.parse({ schemaVersion: '1.0', id, cropId, name, productBasis, grade: null, aliases, massUnit: 'kg', priceUnit: 'INR/kg', sourceMappings: [], mode: 'synthetic' });

const crops = [
  crop('synthetic-ginger', [alias('Ginger', 'en'), alias('இஞ்சி', 'ta'), alias('अदरक', 'hi')], ['synthetic-ginger-fresh', 'synthetic-ginger-dry']),
  crop('synthetic-cotton', [alias('Cotton', 'en')], ['synthetic-cotton-kapas', 'synthetic-cotton-lint']),
  crop('synthetic-chilli', [alias('Chilli', 'en'), alias('Mirchi', 'hi', 'transliteration')], ['synthetic-chilli-green', 'synthetic-chilli-dry']),
  crop('synthetic-chickpea', [alias('Chickpea', 'en'), alias('Chana', 'hi', 'transliteration')], ['synthetic-chickpea-grain']),
];
const products = [
  product('synthetic-ginger-fresh', 'synthetic-ginger', 'Fresh ginger', 'fresh'),
  product('synthetic-ginger-dry', 'synthetic-ginger', 'Dry ginger', 'dry', [alias('Sonth', 'hi', 'trade')]),
  product('synthetic-cotton-kapas', 'synthetic-cotton', 'Kapas', 'kapas', [alias('Seed cotton', 'en')]),
  product('synthetic-cotton-lint', 'synthetic-cotton', 'Cotton lint', 'lint'),
  product('synthetic-chilli-green', 'synthetic-chilli', 'Green chilli', 'green'),
  product('synthetic-chilli-dry', 'synthetic-chilli', 'Dry chilli', 'dry'),
  product('synthetic-chickpea-grain', 'synthetic-chickpea', 'Chickpea grain', 'grain'),
];

describe('crop identity resolution', () => {
  it('crop alias keeps product distinction unresolved (fresh vs dry)', () => {
    const r = resolveCropIdentity('இஞ்சி', crops, products);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.productId).toBeNull();
    expect(r.candidates[0]?.products.map((p) => p.productBasis).sort()).toEqual(['dry', 'fresh']);
    expect(r.ambiguous).toBe(true);
    expect(r.unresolvedReason).toBe('product_basis_unresolved');
  });
  it('product alias resolves the exact product', () => {
    const r = resolveCropIdentity('kapas', crops, products);
    expect(r.candidates.map((c) => c.productId)).toEqual(['synthetic-cotton-kapas']);
    expect(r.ambiguous).toBe(false);
    expect(resolveCropIdentity('sonth', crops, products).candidates[0]?.productId).toBe('synthetic-ginger-dry');
  });
  it('normalizes case/punctuation/whitespace but never forces a match', () => {
    expect(normalizeAlias('  Green-Chilli ')).toBe('green chilli');
    expect(resolveCropIdentity('GREEN  chilli', crops, products).candidates[0]?.productId).toBe('synthetic-chilli-green');
    const none = resolveCropIdentity('dragonfruit', crops, products);
    expect(none.candidates).toEqual([]);
    expect(none.unresolvedReason).toBe('no_alias_match');
  });
  it('prefix matches only when allowed and are ambiguous across crops', () => {
    expect(resolveCropIdentity('Ch', crops, products, { allowPrefix: true }).candidates).toEqual([]);
    const r = resolveCropIdentity('Chi', crops, products, { allowPrefix: true });
    expect(new Set(r.candidates.map((c) => c.cropId))).toEqual(new Set(['synthetic-chilli', 'synthetic-chickpea']));
    expect(r.unresolvedReason).toBe('multiple_crops_match');
    expect(resolveCropIdentity('Chi', crops, products).candidates).toEqual([]);
  });
});
