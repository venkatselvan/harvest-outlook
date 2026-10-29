import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiError,
  CoverageRecord,
  CropRule,
  EvidenceRecord,
  FarmProfile,
  ForecastArtifact,
  JournalFact,
  QuantileSet,
  StructuredAssistantOutput,
  ToolName,
  ToolSchemas,
  ValueRecord,
  VisualAsset,
  apiEnvelope,
  canTransitionJob,
  PUBLIC_CONTRACTS,
} from './index';

const roundTrip = <T>(schema: z.ZodType<T>, value: unknown) => {
  const parsed = schema.parse(value);
  const again = schema.parse(JSON.parse(JSON.stringify(parsed)));
  expect(again).toEqual(parsed);
  return parsed;
};

const unavailablePrice = {
  schemaVersion: '1.0',
  kind: 'quantity',
  value: null,
  unit: 'INR/kg',
  evidenceState: 'unavailable',
  scope: { level: 'market', ids: ['synthetic-market-a'] },
  validFrom: '2027-05-01',
  validTo: '2027-05-31',
  issuedAt: '2026-10-30T00:00:00Z',
  evidenceIds: [],
  assumptionIds: [],
  methodVersion: null,
  validationStatus: 'unsupported',
  missingReason: 'No qualified forecast exists for this product and horizon',
};

describe('ValueRecord', () => {
  it('round-trips the BUILD_SPEC 5.2 unavailable example (scope uses ids[])', () => {
    roundTrip(ValueRecord, unavailablePrice);
  });
  it('requires missingReason when value is null', () => {
    expect(ValueRecord.safeParse({ ...unavailablePrice, missingReason: null }).success).toBe(false);
  });
  it('forbids a value when evidence is unavailable', () => {
    expect(ValueRecord.safeParse({ ...unavailablePrice, value: 42 }).success).toBe(false);
  });
  it('requires a unit for quantities (never inferred)', () => {
    const { unit: _u, ...noUnit } = unavailablePrice;
    expect(ValueRecord.safeParse(noUnit).success).toBe(false);
    expect(ValueRecord.safeParse({ ...unavailablePrice, unit: 'rupees' }).success).toBe(false);
  });
  it('rejects inverted ranges and periods', () => {
    const range = { ...unavailablePrice, kind: 'range', value: { low: 30, high: 20 }, evidenceState: 'scenario', missingReason: null, validationStatus: 'pending' };
    expect(ValueRecord.safeParse(range).success).toBe(false);
    expect(ValueRecord.safeParse({ ...range, value: { low: '20.50', high: 30 } }).success).toBe(true);
    expect(ValueRecord.safeParse({ ...unavailablePrice, validFrom: '2027-06-01' }).success).toBe(false);
  });
  it('rejects unknown fields (strict)', () => {
    expect(ValueRecord.safeParse({ ...unavailablePrice, confidence: 0.9 }).success).toBe(false);
  });
});

describe('ApiEnvelope', () => {
  const Env = apiEnvelope(z.object({ ok: z.boolean() }));
  const ok = { schemaVersion: '1.0', requestId: 'synthetic-req-1', mode: 'synthetic', asOf: '2026-10-30T05:30:00+05:30', data: { ok: true }, warnings: [], error: null };
  it('accepts data without error', () => roundTrip(Env, ok));
  it('requires data null with error, and error with null data', () => {
    const error = { code: 'not_found', message: 'synthetic', retryable: false };
    expect(ApiError.safeParse(error).success).toBe(true);
    expect(Env.safeParse({ ...ok, error }).success).toBe(false);
    expect(Env.safeParse({ ...ok, data: null, error }).success).toBe(true);
    expect(Env.safeParse({ ...ok, data: null }).success).toBe(false);
    expect(Env.safeParse({ ...ok, data: null, error: null }).success).toBe(false);
    const { error: _omitted, ...noError } = ok;
    expect(Env.safeParse(noError).success).toBe(false);
  });
  it('rejects timestamps without offset and invalid modes', () => {
    expect(Env.safeParse({ ...ok, asOf: '2026-10-30T05:30:00' }).success).toBe(false);
    expect(Env.safeParse({ ...ok, mode: 'demo' }).success).toBe(false);
  });
});

const syntheticRule = {
  schemaVersion: '1.0',
  id: 'synthetic-drainage-rule',
  version: 1,
  mode: 'synthetic',
  cropId: 'synthetic-ginger',
  scope: { regionIds: ['synthetic-region'], seasons: ['kharif'], irrigation: [] },
  when: { field: 'soil.drainage', op: 'eq', value: 'poor' },
  exceptions: [],
  effect: { type: 'requires_review', reasonCode: 'drainage_unresolved' },
  alternatives: [],
  evidenceIds: ['synthetic-evidence-only'],
  reviewStatus: 'synthetic',
};

