import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {migrate} from '../src/db/migrate';
import {farmBody, login, setupHarness, type Harness} from './helpers';

/**
 * Migration 0037_future_look_kinds.sql applied to a database that already holds a v1 future_look_assets row. The harness
 * migrates everything; the test then restores the exact pre-0037 shape (0027's columns and unique key), inserts a v1 row,
 * and runs the project's migration runner again so only 0037 applies over it. SYNTHETIC rows.
 */
const ITEM = 'S2A_MSIL2A_20261027T052231_R062_T43PFQ_20261027T101714';
let h: Harness;
beforeAll(async () => { h = await setupHarness(); }, 60_000);
afterAll(async () => h?.close());

describe('0037_future_look_kinds', () => {
  it('applies over v1 rows: they read as stage looks, and the new unique key holds for both kinds', async () => {
    const owner = await login(h.app);
    const farmId = (await owner.call('POST', '/api/v1/farms', {payload: farmBody({facts: {}})})).json().data.id as string;
    const ownerId = (await h.pool.query<{owner_id: string}>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;

    // Back to the 0027 shape.
    await h.pool.query(`
      DROP INDEX future_look_assets_gap_recent;
      ALTER TABLE future_look_assets DROP CONSTRAINT future_look_assets_tuple_key, DROP CONSTRAINT future_look_assets_gap_target;
      ALTER TABLE future_look_assets DROP COLUMN target_week, DROP COLUMN kind, DROP COLUMN target_date, DROP COLUMN guidance;
      ALTER TABLE future_look_assets ADD UNIQUE (farm_id, cycle_id, stage_id, source_item_id, prompt_version);
      DELETE FROM schema_migrations WHERE name = '0037_future_look_kinds.sql';`);
    const v1 = (await h.pool.query<{id: string}>(
      `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, storage_key)
       VALUES ($1,$2,'cycle-1',$3,'2026-10-27T05:22:31Z','mid_season','Mid-season','maize','Maize','future-look-v1','ready','future-look/x/y.png') RETURNING id`,
      [ownerId, farmId, ITEM])).rows[0]!;

    expect(await migrate(h.pool, undefined, () => undefined)).toEqual(['0037_future_look_kinds.sql']);
    const row = (await h.pool.query('SELECT kind, target_date, guidance, target_week, status, prompt_version FROM future_look_assets WHERE id=$1', [v1.id])).rows[0];
    expect(row).toEqual({kind: 'stage', target_date: null, guidance: null, target_week: null, status: 'ready', prompt_version: 'future-look-v1'});
    const keys = (await h.pool.query<{conname: string}>("SELECT conname FROM pg_constraint WHERE conrelid='future_look_assets'::regclass AND contype='u'")).rows.map((r) => r.conname);
    expect(keys).toEqual(['future_look_assets_tuple_key']);

    const insert = (o: {stage?: string; kind?: string; target?: string | null; version?: string; status?: string; key?: string | null}) => h.pool.query(
      `INSERT INTO future_look_assets (owner_id, farm_id, cycle_id, source_item_id, source_acquired_at, stage_id, stage_name, crop_id, crop_name, prompt_version, status, storage_key, kind, target_date, guidance)
       VALUES ($1,$2,'cycle-1',$3,'2026-10-27T05:22:31Z',$4,'Stage','maize','Maize',$5,$6,$7,$8,$9::date,'g')`,
      [ownerId, farmId, ITEM, o.stage ?? 'mid_season', o.version ?? 'future-look-v1', o.status ?? 'queued', o.key ?? null, o.kind ?? 'stage', o.target ?? null]);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: {code?: string}) => e.code);
    // The v1 tuple stays unique (stage rows: target_week NULL, NULLS NOT DISTINCT).
    expect(await code(insert({}))).toBe('23505');
    expect(await code(insert({version: 'future-look-v2', target: '2026-11-14'}))).toBe('ok');
    // Gap rows: one per week per tuple; another week is fine; a gap row needs a target date.
    expect(await code(insert({kind: 'gap', version: 'future-look-v2', target: '2026-11-04'}))).toBe('ok');
    expect((await h.pool.query("SELECT target_week::text AS w FROM future_look_assets WHERE kind='gap'")).rows).toEqual([{w: '2026-11-02'}]);
    expect(await code(insert({kind: 'gap', version: 'future-look-v2', target: '2026-11-08'}))).toBe('23505');
    expect(await code(insert({kind: 'gap', version: 'future-look-v2', target: '2026-11-09'}))).toBe('ok');
    expect(await code(insert({kind: 'gap', version: 'future-look-v2', target: null}))).toBe('23514');
    expect(await code(insert({kind: 'other', version: 'future-look-v3'}))).toBe('23514');
    // The ready/storage_key check is kept.
    expect(await code(insert({version: 'future-look-v3', status: 'ready', key: null}))).toBe('23514');
  });
});
