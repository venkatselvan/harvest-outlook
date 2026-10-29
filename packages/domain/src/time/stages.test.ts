import { StageDefinition } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { addDays, computeStageWindows } from './stages';

// Synthetic stage chain; durations are fixture values, not ginger agronomy.
const stage = (stageId: string, order: number, startsAfter: string | null, min: number, max: number, extra: Record<string, unknown> = {}) =>
  StageDefinition.parse({
    schemaVersion: '1.0', id: `synthetic-${stageId}`, mode: 'synthetic', cropId: 'synthetic-crop', varietyId: null,
    scope: { level: 'region', ids: ['synthetic-region'] }, seasons: ['kharif'], stageId, name: stageId, order, startsAfter,
    prerequisites: [], method: 'calendar_days', durationDays: { min, max }, thermal: null, isHarvest: false, repeat: null,
    evidenceIds: ['synthetic-evidence-only'], limitations: [], reviewStatus: 'synthetic', ...extra,
  });

describe('stage windows', () => {
  it('adds days across month and leap boundaries', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
  });
  it('produces widening ranges from duration ranges (no fixed day count)', () => {
    const r = computeStageWindows(
      [stage('synthetic-establish', 0, null, 10, 20), stage('synthetic-vegetative', 1, 'synthetic-establish', 30, 45), stage('synthetic-harvest', 2, 'synthetic-vegetative', 5, 10, { isHarvest: true })],
      { earliest: '2027-05-01', latest: '2027-05-01' },
    );
    if (r.status !== 'ok') throw new Error(r.reason);
    const veg = r.windows.find((w) => w.stageId === 'synthetic-vegetative')!;
    expect(veg).toMatchObject({ earliestStart: '2027-05-11', latestStart: '2027-05-21', earliestEnd: '2027-06-10', latestEnd: '2027-07-05' });
    const h = r.harvestWindows[0]!;
    expect(h.earliestStart).toBe('2027-06-10');
    expect(h.latestStart).toBe('2027-07-05');
    expect(h.earliest < h.latest).toBe(true);
  });
  it('planting window widens every stage', () => {
    const r = computeStageWindows([stage('synthetic-establish', 0, null, 10, 20)], { earliest: '2027-05-01', latest: '2027-05-15' });
    if (r.status !== 'ok') throw new Error(r.reason);
    expect(r.windows[0]).toMatchObject({ earliestStart: '2027-05-01', latestStart: '2027-05-15', earliestEnd: '2027-05-11', latestEnd: '2027-06-04' });
  });
  it('supports repeated harvest windows', () => {
    const r = computeStageWindows(
      [stage('synthetic-growth', 0, null, 60, 70), stage('synthetic-picking', 1, 'synthetic-growth', 3, 5, { isHarvest: true, repeat: { intervalDays: { min: 7, max: 10 }, maxOccurrences: 3 } })],
      { earliest: '2027-01-01', latest: '2027-01-01' },
    );
    if (r.status !== 'ok') throw new Error(r.reason);
    expect(r.harvestWindows.map((w) => [w.occurrence, w.earliestStart, w.latestStart])).toEqual([
      [1, '2027-03-02', '2027-03-12'],
      [2, '2027-03-09', '2027-03-22'],
      [3, '2027-03-16', '2027-04-01'],
    ]);
    expect(r.limitations.length).toBeGreaterThan(0);
  });
  it('refuses thermal-time stages and cycles rather than guessing', () => {
    const thermal = stage('synthetic-t', 0, null, 10, 20, { method: 'thermal_time', thermal: { baseTempC: 10, gddMin: 100, gddMax: 200, validated: true, evidenceIds: ['synthetic-e'] } });
    expect(computeStageWindows([thermal], { earliest: '2027-01-01', latest: '2027-01-01' }).status).toBe('unsupported');
    const a = stage('synthetic-a', 0, 'synthetic-b', 1, 2);
    const b = stage('synthetic-b', 1, 'synthetic-a', 1, 2);
    expect(computeStageWindows([a, b], { earliest: '2027-01-01', latest: '2027-01-01' }).status).toBe('unsupported');
  });
  it('contract rejects inverted duration ranges', () => {
    expect(() => stage('synthetic-bad', 0, null, 20, 10)).toThrow();
  });
});