describe('CropRule', () => {
  it('round-trips nested all/any/not conditions', () => {
    roundTrip(CropRule, {
      ...syntheticRule,
      when: { all: [{ field: 'soil.ph', op: 'between', value: [5.5, 6.5] }, { not: { any: [{ field: 'season', op: 'in', value: ['rabi'] }, { field: 'farm.areaHa', op: 'known', value: false }] } }] },
    });
  });
  it('rejects non-allowlisted fields and operators', () => {
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'owner.name', op: 'eq', value: 'x' } }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'soil.ph', op: 'regex', value: '.*' } }).success).toBe(false);
  });
  it('type-checks literals against the field type', () => {
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'soil.ph', op: 'gte', value: 'acidic' } }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'soil.drainage', op: 'gte', value: 'poor' } }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'planting.date', op: 'gte', value: '2026-02-30' } }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, when: { field: 'soil.ph', op: 'between', value: [7, 5] } }).success).toBe(false);
  });
  it('blocks synthetic review status or synthetic evidence in live mode', () => {
    expect(CropRule.safeParse({ ...syntheticRule, mode: 'live' }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, mode: 'live', reviewStatus: 'approved' }).success).toBe(false);
    expect(CropRule.safeParse({ ...syntheticRule, mode: 'live', reviewStatus: 'approved', evidenceIds: [] }).success).toBe(false);
  });
});

describe('ForecastArtifact quantiles', () => {
  it('enforces strictly increasing levels and non-crossing values', () => {
    expect(QuantileSet.safeParse([{ level: 0.1, value: 20 }, { level: 0.5, value: 25 }, { level: 0.9, value: 31 }]).success).toBe(true);
    expect(QuantileSet.safeParse([{ level: 0.1, value: 20 }, { level: 0.5, value: 19 }]).success).toBe(false);
    expect(QuantileSet.safeParse([{ level: 0.5, value: 20 }, { level: 0.5, value: 21 }]).success).toBe(false);
    expect(QuantileSet.safeParse([{ level: 0, value: 20 }]).success).toBe(false);
  });
  const artifact = {
    schemaVersion: '1.0',
    id: 'synthetic-forecast-1',
    mode: 'synthetic',
    evidenceState: 'forecast',
    productId: 'synthetic-ginger-fresh',
    marketIds: ['synthetic-market-a'],
    target: { statistic: 'weekly_median_modal', definition: 'synthetic definition', unit: 'INR/kg' },
    issuedAt: '2026-06-01T00:00:00Z',
    trainingCutoff: '2026-05-31T00:00:00Z',
    horizonDays: 180,
    modelId: 'synthetic-model',
    modelKind: 'baseline_seasonal',
    baselineIds: [],
    predictions: [{ period: { start: '2026-12-01', end: '2026-12-07' }, quantiles: [{ level: 0.1, value: -1 }, { level: 0.9, value: 30 }], negativeQuantilesReported: false }],
    evaluation: null,
    featureVersions: [],
    missingness: { fractionMissingWeeks: 0.2, notes: [] },
  };
  it('requires negative quantiles to be flagged, and cutoff before issue', () => {
    expect(ForecastArtifact.safeParse(artifact).success).toBe(false);
    const flagged = { ...artifact, predictions: [{ ...artifact.predictions[0], negativeQuantilesReported: true }] };
    roundTrip(ForecastArtifact, flagged);
    expect(ForecastArtifact.safeParse({ ...flagged, trainingCutoff: '2026-06-02T00:00:00Z' }).success).toBe(false);
  });
});

describe('CoverageRecord', () => {
  const base = {
    schemaVersion: '1.0',
    id: 'synthetic-cov-1',
    mode: 'synthetic',
    cropId: 'synthetic-ginger',
    productId: 'synthetic-ginger-fresh',
    region: { level: 'district', ids: ['synthetic-district-a'] },
    season: 'kharif',
    irrigation: null,
    marketId: 'synthetic-market-a',
    horizonDays: 180,
    capability: 'forecast_evaluated',
    supportStatus: 'unsupported',
    sourceVersions: [],
    modelVersions: [],
    assessedAt: '2026-10-30T00:00:00Z',
    reviewBy: '2027-01-30',
    expiresAt: null,
    measuredQuality: null,
    missingReason: 'synthetic: no held-out evaluation',
  };
  it('unsupported needs a missing reason; supported needs typed quality', () => {
    roundTrip(CoverageRecord, base);
    expect(CoverageRecord.safeParse({ ...base, missingReason: null }).success).toBe(false);
    expect(CoverageRecord.safeParse({ ...base, supportStatus: 'supported' }).success).toBe(false);
    const quality = { metric: 'mae', value: 3.1, baselineId: 'synthetic-baseline', baselineValue: 3.4, intervalNominal: 0.8, intervalEmpiricalCoverage: 0.74, testSamples: 40, testSeasons: 3, abstentions: 2, evaluationReportId: 'synthetic-report' };
    roundTrip(CoverageRecord, { ...base, supportStatus: 'supported', measuredQuality: quality });
    // Quality typed per capability: forecast quality is not valid for visual journey.
    expect(CoverageRecord.safeParse({ ...base, capability: 'visual_journey_supported', supportStatus: 'supported', measuredQuality: quality }).success).toBe(false);
    expect(CoverageRecord.safeParse({ ...base, supportStatus: 'supported', measuredQuality: { ...quality, confidence: 0.9 } }).success).toBe(false);
  });
});

