import { describe, expect, it } from 'vitest';
import { Decimal, UnitError, convert, convertDecimal, depthOverAreaToLitres, inrString, requireUnit, sumInr, waterDimensionalCheck } from './units';

describe('unit conversions', () => {
  it('acre <-> ha uses 0.40468564224 exactly', () => {
    expect(convertDecimal(1, 'acre', 'ha').toString()).toBe('0.40468564224');
    expect(convertDecimal(2.5, 'acre', 'ha').toString()).toBe('1.0117141056');
    expect(convert(convert(3, 'acre', 'ha'), 'ha', 'acre')).toBeCloseTo(3, 12);
  });
  it('quintal = 100 kg, t = 1000 kg', () => {
    expect(convert(3, 'quintal', 'kg')).toBe(300);
    expect(convert(1.5, 't', 'quintal')).toBe(15);
  });
  it('INR/quintal <-> INR/kg', () => {
    expect(convertDecimal('4250', 'INR/quintal', 'INR/kg').toString()).toBe('42.5');
    expect(convertDecimal('42.5', 'INR/kg', 'INR/quintal').toString()).toBe('4250');
  });
  it('kg/acre -> kg/ha', () => {
    expect(convert(1000, 'kg/acre', 'kg/ha')).toBeCloseTo(2471.0538146717, 8);
  });
  it('m3 and litres; 1 mm over 1 ha = 10,000 L', () => {
    expect(convert(1, 'm3', 'L')).toBe(1000);
    expect(depthOverAreaToLitres(1, 1).toNumber()).toBe(10000);
    expect(depthOverAreaToLitres(25, '0.5').toNumber()).toBe(125000);
    expect(waterDimensionalCheck()).toEqual({ litresPerMmHa: 10000, passed: true });
  });
  it('rejects incompatible dimensions', () => {
    expect(() => convert(1, 'kg', 'ha')).toThrow(UnitError);
    expect(() => convert(1, 'INR/kg', 'INR')).toThrow(/incompatible/);
    expect(() => convert(1, 'kg/ha', 'kg')).toThrow(/incompatible/);
    expect(() => convert(1, 'mm', 'L')).toThrow(/incompatible/);
    expect(() => convert(1, 'percent', 'days')).toThrow(/incompatible/);
  });
  it('never infers a missing unit', () => {
    expect(() => convert(500, null, 'kg')).toThrow(/never inferred/);
    expect(() => convert(500, undefined, 'kg')).toThrow(UnitError);
    expect(() => requireUnit('lakh')).toThrow(/unknown unit/);
  });
  it('rejects non-finite values', () => {
    expect(() => convert(Infinity, 'kg', 'kg')).toThrow(UnitError);
  });
});

describe('decimal-safe INR', () => {
  it('avoids binary floating point drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumInr(['0.1', '0.2']).toString()).toBe('0.3');
    expect(inrString(sumInr(Array(1000).fill('0.01')))).toBe('10.00');
  });
  it('rounds to paise half-even', () => {
    expect(inrString(new Decimal('2.345'))).toBe('2.34');
    expect(inrString(new Decimal('2.355'))).toBe('2.36');
  });
});

describe('additional units', () => {
  it('m <-> cm and g <-> kg', () => {
    expect(convert(2.5, 'm', 'cm')).toBe(250);
    expect(convert(30, 'cm', 'm')).toBe(0.3);
    expect(convert(1500, 'g', 'kg')).toBe(1.5);
    expect(convert(2, 'kg', 'g')).toBe(2000);
  });
  it('months -> days requires approximate: true', () => {
    expect(() => convert(2, 'months', 'days')).toThrow(UnitError);
    expect(() => convert(60, 'days', 'months')).toThrow(/approximate/);
    expect(convertDecimal(2, 'months', 'days', { approximate: true }).toString()).toBe('60.875');
    expect(convert(30.4375, 'days', 'months', { approximate: true })).toBe(1);
  });
  it('new units keep dimension checks', () => {
    expect(() => convert(1, 'm', 'mm')).toThrow(UnitError);
    expect(() => convert(1, 'g', 'days', { approximate: true })).toThrow(UnitError);
  });
});
