import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, contentHash, sha256Hex } from './hash';

describe('sha256', () => {
  it('matches node:crypto across lengths and unicode', () => {
    const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'இஞ்சி अदरक ginger'];
    for (const s of inputs) expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
  });
  it('known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('canonical JSON', () => {
  it('is independent of key order and omits undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' }, u: undefined })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(contentHash({ x: 1, y: 2 })).toBe(contentHash({ y: 2, x: 1 }));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });
  it('rejects values without a stable JSON form', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
  });
});