describe('VisualAsset', () => {
  const generated = {
    schemaVersion: '1.0',
    id: 'synthetic-visual-1',
    ownerId: 'synthetic-owner',
    mode: 'synthetic',
    originalMediaId: 'synthetic-media-1',
    regionId: null,
    cropId: 'synthetic-ginger',
    stageId: 'synthetic-stage-tillering',
    qa: { status: 'pending', checks: [] },
    storageKey: 'synthetic/key',
    cacheKey: 'synthetic-cache',
    createdAt: '2026-10-30T00:00:00Z',
    origin: 'generated',
    illustrative: true,
    evidenceState: 'illustrative',
    provider: 'meta',
    modelId: 'synthetic-image-model',
    promptTemplateId: 'synthetic-template',
    promptTemplateHash: 'a'.repeat(64),
    briefHash: 'b'.repeat(64),
    jobId: 'synthetic-job',
  };
  it('generated assets are always illustrative', () => {
    roundTrip(VisualAsset, generated);
    expect(VisualAsset.safeParse({ ...generated, illustrative: false }).success).toBe(false);
    expect(VisualAsset.safeParse({ ...generated, evidenceState: 'observed' }).success).toBe(false);
  });
});

describe('JournalFact', () => {
  it('confirmed status requires a confirmed value', () => {
    const f = { schemaVersion: '1.0', id: 'synthetic-fact', entryId: 'synthetic-entry', ownerId: 'synthetic-owner', field: 'planting.date', original: null, proposed: null, confirmed: null, status: 'confirmed', confirmedAt: null, version: 1 };
    expect(JournalFact.safeParse(f).success).toBe(false);
    expect(JournalFact.safeParse({ ...f, status: 'proposed' }).success).toBe(true);
  });
});

describe('FarmProfile facts', () => {
  const unknownFact = { value: null, basis: 'unknown', confirmed: false };
  const src = { kind: 'farmer_form', ref: null, recordedAt: '2026-10-30T00:00:00Z' };
  const farm = {
    schemaVersion: '1.0', id: 'synthetic-farm', ownerId: 'synthetic-owner', mode: 'synthetic', version: 1, updatedAt: '2026-10-30T00:00:00Z',
    location: { value: { districtId: 'synthetic-district-a', stateId: 'synthetic-state-a', precision: 'district', point: null }, basis: 'farmer_reported', confirmed: true, source: src },
    area: { value: { amount: 2, unit: 'acre' }, basis: 'farmer_reported', confirmed: false, source: src },
    soil: { texture: unknownFact, drainage: unknownFact, ph: { value: 6.1, basis: 'district_proxy', confirmed: false, source: { ...src, kind: 'public_dataset' } }, availableWaterMmPerM: unknownFact },
    water: { category: unknownFact, capacityMmPerWeek: unknownFact },
    plantingWindow: { value: { start: '2027-04-15', end: '2027-05-15' }, basis: 'farmer_reported', confirmed: true, source: src },
    budget: unknownFact, labour: unknownFact, experience: unknownFact, accessibleMarketIds: unknownFact, excludedCropIds: unknownFact,
  };
  it('round-trips and keeps per-field basis', () => {
    const p = roundTrip(FarmProfile, farm);
    expect(p.soil.ph.basis).toBe('district_proxy');
  });
  it('rejects value with unknown basis and known value without source', () => {
    expect(FarmProfile.safeParse({ ...farm, labour: { value: 'low', basis: 'unknown', confirmed: false } }).success).toBe(false);
    expect(FarmProfile.safeParse({ ...farm, labour: { value: 'low', basis: 'farmer_reported', confirmed: false } }).success).toBe(false);
  });
});

