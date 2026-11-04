import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FarmSummary, FarmWorkspace, type OverviewFact } from '@harvest/contracts';
import { setupHarness, login, type Harness, type Client } from './helpers';
import { farmSummaryFacts, readFarmSummary, requestFarmSummary, writeFarmSummary, FARM_SUMMARY_JOB, SUMMARY_HOUR_MS } from '../src/services/farm-summary';
import { Budget } from '../src/services/budget';
import { readOnlyPool } from '../src/agent/bindings/briefing';
import * as research from '../src/services/focused-crops';
import type { TextModelProvider } from '../src/agent/provider';
let h: Harness, owner: Client, other: Client, ownerId: string;
const NOW = new Date('2026-11-03T04:30:00Z');
const boundary = (x: number) => ({
  type: 'Polygon',
  coordinates: [[[x, 12], [x + .001, 12], [x + .001, 12.001], [x, 12.001], [x, 12]]]
});
const config = () => ({
  ...h.config,
  RUNTIME_MODE: 'live' as const,
  MODEL_API_KEY: 'fixture-key'
});
const deps = () => ({
  pool: h.pool,
  config: config(),
  now: () => NOW
});
async function farm(withCrops = true) {
  const response = await owner.call('POST', '/api/v1/farms', {
    payload: {
      name: 'PRIVATE_FARM_LABEL',
      location: {
        districtId: 'IN-KA-hassan',
        stateId: 'IN-KA',
        lat: 12.345678,
        lon: 77.345678,
        precision: 'approximate'
      }
    }
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json().data.id as string;
  if (withCrops) {
    const ws = FarmWorkspace.parse({
      farmId: id,
      version: 1,
      updatedAt: NOW.toISOString(),
      boundary: null,
      previousHarvest: {
        status: 'unknown'
      },
      fields: [{
        id: 'north',
        name: 'PRIVATE_NORTH_LABEL',
        boundary: boundary(77)
      }, {
        id: 'south',
        name: 'PRIVATE_SOUTH_LABEL',
        boundary: boundary(77.002)
      }],
      cycles: [{
        id: 'private-cycle-a',
        cropId: 'maize',
        cropName: 'PRIVATE_CROP_LABEL',
        sowingDate: '2026-09-01',
        establishmentMethod: 'direct_sowing',
        stage: 'growing',
        fieldId: 'north'
      }, {
        id: 'private-cycle-b',
        cropId: 'paddy-rice',
        cropName: 'PRIVATE_CROP_LABEL',
        sowingDate: '2026-10-01',
        establishmentMethod: 'direct_sowing',
        stage: 'growing',
        fieldId: 'south'
      }],
      rotationPlans: []
    });
    await h.pool.query('INSERT INTO farm_workspaces(farm_id,state,version) VALUES($1,$2::jsonb,1) ON CONFLICT(farm_id) DO UPDATE SET state=$2::jsonb,version=1', [id, JSON.stringify((({
      farmId,
      version,
      updatedAt,
      ...state
    }) => state)(ws))]);
  }
  return id;
}
async function row(id: string) {
  return (await h.pool.query<{
    id: string;
    job_id: string;
    context_hash: string;
    facts: OverviewFact[];
  }>('SELECT id,job_id,context_hash,facts FROM farm_summaries WHERE farm_id=$1 ORDER BY enqueued_at DESC LIMIT 1', [id])).rows[0]!;
}
function fake(answer: (facts: OverviewFact[]) => unknown | Promise<unknown>) {
  const provider: TextModelProvider & {
    deleteResponse: ReturnType<typeof vi.fn>;
  } = {
    kind: 'meta',
    provenance: 'meta_live',
    billable: false,
    call: vi.fn(async req => {
      const facts = (JSON.parse(String(req.input)) as {
        facts: OverviewFact[];
      }).facts;
      return {
        ok: true as const,
        result: {
          provenance: 'meta_live' as const,
          responseId: 'summary-response',
          requestId: 'summary-request',
          model: 'fixture',
          outputText: JSON.stringify(await answer(facts)),
          functionCalls: [],
          usage: {
            inputTokens: 100,
            outputTokens: 80,
            cachedInputTokens: 0
          },
          latencyMs: 1,
          retries: 0
        }
      };
    }),
    deleteResponse: vi.fn(async () => ({
      ok: true,
      code: null
    }))
  };
  return provider;
}
const modelAnswer = (facts: OverviewFact[]) => ({
  headline: 'Review your recorded crop priorities',
  points: [{
    kind: 'watch',
    text: facts.find(f => f.id === 'crops')!.text,
    factIds: ['crops']
  }]
});
beforeAll(async () => {
  h = await setupHarness();
  owner = await login(h.app);
  other = await login(h.app);
  ownerId = (await h.pool.query<{
    owner_id: string;
  }>('SELECT owner_id FROM sessions WHERE token_hash IS NOT NULL ORDER BY created_at LIMIT 1')).rows[0]!.owner_id;
  await h.pool.query(`INSERT INTO crop_identities(slug,names) VALUES('maize','{"en":[{"text":"Maize"}]}'::jsonb),('paddy-rice','{"en":[{"text":"Paddy / rice"}]}'::jsonb) ON CONFLICT(slug) DO NOTHING`);
}, 60000);
afterAll(async () => h?.close());
describe('whole-farm summaries', () => {
  it('GET aggregates both fields, contains no farmer text, reads without writes and keeps hash stable between requests', async () => {
    const id = await farm();
    const first = await farmSummaryFacts(deps(), ownerId, id);
    expect(first.facts.find(f => f.id === 'coverage')!.text).toContain('2 saved fields; 2');
    expect(first.facts.find(f => f.id === 'crops')!.text).toContain('Maize');
    expect(JSON.stringify(first.facts)).not.toMatch(/PRIVATE_|12\.345678|private-cycle/);
    const next = await farmSummaryFacts({
      ...deps(),
      now: () => new Date(NOW.getTime() + 1000)
    }, ownerId, id);
    expect(next.contextHash).toBe(first.contextHash);
    const read = FarmSummary.parse(await readFarmSummary({
      ...deps(),
      pool: readOnlyPool(h.pool)
    }, ownerId, id));
    expect(read).toMatchObject({
      scope: 'farm',
      origin: 'deterministic',
      canGenerate: true
    });
    expect((await h.pool.query('SELECT id FROM farm_summaries WHERE farm_id=$1', [id])).rowCount).toBe(0);
  });
  it('includes all unharvested records: two whole-farm records and two sharing one field', async () => {
    const id = await farm();
    const saved = (await h.pool.query<{
      state: {
        cycles: Array<Record<string, unknown>>;
      };
    }>('SELECT state FROM farm_workspaces WHERE farm_id=$1', [id])).rows[0]!.state;
    const first = saved.cycles[0]!,
      second = saved.cycles[1]!;
    const {
        fieldId: unusedA,
        ...wholeA
      } = first,
      {
        fieldId: unusedB,
        ...wholeB
      } = second;
    saved.cycles = [{
      ...first,
      id: 'field-record-one',
      fieldId: 'north'
    }, {
      ...second,
      id: 'field-record-two',
      fieldId: 'north'
    }, {
      ...wholeA,
      id: 'whole-one'
    }, {
      ...wholeB,
      id: 'whole-two'
    }];
    await h.pool.query('UPDATE farm_workspaces SET state=$2::jsonb,version=version+1 WHERE farm_id=$1', [id, JSON.stringify(saved)]);
    const set = await farmSummaryFacts(deps(), ownerId, id);
    expect(set.facts.find(f => f.id === 'coverage')!.text).toContain('2 saved fields; 1 have crops recorded; 2 unharvested whole-farm crop records');
    expect(set.facts.find(f => f.id === 'crops')!.text).toContain('4 unharvested crop records');
    expect(set.facts.find(f => f.id === 'crops')!.text).toContain('Maize');
    expect(set.facts.find(f => f.id === 'crops')!.text).toContain('Paddy / rice');
    expect(set.facts.find(f => f.id === 'associations')!.text).toContain('1 additional unharvested crop records share a field');
  });
  it('API GET/POST honor owner isolation and CSRF; synthetic mode never queues', async () => {
    const id = await farm();
    expect((await other.call('GET', `/api/v1/farms/${id}/summary`)).statusCode).toBe(404);
    expect((await other.call('POST', `/api/v1/farms/${id}/summary`, {
      payload: {}
    })).statusCode).toBe(404);
    expect((await owner.call('POST', `/api/v1/farms/${id}/summary`, {
      payload: {},
      csrf: null
    })).statusCode).toBe(403);
    const bare = await owner.call('POST', `/api/v1/farms/${id}/summary`);
    expect(bare.statusCode, bare.body).toBe(200);
    const response = await owner.call('POST', `/api/v1/farms/${id}/summary`, {
      payload: {}
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(FarmSummary.parse(response.json().data)).toMatchObject({
      origin: 'deterministic',
      canGenerate: false
    });
    expect((await h.pool.query('SELECT id FROM farm_summaries WHERE farm_id=$1', [id])).rowCount).toBe(0);
  });
  it('does not spend on an empty farm or replay, and missing key gives an honest fallback', async () => {
    const empty = await farm(false);
    expect(await requestFarmSummary(deps(), ownerId, empty)).toMatchObject({
      canGenerate: false,
      origin: 'deterministic'
    });
    const id = await farm();
    expect(await requestFarmSummary({
      ...deps(),
      config: {
        ...config(),
        RUNTIME_MODE: 'replay'
      }
    }, ownerId, id)).toMatchObject({
      canGenerate: false,
      origin: 'deterministic'
    });
    expect(await readFarmSummary({
      ...deps(),
      config: {
        ...config(),
        MODEL_API_KEY: undefined
      }
    }, ownerId, id)).toMatchObject({
      status: 'unavailable',
      canGenerate: false
    });
  });
  it('concurrent POSTs deduplicate, GET never enqueues, and worker writes a fact-gated cache hit', async () => {
    const id = await farm();
    const results = await Promise.all([requestFarmSummary(deps(), ownerId, id), requestFarmSummary(deps(), ownerId, id)]);
    expect(results.every(r => r.status === 'pending' && !r.canGenerate)).toBe(true);
    const r = await row(id);
    expect((await h.pool.query('SELECT id,max_attempts FROM jobs WHERE type=$1 AND payload->>\'farmId\'=$2', [FARM_SUMMARY_JOB, id])).rows).toEqual([{
      id: r.job_id,
      max_attempts: 1
    }]);
    const provider = fake(modelAnswer);
    const outcome = await writeFarmSummary({
      ...deps(),
      budget: Budget.fromConfig(h.pool, config()),
      provider
    }, r.id, ownerId, r.job_id);
    expect(outcome.status).toBe('ready');
    expect(provider.call).toHaveBeenCalledTimes(1);
    const request = vi.mocked(provider.call).mock.calls[0]![0];
    expect(request).toMatchObject({
      store: false,
      reasoningEffort: 'low',
      textFormat: {
        name: 'farm_summary'
      }
    });
    expect(String(request.input)).not.toMatch(/PRIVATE_|private-cycle|77\.345678/);
    expect(provider.deleteResponse).toHaveBeenCalledTimes(1);
    expect(await readFarmSummary(deps(), ownerId, id)).toMatchObject({
      origin: 'model',
      status: 'ready',
      canGenerate: false
    });
    await requestFarmSummary(deps(), ownerId, id);
    expect((await h.pool.query('SELECT id FROM jobs WHERE type=$1 AND payload->>\'farmId\'=$2', [FARM_SUMMARY_JOB, id])).rowCount).toBe(1);
  });
  it('changed facts cannot bypass farm throttle and late jobs cannot overwrite a new context', async () => {
    const id = await farm();
    await requestFarmSummary(deps(), ownerId, id);
    const r = await row(id);
    await h.pool.query('UPDATE farm_workspaces SET version=version+1 WHERE farm_id=$1', [id]);
    const next = await readFarmSummary(deps(), ownerId, id);
    expect(next).toMatchObject({
      origin: 'deterministic',
      canGenerate: false
    });
    expect(next.retryAfter).toBe(new Date(NOW.getTime() + SUMMARY_HOUR_MS).toISOString());
    const provider = fake(modelAnswer);
    expect(await writeFarmSummary({
      ...deps(),
      budget: Budget.fromConfig(h.pool, config()),
      provider
    }, r.id, ownerId, r.job_id)).toMatchObject({
      failure: 'stale_context'
    });
    expect(provider.call).not.toHaveBeenCalled();
  });
  it('invalid numeric model output falls back and the same failed hash is retryable only after an hour', async () => {
    const id = await farm();
    await requestFarmSummary(deps(), ownerId, id);
    const r = await row(id);
    const provider = fake(() => ({
      headline: 'Earn 999999 rupees',
      points: [{
        kind: 'money',
        text: 'Earn 999999 rupees',
        factIds: ['crops']
      }]
    }));
    expect(await writeFarmSummary({
      ...deps(),
      budget: Budget.fromConfig(h.pool, config()),
      provider
    }, r.id, ownerId, r.job_id)).toMatchObject({
      origin: 'deterministic',
      failure: 'gate_digit_not_in_facts'
    });
    expect(await readFarmSummary(deps(), ownerId, id)).toMatchObject({
      status: 'unavailable',
      origin: 'deterministic',
      canGenerate: false
    });
    const later = {
      ...deps(),
      now: () => new Date(NOW.getTime() + SUMMARY_HOUR_MS + 1)
    };
    expect((await requestFarmSummary(later, ownerId, id)).status).toBe('pending');
  });
  it('keeps overdue care with zero due tasks and due checks with zero reported issues', async () => {
    const id = await farm();
    const original = await research.focusedResearch(),
      crop = original.crops.find(c => c.cropId === 'maize')!;
    const {
      productIds,
      ...base
    } = crop.care[0]!;
    const spy = vi.spyOn(research, 'focusedResearch').mockResolvedValue({
      ...original,
      crops: [{
        ...crop,
        care: [{
          ...base,
          id: 'fixture-early',
          title: 'Fixture care task',
          anchor: 'sowing',
          startDay: 1,
          endDay: 2,
          repeatEveryDays: null,
          geographyIds: ['IN'],
          establishmentMethods: ['direct_sowing']
        }]
      }]
    });
    try {
      const set = await farmSummaryFacts(deps(), ownerId, id);
      expect(set.facts.find(f => f.id === 'care')!.text).toMatch(/^0 source-scheduled care tasks are due and [1-9]/);
      expect(set.points.some(p => p.factIds.includes('care'))).toBe(true);
      expect(set.facts.find(f => f.id === 'scouting')!.text).toMatch(/^0 farmer-reported issues.*[1-9] field checks/);
      expect(set.points.some(p => p.factIds.includes('scouting'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
  it('worker refuses wrong job, wrong owner, cancellation and a deleted farm without provider calls', async () => {
    const id = await farm();
    await requestFarmSummary(deps(), ownerId, id);
    const r = await row(id),
      provider = fake(modelAnswer),
      worker = {
        ...deps(),
        budget: Budget.fromConfig(h.pool, config()),
        provider
      };
    expect(await writeFarmSummary(worker, r.id, ownerId, '00000000-0000-4000-8000-000000000001')).toMatchObject({
      status: 'cancelled'
    });
    expect(await writeFarmSummary(worker, r.id, '00000000-0000-4000-8000-000000000001', r.job_id)).toMatchObject({
      status: 'cancelled'
    });
    expect(await writeFarmSummary(worker, r.id, ownerId, r.job_id, async () => true)).toMatchObject({
      status: 'cancelled'
    });
    await h.pool.query('UPDATE farms SET deleted_at=now() WHERE id=$1', [id]);
    expect(await writeFarmSummary(worker, r.id, ownerId, r.job_id)).toMatchObject({
      status: 'cancelled'
    });
    expect(provider.call).not.toHaveBeenCalled();
  });
  it('facts changing during a model call prevent publication of the late answer', async () => {
    const id = await farm();
    await requestFarmSummary(deps(), ownerId, id);
    const r = await row(id),
      provider = fake(async facts => {
        await h.pool.query('UPDATE farm_workspaces SET version=version+1 WHERE farm_id=$1', [id]);
        return modelAnswer(facts);
      });
    expect(await writeFarmSummary({
      ...deps(),
      budget: Budget.fromConfig(h.pool, config()),
      provider
    }, r.id, ownerId, r.job_id)).toMatchObject({
      status: 'unavailable',
      origin: 'deterministic',
      failure: 'stale_context'
    });
    expect((await readFarmSummary(deps(), ownerId, id)).origin).toBe('deterministic');
  });
  it('budget refusal falls back without dispatch and exposes the retry time', async () => {
    const id = await farm();
    await requestFarmSummary(deps(), ownerId, id);
    const r = await row(id),
      provider = fake(modelAnswer),
      budget = {
        estimate: () => ({
          usd: 0.01
        }),
        reserve: async () => {
          throw Object.assign(new Error('cap'), {
            code: 'budget_exceeded'
          });
        }
      } as unknown as Budget;
    expect(await writeFarmSummary({
      ...deps(),
      budget,
      provider
    }, r.id, ownerId, r.job_id)).toMatchObject({
      origin: 'deterministic',
      failure: 'error_budget_exceeded'
    });
    expect(provider.call).not.toHaveBeenCalled();
    expect(await readFarmSummary(deps(), ownerId, id)).toMatchObject({
      status: 'unavailable',
      canGenerate: false,
      retryAfter: new Date(NOW.getTime() + SUMMARY_HOUR_MS).toISOString()
    });
  });
  it('owner admission is bounded to eight jobs per rolling hour across farms', async () => {
    const future = {
      ...deps(),
      now: () => new Date(NOW.getTime() + 10 * SUMMARY_HOUR_MS)
    };
    const ids = await Promise.all(Array.from({
      length: 9
    }, () => farm()));
    const replies = await Promise.all(ids.map(id => requestFarmSummary(future, ownerId, id)));
    expect(replies.filter(r => r.status === 'pending')).toHaveLength(8);
    const blocked = replies.find(r => r.status !== 'pending')!;
    expect(blocked.canGenerate).toBe(false);
    expect(blocked.retryAfter).toBe(new Date(NOW.getTime() + 11 * SUMMARY_HOUR_MS).toISOString());
  });
});
