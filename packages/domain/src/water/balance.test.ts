import { WaterBalanceResult, type WaterBalanceInput } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { addDays } from '../time/stages';
import { calculateWaterBalance } from './balance';

// Synthetic weather/soil fixtures for arithmetic checks only.
const days = (n: number, et0: number | null, rain: number | null, state: 'observed' | 'forecast' | 'missing' = 'observed') =>
  Array.from({ length: n }, (_, i) => ({ date: addDays('2027-03-01', i), et0Mm: et0, et0Source: 'synthetic-et0', rainMm: rain, rainState: state }));

const base = (): WaterBalanceInput => ({
  schemaVersion: '1.0',
  days: days(30, 5, 0),
  stages: [{ stageId: 'synthetic-mid', start: '2027-03-01', end: '2027-03-30', kc: 1, kcSource: 'synthetic-kc' }],
  rootZone: { totalAvailableWaterMm: 100, depletionFraction: 0.5, initialDepletionMm: 0, basis: 'synthetic' },
  effectiveRain: { method: 'fixed_fraction', fraction: 0.8 },
  forecastRainPolicy: 'ignore_forecast',
  irrigationEfficiency: 0.8,
  areaHa: 0.5,
  tawScenariosMm: [],
});

describe('water balance', () => {
  it('dimensional self-check: 1 mm over 1 ha = 10,000 L', () => {
    const r = calculateWaterBalance(base());
    expect(r.dimensionalCheck).toEqual({ litresPerMmHa: 10000, passed: true });
    const run = r.runs[0]!;
    expect(run.grossLitresPerHa).toBe(run.grossIrrigationMm! * 10000);
    expect(run.grossLitresTotal).toBe(run.grossIrrigationMm! * 10000 * 0.5);
  });
  it('drought: refill at RAW, net vs gross irrigation, mass balance closes', () => {
    const r = calculateWaterBalance(base());
    expect(WaterBalanceResult.parse(r)).toEqual(r);
    expect(r.status).toBe('complete');
    expect(r.evidenceState).toBe('derived');
    expect(r.permittedPrecision).toBe('rounded_5mm');
    const run = r.runs[0]!;
    expect(run.events).toEqual([{ date: '2027-03-11', netMm: 55 }, { date: '2027-03-22', netMm: 55 }]);
    expect(run.netIrrigationMm).toBe(110);
    expect(run.grossIrrigationMm).toBe(137.5);
    expect(run.grossLitresPerHa).toBe(1_375_000);
    expect(run.stressDays).toBe(0);
    const finalDr = run.daily.at(-1)!.depletionEndMm!;
    // initial + ETc - Peff - net + deep = final
    expect(0 + run.etcMm - run.effectiveRainMm - run.netIrrigationMm + run.deepPercolationMm).toBeCloseTo(finalDr, 9);
    expect(finalDr).toBe(40);
  });
  it('forecast rain without observed rain is a scenario either way', () => {
    const inp = base();
    inp.days = days(30, 5, 10, 'forecast');
    const ignored = calculateWaterBalance(inp);
    expect(ignored.evidenceState).toBe('scenario');
    expect(ignored.permittedPrecision).toBe('range_only');
    expect(ignored.runs[0]!.netIrrigationMm).toBe(110); // treated as no rain
    expect(ignored.runs[0]!.effectiveRainFromForecastMm).toBe(0);

    const used = calculateWaterBalance({ ...inp, forecastRainPolicy: 'use_forecast' });
    expect(used.evidenceState).toBe('scenario');
    expect(used.runs[0]!.effectiveRainFromForecastMm).toBe(240); // 30 * 10 * 0.8
    expect(used.runs[0]!.netIrrigationMm).toBe(0);
    expect(used.runs[0]!.deepPercolationMm).toBe(90); // 3 mm/day surplus
    expect(used.runs[0]!.evidenceState).toBe('scenario');
  });
  it('missing soil capacity: labelled TAW scenarios plus no-storage scenario, never derived', () => {
    const inp = base();
    inp.rootZone.totalAvailableWaterMm = null;
    inp.tawScenariosMm = [60, 120];
    const r = calculateWaterBalance(inp);
    expect(r.status).toBe('incomplete');
    expect(r.missingInputs).toContain('rootZone.totalAvailableWaterMm');
    expect(r.evidenceState).toBe('scenario');
    expect(r.permittedPrecision).toBe('range_only');
    expect(r.runs.map((x) => x.label)).toEqual(['taw_scenario_60mm', 'taw_scenario_120mm', 'no_soil_storage']);
    expect(r.runs.every((x) => x.evidenceState === 'scenario')).toBe(true);
    expect(r.runs.find((x) => x.label === 'no_soil_storage')!.netIrrigationMm).toBe(150);
  });
  it('missing ET0 or rain is never filled', () => {
    const a = base();
    a.days = [...days(5, 5, 0), { ...days(1, null, 0)[0]!, date: '2027-03-06' }];
    const r = calculateWaterBalance(a);
    expect(r.status).toBe('incomplete');
    expect(r.missingInputs).toEqual(['et0:2027-03-06']);
    expect(r.runs).toEqual([]);
    const b = base();
    b.days = days(3, 5, null, 'missing');
    expect(calculateWaterBalance(b).missingInputs).toEqual(['rain:2027-03-01', 'rain:2027-03-02', 'rain:2027-03-03']);
  });
  it('missing Kc stage coverage is reported', () => {
    const inp = base();
    inp.stages = [{ ...inp.stages[0]!, end: '2027-03-29' }];
    expect(calculateWaterBalance(inp).missingInputs).toEqual(['kc:2027-03-30']);
  });
  it('unknown efficiency: net only, gross null, incomplete', () => {
    const r = calculateWaterBalance({ ...base(), irrigationEfficiency: null });
    expect(r.status).toBe('incomplete');
    expect(r.runs[0]!.netIrrigationMm).toBe(110);
    expect(r.runs[0]!.grossIrrigationMm).toBeNull();
    expect(r.runs[0]!.grossLitresPerHa).toBeNull();
  });
  it('USDA-SCS monthly effective rain', () => {
    const inp = base();
    inp.effectiveRain = { method: 'usda_scs_monthly' };
    inp.days = days(10, 5, 10); // 100 mm in March -> Peff = 100*(125-20)/125 = 84
    inp.stages = [{ ...inp.stages[0]!, end: '2027-03-10' }];
    const r = calculateWaterBalance(inp);
    expect(r.runs[0]!.effectiveRainMm).toBe(84);
  });
  it('stress days counted when starting depleted beyond RAW', () => {
    const inp = base();
    inp.rootZone.initialDepletionMm = 70;
    inp.days = days(1, 5, 0);
    inp.stages = [{ ...inp.stages[0]!, end: '2027-03-01' }];
    const run = calculateWaterBalance(inp).runs[0]!;
    expect(run.stressDays).toBe(1);
    expect(run.etcMm).toBe(3); // Ks = (100-70)/(100-50) = 0.6
  });
  it('rejects out-of-order days', () => {
    const inp = base();
    inp.days = [days(2, 5, 0)[1]!, days(1, 5, 0)[0]!];
    expect(calculateWaterBalance(inp).status).toBe('invalid');
  });
});