describe('EvidenceRecord', () => {
  it('requires a locator and verified availability basis', () => {
    const e = {
      schemaVersion: '1.0', id: 'synthetic-evidence-1', mode: 'synthetic', sourceUrl: 'https://example.org/synthetic.pdf', publisher: 'Synthetic publisher', documentTitle: 'Synthetic', documentVersion: null,
      contentHash: 'c'.repeat(64), locator: { page: 3 }, content: { kind: 'excerpt', text: 'synthetic excerpt', language: 'en' }, publishedAt: null,
      availability: { effectiveAvailableAt: '2026-01-01T00:00:00Z', basis: 'conservative_upper_bound' }, ingestedAt: '2026-10-30T00:00:00Z', revisedAt: null,
      geography: { level: 'state', ids: ['synthetic-state-a'] }, cropIds: ['synthetic-ginger'], productIds: [], units: ['kg/ha'], sourceUnits: ['kg/ha'],
      licence: { licence: 'synthetic', accessStatus: 'open', redistributable: false }, extraction: { method: 'manual', version: '1', reviewedBy: 'human' }, validationStatus: 'pending',
    };
    roundTrip(EvidenceRecord, e);
    expect(EvidenceRecord.safeParse({ ...e, locator: {} }).success).toBe(false);
    expect(EvidenceRecord.safeParse({ ...e, availability: { effectiveAvailableAt: null, basis: 'verified_publication' } }).success).toBe(false);
  });
});

describe('Tools and structured assistant output', () => {
  it('defines exactly the 12 BUILD_SPEC tools with input and output schemas', () => {
    expect(Object.keys(ToolSchemas).sort()).toEqual([...ToolName.options].sort());
    expect(ToolName.options).toHaveLength(12);
  });
  it('tool inputs never accept ownerId or mode', () => {
    expect(ToolSchemas.get_farm_context.input.safeParse({ farmId: 'synthetic-farm' }).success).toBe(true);
    expect(ToolSchemas.get_farm_context.input.safeParse({ farmId: 'synthetic-farm', ownerId: 'synthetic-other' }).success).toBe(false);
    expect(ToolSchemas.screen_crops.input.safeParse({ contextId: 'synthetic-ctx', mode: 'live' }).success).toBe(false);
  });
  const out = {
    schemaVersion: '1.0',
    intent: 'market_question',
    language: 'ta',
    proposedFacts: [],
    clarifications: [],
    toolRequests: [{ callId: 'synthetic-call-1', tool: 'get_job_status', input: { jobId: 'synthetic-job' } }],
    answerBlocks: [{ id: 'synthetic-b1', kind: 'numeric', text: 'Central scenario net cash return', numericRefIds: ['synthetic-n1'], claimIds: [] }],
    numericRefs: [{ id: 'synthetic-n1', toolResultId: 'synthetic-result-1', jsonPointer: '/scenarios/1/perHa/netCashReturnInr', presentation: { unit: 'INR', sourceUnit: 'INR', rounding: { mode: 'decimals', digits: 0 }, intervalLabel: 'central' } }],
    claimEvidenceRefs: [],
    limitations: ['synthetic'],
  };
  it('round-trips and validates numeric references and tool inputs', () => {
    roundTrip(StructuredAssistantOutput, out);
    expect(StructuredAssistantOutput.safeParse({ ...out, toolRequests: [{ callId: 'x', tool: 'get_job_status', input: {} }] }).success).toBe(false);
    expect(StructuredAssistantOutput.safeParse({ ...out, toolRequests: [{ callId: 'x', tool: 'run_sql', input: {} }] }).success).toBe(false);
    expect(StructuredAssistantOutput.safeParse({ ...out, numericRefs: [] }).success).toBe(false);
    expect(StructuredAssistantOutput.safeParse({ ...out, numericRefs: [{ ...out.numericRefs[0], jsonPointer: 'scenarios.1' }] }).success).toBe(false);
    expect(StructuredAssistantOutput.safeParse({ ...out, extra: 1 }).success).toBe(false);
  });
  it('proposed facts always require confirmation', () => {
    const fact = { field: 'farm.area', value: { ...unavailablePrice, unit: 'acre' }, sourceSpan: null, requiresConfirmation: false };
    expect(StructuredAssistantOutput.safeParse({ ...out, proposedFacts: [fact] }).success).toBe(false);
    expect(StructuredAssistantOutput.safeParse({ ...out, proposedFacts: [{ ...fact, requiresConfirmation: true }] }).success).toBe(true);
  });
});

describe('Job state machine', () => {
  it('allows only documented transitions', () => {
    expect(canTransitionJob('queued', 'running')).toBe(true);
    expect(canTransitionJob('running', 'queued')).toBe(true);
    expect(canTransitionJob('succeeded', 'running')).toBe(false);
    expect(canTransitionJob('cancelled', 'queued')).toBe(false);
    expect(canTransitionJob('queued', 'succeeded')).toBe(false);
  });
});

describe('registry', () => {
  it('exports every top-level contract plus 24 tool schemas', () => {
    expect(Object.keys(PUBLIC_CONTRACTS).filter((k) => k.startsWith('tool.'))).toHaveLength(24);
    for (const [k, v] of Object.entries(PUBLIC_CONTRACTS)) expect(v, k).toBeDefined();
  });
});
