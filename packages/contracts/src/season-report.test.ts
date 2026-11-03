import {describe, expect, it} from 'vitest';
import {IssueCategory, PUBLIC_CONTRACTS, SeasonReport, SeasonReportQuery} from './index';
import {buildJsonSchemas} from '../scripts/export-json-schema';

// SYNTHETIC example only: ids, dates and texts are invented for schema checks.
const U1 = '11111111-1111-4111-8111-111111111111';
const zeroCounts = Object.fromEntries(IssueCategory.options.map((c) => [c, 0]));
const report = {
  farm: {id: U1, name: 'Test farm', district: 'Wayanad', state: 'IN-KL', areaHa: 1.5},
  field: {id: 'strip-2', name: 'Strip 2', areaHa: 0.5},
  cycle: {id: 'cycle-1', cropId: 'maize', cropName: 'Maize', sowingDate: '2026-10-01', establishmentDate: '2026-10-01', establishmentMethod: 'direct_sowing', stage: 'growing', fieldId: 'strip-2'},
  period: {from: '2026-10-01', to: '2026-11-03'},
  entries: [{id: U1, observedOn: '2026-10-05', activity: 'irrigation', note: null, quantity: {value: 20, unit: 'mm'}, expense: null, sale: null, media: [], facts: [], provenanceLabel: 'Farmer-reported. Saved as you entered it.'}],
  checks: [], issues: [], careCompletions: [{taskId: 't1', title: 'First weeding', completedOn: '2026-10-20'}], alerts: [],
  ndvi: [{date: '2026-10-12', meanNdvi: 0.41, clearFraction: 0.9, verdict: 'usable'}],
  issueTrend: [{weekStart: '2026-10-26', counts: {...zeroCounts, pest: 2}}],
  previousSeasons: [], generatedAt: '2026-11-03T06:00:00.000Z', limitations: ['No alerts were stored for this period.'],
};

describe('SeasonReport contract', () => {
  it('accepts a complete report and rejects unknown keys, a missing category count and a malformed date', () => {
    expect(SeasonReport.safeParse(report).success).toBe(true);
    expect(SeasonReport.safeParse({...report, estimate: 1}).success).toBe(false);
    const {pest: _p, ...short} = zeroCounts as Record<string, number>;
    expect(SeasonReport.safeParse({...report, issueTrend: [{weekStart: '2026-10-26', counts: short}]}).success).toBe(false);
    expect(SeasonReport.safeParse({...report, issueTrend: [{weekStart: '26/10/2026', counts: zeroCounts}]}).success).toBe(false);
    expect(SeasonReport.safeParse({...report, period: {from: '2026-10-01'}}).success).toBe(false);
  });
  it('keeps at most five previous seasons and a nullable field', () => {
    const season = {cycleId: 'c0', cropName: 'Ragi', sowingDate: '2025-06-01', harvestDate: null, issueCount: 0, checksCompleted: 0};
    expect(SeasonReport.safeParse({...report, previousSeasons: Array(5).fill(season)}).success).toBe(true);
    expect(SeasonReport.safeParse({...report, previousSeasons: Array(6).fill(season)}).success).toBe(false);
    expect(SeasonReport.safeParse({...report, field: null}).success).toBe(true);
  });
  it('the query takes only cycleId and fieldId', () => {
    expect(SeasonReportQuery.safeParse({}).success).toBe(true);
    expect(SeasonReportQuery.safeParse({cycleId: 'cycle-1'}).success).toBe(true);
    expect(SeasonReportQuery.safeParse({fieldId: 'a/b'}).success).toBe(false);
    expect(SeasonReportQuery.safeParse({cycleId: ''}).success).toBe(false);
    expect(SeasonReportQuery.safeParse({csv: '1'}).success).toBe(false);
  });
  it('exports a JSON Schema', () => {
    expect(PUBLIC_CONTRACTS.SeasonReport).toBeDefined();
    expect(buildJsonSchemas()['SeasonReport.json']).toContain('"weekStart"');
  });
});
